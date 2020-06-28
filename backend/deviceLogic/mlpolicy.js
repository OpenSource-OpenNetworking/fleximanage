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

const createError = require('http-errors');
const MultiLinkPolicies = require('../models/mlpolicies');
const mongoConns = require('../mongoConns.js')();
const configs = require('../configs')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { devices } = require('../models/devices');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { getDevicesAppIdentificationJobInfo } = require('./appIdentification');
const appComplete = require('./appIdentification').complete;
const appError = require('./appIdentification').error;
const appRemove = require('./appIdentification').remove;

const queueMlPolicyJob = async (deviceList, op, requestTime, policy, user, org) => {
  const jobs = [];
  const jobTitle = op === 'install'
    ? `Install policy ${policy.name}`
    : 'Uninstall policy';

  // Extract applications information
  const { message, params, installIds, deviceJobResp } =
    await getDevicesAppIdentificationJobInfo(
      org,
      'multilink',
      deviceList,
      op === 'install'
    );

  deviceList.forEach(dev => {
    const { _id, machineId, policies } = dev;
    const tasks = [[
      {
        entity: 'agent',
        message: `${op === 'install' ? 'add' : 'remove'}-multilink-policy`,
        params: {}
      }
    ]];

    if (op === 'install') {
      tasks[0][0].params.id = policy._id;
      tasks[0][0].params.rules = policy.rules.map(rule => {
        const { _id, priority, action, classification } = rule;
        return {
          id: _id,
          priority: priority,
          classification: classification,
          action: action
        };
      });
    }
    const data = {
      policy: {
        device: { _id: _id, mlpolicy: policies.multilink },
        requestTime: requestTime,
        op: op,
        org: org
      }
    };

    // If the device's appIdentification database is outdated
    // we add an "add-application" message as well.
    if (installIds[_id] === true) {
      tasks[0].unshift({
        entity: 'agent',
        message: message,
        params: params
      });
      data.appIdentification = {
        deviceId: _id,
        ...deviceJobResp
      };
    }

    jobs.push(
      deviceQueues.addJob(
        machineId,
        user.username,
        org,
        // Data
        {
          title: jobTitle,
          tasks: tasks
        },
        // Response data
        {
          method: 'mlpolicy',
          data: data
        },
        // Metadata
        { priority: 'high', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      )
    );
  });
  return Promise.allSettled(jobs);
};

const getOpDevices = async (devicesObj, org, policy) => {
  // If the list of devices is provided in the request
  // return their IDs, otherwise, extract device IDs
  // of all devices that are currently running the policy
  const devicesList = Object.keys(devicesObj);
  if (devicesList.length > 0) return devicesList;

  // Select only devices on which the policy is already
  // installed or in the process of installation, to make
  // sure the policy is not reinstalled on devices that
  // are in the process of uninstalling the policy.
  const { _id } = policy;
  const result = await devices.find(
    {
      org: org,
      'policies.multilink.policy': _id,
      'policies.multilink.status': { $in: ['installing', 'installed'] }
    },
    { _id: 1 }
  );

  return result.map(device => device._id);
};

const filterDevices = (devices, deviceIds, op) => {
  const filteredDevices = devices.filter(device => {
    const { status, policy } = device.policies.multilink;
    // Don't attempt to uninstall a policy if the device
    // doesn't have one, or if its policy is already in
    // the process of being uninstalled.
    const skipUninstall =
      op === 'uninstall' && (!policy || status === 'uninstalling');
    const id = device._id.toString();
    return !skipUninstall && deviceIds.has(id);
  });

  return filteredDevices;
};

/**
 * Creates and queues add/remove policy jobs.
 * @async
 * @param  {Array}    deviceList    an array of the devices to be modified
 * @param  {Object}   user          User object
 * @param  {Object}   data          Additional data used by caller
 * @return {None}
 */
const apply = async (deviceList, user, data) => {
  const { org } = data;
  const { op, id } = data.meta;

  let mLPolicy, session, deviceIds;
  const requestTime = Date.now();

  try {
    session = await mongoConns.getMainDB().startSession();
    await session.withTransaction(async () => {
      if (op === 'install') {
        // Retrieve policy from database
        mLPolicy = await MultiLinkPolicies.findOne(
          {
            org: org,
            _id: id
          },
          {
            rules: 1,
            name: 1,
            'rules.enabled': 1,
            'rules.priority': 1,
            'rules._id': 1,
            'rules.classification': 1,
            'rules.action': 1
          }
        ).session(session);

        if (!mLPolicy) {
          throw createError(404, `policy ${id} does not exist`);
        }

        // Disabled rules should not be sent to the device
        mLPolicy.rules = mLPolicy.rules.filter(rule => rule.enabled === true);
        if (mLPolicy.rules.length === 0) {
          throw createError(400, 'Policy must have at least one enabled rule');
        }
      }

      // Extract the device IDs to operate on
      deviceIds = data.devices
        ? await getOpDevices(data.devices, org, mLPolicy)
        : [deviceList[0]._id];

      // Update devices policy in the database
      const update = op === 'install'
        ? {
          $set: {
            'policies.multilink': {
              policy: mLPolicy._id,
              status: 'installing',
              requestTime: requestTime
            }
          }
        }
        : {
          $set: {
            'policies.multilink.status': 'uninstalling',
            'policies.multilink.requestTime': requestTime
          }
        };

      await devices.updateMany(
        { _id: { $in: deviceIds }, org: org },
        update,
        { upsert: false }
      ).session(session);
    });
  } catch (err) {
    throw err.name === 'MongoError'
      ? new Error() : err;
  } finally {
    session.endSession();
  }

  // Queue policy jobs
  const deviceIdsSet = new Set(deviceIds.map(id => id.toString()));
  const opDevices = filterDevices(deviceList, deviceIdsSet, op);

  const jobs = await queueMlPolicyJob(opDevices, op, requestTime, mLPolicy, user, org);
  const failedToQueue = [];
  const succeededToQueue = [];
  jobs.forEach(job => {
    switch (job.status) {
      case 'rejected': {
        failedToQueue.push(job);
        break;
      }
      case 'fulfilled': {
        const { id } = job.value;
        succeededToQueue.push(id);
        break;
      }
      default: {
        break;
      }
    }
  });

  let status = 'completed';
  let message = '';
  if (failedToQueue.length !== 0) {
    const failedDevices = failedToQueue.map(ent => {
      const { job } = ent.reason;
      const { _id } = job.data.response.data.policy.device;
      return _id;
    });

    logger.error('Policy jobs queue failed', {
      params: { jobId: failedToQueue[0].reason.job.id, devices: failedDevices }
    });

    // Update devices' policy status in the database
    await devices.updateMany(
      { _id: { $in: failedDevices }, org: org },
      { $set: { 'policies.multilink.status': 'job queue failed' } },
      { upsert: false }
    );
    status = 'partially completed';
    message = `${succeededToQueue.length} of ${jobs.length} policy jobs added`;
  }

  return {
    ids: succeededToQueue,
    status,
    message
  };
};

/**
 * Called when add/remove policy is job completed.
 * Updates the status of the policy in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async (jobId, res) => {
  logger.info('Policy job completed', {
    params: { result: res, jobId: jobId }
  });

  const { op, org } = res.policy;
  const { _id } = res.policy.device;
  try {
    const update = op === 'install'
      ? { $set: { 'policies.multilink.status': 'installed' } }
      : { $set: { 'policies.multilink': {} } };

    await devices.updateOne(
      { _id: _id, org: org },
      update,
      { upsert: false }
    );

    // Call appIdentification complete callback if needed
    if (res.appIdentification) {
      res = res.appIdentification;
      appComplete(jobId, res);
    }
  } catch (err) {
    logger.error('Device policy status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
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
      // Convert the data to the format
      // expected by the complete handler
      const { org, deviceId, op } = data;
      await complete(jobId, {
        policy: {
          org, op, device: { _id: deviceId }
        }
      });
    }
  } catch (err) {
    logger.error('Multi link policy sync complete callback failed', {
      params: { jobsData, reason: err.message }
    });
  }
};

/**
 * Called when add/remove policy job fails and
 * Updates the status of the policy in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.error('Policy job failed', {
    params: { result: res, jobId: jobId }
  });

  const { policy } = res;
  const { op, org } = policy;
  const { _id } = policy.device;
  try {
    const status = `${op === 'install' ? '' : 'un'}installation failed`;
    await devices.updateOne(
      { _id: _id, org: org },
      { $set: { 'policies.multilink.status': status } },
      { upsert: false }
    );

    // Call appIdentification error callback if needed
    if (res.appIdentification) {
      res = res.appIdentification;
      appError(jobId, res);
    }
  } catch (err) {
    logger.error('Device policy status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
};

/**
 * Called when add/remove policy job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion/failure
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  const { device, org, requestTime } = job.data.response.data.policy;
  const { _id } = device;

  if (['inactive', 'delayed'].includes(job._state)) {
    logger.info('Policy job removed', {
      params: { job: job }
    });

    // Set the status to "job deleted" only
    // for the last policy related job.
    const status = 'job deleted';
    try {
      await devices.updateOne(
        {
          _id: _id,
          org: org,
          'policies.multilink.requestTime': { $eq: requestTime }
        },
        { $set: { 'policies.multilink.status': status } },
        { upsert: false }
      );

      // Call applications remove callback if needed
      const { appIdentification } = job.data.response.data;
      if (appIdentification) {
        job.data.response.data = appIdentification;
        appRemove(job);
      }
    } catch (err) {
      logger.error('Device policy status update failed', {
        params: { job: job, status: status, err: err.message }
      });
    }
  }
};

/**
 * Creates the policies section in the full sync job.
 * @return Object
 */
const sync = async (deviceId, org) => {
  const { policies } = await devices.findOne(
    { _id: deviceId },
    { 'policies.multilink': 1 }
  )
    .lean();

  const { policy, status } = policies.multilink;

  // No need to take care of no policy cases,
  // as the device removes the policy in the
  // beginning of the full sync process
  const requests = [];
  const completeCbData = [];
  let callComplete = false;
  if (status.startsWith('install')) {
    const mLPolicy = await MultiLinkPolicies.findOne(
      {
        _id: policy
      },
      {
        rules: 1,
        name: 1,
        'rules.enabled': 1,
        'rules.priority': 1,
        'rules._id': 1,
        'rules.classification': 1,
        'rules.action': 1
      }
    );

    // Nothing to do if the policy was not found.
    // The policy will be removed by the device
    // at the beginning of the sync process
    if (mLPolicy) {
      const params = {};
      params.id = policy;
      params.rules = [];
      mLPolicy.rules.forEach(rule => {
        const { _id, priority, action, classification, enabled } = rule;
        if (enabled) {
          params.rules.push({
            id: _id,
            priority: priority,
            classification: classification,
            action: action
          });
        }
      });
      // Push policy task and relevant data for sync complete handler
      requests.push({ entity: 'agent', message: 'add-multilink-policy', params });
      completeCbData.push({
        org,
        deviceId,
        op: 'install'
      });
      callComplete = true;
    }
  }

  return {
    requests,
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
  sync: sync
};
