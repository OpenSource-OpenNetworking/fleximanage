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
const { getAllAppIdentifications } = require('../models/appIdentifications');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const mongoose = require('mongoose');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { getMajorVersion } = require('../versioning');

/**
 * Queues an add appIdentification or delete appIdentification job to a device.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (devices, user, data) => {
  const userName = user.username;
  const org = data.org;

  const { message, title, params, installIds, deviceJobResp } =
      await getDevicesAppIdentificationJobInfo(
        org, null, Object.keys(data.devices), data.action === 'add'
      );

  const opDevices = (devices && installIds)
    ? devices.filter((device) => installIds.hasOwnProperty(device._id)) : [];

  const jobPromises = [];
  opDevices.forEach(async device => {
    const machineId = device.machineId;
    const majorAgentVersion = getMajorVersion(device.versions.agent);
    if (majorAgentVersion === 0) { // version 0.X.X
      // For now do nothing for version 0.X.X, just skip
    } else if (majorAgentVersion >= 1) { // version 1.X.X+
      const tasks = [];
      tasks.push({ entity: 'agent', message, params });
      const jobPromise = deviceQueues.addJob(machineId, userName, org,
        // Data
        { title: title, tasks: tasks },
        // Response data
        {
          method: 'appIdentification',
          data: {
            deviceId: device.id,
            ...deviceJobResp
          }
        },
        // Metadata
        { priority: 'low', attempts: 1, removeOnComplete: false },
        // Complete callback
        null);
      jobPromises.push(jobPromise);
    }
  });
  const promiseStatus = await Promise.allSettled(jobPromises);

  const fulfilled = promiseStatus.reduce((arr, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      arr.push(job);
      logger.info('App Identification Job Queued', {
        params: {
          jobResponse: job.data.response, jobId: job.id
        }
      });
    } else {
      logger.error('App Identification Job Queue Error', {
        params: { message: elem.reason.message }
      });
    }
    return arr;
  }, []);
  const status = fulfilled.length < opDevices.length
    ? 'partially completed' : 'completed';
  const warningMessage = fulfilled.length < opDevices.length
    ? `${fulfilled.length} of ${opDevices.length} App Identification jobs added` : '';
  return { ids: fulfilled.flat().map(job => job.id), status, message: warningMessage };
};

/**
 * Called when add/remove appIdentification job completed and
 * updates the status of the operation.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  logger.info('appIdentification job complete', { params: { result: res, jobId: jobId } });
  try {
    await devices.findOneAndUpdate(
      { _id: mongoose.Types.ObjectId(res.deviceId) },
      { $set: { 'appIdentification.lastUpdateTime': res.requestTime } },
      { upsert: false }
    );
  } catch (error) {
    logger.error('Complete appIdentification job, failed', {
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
    logger.error('App identification sync complete callback failed', {
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
      { $set: { 'appIdentification.lastRequestTime': new Date(0) } },
      { upsert: false }
    );
  } catch (error) {
    logger.error('revert appIdentification job, failed', {
      params: { result: res, jobId: jobId, message: error.message }
    });
  }
};

/**
 * Handle appIentification errors
 * @param {String} jobId - Failed job ID
 * @param {Object} res   - response data for job ID
 */
const error = async (jobId, res) => {
  logger.info('appIdentification job failed', { params: { result: res, jobId: jobId } });
  if (!res || !res.deviceId || !res.message) {
    logger.error('appIdentification job error got an invalid job result', {
      params: { result: res, jobId: jobId }
    });
    return;
  }
  await resetDeviceLastRequestTime(jobId, res);
};

/**
 * Handle appIentification job removal
 * @param {String} jobId - Failed job ID
 * @param {Object} res   - response data for job ID
 */
const remove = async (job) => {
  const res = job.data.response.data;
  logger.info('appIdentification job removed', { params: { result: res, jobId: job.id } });
  if (!res || !res.deviceId || !res.message) {
    logger.error('appIdentification job removal got an invalid job result', {
      params: { result: res, jobId: job.id }
    });
    return;
  }
  await resetDeviceLastRequestTime(job.id, res);
};

/**
 * Get final list of applications for organization
 * @param {MongoId} org - Organization Mongo ID
 */
const getOrgAppIdentifications = async (org) => {
  return await getAllAppIdentifications(null, null, [org]);
};

/**
 * This function gets the device info needed for creating a job
 * @param   {mongoID} org - organization to apply (make sure it is not the user defaultOrg)
 * @param   {String} client - client name that asks for the application installation
 *                            null client only update jobs, not install/uninstall new
 * @param   {List} deviceIdList - deviceIDList the client askes to install on
 * @param   {Boolean} isInstall
 * @return {Object} with:
 *  message       - The message that should be sent to the add application message
 *                  (add-application/remove-application)
 *  title         - Title (Add/Remove)
 *  params        - list of application rules
 *  installIds    - A list with a subset of the devices to install / uninstall
 *                  should only be included in jobs to these devices
 *  deviceJobResp - Parameters to include in the job response data together with the device Id
 * @throw exception on error
 */
const getDevicesAppIdentificationJobInfo = async (org, client, deviceIdList, isInstall) => {
  // find all devices that require a new update
  //  (don't have a pending job)
  // if isInstall==true, find devices older from latest the app update time
  //  which are not already in progress
  // if isInstall==false, we need to remove the apps from the device if
  //  the called client is the last one or no clients defined but last updated time is not null
  // If there are other clients using applications it will be kept installed
  let opDevices, update;
  let requestTime = null;
  let appRules = null;
  let updateAt = null;
  if (isInstall) {
    // get full application list for this organization
    appRules = await getOrgAppIdentifications(org);
    // Get latest update time
    updateAt = (appRules.meta.importedUpdatedAt >= appRules.meta.customUpdatedAt)
      ? appRules.meta.importedUpdatedAt : appRules.meta.customUpdatedAt;
    if (updateAt) {
      requestTime = updateAt;
      opDevices = await devices.find(
        {
          _id: { $in: deviceIdList },
          'appIdentification.lastRequestTime': { $ne: requestTime },
          $or: [
            // last update is not null or lower than latest
            { 'appIdentification.lastUpdateTime': null },
            { 'appIdentification.lastUpdateTime': { $lt: updateAt } },
            // request time and update time are not equal - job failed or removed
            {
              $expr: {
                $ne: [
                  '$appIdentification.lastRequestTime',
                  '$appIdentification.lastUpdateTime'
                ]
              }
            }
          ]
        }, { _id: 1 });
      update = { $set: { 'appIdentification.lastRequestTime': updateAt } };
    } else {
      opDevices = [];
      update = {};
      logger.warn('getDevicesAppIdentificationJobInfo: No application data found ', {
        params: { org: org, client: client }
      });
    }
  } else {
    opDevices = await devices.find(
      {
        _id: { $in: deviceIdList },
        'appIdentification.lastRequestTime': { $ne: requestTime },
        $or: [
          // This client is the only one left, we can remove
          { 'appIdentification.clients': [client] },
          // request time and update time are not equal - job failed or removed
          {
            $expr: {
              $ne: [
                '$appIdentification.lastRequestTime',
                '$appIdentification.lastUpdateTime'
              ]
            }
          },
          // No client exist but last update is not null - apps still installed
          {
            $and: [
              { 'appIdentification.clients': [] },
              { 'appIdentification.lastUpdateTime': { $ne: null } }
            ]
          }
        ]
      }, { _id: 1 });
    update = { $set: { 'appIdentification.lastRequestTime': null } };
  }

  if (client) {
    if (isInstall) {
      update.$addToSet = { 'appIdentification.clients': client };
    } else {
      update.$pull = { 'appIdentification.clients': client };
    }
  }
  await devices.updateMany(
    { _id: { $in: deviceIdList } },
    update
  );

  // return parameters
  const ret = {};
  ret.message = (isInstall) ? 'add-application' : 'remove-application';
  const titlePrefix = (isInstall) ? 'Add' : 'Remove';
  ret.title = `${titlePrefix} appIdentifications to device`;
  ret.installIds = opDevices.reduce((obj, d) => { obj[d._id] = true; return obj; }, {});
  ret.params = (appRules && appRules.appIdentifications && isInstall)
    ? { applications: appRules.appIdentifications } : {};
  ret.deviceJobResp = {
    requestTime: requestTime,
    message: ret.message,
    client: client
  };

  return ret;
};

/**
 * Creates the application identification section in the full sync job.
 * @return Object
 */
const sync = async (deviceId, org) => {
  const {
    installIds,
    message,
    params,
    deviceJobResp
  } = await getDevicesAppIdentificationJobInfo(
    org,
    null,
    [deviceId],
    true
  );
  const request = [];
  const completeCbData = [];
  let callComplete = false;
  if (installIds[deviceId.toString()]) {
    request.push({ entity: 'agent', message: message, params });
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
  getDevicesAppIdentificationJobInfo: getDevicesAppIdentificationJobInfo
};
