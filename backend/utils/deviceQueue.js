// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { passFilters } = require('../utils/filterUtils');
const CHUNK_SIZE = 1000; // Chunk of jobs handled at once
class JobError extends Error {
  constructor (...args) {
    const [message, job] = args;
    super(message);
    this.job = job;
  }
}

class DeviceQueues {
  /**
     * Creates a DeviceQueues. Multiple DeviceQueues per system
     * are allowed. The broker creates a queue per connected device.
     * @param  {string} prefix    prefix used for the queue
     * @param  {object} redis     redis connection object,
     *                            if not provided use default redis host/port
     */
  constructor (prefix, redis) {
    // Bind class functions
    this.startQueue = this.startQueue.bind(this);
    this.shutdown = this.shutdown.bind(this);
    this.addJob = this.addJob.bind(this);
    this.pauseQueue = this.pauseQueue.bind(this);
    this.resumeQueue = this.resumeQueue.bind(this);
    this.restartQueue = this.restartQueue.bind(this);
    this.removeJobs = this.removeJobs.bind(this);
    this.removeJobIdsByOrg = this.removeJobIdsByOrg.bind(this);
    this.getLastJob = this.getLastJob.bind(this);
    this.getOPendingJobsCount = this.getOPendingJobsCount.bind(this);
    this.registerJobRemoveCallback = this.registerJobRemoveCallback.bind(this);
    this.unregisterJobRemoveCallback = this.unregisterJobRemoveCallback.bind(this);
    this.callRemoveRegisteredCallback = this.callRemoveRegisteredCallback.bind(this);
    this.registerJobErrorCallback = this.registerJobErrorCallback.bind(this);
    this.unregisterJobErrorCallback = this.unregisterJobErrorCallback.bind(this);
    this.callErrorRegisteredCallback = this.callErrorRegisteredCallback.bind(this);
    this.failedJobs = this.failedJobs.bind(this);
    this.resetWaitPause = this.resetWaitPause.bind(this);

    this.updateSyncState = async (deviceId, job) => {};
    this.removeCallbacks = {};
    this.errorCallbacks = {};

    // TBD: make it more safe
    const args = redis.split('://')[1].split(':');
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
            if (options.total_retry_time > configs.get('redisTotalRetryTime', 'number')) {
              // End reconnecting after a specific timeout and flush all commands
              // with a individual error
              return new Error('Retry time exhausted');
            }
            if (options.attempt > configs.get('redisTotalAttempts', 'number')) {
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
    if (typeof options === 'object') {
      Object.assign(this.redisOptions.redis.options, options);
    }

    // Kue init on the first time a class called for a system
    this.queue = kue.createQueue({ prefix, redis });
    this.queue.watchStuckJobs(10000);
    this.queue.on('error', (err) => {
      logger.error('DeviceQueues error', { params: { redisConn: redis, err: err } });
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
  async startQueue (deviceId, processor) {
    if (this.deviceQueues[deviceId]?.context) {
      // Queue for that device already exist, resume queue
      this.resumeQueue(deviceId);
      return;
    }

    // Initialize queue info
    const queueInfo = {
      context: undefined,
      paused: false,
      concurrency: 1
    };

    // Increase event listeners limit - https://github.com/Automattic/kue/issues/1189
    this.queue.setMaxListeners(this.queue.getMaxListeners() + queueInfo.concurrency);

    this.queue.process(deviceId, queueInfo.concurrency, async (job, ctx, done) => {
      queueInfo.context = ctx;
      // Init message is sent only to update the context
      if (job.data.metadata.init) {
        done(null, true);
        return;
      }
      try {
        // Call to process current job, using the processor callback function
        const resolved = await processor(job);
        // not resolved means that the websocket message was not sent
        // the job is set as inactive and will be processed on the next connection
        if (!resolved) return;
      } catch (err) {
        logger.debug('Failed to process job', {
          params: { job: job, deviceId: deviceId, err: err.message },
          job: job
        });
        if (!job.data.ignoreFailure) {
          return done(err, false);
        }
      }
      // the pending job is completed, the waiting pause queue should be paused immediately
      if (this.deviceQueues[deviceId].waitPause) {
        this.deviceQueues[deviceId].context.pause(0, (err) => {
          if (err) {
            logger.error('Queue pausing error',
              { params: { err, deviceId }, queue: this.deviceQueues[deviceId] });
            return;
          };
          logger.debug('Queue paused, succeeded',
            { params: { deviceId }, queue: this.deviceQueues[deviceId] });
          this.deviceQueues[deviceId].paused = true;
          this.deviceQueues[deviceId].waitPause = false;
        });
      }
      done(null, job.data.response);
    });

    // Update data and send first message
    this.deviceQueues[deviceId] = queueInfo;
    // Send first message to get hold on the context
    try {
      await this.addJob(deviceId, null, null, {}, true,
        { priority: 'critical', attempts: 1, init: true, removeOnComplete: true });
    } catch (err) {
      logger.warn('Failed to start device queue',
        { params: { deviceId: deviceId, err: err.message } });
    }
  }

  /**
     * Gracefully shutdown the queue.
     * @return {void}
     */
  shutdown () {
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
     * @param {string}  options.priority         Job priority (low, normal, medium, high, critical)
     * @param {number}  options.attempts         Number of attempts in case of errors
     * @param {boolean} options.init             Whether this is a special init message
     * @param {boolean} options.removeOnComplete Should job be removed on completion
     * @param {Callback} OnComplete              Function (jobid, result) executed on job complete
     *                                           (Careful!!! seen some missing events)
     * @return {Promise}                         Promise of new job
     */
  addJob (deviceId, username, org, message, response = true,
    {
      priority = 'normal',
      attempts = 1,
      init = false,
      removeOnComplete = true
    } = {},
    onComplete = null) {
    // Return promise
    return new Promise((resolve, reject) => {
      const metadata = {
        target: deviceId,
        username: (username) || 'unknown',
        org: (org) || 'unknown',
        init: init,
        jobUpdated: false
      };

      const job = this.queue
        .create(deviceId, { message, response, metadata })
        .ttl(configs.get('jobTimeout', 'number') + 60000);

      if (priority) job.priority(priority);
      if (attempts) job.attempts(attempts);
      if (removeOnComplete) job.removeOnComplete(removeOnComplete);
      // If onComplete callback defined, set it
      if (onComplete) job.on('complete', (res) => { onComplete(job.id, res); });

      // For init message, wait for completion
      if (init) {
        job
          .on('complete', (res) => {
            return resolve(res);
          })
          .on('failed', (failErr) => {
            return reject(new Error(failErr));
          });
      }
      job.save(async (err) => {
        if (err) return reject(new JobError(err, job));
        else if (!init) {
          // If autoSync is on, queueing a job should
          // change the devices sync state to "syncing"
          try {
            await this.updateSyncState(deviceId, message);
          } catch (e) {
            return reject(new JobError(e, job));
          }
          return resolve(job);
        }
      });
    });
  }

  /**
   * Resets the waitPause flag for a given device ID
   * should be done before starting the queue, as soon as device is connected.
   * @param  {string} deviceId UUID of the device
   */
  resetWaitPause (deviceId) {
    if (this.deviceQueues[deviceId]?.waitPause) {
      this.deviceQueues[deviceId].waitPause = false;
    }
  }

  /**
     * Pause a queue for a given device ID, called from the queue consumer.
     * @param  {string} deviceId UUID of the device
     * @return {void}
     */
  pauseQueue (deviceId) {
    logger.debug('Pausing queue request',
      { params: { deviceId: deviceId, queue: this.deviceQueues[deviceId] } });
    return new Promise((resolve, reject) => {
      if (!this.deviceQueues[deviceId]) {
        return reject(
          new Error('DeviceQueues: Trying to pause an undefined queue, deviceID=' + deviceId)
        );
      }
      if (this.deviceQueues[deviceId].paused) {
        logger.debug('Queue already paused, succeeded',
          { params: { deviceId: deviceId, queue: this.deviceQueues[deviceId] } });
        return resolve(); // Already paused
      }
      if (!this.deviceQueues[deviceId].context) {
        return reject(
          new Error('DeviceQueues: Pausing a queue with no context, deviceID=' + deviceId)
        );
      }
      // in case the device is reconnected and active job exists in the queue
      // the pause/resume process clears the current job in the kue worker's memory
      // which causes not assigning the 'complete' status and 'TTL exceeded' failure
      // hence there should be a delay to prevent unnecessary pause/resume process
      // also the waiting pause timeout should be always less than the job timeout
      // to prevent processing the next job if the current one is failed
      const waitPauseTimeout = configs.get('jobTimeout', 'number') / 2;
      const pause = () => {
        if (this.deviceQueues[deviceId].waitPause) {
          this.deviceQueues[deviceId].context.pause(0, (err) => {
            if (err) {
              return reject(err);
            };
            logger.debug('Queue paused, succeeded',
              { params: { deviceId: deviceId }, queue: this.deviceQueues[deviceId] });
          });
          this.deviceQueues[deviceId].paused = true;
          this.deviceQueues[deviceId].waitPause = false;
        }
        return resolve();
      };
      this.deviceQueues[deviceId].waitPause = false;
      this.getCount('active', deviceId).then((count) => {
        this.deviceQueues[deviceId].waitPause = true;
        if (count > 0) {
          logger.debug('Active jobs exist, queue pause is delayed',
            { params: { deviceId, count }, count, queue: this.deviceQueues[deviceId] });
          setTimeout(pause, waitPauseTimeout);
        } else {
          pause();
        };
      });
    });
  }

  /**
     * Resumes a queue for a given device ID, called from the queue consumer
     * @param  {string} deviceId UUID of the device
     * @return {void}
     */
  resumeQueue (deviceId) {
    logger.debug('Resuming device queue',
      { params: { deviceId: deviceId }, queue: this.deviceQueues[deviceId] });
    if (!this.deviceQueues[deviceId]) {
      throw new Error('DeviceQueues: Trying to resume an undefined queue, deviceID=' + deviceId);
    }
    this.deviceQueues[deviceId].waitPause = false;
    if (!this.deviceQueues[deviceId].context) {
      throw new Error('DeviceQueues: Resuming a queue with no context, deviceID=' + deviceId);
    }
    this.deviceQueues[deviceId].context.resume();
    this.deviceQueues[deviceId].paused = false;
  }

  /**
    * Restarts a queue for a given device ID
    * @param  {string} deviceId UUID of the device
    * @return {void}
    */
  restartQueue (deviceId) {
    if (!this.deviceQueues[deviceId]?.context) {
      logger.error('Restarting a queue with no context', { params: { deviceId } });
      return;
    }
    this.deviceQueues[deviceId].context.pause(0, (err) => {
      if (err) {
        logger.error('Restarting queue error', { params: { deviceId, err } });
        return;
      };
      this.deviceQueues[deviceId].context.resume();
      logger.debug('Queue restarted',
        { params: { deviceId: deviceId }, queue: this.deviceQueues[deviceId] });
    });
  }

  /**
     * Set Immediate Promise to let other functions to operate during heavy tasks
     * @param  None
     * @return Promise
     */
  setImmediatePromise () {
    return new Promise((resolve) => {
      setImmediate(() => resolve());
    });
  }

  /**
     * Iterates over jobs of specific state
     * @param  {string}   state    queue state ('all', 'complete', 'failed',
     *                             'inactive', 'delayed', 'active')
     * @param  {Callback} callback callback to be called per job
     * @param  {string}   deviceId the deviceId (UUID) to filter by
     * @param  {integer}  from     index to start looking from (could be negative)
     * @param  {integer}  to       index to end looking from (could be negative)
     * @param  {string}   dir      order to return data 'asc' or 'desc'
     * @param  {integer}  limit    limit the number of processed jobs, -1 for no limit
     *                             the callback should return 'true' for processed job
     * @param  {boolean}  isDelete job will be deleted in the callback
     * @return {void}
     */
  iterateJobs (state, callback, deviceId = null, from = 0, to = -1, dir = 'asc', limit = -1,
    isDelete = false) {
    return new Promise((resolve, reject) => {
      let done = 0;

      // Define single batch Iteration
      const singleBatchIteration = (batchFrom, batchTo) => {
        return new Promise((resolve, reject) => {
          const handleFunc = (err, jobs) => {
            if (err) {
              return reject(
                new Error('DeviceQueues: Iteration error, state=' + state + ', err=' + err)
              );
            }
            for (const job of jobs) {
              if (limit > 0 && done >= limit) break;
              if (callback(job)) done += 1;
            };
            resolve();
          };
          // if jobs are removed after single batch iteration
          // we need to start a new iteration shifted by the number of deleted jobs
          let getJobsFrom = batchFrom;
          let getJobsTo = batchTo;
          if (isDelete) {
            getJobsTo = getJobsTo - done;
            getJobsFrom = getJobsFrom - done;
          }
          if (state === 'all') {
            kue.Job.range(getJobsFrom, getJobsTo, dir, handleFunc);
          } else if (deviceId) {
            kue.Job.rangeByType(deviceId, state, getJobsFrom, getJobsTo, dir, handleFunc);
          } else {
            kue.Job.rangeByState(state, getJobsFrom, getJobsTo, dir, handleFunc);
          }
        });
      };

      this.getCount(state, deviceId)
        .then(async (count) => {
          if (from < 0) from = (count > -from) ? (count + from) : 0;
          if (to < 0) to = (count > -to) ? (count + to) : 0;
          let loopFrom = from;
          let loopDelta = CHUNK_SIZE;
          if (dir === 'desc') {
            loopFrom = to - CHUNK_SIZE + 1;
            loopDelta = -CHUNK_SIZE;
          }
          for (
            let chunkFrom = loopFrom;
            (chunkFrom + CHUNK_SIZE >= from && chunkFrom <= to);
            chunkFrom += loopDelta
          ) {
            if (limit > 0 && done >= limit) break;
            await singleBatchIteration(
              Math.max(chunkFrom, from),
              Math.min(chunkFrom + CHUNK_SIZE - 1, to)
            );
            await this.setImmediatePromise();
          };
          resolve();
        })
        .catch((err) => {
          return reject(
            new Error('DeviceQueues: Get count error, state=' + state + ', err=' + err)
          );
        });
    });
  }

  /**
     * Iterates over jobs of specific state and organization
     * The current implementation get all jobs and filter the org specific ones
     * This implementation doesn't scale for a large system
     * @param  {string}   org      organization to iterate jobs for
     * @param  {string}   state    queue state ('all', 'complete', 'failed',
     *                             'inactive', 'delayed', 'active')
     * @param  {Callback} callback callback to be called per job
     *                             the callback should return 'true' for processed job
     * @param  {integer}  from     index to start looking from (could be negative)
     * @param  {integer}  to       index to end looking from (could be negative)
     * @param  {string}   dir      order to return data 'asc' or 'desc'
     * @param  {integer}  skip     org jobs to skip before starting to iterate
     * @param  {integer}  limit    limit the number of processed jobs, -1 for no limit
     * @param  {array}    filters  an array of filters objects [{ key, op, val}]
     *                             example [{key:'state',op:'!=',val:'failed'}, ...]
     * @param  {boolean}  isDelete jobs will be deleted in the callback
     * @param  {object}   devicesByMachineId an object of devices by machineId
     * @return {void}
     */
  iterateJobsByOrg (org, state, callback, from = 0, to = -1, dir = 'asc',
    skip = 0, limit = -1, filters, isDelete = false, devicesByMachineId = { }) {
    return new Promise((resolve, reject) => {
      let skipped = 0;
      let deviceId = null;
      if (Array.isArray(filters)) {
        // 'and' condition is applied to all filters
        // if there are more than 1 eq filters with the same key/value
        // then no need to iterate jobs, the result will be empty
        const eqFilters = filters.filter(f => f.op === '==').reduce((r, f) => {
          if (!r[f.key]) r[f.key] = {};
          r[f.key][f.val.toString()] = true;
          return r;
        }, {});
        if (Object.values(eqFilters).some(f => Object.keys(f).length > 1)) {
          resolve();
          return;
        }
        // if there is only one state or device in filters array
        // then special iterate functions will be called
        const stateFilters = filters.filter(f => f.op === '==' && f.key === 'state');
        const deviceFilters = filters.filter(f => f.op === '==' && f.key === 'type');
        if (stateFilters.length === 1) state = stateFilters[0].val;
        if (deviceFilters.length === 1) deviceId = deviceFilters[0].val;
      }

      const orgCallback = (orgJob) => {
        // need to prepare the job the same way it is returned in the service
        const jobObj = { ...orgJob, _id: orgJob.id, state: orgJob._state };
        if (devicesByMachineId[orgJob.type] !== undefined) {
          jobObj.device = devicesByMachineId[orgJob.type];
        }
        if (orgJob.data.metadata.org === org && (!filters || passFilters(jobObj, filters))) {
          if (skipped < skip) skipped += 1;
          else {
            if (callback(orgJob)) return true; // job done
          }
        }
        return false;
      };

      this.iterateJobs(state, orgCallback, deviceId, from, to, dir, limit, isDelete)
        .then(() => {
          return resolve();
        })
        .catch((err) => {
          return reject(err);
        });
    });
  }

  /**
   * Get one job by ID
   * @param  {integer}    id Job ID
   * @param  {Callback}   callback callback to be called per job
   */
  getOneJob (id, callback) {
    return new Promise((resolve, reject) => {
      kue.Job.get(id, (err, job) => {
        if (err) return reject(err);
        const result = callback(job);
        if (result.error) reject(new Error(result.message));
        resolve(job);
      });
    });
  }

  /**
     * Iterates over jobs IDs of specific state and organization
     * @param  {string}     org      organization to iterate jobs for
     * @param  {Array(Int)} jobIds   List of Job IDs to iterate
     * @param  {Callback}   callback callback to be called per job
     * @return {void}
     */
  async iterateJobsIdsByOrg (org, jobIDs, callback) {
    const promises = [];
    jobIDs.forEach(async (id) => {
      promises.push(this.getOneJob(id, (job) => {
        if (!job) {
          return { error: true, message: `Job ${id} not found` };
        }
        if (!(job.data.metadata.org === org)) {
          return { error: true, message: 'Job not found in org' };
        }
        callback(job);
        return { error: false, message: '' };
      }));
    });
    const results = await Promise.all(promises);
    return results;
  }

  /**
     * Removes all jobs in the jobIDs array according
     * to an organizations id.
     * @param  {string} org    organization id
     * @param  {Array}  jobIDs an array of ids of the jobs to be removed
     */
  async removeJobIdsByOrg (org, jobIDs) {
    try {
      await this.iterateJobsIdsByOrg(org, jobIDs, async (job) => {
        const removedJob = await job.remove(function (err) { if (err) throw err; });
        const { method } = removedJob.data.response;
        this.callRemoveRegisteredCallback(method, removedJob);
      });
    } catch (err) {
      logger.warn('Encountered an error while removing jobs', {
        params: { org: org, jobIDs: jobIDs, err: err.message }
      });
      throw err;
    }
  }

  /**
   * Removes all jobs matching the filters array according
   * to an organizations id.
   * @param  {string} org     organization id
   * @param  {Array}  filters an array of filters matching the jobs to be removed
   * @param  {Object} devicesByMachineId an object of devices by machineId
   */
  async removeJobsByOrgAndFilters (org, filters, devicesByMachineId) {
    try {
      const isDelete = true;
      await this.iterateJobsByOrg(org, 'all', async (job) => {
        const removedJob = await job.remove(err => { if (err) throw err; });
        const { method } = removedJob.data.response;
        this.callRemoveRegisteredCallback(method, removedJob);
        return true;
      }, 0, -1, 'asc', 0, -1, filters, isDelete, devicesByMachineId);
    } catch (err) {
      logger.warn('Encountered an error while removing jobs', {
        params: { org: org, filters: filters, err: err.message }
      });
      throw err;
    }
  }

  /**
   * Gets the number of pending (waiting/running) jobs
   * for the device specified by "deviceId"
   * @param  {string} deviceId device UUID
   * @return {Promise}         a list of job ids of pending jobs
   */
  async getOPendingJobsCount (deviceId) {
    let activeCount = 0;
    let inactiveCount = 0;
    await this.iterateJobs('active', () => activeCount++, deviceId);
    await this.iterateJobs('inactive', () => inactiveCount++, deviceId);
    // this function is called when updating the sync status of connected devices
    // no active job with existing inactive jobs means the queue stuck
    if (activeCount === 0 && inactiveCount > 0) {
      logger.info('Restart the queue after stuck', {
        params: { deviceId, inactiveCount }
      });
      this.restartQueue(deviceId);
    }
    return activeCount + inactiveCount;
  }

  /**
   * Gets the last job in the queue of
   * the device specified by "deviceId"
   * @param  {string} deviceId device UUID
   * @param  {string} state - state to query last job for. No value looks for all states
   * @return {Promise}         last queued job
   */
  async getLastJob (deviceId, state) {
    const allJobs = [];
    const states = (state) ? [state] : ['complete', 'failed', 'inactive', 'delayed', 'active'];
    for (const _state of states) {
      // Iterate last job per state and push to allJobs
      await this.iterateJobs(_state, (job) => {
        allJobs.push(job);
      }, deviceId, -1, -1, 'asc');
    }

    // Find the job with the highest ID
    return allJobs.reduce((res, job) => !res.id || job.id > res.id ? job : res, {});
  }

  /**
     * Gets the number of jobs for current state
     * @param  {string} state    queue state ('all', 'complete', 'failed',
     *                           'inactive', 'delayed', 'active')
     * @param  {string} deviceId device machine id (optional)
     * @return {number}       Number of jobs
     */
  async getCount (state, deviceId = null) {
    return new Promise((resolve, reject) => {
      const handleFunc = (err, total) => {
        if (err) {
          return reject(new Error('DeviceQueues: getCount error, state=' + state + ', err=' + err));
        } else return resolve(total);
      };
      if (state === 'all') {
        this.queue.client.zcard(this.queue.client.getKey('jobs'), handleFunc);
      } else if (!deviceId) {
        this.queue[state + 'Count'](handleFunc);
      } else {
        this.queue[state + 'Count'](deviceId, handleFunc);
      }
    });
  }

  /**
     * Removes jobs created before the specified time for a given state
     * @param  {string} state         queue state to remove jobs from
     *                                ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @param  {number} createdBefore time in milliseconds
     * @return {void}
     */
  async removeJobs (state, createdBefore = 3600000) {
    try {
      const now = new Date().getTime();
      await this.iterateJobs(state, async (job) => {
        if (now - job.created_at > createdBefore) {
          const removedJob = await job.remove(function (err) { if (err) throw err; });
          const { method } = removedJob.data.response;
          this.callRemoveRegisteredCallback(method, removedJob);
        }
      });
    } catch (err) {
      logger.warn('Encountered an error while removing old jobs', {
        params: { state: state, createdBefore: createdBefore, err: err.message }
      });
      throw err;
    }
  }

  /**
     * Set jobs created before the specified time for a given state to failed
     * @param  {string} state         queue state to remove jobs from
     *                                ('complete', 'failed', 'inactive', 'delayed', 'active')
     * @param  {number} createdBefore time in milliseconds
     * @return {void}
     */
  async failedJobs (state, createdBefore = 3600000) {
    try {
      const now = new Date().getTime();
      await this.iterateJobs(state, async (job) => {
        if (now - job.created_at > createdBefore) {
          const failedJob = await job.failed(function (err) { if (err) throw err; });
          await job.error('Error: Dangle Waiting');
          const { method } = failedJob.data.response;
          this.callErrorRegisteredCallback(method, failedJob);
        }
      });
    } catch (err) {
      logger.warn('Encountered an error while setting failure for old jobs', {
        params: { state: state, createdBefore: createdBefore, err: err.message }
      });
      throw err;
    }
  }

  /**
   * Returns the job object according to the job id.
   * @param  {string}  jobId  Id of the job to be retrieved
   */
  getJobById (jobId, strict = false) {
    return new Promise((resolve, reject) => {
      kue.Job.get(jobId, async (err, job) => {
        if (err) resolve(null);
        return resolve(job);
      });
    });
  }

  /**
     * Registers a callback to be called when a job is removed from the queue.
     * @param  {string}   name      the name of the module that registered the callback.
     * @param  {Callback} callback  the callback method to be called
     * @return {void}
     */
  registerJobRemoveCallback (name, callback) {
    this.removeCallbacks[name] = callback;
  }

  /**
     * Unregisters a callback that was registered using registerJobRemoveCallback().
     * @param  {string} name The name of the module that registered the callback.
     * @return {void}
     */
  unregisterJobRemoveCallback (name) {
    delete this.removeCallbacks[name];
  }

  /**
     * Calls remove registered callbacks
     * @param  {string} name  The name of the callback to be called.
     * @param  {Object} job   The job object that will be pass to the callbacks.
     * @return {void}
     */
  callRemoveRegisteredCallback (name, job) {
    if (this.removeCallbacks.hasOwnProperty(name)) {
      return this.removeCallbacks[name](job);
    }
  }

  /**
     * Registers a callback to be called when a job has an error.
     * @param  {string}   name      the name of the module that registered the callback.
     * @param  {Callback} callback  the callback method to be called
     * @return {void}
     */
  registerJobErrorCallback (name, callback) {
    this.errorCallbacks[name] = callback;
  }

  /**
       * Unregister a callback that was registered using registerJobErrorCallback().
       * @param  {string} name The name of the module that registered the callback.
       * @return {void}
       */
  unregisterJobErrorCallback (name) {
    delete this.errorCallbacks[name];
  }

  /**
       * Calls error registered callbacks
       * @param  {string} name  The name of the callback to be called.
       * @param  {Object} job   The job object that will be pass to the callbacks.
       * @return {void}
       */
  callErrorRegisteredCallback (name, job) {
    if (this.errorCallbacks.hasOwnProperty(name)) {
      return this.errorCallbacks[name](job.id, job.data.response);
    }
  }

  /**
   * Registers a method to be called as part of
   * addJob() and update the device sync status
   * @param  {Function} method  the callback method to be called
   * @return {void}
   */
  registerUpdateSyncMethod (method) {
    this.updateSyncState = method;
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
