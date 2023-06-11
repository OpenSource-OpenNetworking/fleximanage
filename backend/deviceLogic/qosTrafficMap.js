// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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
const mongoose = require('mongoose');
const { devices } = require('../models/devices');
const qosTrafficMapModel = require('../models/qosTrafficMap');
const { predefinedServiceClasses } = require('../models/appIdentifications');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { toCamelCase } = require('../utils/helpers');
const { getMajorVersion } = require('../versioning');

/**
 * Queues an add-qos-traffic-map job to a device.
 * @async
 * @param  {Array}    orgDevices an array of the devices of the org
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (orgDevices, user, data) => {
  const userName = user.username;
  const { org, devices } = data;

  const { message, params, installIds, deviceJobResp } =
    await getDevicesTrafficMapJobInfo(org, devices ? Object.keys(devices) : []);

  const opDevices = (orgDevices && installIds)
    ? orgDevices.filter((device) => installIds.hasOwnProperty(device._id)) : [];

  const jobPromises = [];
  opDevices.forEach(async device => {
    const machineId = device.machineId;
    const tasks = [];
    tasks.push({ entity: 'agent', message, params });
    const jobPromise = deviceQueues.addJob(machineId, userName, org,
      // Data
      { title: `Add QoS Traffic Map to device ${device.name}`, tasks: tasks },
      // Response data
      {
        method: 'qosTrafficMap',
        data: {
          deviceId: device.id,
          ...deviceJobResp
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null);
    jobPromises.push(jobPromise);
  });
  const promiseStatus = await Promise.allSettled(jobPromises);

  const fulfilled = promiseStatus.reduce((arr, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      arr.push(job);
      logger.info('QoS Traffic Map Job Queued', {
        params: {
          job: job
        }
      });
    } else {
      logger.error('QoS Traffic Map Job Queue Error', {
        params: { message: elem.reason.message }
      });
    }
    return arr;
  }, []);
  const status = fulfilled.length < opDevices.length
    ? 'partially completed' : 'completed';
  const warningMessage = fulfilled.length < opDevices.length
    ? `${fulfilled.length} of ${opDevices.length} QoS Traffic Map jobs added` : '';
  return { ids: fulfilled.flat().map(job => job.id), status, message: warningMessage, ...params };
};

/**
 * Called when add qosTrafficMap job completed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  try {
    await devices.findOneAndUpdate(
      { _id: mongoose.Types.ObjectId(res.deviceId) },
      { $set: { 'qosTrafficMap.lastUpdateTime': res.requestTime } },
      { upsert: false }
    );
  } catch (error) {
    logger.error('Complete QoS Traffic Map job, failed', {
      params: { result: res, jobId: jobId, message: error.message }
    });
  }
};

/**
 * Complete handler for sync job
 * @return void
 */
const completeSync = async (jobId, jobsData) => {
  try {
    for (const data of jobsData) {
      await complete(jobId, data);
    }
  } catch (err) {
    logger.error('QoS Traffic Map sync complete callback failed', {
      params: { jobsData, reason: err.message }
    });
  }
};

/**
 * Reset last request time for failed or removed jobs
 * This will allow resending a new identical job
 * @param {String} jobId - Failed job ID
 * @param {Object} res   - response data for job ID
 */
const resetDeviceLastRequestTime = async (jobId, res) => {
  try {
    await devices.findOneAndUpdate(
      { _id: mongoose.Types.ObjectId(res.deviceId) },
      { $set: { 'qosTrafficMap.lastRequestTime': null } },
      { upsert: false }
    );
  } catch (error) {
    logger.error('Revert QoS Traffic Map job, failed', {
      params: { result: res, jobId: jobId, message: error.message }
    });
  }
};

/**
 * Handle QoS Traffic Map errors
 * @param {String} jobId - Failed job ID
 * @param {Object} res   - response data for job ID
 */
const error = async (jobId, res) => {
  logger.info('QoS Traffic Map job failed', { params: { result: res, jobId: jobId } });
  if (!res || !res.deviceId) {
    logger.error('QoS Traffic Map job error got an invalid job result', {
      params: { result: res, jobId: jobId }
    });
    return;
  }
  await resetDeviceLastRequestTime(jobId, res);
};

/**
 * Handle QoS Traffic Map job removal
 * @param {String} jobId - Failed job ID
 * @param {Object} res   - response data for job ID
 */
const remove = async (job) => {
  const res = job.data.response.data;
  logger.info('QoS Traffic Map job removed', { params: { result: res, jobId: job.id } });
  if (!res || !res.deviceId) {
    logger.error('QoS Traffic Map job removal got an invalid job result', {
      params: { result: res, jobId: job.id }
    });
    return;
  }
  await resetDeviceLastRequestTime(job.id, res);
};

/**
 * Returns the full QOS traffic map extended with default values
 * Logic behind default queue mapping:
 * - 'low' importance is mapped to 'best-effort'
 * - 'medium' importance is mapped to 'standard-select'
 * - 'high' importance of 'realtime' is mapped to 'realtime'
 * - 'high' importance of 'network-control', 'signaling', 'oam' is mapped to 'control-signaling'
 * - all other 'high' importance is mapped to 'prime-select'
 *
 * @param {List}    orgList Organizations filter
 * @param {Boolean} toAgent true is must be prepared for the agent API
 * @returns {Object} Object with QOS Traffic Map and last update timestamp
 */
const getFullTrafficMap = async (orgList, toAgent) => {
  const convert = toAgent ? v => toCamelCase(v) + 'Queue' : v => v;
  const trafficMap = {};
  let updatedAt = new Date(0);
  for (const serviceClass of predefinedServiceClasses) {
    trafficMap[serviceClass] = {};
    trafficMap[serviceClass].low = convert('best-effort');
    trafficMap[serviceClass].medium = convert('standard-select');

    const highRealTime = ['real-time', 'telephony', 'low-latency', 'multimedia-conferencing'];
    const highControlSignaling = ['network-control', 'signaling', 'oam'];

    if (highRealTime.includes(serviceClass)) {
      trafficMap[serviceClass].high = convert('realtime');
    } else if (highControlSignaling.includes(serviceClass)) {
      trafficMap[serviceClass].high = convert('control-signaling');
    } else {
      trafficMap[serviceClass].high = convert('prime-select');
    }
  }
  const res = await qosTrafficMapModel.findOne(
    { org: { $in: orgList } },
    { trafficMap: 1, updatedAt: 1 }
  ).lean();
  const trafficMapInDB = res?.trafficMap;

  if (trafficMapInDB) {
    updatedAt = res.updatedAt;
    for (const serviceClass in trafficMapInDB) {
      for (const importance in trafficMapInDB[serviceClass]) {
        if (trafficMap[serviceClass]) {
          trafficMap[serviceClass][importance] = convert(trafficMapInDB[serviceClass][importance]);
        }
      }
    }
  }
  return { trafficMap, updatedAt };
};

/**
 * This function gets the device info needed for creating a job
 * @param   {mongoID} org - organization to apply (make sure it is not the user defaultOrg)
 * @param   {List}    deviceIdList - deviceIDs List
 * @param   {Boolean} sync - true if sync action
 * @param   {Object}  device - populated device object (to reduce DB calls)
 * @return {Object} with:
 *  params        - the QoS traffic map table
 *  installIds    - A list with a subset of the devices to add the QoS traffic map
 *                  should only be included in jobs to these devices
 *  deviceJobResp - Parameters to include in the job response data together with the device Id
 * @throw exception on error
 */
const getDevicesTrafficMapJobInfo = async (org, deviceIdList, sync = false, device = null) => {
  // find all devices that require a new update (don't have a pending job)
  const requestTime = Date.now();

  // Extract QoS traffic map information
  const { trafficMap, updatedAt } = await getFullTrafficMap([org], true);
  const filter = {
    $and: []
  };
  if (deviceIdList.length) {
    filter.$and.push({ _id: { $in: deviceIdList } });
  }
  if (!sync) {
    filter.$and.push({
      'policies.qos.status': { $in: ['installing', 'installed', 'installation failed'] }
    });
    filter.$and.push({
      $or: [
        { 'qosTrafficMap.lastRequestTime': { $exists: false } },
        { 'qosTrafficMap.lastRequestTime': null },
        { 'qosTrafficMap.lastRequestTime': { $lt: updatedAt } }
      ]
    });
  }
  const opDevices = device ? [device] : await devices.find(filter, { _id: 1, versions: 1 });
  const installIdsObject = {};
  const installIdsArray = [];
  for (const dev of opDevices) {
    const majorAgentVersion = getMajorVersion(dev.versions.agent);
    if (majorAgentVersion >= 6) {
      const deviceId = (device ? deviceIdList[0] : dev._id).toString();
      installIdsArray.push(deviceId);
      installIdsObject[deviceId] = true;
    }
  };
  if (installIdsArray.length > 0) {
    await devices.updateMany(
      { _id: { $in: installIdsArray } },
      { $set: { 'qosTrafficMap.lastRequestTime': requestTime } }
    );
  };

  return {
    message: 'add-qos-traffic-map',
    params: trafficMap,
    deviceJobResp: { requestTime: requestTime },
    installIds: installIdsObject
  };
};

/**
 * Creates the QoS traffic map section in the full sync job.
 * @return Object
 */
const sync = async (deviceId, org, device) => {
  const {
    installIds,
    message,
    params,
    deviceJobResp
  } = await getDevicesTrafficMapJobInfo(org, [deviceId], true, device);
  const request = [];
  const completeCbData = [];
  let callComplete = false;
  if (installIds[deviceId.toString()]) {
    request.push({ entity: 'agent', message, params });
    completeCbData.push({ deviceId, requestTime: deviceJobResp.requestTime });
    callComplete = true;
  }

  return {
    requests: request,
    completeCbData,
    callComplete
  };
};

module.exports = {
  apply: apply,
  complete: complete,
  completeSync: completeSync,
  error: error,
  remove: remove,
  sync: sync,
  getFullTrafficMap,
  getDevicesTrafficMapJobInfo
};
