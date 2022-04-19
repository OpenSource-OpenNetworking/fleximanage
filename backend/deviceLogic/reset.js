// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2020  flexiWAN Ltd.

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

const configs = require('../configs')();
const deviceStatus = require('../periodic/deviceStatus')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });

/**
 * Creates and queues the reset-device job.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (devices, user, data) => {
  const { username } = user;
  const { org } = data;
  const applyPromises = [];
  for (const device of devices) {
    const { machineId, hostname, _id } = device;
    logger.info('Resetting device:', { params: { machineId, user, data } });

    // Set the device state to "pending". Device state will
    // be updated again when the device sends periodic message
    deviceStatus.setDeviceState(machineId, 'pending');

    const tasks = [{ entity: 'agent', message: 'reset-device' }];

    applyPromises.push(deviceQueues.addJob(
      machineId,
      username,
      org,
      // Data
      { title: 'Reset device ' + hostname, tasks: tasks },
      // Response data
      {
        method: 'reset',
        data: {
          device: _id,
          org: org
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    ));
  };
  const promisesStatus = await Promise.allSettled(applyPromises);
  const { fulfilled, reasons } = promisesStatus.reduce(({ fulfilled, reasons }, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      logger.info('Reset device job queued', {
        params: {
          jobId: job.id,
          machineId: job.type
        }
      });
      fulfilled.push(job.id);
    } else {
      if (!reasons.includes(elem.reason.message)) {
        reasons.push(elem.reason.message);
      }
    };
    return { fulfilled, reasons };
  }, { fulfilled: [], reasons: [] });
  const status = fulfilled.length < devices.length
    ? 'partially completed' : 'completed';
  const message = fulfilled.length < devices.length
    ? `Warning: ${fulfilled.length} of ${devices.length} reset device jobs added.` +
      `Some devices have following errors: ${reasons.join('. ')}`
    : `Reset device job${devices.length > 1 ? 's' : ''} added successfully`;
  return { ids: fulfilled, status, message };
};

/**
 * Called when reset device job completed
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = (jobId, res) => {
  logger.info('Reset device job complete', {
    params: { result: res, jobId: jobId }
  });
};

/**
 * Called when reset device job failed
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const error = (jobId, res) => {
  logger.error('Reset device job failed', {
    params: { result: res, jobId: jobId }
  });
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error
};
