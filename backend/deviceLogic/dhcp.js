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
const { transformDHCP } = require('./jobParameters');
/**
 * Queues an add dhcp or delete dhcp job to a device.
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

  // {
  //   "entity":  "agent",
  //   "message": "add-dhcp-config",
  //   "params": {
  //       "interface": "0000:00:08.00",
  //       "range_start": "20.20.20.2",
  //       "range_end": "20.20.20.255",
  //       "dns": ["8.8.8.8", "8.8.8.4"],
  //       "mac_assign":[{"host":"flexiwan-host2", "mac":"08:00:27:d0:d2:04", "ipv4":"20.20.20.20"},
  //                     {"host":"flexiwan-host3", "mac":"08:00:27:d0:d2:05", "ipv4":"20.20.20.21"}]
  //    }
  // },

  if (majorAgentVersion === 0) { // version 0.X.X
    throw new Error('Command is not supported for the current agent version');
  } else if (majorAgentVersion >= 1) { // version 1.X.X+
    const tasks = [];
    const dhcpId = data._id;

    let message;
    let titlePrefix;
    let params;

    switch (data.action) {
      case 'add':
        message = 'add-dhcp-config';

        titlePrefix = 'Add';
        params = transformDHCP(data);
        break;
      case 'del':
        titlePrefix = 'Delete';
        message = 'remove-dhcp-config';
        params = {
          interface: data.interface
        };
        break;
      case 'modify':
        titlePrefix = 'Modify';
        message = 'modify-device';
        params = {
          modify_dhcp_config: {
            dhcp_configs: [transformDHCP(data)]
          }
        };
        break;
      default:
        return [];
    }

    tasks.push({ entity: 'agent', message, params });
    try {
      const job = await deviceQueues.addJob(machineId, userName, org,
        // Data
        { title: `${titlePrefix} DHCP in device ${device.hostname}`, tasks: tasks },
        // Response data
        {
          method: 'dhcp',
          data: {
            deviceId: device.id,
            dhcpId: dhcpId,
            ...(data.origDhcp) && { origDhcp: data.origDhcp },
            message
          }
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null);

      logger.info('Add DHCP job queued', { params: { job } });
      return { ids: [job.id], status: 'completed', message: '' };
    } catch (err) {
      logger.error('Add DHCP job failed', { params: { machineId, error: err.message } });
      return {};
    }
  }
};

/**
 * Called when add/remove dhcp job completed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  if (!res || !res.deviceId || !res.message || !res.dhcpId) {
    logger.warn('DHCP job complete got an invalid job result', {
      params: { result: res, jobId: jobId }
    });
    return;
  }
  try {
    if (res.message === 'remove-dhcp-config') {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        {
          $pull: {
            dhcp: {
              _id: mongoose.Types.ObjectId(res.dhcpId)
            }
          }
        }
      );
    } else {
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(res.deviceId) },
        { $set: { 'dhcp.$[elem].status': 'complete' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.dhcpId) }]
        }
      );
    }
  } catch (error) {
    logger.warn('Complete DHCP job, failed to update database', {
      params: { result: res, jobId: jobId }
    });
  }
};

/**
 * Rollback modify dhcp job
 * @param {String} deviceId - Id of the device the DHCP belongs to
 * @param {Object} origDhcp - Original DHCP
 */
const rollbackDhcpChanges = async (deviceId, origDhcp) => {
  const result = await devices.update(
    { _id: deviceId },
    { $set: { 'dhcp.$[elem]': origDhcp } },
    { arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(origDhcp._id) }] }
  );

  // console.log(JSON.stringify(result));
  if (result.nModified !== 1) throw new Error('Failed to restore DHCP');
};

/**
* Called if add/remove dhcp job failed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.info('DHCP job failed', { params: { result: res, jobId: jobId } });

  try {
    switch (res.message) {
      case 'add-dhcp-config':
        await devices.findOneAndUpdate(
          { _id: mongoose.Types.ObjectId(res.deviceId) },
          { $set: { 'dhcp.$[elem].status': 'add-failed' } },
          {
            arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.dhcpId) }]
          }
        );
        break;
      case 'remove-dhcp-config':
        await devices.findOneAndUpdate(
          { _id: mongoose.Types.ObjectId(res.deviceId) },
          { $set: { 'dhcp.$[elem].status': 'remove-failed' } },
          {
            arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.dhcpId) }]
          }
        );
        break;
      case 'modify-device':
        await rollbackDhcpChanges(res.deviceId, res.origDhcp);
        await devices.findOneAndUpdate(
          { _id: mongoose.Types.ObjectId(res.deviceId) },
          { $set: { 'dhcp.$[elem].status': 'modify-failed' } },
          {
            arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(res.dhcpId) }]
          }
        );
        break;
      default:
        throw new Error('DHCP job error: Unable to find message type');
    }
  } catch (error) {
    logger.warn('DHCP job error, failed to update database', {
      params: { result: res, jobId: jobId, message: error.message }
    });
  }
};

/**
 * Called when add dhcp/remove-dhcp job is removed only
 * for tasks that were deleted before completion/failure.
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  if (['inactive', 'delayed', 'active'].includes(job._state)) {
    logger.info('DHCP remove job, mark as deleted', {
      params: { jobId: job.id }
    });
    const deviceId = job.data.response.data.deviceId;
    const dhcpId = job.data.response.data.dhcpId;

    try {
      if (job.data.response.data.message === 'modify-device') {
        await rollbackDhcpChanges(deviceId, job.data.response.data.origDhcp);
      }
      await devices.findOneAndUpdate(
        { _id: mongoose.Types.ObjectId(deviceId) },
        { $set: { 'dhcp.$[elem].status': 'job-deleted' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(dhcpId) }]
        }
      );
    } catch (error) {
      logger.warn('Failed to remove DHCP job', {
        params: { jobId: job.id, message: error.message }
      });
    }
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error,
  remove: remove
};
