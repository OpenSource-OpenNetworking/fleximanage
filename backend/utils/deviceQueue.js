// flexiWAN SD-WAN software - flexiEdge, flexiManage. For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/**********************************************
 * This module runs a job queue wrapper for
 * having the server save jobs and also the
 * broker to consume.
 * DeviceQueues class is a singleton per system:
 * server, broker, etc.
 **********************************************/
const kue = require('kue');
const configs = require('../configs')();
const logger = require('../logging/logging')({module: module.filename, type: 'job'});

class DeviceQueues {

    /**
     * Creates a DeviceQueues. Multiple DeviceQueues per system
     * are allowed. The broker creates a queue per connected device.
     * @param  {string} prefix    prefix used for the queue
     * @param  {object} redis     redis connection object, if not provided use default redis host/port
     */
    constructor(prefix, redis) {
        // Bind class functions
        this.startQueue = this.startQueue.bind(this);
        this.shutdown = this.shutdown.bind(this);
        this.addJob = this.addJob.bind(this);
        this.pauseQueue = this.pauseQueue.bind(this);
        this.resumeQueue = this.resumeQueue.bind(this);
        this.removeJobs = this.removeJobs.bind(this);
        this.removeJobIdsByOrg = this.removeJobIdsByOrg.bind(this);

        this.removeCallbacks = {};

        // TBD: make it more safe
        const args = redis.split("://")[1].split(":");
        const options = {
            host: args[0],
            port: args[1]
        };

        // define redis options here
        this.redisOptions = {
            redis: {
                options: {
                    retry_strategy: function (options) {
                        if (options.error && options.error.code === 'ECONNREFUSED') {
                            // End reconnecting on a specific error and flush all commands with
                            // a individual error
                            return new Error('The server refused the connection');
                        }
                        if (options.total_retry_time > configs.get('redisTotalRetryTime')) {
                            // End reconnecting after a specific timeout and flush all commands
                            // with a individual error
                            return new Error('Retry time exhausted');
                        }
                        if (options.attempt > configs.get('redisTotalAttempts')) {
                            // End reconnecting with built in error
                            return undefined;
                        }
                        // reconnect after
                        return Math.min(options.attempt * 100, 3000);
                    }
                }

            }
        };

        // Update redis options
        if (typeof options === "object") {
            Object.assign(this.redisOptions.redis.options, options);
        }

        // Kue init on the first time a class called for a system
        this.queue = kue.createQueue({prefix, redis});
        this.queue.watchStuckJobs(10000);
        this.queue.on('error', (err) => {
            logger.error('DeviceQueues error', {params: {redisConn: redis, err: err}});
        });
        this.deviceQueues = {};
    }

    /**
     * Start a Queue for a device ID and initialize its processor
     * Starting a queue is done from the consumer side, the producer
     * can add jobs. If queue already exist, use it and resume it.
     * @param  {string} deviceId  UUID of the device
     * @param  {Callback} processor processor handler
     * @return {void}
     */
    async startQueue(deviceId, processor) {
        if (this.deviceQueues[deviceId]) {
            // Queue for that device already exist, resume queue
            this.resumeQueue(deviceId);
            return;
        }

        // Initialize queue info
        const queueInfo = {
            context: undefined,
            paused: false,
            concurrency: 1};

        this.queue.process(deviceId, queueInfo.concurrency, async (job, ctx, done) => {
            queueInfo.context = ctx;
            // Init message is sent only to update the context
            if (job.data.metadata.init) {
                done(null, true);
                return;
            }
            try {
                // Call to process current job, using the processor callback function
                await processor(job);
            }
            catch (err) {
                logger.warn("Failed to process job", {
                    params: { job: job, deviceId: deviceId, err: err.message },
                    job: job
                });
                if (!job.data.ignoreFailure) {
                    return done(err, false);
                }
            }
            done(null, job.data.response);
        });

        // Update data and send first message
        this.deviceQueues[deviceId] = queueInfo;
        // Send first message to get hold on the context
        try {
            await this.addJob(deviceId, null, null, {}, true,
                {priority:'critical', attempts:1, init:true, removeOnComplete:true});
        }
        catch (err) {
            logger.warn('Failed to start device queue',
                        {params: {deviceId: deviceID, err: err.message}});
        }
    }

    /**
     * Gracefully shutdown the queue.
     * @return {void}
     */
    shutdown() {
        this.queue.shutdown(() => {
            this.queue = undefined;
            this.deviceQueues = {};
            deviceq = null;
        });
    }


    /**
     * Adds a job to the queue for deviceID.
     * @param {string}  deviceId                 Device UUID
     * @param {string}  org                      Organization the transaction belongs to
     * @param {Object}  message                  Data to be sent
     * @param {Object}  response                 Data to be sent when the job completed
     * @param {string}  options.priority         Priority of the Job (low, normal, medium, high, critical)
     * @param {number}  options.attempts         Number of attempts in case of errors
     * @param {boolean} options.init             Whether this is a special init message
     * @param {boolean} options.removeOnComplete Should job be removed on completion
     * @param {Callback} OnComplete              Function (jobid, result) - executed on job complete
     *                                                           (Careful!!! seen some missing events)
     * @return {Promise}                         Promise of new job
     */
    addJob(deviceId, username, org, message, response = true,
        {priority = 'normal',
         attempts = 1,
         init = false,
         removeOnComplete = true,
         } = {},
         onComplete = null) {

        // Return promise
        return new Promise((resolve, reject) => {

            const metadata = {
                target: deviceId,
                username: (username)?username:'unknown',
                org: (org)?org:'unknown',
                init: init,
            };

            const job = this.queue
                .create(deviceId, {message, response, metadata});
            if (priority) job.priority(priority);
            if (attempts) job.attempts(attempts);
            if (removeOnComplete) job.removeOnComplete(removeOnComplete);
            // If onComplete callback defined, set it
            if (onComplete) job.on('complete', (res) => {onComplete(job.id, res);});

            // For init message, wait for completion
            if (init) {
                job
                .on('complete', (res) => {
                    resolve(res);
                })
                .on('failed', (failErr) => {
                    reject(new Error(failErr));
                });
            }
            job.save((err) => {
                if (err) reject(new Error(err));
                else if (!init) resolve(job);
            });
        });
    }

    /**
     * Pause a queue for a given device ID, called from the queue consumer.
     * @param  {string} deviceId UUID of the device
     * @return {void}
     */
    pauseQueue(deviceId) {
        logger.info("Pausing queue request",
                    {params: {deviceId: deviceId, queue: this.deviceQueues[deviceId]}});
        return new Promise ((resolve, reject) => {
            if (!this.deviceQueues[deviceId]) {
                reject(new Error('DeviceQueues: Trying to pause an undefined queue, deviceID=' + deviceId));
                return;
            }
            if (this.deviceQueues[deviceId].paused) {
                resolve();    // Already paused
                logger.info("Queue already paused, succeeded",
                            {params: {deviceId: deviceId, queue: this.deviceQueues[deviceId]}});
                return;
            }
            if (!this.deviceQueues[deviceId].context) {
                reject(new Error('DeviceQueues: Pausing a queue with no context, deviceID=' + deviceId));
                return;
            }
            // Pause immediatly
            this.deviceQueues[deviceId].context.pause(0, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
            });
            resolve();
            logger.info("Queue paused, succeeded",
                        {params: {deviceId: deviceId}, queue: this.deviceQueues[deviceId]});
            this.deviceQueues[deviceId].paused = true;
        });
    }

    /**
     * Resumes a queue for a given device ID, called from the queue consumer
     * @param  {string} deviceId UUID of the device
     * @return {void}
     */
    resumeQueue(deviceId) {
        logger.info("Resuming device queue",
                    {params: {deviceId: deviceId}, queue: this.deviceQueues[deviceId]});
        if (!this.deviceQueues[deviceId])
            throw new Error('DeviceQueues: Trying to resume an undefined queue, deviceID=' + deviceId);
        if (!this.deviceQueues[deviceId].paused) return;    // Already resumed
        if (!this.deviceQueues[deviceId].context)
            throw new Error('DeviceQueues: Resuming a queue with no context, deviceID=' + deviceId);
        this.deviceQueues[deviceId].context.resume();
        this.deviceQueues[deviceId].paused = false;
    }

    /**
     * Iterates over jobs of specific state
     * @param  {string}   state    queue state ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @param  {Callback} callback callback to be called per job
     * @return {void}
     */
    iterateJobs(state, callback) {
        return new Promise((resolve, reject) => {
            kue.Job.rangeByState(state, 0, -1, 'asc', async function(err, jobs) {
                if (err) {
                    reject(new Error('DeviceQueues: Iteration error, state=' + state + ', err=' + err));
                    return;
                }
                jobs.forEach((job) => callback(job));
                resolve();
            });
        });
    }

    /**
     * Iterates over jobs of specific state and organization
     * The current implementation get all jobs and filter the org specific ones
     * This implementation doesn't scale for a large system
     * TBD: For a large deployment, two improvements could be done:
     *   a) Manage a separate redis queue holding the jobs for a org, the job can be added when adding the
     *      job in kue, and delete it using the periodic kue management
     *   b) Get partial jobs and not all, when org get more, get more messages from the queue
     * @param  {string}   org      organization to iterate jobs for
     * @param  {string}   state    queue state ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @param  {Callback} callback callback to be called per job
     * @return {void}
     */
    iterateJobsByOrg(org, state, callback) {
        return new Promise((resolve, reject) => {
            try {
                kue.Job.rangeByState(state, 0, -1, 'asc', function(err, jobs) {
                    if (err) {
                        reject(new Error('DeviceQueues: Iteration error, state=' + state + ', err=' + err));
                        return;
                    }
                    jobs.forEach(async (job) => {
                        if (job.data.metadata.org === org) callback(job);
                    });
                    resolve();
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Iterates over jobs IDs of specific state and organization
     * @param  {string}     org      organization to iterate jobs for
     * @param  {Array(Int)} jobIds   List of Job IDs to iterate
     * @param  {Callback}   callback callback to be called per job
     * @return {void}
     */
    iterateJobsIdsByOrg(org, jobIDs, callback) {
        return new Promise((resolve, reject) => {
            try {
                jobIDs.forEach(async (id) => {
                    await kue.Job.get(id, async (err, job) => {
                        if (err) reject(err);
                        if (!job) reject(new Error('DeviceQueues: Iterated job not found for ID=' + id));
                        if (!job.data.metadata.org === org)
                            reject(new Error('DeviceQueues: Iteration org not authorized, org=' + org));
                        callback(job);
                    });
                });
                resolve();
            } catch (err) {
                reject (err);
            }
        });
    }
    /**
     * Removes all jobs in the jobIDs array according
     * to an organizations id.
     * @param  {string} org    organization id
     * @param  {Array}  jobIDs an array of ids of the jobs to be removed
     */
    async removeJobIdsByOrg(org, jobIDs) {
        try {
            await this.iterateJobsIdsByOrg(org, jobIDs, async (job) => {
                const removedJob = await job.remove( function(err) { if (err) throw err; });
                const { method } = removedJob.data.response;
                this.callRegisteredCallback(method, removedJob);
            });
        } catch (err) {
            throw err;
        }
    }

  /**
   * Returns the job object according to the job id.
   * @param  {string}  jobId  Id of the job to be retrieved
   * @param  {boolean} strict a flag that states what to do
   *                          in case the job was not found:
   *                          true - reject, false - resolve as null
   * @return {Promise}        for a job object
   */
  getJobById(jobId, strict=false) {
    return new Promise((resolve, reject) => {
        kue.Job.get(jobId, async (err, job) => {
            if (err) {
                // If not in strict mode, don't treat non existing
                // jobs as error. Simply return null instead of the job.
                if(err.message.includes('doesnt exist') && !strict) {
                    return resolve(null);
                }
                reject(err);
            }
            return resolve(job);
        });
    });
  }

    /**
     * Gets the number of jobs for current state
     * @param  {string} state queue state ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @return {number}       Number of jobs
     */
    async getCount(state) {
        return new Promise((resolve, reject) => {
            this.queue[state + 'Count']((err, total) => {
                if (err) reject(new Error('DeviceQueues: getCount error, state=' + state + ', err=' + err));
                else resolve(total);
            });
        });
    }

    /**
     * Removes jobs created before the specified time for a given state
     * @param  {string} state         queue state to remove jobs from
     *                                ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @param  {number} createdBefore time in milliseconds
     * @return {void}
     */
    async removeJobs(state, createdBefore=3600000) {
        try {
            const now = new Date().getTime();
            await this.iterateJobs(state, async (job) => {
                if (now - job.created_at > createdBefore) {
                    const removedJob = await job.remove( function(err) { if (err) throw err; });
                    const { method } = removedJob.data.response;
                    this.callRegisteredCallback(method, removedJob);
                }
            });
        } catch (err) {
            throw err;
        }
    }

    /**
     * Registers a callback to be called when a job is removed from the queue.
     * @param  {string}   name      the name of the module that registered the callback.
     * @param  {Callback} callback  the callback method to be called
     * @return {void}
     */
    registerJobRemoveCallback(name, callback) {
        this.removeCallbacks[name] = callback;
    }

    /**
     * Unregisters a callback that was registered using registerJobRemoveCallback().
     * @param  {string} name The name of the module that registered the callback.
     * @return {void}
     */
    unregisterJobRemoveCallback(name) {
        delete this.removeCallbacks[name];
    }

    /**
     * Calls all registered callbacks
     * @param  {string} name  The name of the callback to be called.
     * @param  {Object} job   The job object that will be pass to the callbacks.
     * @return {void}
     */
    callRegisteredCallback(name, job) {
        if (this.removeCallbacks.hasOwnProperty(name)) {
            this.removeCallbacks[name](job);
        }
    }
}

var deviceq = null;
module.exports = function (prefix, redisConn) {
    if (deviceq) return deviceq;
    else {
        deviceq = new DeviceQueues(prefix, redisConn);
        return deviceq;
    }
};

