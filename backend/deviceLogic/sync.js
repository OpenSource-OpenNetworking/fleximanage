
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

// Create a list of all sync handlers
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

const calcChangeHash = (currHash, message) => {
  const contents = message.tasks;
  return SHA1(currHash + stringify(contents)).toString();
};

const setSyncStateOnJobQueue = async (machineId, message) => {
  // Calculate the new configuration hash
  const { sync } = await devices.findOne(
    { machineId: machineId },
    { 'sync.hash': 1 }
  )
    .lean();
  const { hash } = sync || {};
  if (hash === null || hash === undefined) {
    throw new Error('Failed to get device hash value');
  }

  // Reset hash value for full-sync messages
  const messageContents = Array.isArray(message.tasks[0])
    ? message.tasks[0][0].message
    : message.tasks[0].message;
  const newHash =
    messageContents !== 'sync-device' ? calcChangeHash(hash, message) : '';

  const { state } = sync;
  const newState = state !== 'not-synced' ? 'syncing' : 'not-synced';
  return devices.updateOne(
    { machineId: machineId },
    { 'sync.state': newState, 'sync.hash': newHash },
    { upsert: false }
  );
};

// Register a method that updates the sync
// state upon queuing a job to the device queue
deviceQueues.registerUpdateSyncMethod(setSyncStateOnJobQueue);

const updateSyncState = (org, deviceId, state) => {
  // When moving to "synced" state we have to
  // also reset auto sync state and trials
  const set =
    state === 'synced'
      ? {
        'sync.state': state,
        'sync.autoSync': 'on',
        'sync.trials': 0,
        'sync.failedJobRetried': false
      }
      : { 'sync.state': state };
  return devices.updateOne(
    { org, _id: deviceId },
    { $set: set }
  );
};

const calculateNewSyncState = (currHash, newHash, autoSyncState) => {
  // Calculate the next state in the state machine.
  // If hash values are equal, we assume MGMT
  // and device are synced. Otherwise, if auto
  // sync is on, the device can still be in
  // syncing phase, and if not - it should be
  // marked as "not-synced"
  if (currHash === newHash) return 'synced';
  return autoSyncState === 'on' ? 'syncing' : 'not-synced';
};

const setFailedJobFlagInDB = (deviceId) => {
  return devices.updateOne(
    { _id: deviceId },
    { 'sync.failedJobRetried': true },
    { upsert: false }
  );
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
    { _id: deviceId },
    { $inc: { 'sync.trials': 1 } },
    { upsert: false }
  );
};

const queueFullSyncJob = async (device, hash, org) => {
  // Queue full sync job
  // Add current hash to message so the device can
  // use it to check if it is already synced
  const { machineId, hostname, deviceId } = device;

  // Reset device command might change IP address of the
  // interface connected to the MGMT. Tell the agent to
  // reconnect to the MGMT after processing this command.
  const params = {
    type: 'full-sync',
    'router-cfg-hash': hash,
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
        handlers: completeHandlers
      }
    },
    // Metadata
    { priority: 'medium', attempts: 1, removeOnComplete: false },
    // Complete callback
    null
  );

  // Increment auto sync trials
  await incAutoSyncTrials(deviceId);

  logger.info('Sync device job queued', {
    params: { deviceId, jobId: job }
  });
  return job;
};

/**
 * Called when full sync device job completed
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = async (jobId, res) => {
  logger.info('Sync device job complete', {
    params: { result: res, jobId: jobId }
  });

  // Call the different module's sync complete callback
  const { handlers } = res;
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

const updateSyncStatus = async (org, deviceId, machineId, deviceHash) => {
  try {
    // Get current device sync status
    const { sync, hostname } = await devices.findOne(
      { org, _id: deviceId },
      { sync: 1, hostname: 1 }
    )
      .lean();

    // Calculate the new sync state based on the hash
    // value received from the agent and the current state
    const { state, hash, autoSync, failedJobRetried } = sync;
    const newState = calculateNewSyncState(hash, deviceHash, autoSync);

    // Update the device sync state if it has changed
    if (state !== newState) {
      await updateSyncState(org, deviceId, newState);
      logger.info('Device sync state updated', {
        deviceId,
        formerState: state,
        newState
      });
    }

    // If the device is synced, we have nothing to do anyway.
    // If the device is not-synced, user has to first resync
    // the device manually
    if (['synced', 'not-synced'].includes(newState)) return;

    // Don't attempt to sync if there are pending jobs
    // in the queue, as sync state might change when
    // the jobs are completed
    const waitingJobs = await deviceQueues.getCount('inactive');
    const runningJobs = await deviceQueues.getCount('active');
    if (waitingJobs > 0 || runningJobs > 0) {
      logger.debug('Full sync skipped due to pending jobs', {
        params: { deviceId, waitingJobs, runningJobs }
      });
      return;
    }

    // Attempt to sync the device. First, retry the last
    // failed job in the queue, if there's one. If not,
    // queue a full sync job
    if (!failedJobRetried) {
      const { _state, id, data } = await deviceQueues.getLastJob(machineId);
      const { message } = Array.isArray(data.message.tasks[0])
        ? data.message.tasks[0][0] : data.message.tasks[0];

      // Don't retry full sync jobs
      if (message !== 'sync-device' && _state === 'failed') {
        logger.debug('Failed job retry before full sync attempt', {
          params: { deviceId, jobId: id, message }
        });
        await deviceQueues.retryJob(id);
      }
      // Try the last failed job only once
      await setFailedJobFlagInDB(deviceId);
      return;
    }

    // Set auto sync off if auto sync limit is exceeded
    const { trials } = sync;
    if (trials >= 3) {
      await setAutoSyncOff(deviceId);
      return;
    }
    await queueFullSyncJob({ deviceId, machineId, hostname }, hash, org);
  } catch (err) {
    logger.error('Device sync state update failed', {
      params: { deviceId, error: err.message }
    });
  }
};

const apply = async (device, user, data) => {
  const { _id, machineId, hostname, org } = device[0];
  // Get device current configuration hash
  const { sync } = await devices.findOneAndUpdate(
    { org, _id },
    {
      'sync.state': 'syncing',
      'sync.autoSync': 'on',
      'sync.trials': 0,
      'sync.failedJobRetried': false
    },
    { sync: 1 }
  )
    .lean();

  const { hash } = sync;
  const job = await queueFullSyncJob(
    { deviceId: _id, machineId, hostname },
    hash,
    org
  );

  return {
    ids: [job.id],
    status: 'completed',
    message: ''
  };
};

// Register a method that updates sync state
// from periodic status message flow
deviceStatus.registerSyncUpdateFunc(updateSyncStatus);

module.exports = {
  updateSyncStatus,
  apply,
  complete,
  error
};
