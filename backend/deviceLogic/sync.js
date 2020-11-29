
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
const policySyncHandler = require('./mlpolicy').sync;
const policyCompleteHandler = require('./mlpolicy').completeSync;
const deviceConfSyncHandler = require('./modifyDevice').sync;
const deviceConfCompleteHandler = require('./modifyDevice').completeSync;
const tunnelsSyncHandler = require('./tunnels').sync;
const tunnelsCompleteHandler = require('./tunnels').completeSync;
const appIdentificationSyncHandler = require('./appIdentification').sync;
const appIdentificationCompleteHandler = require('./appIdentification').completeSync;
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const stringify = require('json-stable-stringify');
const SHA1 = require('crypto-js/sha1');
const { getMajorVersion } = require('../versioning');

// Create a object of all sync handlers
const syncHandlers = {
  deviceConf: {
    syncHandler: deviceConfSyncHandler,
    completeHandler: deviceConfCompleteHandler
  },
  tunnels: {
    syncHandler: tunnelsSyncHandler,
    completeHandler: tunnelsCompleteHandler
  },
  policies: {
    syncHandler: policySyncHandler,
    completeHandler: policyCompleteHandler
  },
  appIdentification: {
    syncHandler: appIdentificationSyncHandler,
    completeHandler: appIdentificationCompleteHandler
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

/**
 * Modifies sync state based on the queued job.
 * Gets called whenever job gets saved in the device queue.
 *
 * @param {*} machineId Device machine Id
 * @param {*} message Device message to be used in hash calculation
 * @returns
 */
const setSyncStateOnJobQueue = async (machineId, message) => {
  // Calculate the new configuration hash
  const { sync, versions } = await devices.findOne(
    { machineId: machineId },
    { 'sync.hash': 1, 'sync.state': 1, versions: 1 }
  )
    .lean();

  const majorAgentVersion = getMajorVersion(versions.agent);
  if (majorAgentVersion < 2) {
    logger.debug('No update sync status on job queue for this device', {
      params: { machineId, agentVersion: versions.agent }
    });
    return;
  }

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
  const updateFields = messageContents !== 'sync-device'
    ? {
      'sync.state': newState,
      'sync.hash': newHash,
      'sync.autoSync': 'on',
      'sync.trials': 0
    }
    : { 'sync.state': newState };

  return devices.updateOne(
    { machineId: machineId },
    updateFields,
    { upsert: false }
  );
};

const updateSyncState = (org, deviceId, state) => {
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
    { _id: deviceId, 'sync.trials': { $lt: 3 } },
    { $inc: { 'sync.trials': 1 } },
    { upsert: false }
  );
};

const queueFullSyncJob = async (device, org) => {
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
    } = await syncHandler(deviceId, org);

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
    'system',
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
    { priority: 'low', attempts: 1, removeOnComplete: false },
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
  logger.info('Sync device job complete', {
    params: { result: res, jobId: jobId }
  });

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

    const majorAgentVersion = getMajorVersion(versions.agent);
    if (majorAgentVersion >= 2) {
      logger.debug('No job update sync status for this device', {
        params: { machineId, agentVersion: versions.agent }
      });
      return;
    }

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
    const { sync, hostname, versions } = await devices.findOne(
      { org, _id: deviceId },
      { sync: 1, hostname: 1, versions: 1 }
    )
      .lean();

    const majorAgentVersion = getMajorVersion(versions.agent);
    if (majorAgentVersion < 2) {
      logger.debug('No periodic update sync status for this device', {
        params: { machineId, agentVersion: majorAgentVersion }
      });
      return;
    }

    // Calculate the new sync state based on the hash
    // value received from the agent and the current state
    const { state, hash, autoSync, trials } = sync;
    const newState = calculateNewSyncState(hash, deviceHash, autoSync);
    logger.debug('updateSyncStatus calculateNewSyncState', {
      params: { state, newState, hash, deviceHash, autoSync, trials }
    });

    // Update the device sync state if it has changed
    if (state !== newState) {
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

    // If the device is synced, we have nothing to do anyway.
    // If the device is not-synced, user has to first resync
    // the device manually
    if (['synced', 'not-synced'].includes(newState)) return;

    // Don't attempt to sync if there are pending jobs
    // in the queue, as sync state might change when
    // the jobs are completed
    const pendingJobs = await deviceQueues.getOPendingJobsCount(machineId);
    if (pendingJobs > 0) {
      logger.error('Full sync skipped due to pending jobs', {
        params: { deviceId, pendingJobs, newState, trials }
      });
      return;
    }

    logger.info('Queueing full-sync job', {
      params: { deviceId, state, newState, hash, trials }
    });
    await queueFullSyncJob({ deviceId, machineId, hostname }, org);
  } catch (err) {
    logger.error('Device sync state update failed', {
      params: { deviceId, error: err.message }
    });
  }
};

const apply = async (device, user, data) => {
  const { _id, machineId, hostname, org, versions } = device[0];

  if (getMajorVersion(versions.agent) < 2) {
    return;
  }

  // Reset auto sync in database
  await devices.findOneAndUpdate(
    { org, _id },
    {
      'sync.state': 'syncing',
      'sync.autoSync': 'on',
      'sync.trials': 0
    },
    { sync: 1 }
  );

  const job = await queueFullSyncJob(
    { deviceId: _id, machineId, hostname },
    org
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
  error
};
