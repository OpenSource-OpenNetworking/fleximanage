
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
// const deviceStatus = require('../periodic/deviceStatus')();
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const deviceStatus = require('../periodic/deviceStatus')();
const { devices } = require('../models/devices');
const mlPolicySyncHandler = require('./mlpolicy').sync;
const mlPolicyCompleteHandler = require('./mlpolicy').completeSync;
const firewallPolicySyncHandler = require('./firewallPolicy').sync;
const firewallPolicyCompleteHandler = require('./firewallPolicy').completeSync;
const qosPolicySyncHandler = require('./qosPolicy').sync;
const qosPolicyCompleteHandler = require('./qosPolicy').completeSync;
const qosTrafficMapSyncHandler = require('./qosTrafficMap').sync;
const qosTrafficMapCompleteHandler = require('./qosTrafficMap').completeSync;
const deviceConfSyncHandler = require('./modifyDevice').sync;
const deviceConfCompleteHandler = require('./modifyDevice').completeSync;
const tunnelsSyncHandler = require('./tunnels').sync;
const tunnelsCompleteHandler = require('./tunnels').completeSync;
const applicationsSyncHandler = require('./application').sync;
const applicationsCompleteHandler = require('./application').completeSync;
const appIdentificationSyncHandler = require('./appIdentification').sync;
const appIdentificationCompleteHandler = require('./appIdentification').completeSync;
const vrrpSyncHandler = require('./vrrp').sync;
const vrrpCompleteHandler = require('./vrrp').completeSync;
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const stringify = require('json-stable-stringify');
const SHA1 = require('crypto-js/sha1');
const {
  activatePendingTunnelsOfDevice,
  releasePublicAddrLimiterBlockage
} = require('./events');
const { reconfigErrorsLimiter } = require('../limiters/reconfigErrors');
const deviceNotificationsSync = require('./deviceNotifications').sync;
const AsyncLock = require('async-lock');
const lock = new AsyncLock({ maxOccupationTime: 60000 });

// Create an object of all sync handlers
const syncHandlers = {
  deviceConf: {
    syncHandler: deviceConfSyncHandler,
    completeHandler: deviceConfCompleteHandler
  },
  tunnels: {
    syncHandler: tunnelsSyncHandler,
    completeHandler: tunnelsCompleteHandler
  },
  mlPolicies: {
    syncHandler: mlPolicySyncHandler,
    completeHandler: mlPolicyCompleteHandler
  },
  firewallPolicies: {
    syncHandler: firewallPolicySyncHandler,
    completeHandler: firewallPolicyCompleteHandler
  },
  lanNatPolicies: {
    syncHandler: require('./lanNatPolicy').sync
  },
  qosPolicies: {
    syncHandler: qosPolicySyncHandler,
    completeHandler: qosPolicyCompleteHandler
  },
  qosTrafficMap: {
    syncHandler: qosTrafficMapSyncHandler,
    completeHandler: qosTrafficMapCompleteHandler
  },
  appIdentification: {
    syncHandler: appIdentificationSyncHandler,
    completeHandler: appIdentificationCompleteHandler
  },
  applications: {
    syncHandler: applicationsSyncHandler,
    completeHandler: applicationsCompleteHandler
  },
  deviceNotifications: {
    syncHandler: deviceNotificationsSync
  },
  vrrp: {
    syncHandler: vrrpSyncHandler,
    completeHandler: vrrpCompleteHandler
  }
};

/**
 * Calculates new hash value based on existing hash and delta
 * which consists of the new device message.
 *
 * @param {*} currHash Exising hash value stored in management database
 * @param {*} message Device message to be used in hash calculation
 * @returns SHA1 hash
 */
const calcChangeHash = (currHash, message) => {
  const contents = message.tasks[0];
  const delta = stringify(contents);
  logger.info('Calculating new hash based on', {
    params: { currHash, delta }
  });
  return SHA1(currHash + delta).toString();
};

/**
 * Extracts message contents from device message
 *
 * @param {*} message
 * @returns message contents
 */
const toMessageContents = (message) => {
  return Array.isArray(message.tasks[0])
    ? message.tasks[0][0].message
    : message.tasks[0].message;
};

const setSyncStateOnJobQueueFunc = async (machineId, message) => {
  try {
    const device = await devices.findOne(
      { machineId: machineId },
      { 'sync.hash': 1, 'sync.state': 1, versions: 1 }
    );

    const { sync } = device;
    const { hash } = sync || {};
    if (hash === null || hash === undefined) {
      throw new Error('Failed to get device hash value');
    }

    // Reset hash value for full-sync messages
    const messageContents = toMessageContents(message);
    const newHash =
      messageContents !== 'sync-device' ? calcChangeHash(hash, message) : '';

    const { state } = sync;
    const newState = state !== 'not-synced' ? 'syncing' : 'not-synced';
    logger.info('New sync state calculated, updating database', {
      params: { state, newState, hash, newHash }
    });

    // Update hash and reset autoSync state only when the added
    // job is not sync-device. The hash for sync-device job will be
    // reset after the job is completed. If sync-device job has
    // failed, the hash will not be changed.
    if (messageContents !== 'sync-device') {
      device.sync.state = newState;
      device.sync.hash = newHash;
      device.sync.autoSync = 'on';
      device.sync.trials = 0;
    } else {
      device.sync.state = newState;
    }
    await device.save();
  } catch (err) {
    logger.error('setSyncStateOnJobQueueFunc failed. A sync message may be sent soon', {
      params: { err: err.message, machineId, message }
    });
  }
};

/**
 * Modifies sync state based on the queued job.
 * Gets called whenever job gets saved in the device queue.
 *
 * @param {*} machineId Device machine Id
 * @param {*} message Device message to be used in hash calculation
 * @returns
 */
const setSyncStateOnJobQueue = async (machineId, message) => {
  lock.acquire(
    'setSyncStateOnJobQueue',
    async () => await setSyncStateOnJobQueueFunc(machineId, message)
  ).catch(async err => {
    // try one more time, now, outside of the lock.
    logger.error('setSyncStateOnJobQueue failed', {
      params: { err: err.message, machineId, message }
    });
    await setSyncStateOnJobQueueFunc(machineId, message);
  });
};

const updateSyncState = async (org, deviceId, state) => {
  // When moving to "synced" state we have to
  // also reset auto sync state and trials
  const set =
    state === 'synced'
      ? {
        'sync.state': state,
        'sync.autoSync': 'on',
        'sync.trials': 0
      }
      : { 'sync.state': state };
  return devices.updateOne(
    { org, _id: deviceId },
    { $set: set }
  );
};

const calculateNewSyncState = (mgmtHash, deviceHash, autoSync) => {
  // Calculate the next state in the state machine.
  // If hash values are equal, we assume MGMT
  // and device are synced. Otherwise, if auto
  // sync is on, the device can still be in
  // syncing phase, and if not - it should be
  // marked as "not-synced"
  if (mgmtHash === deviceHash) return 'synced';
  return autoSync === 'on' ? 'syncing' : 'not-synced';
};

const setAutoSyncOff = (deviceId) => {
  return devices.updateOne(
    { _id: deviceId },
    { 'sync.autoSync': 'off' },
    { upsert: false }
  );
};

const incAutoSyncTrials = (deviceId) => {
  return devices.updateOne(
    { _id: deviceId, 'sync.trials': { $lt: 2 } },
    { $inc: { 'sync.trials': 1 } },
    { upsert: false }
  );
};

const queueFullSyncJob = async (device, hash, org, username = 'system') => {
  // Queue full sync job
  // Add current hash to message so the device can
  // use it to check if it is already synced
  const { machineId, hostname, deviceId } = device;

  const params = {
    requests: []
  };

  // Create sync message tasks
  const tasks = [{ entity: 'agent', message: 'sync-device', params }];
  const completeHandlers = {};
  for (const [module, handlers] of Object.entries(syncHandlers)) {
    const { syncHandler } = handlers;
    const {
      requests,
      completeCbData,
      callComplete
    } = await syncHandler(deviceId, org, device);

    // Add the requests to the sync message params object
    requests.forEach(subTask => {
      tasks[0].params.requests.push(subTask);
    });
    // If complete handler should be called, add its
    // data to the sync-device data stored on the job
    if (callComplete) completeHandlers[module] = completeCbData;
  }

  // Increment auto sync trials
  var res = await incAutoSyncTrials(deviceId);
  // when no trials were incremented, this means that the maximum
  // limit of retries has been reached.
  if (res.nModified === 0) {
    // Set auto sync off if auto sync limit is exceeded
    logger.info('Auto sync limit is exceeded, setting autosync off', {
      params: { deviceId }
    });
    await setAutoSyncOff(deviceId);
    return;
  }

  const job = await deviceQueues.addJob(
    machineId,
    username,
    org,
    // Data
    { title: 'Sync device ' + hostname, tasks: tasks },
    // Response data
    {
      method: 'sync',
      data: {
        handlers: completeHandlers,
        machineId
      }
    },
    // Metadata
    { priority: 'normal', attempts: 1, removeOnComplete: false },
    // Complete callback
    null
  );

  logger.info('Sync device job queued', {
    params: { deviceId, jobId: job.id }
  });
  return job;
};

/**
 * Called when full sync device job completed
 * Resets sync hash value in the database. When non-sync-device job
 * is applied (e.g. modify-device), the new hash value gets updated
 * in the database immediately, regardless whether or not the job
 * succeeds (calculated hash should reflect the desired state). However,
 * when sync-device job gets applied, the update of the hash gets deferred
 * and is updated after the sync-device job is completed successfully,
 * otherwise the hash value stays unchanged.
 * Calls the different module's sync complete callback
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  const { handlers, machineId } = res;

  // Reset hash value for full-sync messages
  logger.info('Updating hash after full-sync job succeeded', {
    params: { }
  });
  await devices.updateOne(
    { machineId: machineId },
    { 'sync.hash': '' },
    { upsert: false }
  );

  // Call the different module's sync complete callback
  for (const [module, data] of Object.entries(handlers)) {
    const { completeHandler } = syncHandlers[module];
    if (completeHandler) {
      await completeHandler(jobId, data);
    }
  }
};

/**
 * Called when full sync job failed
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.error('Sync device job failed', {
    params: { result: res, jobId: jobId }
  });
};

/**
 * Updates sync state based on the last job status. This function
 * is needed for legacy devices (agent version <2) and needs to be
 * removed later. For devices with agent version >= 2 the sync state
 * is based on the configuration hash responses coming from the device.
 *
 * @param {*} org Organization
 * @param {*} deviceId Device Id
 * @param {*} machineId Device Machine Id
 * @param {*} isJobSucceeded Successful Job Completion Flag
 * @returns
 */
const updateSyncStatusBasedOnJobResult = async (org, deviceId, machineId, isJobSucceeded) => {
  try {
    // Get device version
    const { versions } = await devices.findOne(
      { org, _id: deviceId },
      { versions: 1 }
    )
      .lean();

    logger.debug('No job update sync status for this device', {
      params: { machineId, agentVersion: versions.agent }
    });

    // only devices version <2 will have the unknown status. This is
    // needed for backward compatibility.
    const newState = isJobSucceeded ? 'synced' : 'unknown';
    await updateSyncState(org, deviceId, newState);
    logger.info('Device sync state updated', {
      params: {
        deviceId,
        newState
      }
    });
  } catch (err) {
    logger.error('Device sync state update failed', {
      params: { deviceId, error: err.message }
    });
  }
};

/**
 * Periodically checks and updated device status based on the status
 * report from the device. Triggered from deviceStatus.
 *
 * @param {*} org Device organization
 * @param {*} deviceId Device id
 * @param {*} machineId Machine id
 * @param {*} deviceHash Reported current device hash value
 * @returns
 */
const updateSyncStatus = async (org, deviceId, machineId, deviceHash) => {
  try {
    // Get current device sync status
    const device = await devices.findOne(
      { org, _id: deviceId },
      { sync: 1, hostname: 1, versions: 1, deviceSpecificRulesEnabled: 1, firewall: 1 }
    )
      .lean();

    if (!device) {
      logger.error('Sync state update failed, device not found', {
        params: { deviceId }
      });
      return;
    }
    const { sync, hostname, versions, deviceSpecificRulesEnabled, firewall } = device;
    // Calculate the new sync state based on the hash
    // value received from the agent and the current state
    const { state, hash, autoSync, trials } = sync;
    const newState = calculateNewSyncState(hash, deviceHash, autoSync);
    const isStateChanged = state !== newState;
    // Update the device sync state if it has changed
    if (isStateChanged) {
      await updateSyncState(org, deviceId, newState);
      logger.info('Device sync state updated', {
        params: {
          deviceId,
          formerState: state,
          newState,
          hash,
          deviceHash
        }
      });
    }
    // TODO Notify the user about the new state of the device
    // If the device is not-synced, the user has to first resync
    // the device manually
    if (['synced', 'not-synced'].includes(newState)) {
      return;
    }

    // Don't attempt to sync if there are pending jobs
    // in the queue, as sync state might change when
    // the jobs are completed
    const pendingJobs = await deviceQueues.getOPendingJobsCount(machineId);
    if (pendingJobs > 0) {
      logger.error('Full sync skipped due to pending jobs', {
        params: { deviceId, machineId, pendingJobs, newState, trials }
      });
      return;
    }

    logger.info('Queueing full-sync job', {
      params: { deviceId, state, newState, hash, trials }
    });
    await queueFullSyncJob({
      deviceId, machineId, hostname, versions, deviceSpecificRulesEnabled, firewall
    }, hash, org);
  } catch (err) {
    logger.error('Device sync state update failed', {
      params: { deviceId, error: err.message }
    });
  }
};

const apply = async (device, user, data) => {
  const {
    _id, isApproved, machineId, hostname, org, versions, deviceSpecificRulesEnabled, firewall
  } = device[0];

  if (!isApproved) {
    logger.error('Sync failed, the device is not approved', { params: { machineId } });
    throw (new Error('Sync device failed, please approve device first'));
  }

  // Reset auto sync in database
  const updDevice = await devices.findOneAndUpdate(
    { org, _id },
    {
      'sync.state': 'syncing',
      'sync.autoSync': 'on',
      'sync.trials': 0
    },
    { sync: 1, new: true }
  ).lean();

  // release existing limiters if the device is blocked
  await reconfigErrorsLimiter.release(_id.toString());
  await releasePublicAddrLimiterBlockage(device[0]);
  await activatePendingTunnelsOfDevice(updDevice, true);

  // Get device current configuration hash
  const { sync } = await devices.findOne(
    { org, _id },
    { sync: 1 }
  )
    .lean();

  const { hash } = sync;
  const job = await queueFullSyncJob(
    { deviceId: _id, machineId, hostname, versions, deviceSpecificRulesEnabled, firewall },
    hash,
    org,
    user.username
  );

  if (!job) {
    logger.error('Sync device job failed', { params: { machineId } });
    throw (new Error('Sync device job failed'));
  }

  return {
    ids: [job.id],
    status: 'completed',
    message: ''
  };
};

/**
 * Function that put given devices in syncing state
 * so the system will send sync immediately
 *
 * @param {array} devicesIds List of devices to put in syncing state
 * @returns
 */
const forceDevicesSync = async devicesIds => {
  await devices.updateMany(
    { _id: { $in: devicesIds } },
    {
      $set: {
        // set hardcoded hash to trigger a change on next get-device-stats
        'sync.hash': 'FORCE_SYNC',
        'sync.state': 'syncing',
        'sync.autoSync': 'on',
        'sync.trials': 0
      }
    },
    { upsert: false }
  );
};

// Register a method that updates sync state
// from periodic status message flow
deviceStatus.registerSyncUpdateFunc(updateSyncStatus);

// Register a method that updates the sync
// state upon queuing a job to the device queue
deviceQueues.registerUpdateSyncMethod(setSyncStateOnJobQueue);

module.exports = {
  updateSyncStatus,
  updateSyncStatusBasedOnJobResult,
  apply,
  complete,
  error,
  forceDevicesSync
};
