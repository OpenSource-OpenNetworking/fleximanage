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
const { devices } = require('../models/devices');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const mongoose = require('mongoose');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { getMajorVersion } = require('../versioning');

/**
 * Queues an add-route or delete-route job to a device.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (device, user, data) => {
  const userName = user.username;
  const org = data.org;
  const machineId = device.machineId;
  const majorAgentVersion = getMajorVersion(device.versions.agent);

  if (majorAgentVersion === 0) { // version 0.X.X
    throw new Error('Command is not supported for the current agent version');
  } else if (majorAgentVersion >= 1) { // version 1.X.X+
    const tasks = [];
    const routeId = data._id;

    let message = 'add-route';
    let titlePrefix = 'Add';

    const params = {
      addr: data.destination,
      via: data.gateway,
      redistributeViaOSPF: data.redistributeViaOSPF
    };

    if (data.ifname) {
      params.devId = data.ifname;
    }

    if (data.metric) {
      params.metric = data.metric;
    }

    if (data.action === 'del') {
      titlePrefix = 'Delete';
      message = 'remove-route';
    }

    tasks.push({ entity: 'agent', message, params });

    try {
      const job = await deviceQueues.addJob(machineId, userName, org,
        // Data
        { title: `${titlePrefix} Static Route in device ${device.hostname}`, tasks: tasks },
        // Response data
        { method: 'staticroutes', data: { deviceId: device.id, routeId: routeId, message } },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null);
      logger.info('Add static route job queued', { params: { job } });
      return { ids: [job.id], status: 'completed', message: '' };
    } catch (err) {
      logger.error('Add static route job failed', { params: { machineId, error: err.message } });
      throw (new Error(err.message || 'Internal server error'));
    }
  }
};

/**
 * Called when add/remove route job completed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  if (!res || !res.deviceId || !res.message || !res.routeId) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
    return;
  }
  try {
    if (res.message === 'remove-route') {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        {
          $pull: {
            staticroutes: {
              _id: mongoose.Types.ObjectId(res.routeId)
            }
          }
        }
      );
    } else {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        { $set: { 'staticroutes.$[elem].status': 'complete' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.routeId) }]
        }
      );
    }
  } catch (error) {
    logger.warn('Failed to update database', { params: { result: res, jobId: jobId } });
  }
};

/**
* Called if add/remove route job failed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.info('Static route job failed', { params: { result: res, jobId: jobId } });

  try {
    if (res.message === 'remove-route') {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        { $set: { 'staticroutes.$[elem].status': 'remove-failed' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.routeId) }]
        }
      );
    } else {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        { $set: { 'staticroutes.$[elem].status': 'add-failed' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.routeId) }]
        }
      );
    }
  } catch (error) {
    logger.warn('Failed to update database', { params: { result: res, jobId: jobId } });
  }
};

/**
 * Called when add-route/remove-route job is removed only
 * for tasks that were deleted before completion/failure.
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  if (['inactive', 'delayed', 'active'].includes(job._state)) {
    logger.info('Rolling back device changes for removed task', { params: { jobId: job.id } });
    const deviceId = job.data.response.data.deviceId;
    const routeId = job.data.response.data.routeId;

    try {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(deviceId) },
        { $set: { 'staticroutes.$[elem].status': 'job-deleted' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(routeId) }]
        }
      );
    } catch (error) {
      logger.warn('Failed to update database', { params: { jobId: job.id } });
    }
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error,
  remove: remove
};
