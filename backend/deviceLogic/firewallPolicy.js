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
const firewallPoliciesModel = require('../models/firewallPolicies');
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
const isEmpty = require('lodash/isEmpty');
const { validateFirewallRules } = require('../deviceLogic/validators');

/**
 * Gets the device firewall data needed for creating a job
 * @async
 * @param   {Object} device - the device to send firewall parameters
 * @return  {Object} parameters to include in the job response data { requests, response }
*/
const getDevicesFirewallJobInfo = async (device) => {
  let op = 'install';
  const { policy: firewallPolicy } = device.policies.firewall;
  const policyParams = getFirewallParameters(firewallPolicy, device);
  if (!policyParams) op = 'uninstall';
  // Extract applications information
  const apps = await getDevicesAppIdentificationJobInfo(
    device.org,
    'firewall',
    [device._id],
    op === 'install'
  );

  const requestTime = Date.now();
  await updateDevicesBeforeJob([device._id], op, requestTime, firewallPolicy, device.org);
  return prepareFirewallJobInfo(device, policyParams, op, device.org, apps, requestTime);
};

const prepareFirewallJobInfo = (device, policyParams, op, org, apps, requestTime) => {
  const tasks = [
    {
      entity: 'agent',
      message: `${op === 'install' ? 'add' : 'remove'}-firewall-policy`,
      params: policyParams
    }
  ];
  const data = {
    policy: {
      device: { _id: device._id, firewallPolicy: policyParams ? policyParams.id : '' },
      requestTime: requestTime,
      op: op,
      org: org
    }
  };

  // If the device's appIdentification database is outdated
  // we add an add-application/remove-application message as well.
  // add-application comes before add-firewall-policy when installing.
  // remove-application comes after remove-firewall-policy when uninstalling.
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
 * Gets firewall policy parameters of the device, needed for creating a job
 * @param   {Object} policy - the global firewall policy with array of rules
 * @param   {Object} device - the device where to send firewall parameters
 * @return  {Object} parameters to include in the job or null if nothing to send
 */
const getFirewallParameters = (policy, device) => {
  // global rules must be applied after device specific rules
  // assuming there will be not more than 10000 local rules
  const globalShift = 10000;
  const policyRules = policy ? policy.rules
    .filter(r => r.enabled)
    .map(r => ({ ...r, priority: r.priority + globalShift })) : [];
  const deviceRules = device.deviceSpecificRulesEnabled ? device.firewall.rules
    .filter(r => r.enabled) : [];
  const firewallRules = [...policyRules, ...deviceRules]
    .sort((r1, r2) => r1.priority - r2.priority);
  if (firewallRules.length === 0) {
    return null;
  }
  const params = {};
  params.id = policy ? policy._id : 'device-specific';
  params.outbound = {
    rules: firewallRules.filter(rule => rule.direction === 'outbound').map(rule => {
      const { _id, priority, action, interfaces } = rule;
      const classification = {};
      if (rule.classification) {
        if (!isEmpty(rule.classification.source)) {
          classification.source = {};
          ['trafficId', 'ipPort'].forEach(item => {
            if (!isEmpty(rule.classification.source[item])) {
              classification.source[item] = rule.classification.source[item];
            }
          });
        }
        if (!isEmpty(rule.classification.destination)) {
          classification.destination = {};
          ['trafficId', 'trafficTags', 'ipProtoPort'].forEach(item => {
            if (!isEmpty(rule.classification.destination[item])) {
              classification.destination[item] = rule.classification.destination[item];
            }
          });
        }
      }
      const jobRule = {
        id: _id,
        priority,
        classification,
        action: {
          permit: action === 'allow'
        }
      };
      if ((priority >= 0) && (priority < globalShift) && interfaces?.length) {
        // attach interfaces only for device specific rules
        jobRule.action.interfaces = interfaces;
      }
      return jobRule;
    })
  };
  params.inbound = firewallRules.filter(r => r.direction === 'inbound')
    .reduce((result, rule) => {
      const { _id, inbound, priority, action } = rule;
      const classification = {};
      if (!isEmpty(rule.classification.source) && inbound !== 'nat1to1') {
        classification.source = {};
        ['trafficId', 'ipPort'].forEach(item => {
          if (!isEmpty(rule.classification.source[item])) {
            classification.source[item] = rule.classification.source[item];
          }
        });
      }
      const { ipProtoPort } = rule.classification.destination;
      if (!isEmpty(ipProtoPort)) {
        classification.destination = {};
        const inboundParams = inbound === 'nat1to1' ? ['interface']
          : ['interface', 'ports', 'protocols'];
        inboundParams.forEach(item => {
          if (!isEmpty(ipProtoPort[item])) {
            classification.destination[item] = ipProtoPort[item];
          }
        });
      }
      const ruleAction = {};
      switch (inbound) {
        case 'nat1to1':
          ruleAction.internalIP = rule.internalIP;
          break;
        case 'portForward':
          ruleAction.internalIP = rule.internalIP;
          ruleAction.internalPortStart = +rule.internalPortStart;
          break;
        default:
          ruleAction.permit = action === 'allow';
      }
      const jobRule = {
        id: _id,
        priority,
        classification,
        action: ruleAction
      };
      result[inbound] = result[inbound] || { rules: [] };
      result[inbound].rules.push(jobRule);
      return result;
    }, {});
  return params;
};

const queueFirewallPolicyJob = async (deviceList, op, requestTime, policy, user, org) => {
  const jobs = [];

  // Extract applications information
  const apps = await getDevicesAppIdentificationJobInfo(
    org,
    'firewall',
    deviceList.filter(d => op === 'install' || !d.deviceSpecificRulesEnabled).map(d => d._id),
    op === 'install'
  );

  deviceList.forEach(dev => {
    const params = getFirewallParameters(policy, dev, op);
    const devOp = params ? 'install' : 'uninstall';
    const jobTitle = devOp === 'install'
      ? policy ? `Install policy ${policy.name}` : 'Install device specific policy'
      : 'Uninstall policy';

    const { tasks, data } = prepareFirewallJobInfo(dev, params, devOp, org, apps, requestTime);
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
          method: 'firewallPolicy',
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

const getOpDevices = async (devicesObj, org, policy) => {
  // If the list of devices is provided in the request
  // return their IDs, otherwise, extract device IDs
  // of all devices that are currently running the policy
  const devicesList = Object.keys(devicesObj);
  if (devicesList.length > 0) return devicesList;
  if (!policy) return [];

  // Select only devices on which the policy is already
  // installed or in the process of installation, to make
  // sure the policy is not reinstalled on devices that
  // are in the process of uninstalling the policy.
  const { _id } = policy;
  const result = await devices.find(
    {
      org: org,
      'policies.firewall.policy': _id,
      'policies.firewall.status': { $in: ['installing', 'installed'] }
    },
    { _id: 1 }
  );

  return result.map(device => device._id);
};

const filterDevices = (devices, deviceIds, op) => {
  const filteredDevices = devices.filter(device => {
    const { status, policy } = device.policies.firewall || {};
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
 * Get a global firewall policy with rules by Id from the database
 * @async
 * @param  {string} id  - the global firewall policy Id
 * @param  {string} org - the organization Id
 * @return {Object} mongo firewallPolicy object with rules or undefined
 */
const getFirewallPolicy = async (id, org) => {
  if (!id) return undefined;
  const firewallPolicy = await firewallPoliciesModel.findOne(
    { org: org, _id: id },
    { rules: 1, name: 1 }
  ).lean();
  return firewallPolicy;
};

/**
 * Update devices policy status in DB before sending jobs
 */
const updateDevicesBeforeJob = async (deviceIds, op, requestTime, firewallPolicy, org) => {
  const updateOps = [];
  if (op === 'install') {
    updateOps.push({
      updateMany: {
        filter: { _id: { $in: deviceIds }, org: org },
        update: {
          $set: {
            'policies.firewall': {
              policy: firewallPolicy ? firewallPolicy._id : null,
              status: 'installing',
              requestTime: requestTime
            }
          }
        },
        upsert: false
      }
    });
  } else {
    updateOps.push({
      updateMany: {
        filter: { _id: { $in: deviceIds }, org: org, deviceSpecificRulesEnabled: false },
        update: {
          $set: {
            'policies.firewall.status': 'uninstalling',
            'policies.firewall.requestTime': requestTime
          }
        },
        upsert: false
      }
    });
    updateOps.push({
      updateMany: {
        filter: { _id: { $in: deviceIds }, org: org, deviceSpecificRulesEnabled: true },
        update: {
          $set: {
            'policies.firewall': {
              policy: null,
              status: 'installing',
              requestTime: requestTime
            }
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
  const { org: orgId } = data;
  const { op, id } = data.meta;

  let firewallPolicy, deviceIds;

  try {
    if (op === 'install') {
      // Retrieve policy from database
      firewallPolicy = await getFirewallPolicy(id, orgId);

      if (!firewallPolicy) {
        throw createError(404, `Firewall policy ${id} does not exist`);
      }
      // Disabled rules should not be sent to the device
      firewallPolicy.rules = firewallPolicy.rules.filter(rule => rule.enabled);
      if (firewallPolicy.rules.length === 0) {
        throw createError(400, 'Policy must have at least one enabled rule');
      }
    }

    // Extract the device IDs to operate on
    deviceIds = data.devices
      ? await getOpDevices(data.devices, orgId, firewallPolicy)
      : [deviceList[0]._id];

    if (op === 'install') {
      const reqDevices = await devices.find(
        { org: orgId, _id: { $in: deviceIds } },
        { name: 1, interfaces: 1, 'firewall.rules': 1, deviceSpecificRulesEnabled: 1 }
      ).populate('org').lean();

      for (const dev of reqDevices) {
        const { valid, err } = validateFirewallRules(
          [...firewallPolicy.rules, ...dev.firewall.rules],
          dev.org,
          dev.interfaces
        );
        if (!valid) {
          throw createError(500, `Can't install policy on ${dev.name}: ${err}`);
        }
      }
    }
  } catch (err) {
    throw err.name === 'MongoError'
      ? new Error() : err;
  }
  const deviceIdsSet = new Set(deviceIds.map(id => id.toString()));
  const opDevices = filterDevices(deviceList, deviceIdsSet, op);
  if (opDevices.length === 0) {
    // no need to apply if not installed on any of devices
    return {
      ids: [],
      status: 'completed',
      message: 'The policy is not installed on any of the devices'
    };
  }
  return applyPolicy(opDevices, firewallPolicy, op, user, orgId);
};

/**
 * Updates devices, creates and queues add/remove policy jobs.
 * @async
 * @param  {Array}   opDevices        an array of the devices to be modified
 * @param  {Object}  firewallPolicy   the policy to apply
 * @param  {String}  op               operation [install|uninstall]
 * @param  {Object}  user             User object
 * @param  {String}  org              Org ID
 */
const applyPolicy = async (opDevices, firewallPolicy, op, user, org) => {
  const deviceIds = opDevices.map(device => device._id);
  const requestTime = Date.now();

  // Update devices policy in the database
  await updateDevicesBeforeJob(deviceIds, op, requestTime, firewallPolicy, org);

  // Queue policy jobs
  const jobs = await queueFirewallPolicyJob(opDevices, op, requestTime, firewallPolicy, user, org);
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
      { $set: { 'policies.firewall.status': 'job queue failed' } },
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
      ? { $set: { 'policies.firewall.status': 'installed' } }
      : { $set: { 'policies.firewall': {} } };

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
    logger.error('Firewall policy sync complete callback failed', {
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
      { $set: { 'policies.firewall.status': status } },
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
          'policies.firewall.requestTime': { $eq: requestTime }
        },
        { $set: { 'policies.firewall.status': status } },
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
  const device = await devices.findOne(
    { _id: deviceId },
    { deviceSpecificRulesEnabled: 1, 'policies.firewall': 1, 'firewall.rules': 1 }
  ).lean();

  const { policy, status } = device.policies.firewall;

  // No need to take care of no policy cases,
  // as the device removes the policy in the
  // beginning of the full sync process
  const requests = [];
  const completeCbData = [];
  let callComplete = false;
  let firewallPolicy;
  if (status.startsWith('install')) {
    firewallPolicy = await firewallPoliciesModel.findOne(
      {
        _id: policy
      },
      {
        rules: 1,
        name: 1
      }
    ).lean();
  }
  // if no firewall policy then device specific rules will be sent
  const params = getFirewallParameters(firewallPolicy, device);
  if (params) {
    // Push policy task and relevant data for sync complete handler
    requests.push({ entity: 'agent', message: 'add-firewall-policy', params });
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
  getDevicesFirewallJobInfo
};
