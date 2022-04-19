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
const compressObj = require('../utils/compression');

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
        { title: `${title} ${device.name}`, tasks: tasks },
        // Response data
        {
          method: 'appIdentification',
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
    }
  });
  const promiseStatus = await Promise.allSettled(jobPromises);

  const fulfilled = promiseStatus.reduce((arr, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      arr.push(job);
      logger.info('App Identification Job Queued', {
        params: {
          job: job
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
const getDevicesAppIdentificationJobInfo = async (org, client, deviceIdList, isInstall,
  sync = false) => {
  // find all devices that require a new update
  //  (don't have a pending job)
  // if isInstall==true, find devices older from latest the app update time
  //  which are not already in progress
  // if isInstall==false, we need to remove the apps from the device if
  //  the called client is the last one or no clients defined but last updated time is not null
  // If there are other clients using applications it will be kept installed
  let opDevices;
  let requestTime = null;
  let appRules = null;
  let updateAt = null;
  const updateOps = [];

  // On sync device, no client is allowed and device should be installed if has clients
  if (sync && !client && isInstall) {
    opDevices = await devices.find(
      {
        _id: { $in: deviceIdList },
        $and: [
          { 'appIdentification.clients': { $ne: [] } },
          { 'appIdentification.clients': { $ne: null } }
        ]
      }, { _id: 1, 'versions.agent': 1 });
    if (opDevices.length) {
      // get full application list for this organization
      appRules = await getOrgAppIdentifications(org);
      // Get latest update time
      requestTime = (appRules.meta.importedUpdatedAt >= appRules.meta.customUpdatedAt)
        ? appRules.meta.importedUpdatedAt : appRules.meta.customUpdatedAt;
      updateOps.push({
        updateMany: {
          filter: { _id: { $in: opDevices.map((d) => d._id) } },
          update: { $set: { 'appIdentification.lastRequestTime': requestTime } }
        }
      });
    }
  } else if (isInstall) {
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
            // last update is null but client is not null, or lower than latest
            ...((client != null) ? [{ 'appIdentification.lastUpdateTime': null }] : []),
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
        }, { _id: 1, 'versions.agent': 1 });
      const update = { $set: { 'appIdentification.lastRequestTime': updateAt } };
      // if client is set then attach it to all devices in db and send apps to opDevices only
      if (client) {
        update.$addToSet = { 'appIdentification.clients': client };
      };
      updateOps.push({
        updateMany: {
          filter: {
            _id: { $in: client ? deviceIdList : opDevices.map(d => d._id) }
          },
          update
        }
      });
    } else {
      opDevices = [];
      logger.warn('getDevicesAppIdentificationJobInfo: No application data found ', {
        params: { org: org, client: client }
      });
    }
  } else {
    // no need to remove app identifications, they will be stored in device's local db
    opDevices = [];
  }

  // Update devices in db
  if (updateOps.length) {
    await devices.bulkWrite(updateOps);
  }

  // return parameters
  const ret = {};
  ret.message = (isInstall) ? 'add-application' : 'remove-application';
  const titlePrefix = (isInstall) ? 'Add' : 'Remove';
  ret.title = `${titlePrefix} appIdentifications to device`;
  const idsAndVersion = opDevices.reduce((obj, d) => {
    obj.ids[d._id] = true;
    obj.minVer = (d.versions && d.versions.agent)
      ? Math.min(obj.minVer, getMajorVersion(d.versions.agent)) : 0;
    return obj;
  }, { ids: {}, minVer: Number.MAX_VALUE });
  ret.installIds = idsAndVersion.ids;
  if (appRules && appRules.appIdentifications && isInstall) {
    // If some devices with older version than 5 use old application scheme
    if (idsAndVersion.minVer < 5) {
      ret.params = { applications: appRules.appIdentifications };
    } else {
      // Add devices support compression, try to compress
      try {
        ret.params = { applications: await compressObj(appRules.appIdentifications) };
      } catch (err) {
        logger.error('Application compression error', { params: { err: err.message } });
        ret.params = { applications: appRules.appIdentifications };
      }
    }
  } else ret.params = {};
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
    true,
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
