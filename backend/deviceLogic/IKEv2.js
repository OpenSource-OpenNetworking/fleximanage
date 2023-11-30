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

const mongoose = require('mongoose');
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { getMajorVersion } = require('../versioning');

/**
 * Returns a timestamp to compare with expiration time of IKEv2 certificates
 * which are about to expire and decide if need to regenerate it
 */
const getRenewBeforeExpireTime = () => {
  const renewBeforeExpireTime = new Date();
  renewBeforeExpireTime.setDate(renewBeforeExpireTime.getDate() +
    configs.get('ikev2RenewBeforeExpireDays', 'number'));
  return renewBeforeExpireTime.getTime();
};

/**
 * Checks if the device is valid for creating IKEv2 tunnels
 * @param {Object} device - the device to validate
 * @return {{valid: boolean, reason: string}}
 */
const validateIKEv2 = (device) => {
  const majorAgentVersion = getMajorVersion(device.versions.agent);
  if (majorAgentVersion < 4) {
    return {
      valid: false,
      reason: 'IKEv2 key exchange method not supported'
    };
  };
  if (!device.IKEv2 || !device.IKEv2.certificate || !device.IKEv2.expireTime) {
    return {
      valid: false,
      reason: 'No valid IKEv2 certificate'
    };
  };
  const now = Date.now();
  if (device.IKEv2.expireTime.getTime() < now) {
    return {
      valid: false,
      reason: 'IKEv2 certificate is expired'
    };
  };
  return {
    valid: true,
    reason: ''
  };
};

/**
 * Queues IKEv2 jobs to a list of devices.
 * @param  {Array}   devices       array of devices to which a job should be queued
 * @param  {string}  user          user name of the user the queued the job
 * @param  {string}  org           id of the organization to which the user belongs
 * @return {Promise}               a promise for queuing a job
 */
const queueCreateIKEv2Jobs = (devices, user, org) => {
  const days = configs.get('ikev2ExpireDays', 'number');
  const tasks = [{
    entity: 'agent',
    message: 'get-device-certificate',
    params: { days, type: 'ikev2', new: true }
  }];
  const jobs = [];
  devices.forEach(dev => {
    jobs.push(
      deviceQueues.addJob(dev.machineId, user, org,
        // Data
        { title: `Create IKEv2 certificate on the device ${dev.hostname}`, tasks },
        // Response data
        {
          method: 'ikev2',
          data: {
            deviceId: dev._id,
            machineId: dev.machineId,
            org,
            action: 'get-device-certificate'
          }
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null)
    );
  });
  // Set the create IKEv2 job pending flag for all devices.
  // This prevents queuing additional IKEv2 tasks on the devices.
  setIKEv2QueuedFlag(devices.map(dev => dev._id), true);

  return Promise.all(jobs);
};

/**
 * Sets the value of the pending IKEv2 jobs flag in the database.
 * The pending flag indicates if a pending IKEv2 job
 * already exists in the device's queue.
 * @param  {string}  deviceIDs the list of ids of the devices
 * @param  {boolean} flag      the value to be set in the database
 * @return {Promise}
 */
const setIKEv2QueuedFlag = async (deviceIDs, flag) => {
  const $set = { 'IKEv2.jobQueued': flag };
  if (flag) {
    // clear the certificate when a new generate certificate job is queued
    $set['IKEv2.certificate'] = '';
  };
  const result = await devices.updateMany(
    { _id: { $in: deviceIDs } },
    { $set: $set },
    { upsert: false }
  );
  logger.debug('IKEv2 jobQueued flag set', { params: { deviceIDs, flag, result } });
};

/**
 * Applies the create IKEv2 request on all requested devices
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (devicesIn, user, data) => {
  // If the apply method was called for multiple devices, extract
  // only the devices that appear in the body. If it was called for
  // a single device, simply used the first device in the devices array.
  const deviceIds = data.devices ? Object.keys(data.devices) : devicesIn.map(d => d._id);

  // Filter out devices (ver.4+) that already have
  // a pending IKEv2 job in the queue.
  const opDevices = await devices.find({
    $and: [
      { _id: { $in: deviceIds } },
      { 'IKEv2.jobQueued': { $ne: true } },
      { 'versions.device': { $regex: /[4-9]\d?\.\d+\.\d+/ } }
    ]
  },
  '_id machineId hostname'
  );

  const userName = user.username;
  const org = data.org;
  const jobResults = await queueCreateIKEv2Jobs(opDevices, userName, org);
  jobResults.forEach(job => {
    logger.info('Create IKEv2 certificate device job queued', {
      params: { job: job }
    });
  });

  return { ids: jobResults.map(job => job.id), status: 'completed', message: '' };
};

/**
 * Called when IKEv2 device job completes
 * to update IKEv2 data in DB, rebuild tunnels if needed
 * and unset the pending IKEv2 job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {string} res   device object ID and username
 * @return {void}
 */
const complete = async (jobId, res) => {
  if (res.action === 'update-public-certificate') {
    // send job to initiator to confirm that remote cert was applied on responder
    if (Array.isArray(res.reinitiateTunnels) && res.reinitiateTunnels.length) {
      const tasks = res.reinitiateTunnels.map(tunnelnum => {
        return {
          entity: 'agent',
          message: 'modify-tunnel',
          params: {
            'tunnel-id': tunnelnum,
            ikev2: { 'remote-cert-applied': true }
          }
        };
      });
      deviceQueues.addJob(res.machineId, 'system', res.org,
        // Data
        { title: `IKEv2 certificate applied on device ${res.hostname}`, tasks },
        // Response data
        {
          method: 'ikev2',
          data: {
            deviceId: res.deviceId,
            org: res.org,
            action: 'remote-certificate-applied'
          }
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      );
    }
  } else if (res.action === 'get-device-certificate') {
    let certificate = res.agentMessage.certificate;
    certificate = Array.isArray(certificate) ? certificate.join('') : certificate;
    const expireTime = certificate && res.agentMessage.expiration
      ? (new Date(res.agentMessage.expiration)).getTime() : null;

    if (certificate && expireTime && !isNaN(expireTime)) {
      // update the device IKEv2 data
      await devices.updateOne(
        { _id: res.deviceId },
        {
          $set: {
            'IKEv2.certificate': certificate,
            'IKEv2.expireTime': expireTime
          }
        },
        { upsert: false }
      );
      // update public certificate on the devices having IKEv2 tunnel with this one
      const localDevID = mongoose.Types.ObjectId(res.deviceId);
      const remoteDevices = await tunnelsModel
        .aggregate([
          {
            $match: {
              peer: null,
              isActive: true,
              encryptionMethod: 'ikev2',
              $or: [{ deviceA: localDevID }, { deviceB: localDevID }]
            }
          },
          {
            $project: {
              num: 1,
              role: { $cond: [{ $eq: ['$deviceA', localDevID] }, 'responder', 'initiator'] },
              dev_id: { $cond: [{ $eq: ['$deviceA', localDevID] }, '$deviceB', '$deviceA'] }
            }
          },
          {
            $group: {
              _id: '$dev_id',
              tunnels: { $push: { num: '$$ROOT.num', role: '$$ROOT.role' } }
            }
          },
          { $lookup: { from: 'devices', localField: '_id', foreignField: '_id', as: 'devices' } },
          {
            $addFields: {
              hostname: { $arrayElemAt: ['$devices.hostname', 0] },
              machineId: { $arrayElemAt: ['$devices.machineId', 0] }
            }
          },
          { $project: { hostname: 1, machineId: 1, tunnels: 1 } }
        ]);

      for (const { _id, hostname, machineId, tunnels } of remoteDevices) {
        const tasks = tunnels.map(tunnel => {
          return {
            entity: 'agent',
            message: 'modify-tunnel',
            params: {
              'tunnel-id': tunnel.num,
              ikev2: { certificate, 'remote-cert-applied': tunnel.role === 'initiator' }
            }
          };
        });
        deviceQueues.addJob(machineId, 'system', res.org,
          // Data
          { title: `Modify tunnel IKEv2 certificate on device ${hostname}`, tasks },
          // Response data
          {
            method: 'ikev2',
            data: {
              deviceId: _id,
              machineId: res.machineId,
              hostname,
              reinitiateTunnels: tunnels.filter(t => t.role === 'responder').map(t => t.num),
              org: res.org,
              action: 'update-public-certificate'
            }
          },
          // Metadata
          { priority: 'normal', attempts: 1, removeOnComplete: false },
          // Complete callback
          null);
      }
    } else {
      logger.warn('Failed to create IKEv2 certificate',
        { params: { result: { certificate, expireTime } } }
      );
    }
    // unset the pending IKEv2 job flag in the database
    try {
      await setIKEv2QueuedFlag([res.deviceId], false);
    } catch (err) {
      logger.warn('Failed to update jobQueued field in database', {
        params: { result: res, jobId: jobId, err: err.message }
      });
    }
  }
};

/**
 * Called if device IKEv2 job fails to unset
 * the pending job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID
 * @param  {Object} res
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.warn('Device IKEv2 job failed', { params: { result: res, jobId: jobId } });
  try {
    await setIKEv2QueuedFlag([res.deviceId], false);
  } catch (err) {
    logger.warn('Failed to update IKEv2 jobQueued field in database', {
      params: { result: res, jobId: jobId, err: err.message }
    });
  }
};

/**
 * Called if device IKEv2 job was removed to unset
 * the pending IKEv2 job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID
 * @param  {Object} res
 * @return {void}
 */
const remove = async (job) => {
  if (['inactive', 'delayed', 'active'].includes(job._state)) {
    logger.info('Device IKEv2 job removed', { params: { jobId: job.id } });
    try {
      const { deviceId } = job.data.response.data;
      await setIKEv2QueuedFlag([deviceId], false);
    } catch (err) {
      logger.error('Failed to update jobQueued field in database', {
        params: { jobId: job.id, err: err.message }
      });
    }
  }
};

module.exports = {
  getRenewBeforeExpireTime,
  validateIKEv2,
  queueCreateIKEv2Jobs,
  apply,
  complete,
  error,
  remove
};
