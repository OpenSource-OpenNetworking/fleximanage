// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
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

// Logic to start/stop a device
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const devUtils = require('./utils');
const async = require('async');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const dispatcher = require('../deviceLogic/dispatcher');
const { updateSyncStatus, updateSyncStatusBasedOnJobResult } =
  require('../deviceLogic/sync');
const connections = require('../websocket/Connections')();
const omit = require('lodash/omit');

/**
 * A callback that is called when a device connects to the MGMT
 * @async
 * @param  {string} deviceId Device UUID
 * @return {void}
 */
exports.deviceConnectionOpened = async (deviceId) => {
  logger.info('Broker: device connection opened', { params: { deviceID: deviceId } });
  try {
    await deviceQueues.startQueue(deviceId, deviceProcessor);
  } catch (err) {
    logger.error('Broker starting queue error', { params: { err: err.message } });
  }
};

/**
 * A callback that is called when a device disconnects from the MGMT
 * @async
 * @param  {string} deviceId Device UUID
 * @return {void}
 */
exports.deviceConnectionClosed = async (deviceId) => {
  logger.info('Broker: device connection closed', { params: { deviceID: deviceId } });
  try {
    await deviceQueues.pauseQueue(deviceId);
  } catch (err) {
    logger.error('Broker pausing queue error', { params: { err: err.message } });
  }
};

/**
 * A job processor for a device queue message
 * @async
 * @param  {Object}  job job to be processed
 * @return {Promise}     a promise for processing the job
 */
const deviceProcessor = async (job) => {
  // limit the print job tasks param size
  const logJob = omit(job, ['data.message.tasks']);
  logJob.data.message.tasks = job.data.message.tasks.map(
    t => JSON.stringify(t).substring(0, 2048)
  );

  // Job is passed twice - for event data and event header.
  logger.info('Processing job', { params: { job: logJob }, job: logJob });

  // Get tasks
  const tasks = job.data.message.tasks;
  const tasksLength = tasks.length;
  let curTask = 0;
  // Build operations from tasks
  const operations = [];
  const mId = job.data.metadata.target;
  const org = job.data.metadata.org;
  return new Promise((resolve, reject) => {
    operations.push((callback) => { callback(null, 'Start Job Tasks, job ID=' + job.id); });
    tasks.forEach((task) => {
      operations.push(devUtils.sendMsg(org, mId, task, job, ++curTask, tasksLength));
    });
    // Execute all tasks
    // 1. Loop on all job transaction messages
    // 2. Send to device over a web socket
    // 3. Update transaction job progress
    async.waterfall(operations, async (error, results) => {
      if (error) {
        logger.error('Job error', { params: { job: logJob, err: error.message }, job: logJob });
        // Call error callback only if the job reached maximal retries
        // We check if the remaining attempts are less than 1 instead of 0
        // since this code runs before the number of attempts is decreased.
        const { remaining } = job.toJSON().attempts;
        if (remaining <= 1) {
          dispatcher.error(job.id, job.data.response);
        }
        if (error.message === 'Error: Send Timeout') {
          // If the device paused, reject doesn't mark the job as failed
          // In that case we make sure to explicitly mark it this way
          // If reject executed correctly, it overrides this failure
          job.error(error.message);
          job.failed();
        }
        try {
          if (connections.isConnected(mId)) {
            const { deviceObj } = connections.getDeviceInfo(mId);
            // This call takes care of setting the legacy device sync status to not-synced.
            await updateSyncStatusBasedOnJobResult(org, deviceObj, mId, false);
          } else {
            logger.warn('Failed to update sync status, device not connected', {
              params: { machineId: mId }
            });
          }
        } catch (err) {
          logger.warn('Failed to update sync status', {
            params: { err: err.message, machineId: mId }
          });
        }
        reject(error.message);
      } else {
        logger.info('Job completed', {
          params: {
            job: logJob,
            results: results.message,
            deviceHash: results['router-cfg-hash'] || 'n/a'
          },
          job: logJob
        });
        // Dispatch the response for Job completion
        // In the past this was called from job complete event but there were some missing events
        // So moved the dispatcher to here
        dispatcher.complete(job.id, job.data.response);
        // Device configuration hash is included in every job
        // response. Use it to update the device's sync status
        try {
          const { deviceObj } = connections.getDeviceInfo(mId);
          await updateSyncStatus(org, deviceObj, mId, results['router-cfg-hash']);
        } catch (err) {
          logger.error('Device sync status update failed', {
            params: { err: err.message, machineId: mId }
          });
          return reject(err.message);
        }
        resolve();
      }
    });
  });
};
