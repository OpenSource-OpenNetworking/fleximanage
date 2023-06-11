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

const createError = require('http-errors');
const pick = require('lodash/pick');
const qosPoliciesModel = require('../models/qosPolicies');
const { getMajorVersion } = require('../versioning');

const {
  complete: appComplete,
  error: appError,
  remove: appRemove,
  getDevicesAppIdentificationJobInfo
} = require('./appIdentification');

const {
  complete: trafficMapComplete,
  error: trafficMapError,
  remove: trafficMapRemove,
  getDevicesTrafficMapJobInfo
} = require('./qosTrafficMap');

const configs = require('../configs')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { devices } = require('../models/devices');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { validateQOSPolicy } = require('../deviceLogic/validators');

const { toCamelCase } = require('../utils/helpers');

/**
 * Gets the device QOS data needed for creating a job
 * @async
 * @param   {Object} device - the device to send QOS parameters
 * @return  {Object} parameters to include in the job response data { requests, response }
*/
const getDevicesQOSJobInfo = async (device) => {
  let op = 'install';
  const { status, policy: qosPolicy } = device.policies.qos;
  const policyParams =
    getQOSParameters(status.startsWith('install') ? qosPolicy : null, device, op);
  if (!policyParams) op = 'uninstall';
  // Extract QoS traffic map information
  const trafficMap = await getDevicesTrafficMapJobInfo(device.org, [device._id], false, device);
  // Extract applications information
  const apps = await getDevicesAppIdentificationJobInfo(
    device.org,
    'qos',
    [device._id],
    op === 'install'
  );
  const requestTime = Date.now();
  await updateDevicesBeforeJob([device._id], op, requestTime, qosPolicy, device.org, true);
  return prepareQOSJobInfo(device, policyParams, op, device.org, apps, trafficMap, requestTime);
};

const prepareQOSJobInfo = (device, policyParams, op, org, apps, trafficMap, requestTime) => {
  const tasks = [
    {
      entity: 'agent',
      message: `${op === 'install' || policyParams ? 'add' : 'remove'}-qos-policy`,
      params: policyParams || {}
    }
  ];
  const data = {
    policy: {
      device: { _id: device._id, qosPolicy: policyParams ? policyParams.id : '' },
      requestTime: requestTime,
      op: op,
      org: org
    }
  };

  // If the QOS traffic map was modified and not sent yet, attach the task
  if (trafficMap.installIds[device._id] === true && op === 'install') {
    const task = {
      entity: 'agent',
      message: trafficMap.message,
      params: trafficMap.params
    };
    tasks.unshift(task);
    data.qosTrafficMap = {
      deviceId: device._id
    };
  }

  // If the device's appIdentification database is outdated
  // we add an add-application/remove-application message as well.
  // add-application comes before add-qos-policy when installing.
  // remove-application comes after remove-qos-policy when uninstalling.
  if (apps.installIds[device._id] === true) {
    const task = {
      entity: 'agent',
      message: apps.message,
      params: apps.params
    };
    op === 'install' ? tasks.unshift(task) : tasks.push(task);

    data.appIdentification = {
      deviceId: device._id,
      ...apps.deviceJobResp
    };
  }
  return { tasks, data };
};

/**
 * Converts the QOS Policy parameters to match the agent API
 * @param   {Object} policy - a global QOS policy applied on the device
 * @return  {Object} parameters to include in the job
 */
const convertParameters = (policy) => {
  const { name, advanced, inbound, outbound } = policy;

  const dataTrafficClasses = [
    'control-signaling',
    'prime-select',
    'standard-select',
    'best-effort'
  ];

  const { bandwidthLimitPercent, dscpRewrite } = outbound.realtime || {};
  const scheduling = {
    realtimeQueue: {
      bandwidthLimitPercent: +bandwidthLimitPercent,
      dscpRewrite: advanced && dscpRewrite ? dscpRewrite : 'CS0'
    }
  };
  for (const queueName of dataTrafficClasses) {
    if (outbound[queueName]) {
      const { weight, dscpRewrite } = outbound[queueName];
      scheduling[toCamelCase(queueName) + 'Queue'] = {
        weight: +weight,
        dscpRewrite: advanced && dscpRewrite ? dscpRewrite : 'CS0'
      };
    }
  };

  const policerBandwidthLimitPercent = pick(inbound?.policerBandwidthLimitPercent || {
    // default inbound values
    high: 100,
    medium: 80,
    low: 65
  }, [
    'high',
    'medium',
    'low'
  ]);

  const params = {
    name,
    interfaces: [],
    inbound: { policerBandwidthLimitPercent },
    outbound: { scheduling }
  };

  return params;
};

/**
 * Gets QOS policy parameters of the device, needed for creating a job
 * @param   {Object} policy - a global QOS policy applied on the device
 * @param   {Object} device - the device where to send the QOS parameters
 * @param   {String} op     - requested action {install|uninstall}
 * @return  {Object} parameters to include in the job or null if nothing to send
 */
const getQOSParameters = (policy, device, op = 'install') => {
  if (!policy && op !== 'install') {
    // remove all policies from the device
    return null;
  }
  // we will collect device and interface specific policies with arrays of devIds
  const devicePolicies = {};
  // requested policy id
  const reqPolicyId = (policy?._id || '').toString();
  // interfaces specific policies
  for (const ifc of device.interfaces.filter(i => i.isAssigned && i.type === 'WAN')) {
    const ifcPolicyId = (ifc.qosPolicy?._id || '').toString();
    if (op === 'install') {
      if (ifcPolicyId) {
        if (!devicePolicies[ifcPolicyId]) {
          devicePolicies[ifcPolicyId] = convertParameters(ifc.qosPolicy);
        }
        // push devId if interface specific policy installed
        devicePolicies[ifcPolicyId].interfaces.push(ifc.devId);
      }
    } else {
      // uninstalling
      if (reqPolicyId && ifcPolicyId && ifcPolicyId !== reqPolicyId) {
        if (!devicePolicies[ifcPolicyId]) {
          devicePolicies[ifcPolicyId] = convertParameters(ifc.qosPolicy);
        }
        // push devId if interface specific policy installed and not requested to remove
        devicePolicies[ifcPolicyId].interfaces.push(ifc.devId);
      }
    };
  }
  const policies = [];
  for (const policyId in devicePolicies) {
    if (devicePolicies[policyId].interfaces.length) {
      policies.push(devicePolicies[policyId]);
    }
  }
  if (policies.length) {
    return { policies };
  }
  return null;
};

const queueQOSPolicyJob = async (deviceList, op, requestTime, policy, user, org, installed) => {
  const jobs = [];

  // Extract QoS traffic map information
  const trafficMap = await getDevicesTrafficMapJobInfo(org, deviceList.map(d => d._id));

  // Extract applications information
  const apps = await getDevicesAppIdentificationJobInfo(
    org,
    'qos',
    deviceList.map(d => d._id),
    op === 'install'
  );

  deviceList.forEach(dev => {
    dev = dev.toObject();
    if (!installed && op === 'install') {
      // a new default policy is installing, interfaces QoS policy should be updated
      dev.interfaces.forEach(ifc => {
        ifc.qosPolicy = policy;
      });
    }
    const policyParams = getQOSParameters(
      installed && op === 'install' ? dev.policies?.qos?.policy : policy, dev, op
    );

    const jobTitle = op === 'install'
      ? policy ? `Install policy ${policy.name}` : 'Install interfaces specific policies'
      : `Uninstall policy ${policy ? policy.name : ''}`;

    if (!policyParams) op = 'uninstall';

    const { tasks, data } = prepareQOSJobInfo(
      dev, policyParams, op, org, apps, trafficMap, requestTime
    );
    jobs.push(
      deviceQueues.addJob(
        dev.machineId,
        user.username,
        org,
        // Data
        {
          title: jobTitle,
          tasks: tasks
        },
        // Response data
        {
          method: 'qosPolicy',
          data: data
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      )
    );
  });
  return Promise.allSettled(jobs);
};

const getOpDevices = async (devicesObj, org, policy, op) => {
  // If the list of devices is provided in the request
  // return their IDs, otherwise, extract device IDs
  // of all devices that are currently running the policy
  const devicesList = Object.keys(devicesObj);
  if (devicesList.length > 0 && op === 'install') return devicesList;

  // Select only devices on which the policy is already
  // installed or in the process of installation, to make
  // sure the policy is not reinstalled on devices that
  // are in the process of uninstalling the policy.
  const { _id } = policy || { _id: null };
  const filter = {
    org: org,
    'policies.qos.status': { $in: ['installing', 'installed', 'installation failed'] }
  };

  // uninstall a specified policy
  if (op !== 'install' && _id) {
    filter.$or = [
      { 'policies.qos.policy': _id },
      { 'interfaces.qosPolicy': _id }
    ];
  }

  if (op !== 'install' && devicesList.length > 0) {
    filter._id = { $in: devicesList };
  }
  const result = await devices.find(filter, { _id: 1 });

  return result.map(device => device._id);
};

const filterDevices = (devices, deviceIds, op, policyIdRequest) => {
  const filteredDevices = devices.filter(device => {
    const { status, policy } = device.policies.qos || {};

    const hasDeviceDefaultPolicy =
      policy && (!policyIdRequest || policyIdRequest === policy._id.toString());
    const hasInterfaceSpecificPolicy =
      device.interfaces.some(ifc => (ifc.qosPolicy?._id || '').toString() === policyIdRequest);
    const policyExist = hasDeviceDefaultPolicy || hasInterfaceSpecificPolicy;

    // Don't attempt to uninstall a policy if the device
    // doesn't have one, or if its policy is already in
    // the process of being uninstalled.
    const skipUninstall = op === 'uninstall' && (status === 'uninstalling' || !policyExist);
    const id = device._id.toString();
    return !skipUninstall && ((deviceIds.size === 0 && op === 'uninstall') || deviceIds.has(id));
  });

  return filteredDevices;
};

/**
 * Get a global QOS policy by Id from the database
 * @async
 * @param  {string} id  - the global QOS policy Id
 * @param  {string} org - the organization Id
 * @return {Object} mongo qosPolicy object or undefined
 */
const getQOSPolicy = async (id, org) => {
  if (!id) return undefined;
  const qosPolicy = await qosPoliciesModel.findOne(
    { org: org, _id: id },
    { name: 1, inbound: 1, outbound: 1 }
  ).lean();
  return qosPolicy;
};

/**
 * Update devices policy status in DB before sending jobs
 */
const updateDevicesBeforeJob = async (deviceIds, op, requestTime, qosPolicy, org, installed) => {
  // QoS policy can be applied for device and for every interface
  // so even if we uninstall some policy we still keep others and set status as 'installing'
  const updateOps = [];
  if (op === 'install') {
    const qosUpdates = {
      'policies.qos.status': 'installing',
      'policies.qos.requestTime': requestTime
    };
    if (!installed) {
      qosUpdates['policies.qos.policy'] = qosPolicy ? qosPolicy._id : null;
      qosUpdates['interfaces.$[].qosPolicy'] = qosPolicy ? qosPolicy._id : null;
    };
    updateOps.push({
      updateMany: {
        filter: { _id: { $in: deviceIds }, org: org },
        update: { $set: qosUpdates },
        upsert: false
      }
    });
  } else if (qosPolicy) {
    // uninstalling an exact policy
    // set 'uninstall' to all devices with only this policy applied
    updateOps.push({
      updateMany: {
        filter: {
          _id: { $in: deviceIds },
          org: org,
          $or: [
            { 'policies.qos.policy': qosPolicy._id },
            { 'policies.qos.policy': null }
          ],
          interfaces: {
            $not: {
              $elemMatch: {
                $and: [
                  { qosPolicy: { $ne: null } },
                  { qosPolicy: { $ne: qosPolicy._id } }
                ]
              }
            }
          }
        },
        update: {
          $set: {
            'interfaces.$[ifc].qosPolicy': null,
            'policies.qos.status': 'uninstalling',
            'policies.qos.requestTime': requestTime
          }
        },
        arrayFilters: [{ 'ifc.qosPolicy': qosPolicy._id }],
        upsert: false
      }
    });
    // set 'installing' and clear the selected policy (keeping others)
    updateOps.push({
      updateMany: {
        filter: {
          _id: { $in: deviceIds },
          org: org,
          'policies.qos.policy': qosPolicy._id,
          interfaces: {
            $elemMatch: {
              qosPolicy: { $ne: qosPolicy._id }
            }
          }
        },
        update: {
          $set: {
            'interfaces.$[ifc].qosPolicy': null,
            'policies.qos': {
              policy: null,
              status: 'installing',
              requestTime: requestTime
            }
          }
        },
        arrayFilters: [{ 'ifc.qosPolicy': qosPolicy._id }],
        upsert: false
      }
    });
    // the selected is not the default device policy, and others interface specific exist
    // clear all interface specific records with the selected policy
    // set 'installing' and keep others policies
    updateOps.push({
      updateMany: {
        filter: {
          _id: { $in: deviceIds },
          org: org,
          'policies.qos.policy': { $ne: qosPolicy._id },
          interfaces: {
            $elemMatch: {
              qosPolicy: qosPolicy._id
            }
          }
        },
        update: {
          $set: {
            'interfaces.$[ifc].qosPolicy': null,
            'policies.qos.status': 'installing',
            'policies.qos.requestTime': requestTime
          }
        },
        arrayFilters: [{ 'ifc.qosPolicy': qosPolicy._id }],
        upsert: false
      }
    });
  } else {
    // the uninstall policy is not provided
    // uninstalling all policies
    updateOps.push({
      updateMany: {
        filter: {
          _id: { $in: deviceIds },
          org: org,
          $or: [
            { 'policies.qos.policy': { $ne: null } },
            { interfaces: { $elemMatch: { qosPolicy: { $ne: null } } } }
          ]
        },
        update: {
          $set: {
            'interfaces.$[].qosPolicy': null,
            'policies.qos.policy': null,
            'policies.qos.status': 'uninstalling',
            'policies.qos.requestTime': requestTime
          }
        },
        upsert: false
      }
    });
  }
  await devices.bulkWrite(updateOps);
};

/**
 * Called from dispatcher, runs required validations and calls applyPolicy
 * @async
 * @param  {Array}    deviceList    an array of the devices to be modified
 * @param  {Object}   user          User object
 * @param  {Object}   data          Additional data used by caller
 * @return {None}
 */
const apply = async (deviceList, user, data) => {
  const { org } = data;
  const { op, id: policyId } = data.meta;

  deviceList = await Promise.all(deviceList.map(d => d
    .populate('policies.qos.policy')
    .populate('interfaces.qosPolicy')
    .execPopulate()
  ));

  let qosPolicy, deviceIds;

  if (op === 'install' && !policyId) {
    throw createError(400, 'QOS policy id is required');
  }

  try {
    if (policyId) {
      // Retrieve policy from database
      qosPolicy = await getQOSPolicy(policyId, org);

      if (!qosPolicy) {
        throw createError(404, `QOS policy ${policyId} does not exist`);
      }
    }

    // Extract the device IDs to operate on
    deviceIds = await getOpDevices(
      data.devices || { [deviceList[0]._id]: true }, org, qosPolicy, op
    );
  } catch (err) {
    throw err.name === 'MongoError'
      ? new Error() : err;
  }
  const deviceIdsSet = new Set(deviceIds.map(id => id.toString()));
  const opDevices = filterDevices(deviceList, deviceIdsSet, op, policyId);
  if (opDevices.length === 0) {
    // no need to apply if not installed on any of devices
    return {
      ids: [],
      status: 'completed',
      message: 'The policy is not installed on any of the devices'
    };
  }
  return applyPolicy(opDevices, qosPolicy, op, user, org);
};

/**
 * Updates devices, creates and queues add/remove policy jobs.
 * @async
 * @param  {Array}   opDevices        an array of the devices to be modified
 * @param  {Object}  qosPolicy        the policy to apply
 * @param  {String}  op               operation [install|uninstall]
 * @param  {Object}  user             User object
 * @param  {String}  org              Org ID
 * @param  {Boolean} installed        the policy is installed already, just updating values
 */
const applyPolicy = async (opDevices, qosPolicy, op, user, org, installed = false) => {
  // validate QoS on devices
  if (op === 'install') {
    const { valid, err } = validateQOSPolicy(opDevices);
    if (!valid) {
      throw createError(500, `Can't install QoS policy: ${err}`);
    }
  }

  const deviceIds = opDevices.map(device => device._id);
  const requestTime = Date.now();

  // Update devices policy in the database
  await updateDevicesBeforeJob(deviceIds, op, requestTime, qosPolicy, org, installed);

  // Queue policy jobs
  const jobs = await queueQOSPolicyJob(opDevices, op, requestTime, qosPolicy, user, org, installed);
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
      { $set: { 'policies.qos.status': 'job queue failed' } },
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
  const { op, org } = res.policy;
  const { _id } = res.policy.device;
  try {
    const update = op === 'install'
      ? { $set: { 'policies.qos.status': 'installed' } }
      : { $set: { 'policies.qos': {} } };

    await devices.updateOne(
      { _id: _id, org: org },
      update,
      { upsert: false }
    );
    const { appIdentification, qosTrafficMap } = res;
    if (appIdentification) {
      appComplete(jobId, appIdentification);
    }
    if (qosTrafficMap) {
      trafficMapComplete(jobId, qosTrafficMap);
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
    logger.error('QOS policy sync complete callback failed', {
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
      { $set: { 'policies.qos.status': status } },
      { upsert: false }
    );
    const { appIdentification, qosTrafficMap } = res;
    if (appIdentification) {
      appError(jobId, res);
    }
    if (qosTrafficMap) {
      trafficMapError(jobId, qosTrafficMap);
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
      params: { jobId: job.id }
    });

    // Set the status to "job deleted" only
    // for the last policy related job.
    const status = 'job deleted';
    try {
      await devices.updateOne(
        {
          _id: _id,
          org: org,
          'policies.qos.requestTime': { $eq: requestTime }
        },
        { $set: { 'policies.qos.status': status } },
        { upsert: false }
      );
      // Call remove callbacks if needed
      const { appIdentification, qosTrafficMap } = job.data.response.data;
      if (appIdentification) {
        job.data.response.data = appIdentification;
        appRemove(job);
      }
      if (qosTrafficMap) {
        job.data.response.data = qosTrafficMap;
        trafficMapRemove(job);
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
  const device = await devices.findOne(
    { _id: deviceId },
    {
      versions: 1,
      'interfaces.isAssigned': 1,
      'interfaces.type': 1,
      'interfaces.devId': 1,
      'interfaces.qosPolicy': 1,
      'policies.qos': 1
    }
  )
    .populate('interfaces.qosPolicy')
    .populate('policies.qos.policy')
    .lean();

  const { policy, status } = device.policies.qos;

  // No need to take care of no policy cases,
  // as the device removes the policy in the
  // beginning of the full sync process
  const requests = [];
  const completeCbData = [];
  let callComplete = false;

  const majorAgentVersion = getMajorVersion(device.versions.agent);
  if (majorAgentVersion < 6) {
    return {
      requests,
      completeCbData,
      callComplete
    };
  }

  // if no QOS global policy then interfaces specific policies will be sent
  const params = status.startsWith('install') ? getQOSParameters(policy, device) : null;
  if (params) {
    // Push policy task and relevant data for sync complete handler
    requests.push({ entity: 'agent', message: 'add-qos-policy', params });
    completeCbData.push({
      org,
      deviceId,
      op: 'install'
    });
    callComplete = true;
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
  sync: sync,
  applyPolicy,
  getDevicesQOSJobInfo
};
