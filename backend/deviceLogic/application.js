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
const applications = require('../models/applications');
const mongoConns = require('../mongoConns.js')();
const configs = require('../configs')();
const logger = require('../logging/logging')({
  module: module.filename,
  type: 'req'
});
const { devices } = require('../models/devices');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const ObjectId = require('mongoose').Types.ObjectId;

const {
  onJobComplete,
  onJobRemoved,
  onJobFailed,
  validateApplication,
  getJobParams
} = require('../applicationLogic/applications');

/**
 * Creates and queues add/remove deploy application jobs.
 * @async
 * @param  {Array}    deviceList    an array of the devices to be modified
 * @param  {Object}   user          User object
 * @param  {Object}   data          Additional data used by caller
 * @return {None}
 */
const apply = async (deviceList, user, data) => {
  const { org } = data;
  const { op, id } = data.meta;

  let app, session, deviceIds;
  const requestTime = Date.now();

  try {
    session = await mongoConns.getMainDB().startSession();

    await session.withTransaction(async () => {
      // Get application
      app = await applications.findOne({
        org: org,
        _id: id
      }).populate('libraryApp').lean().session(session);

      // if the user selected multiple devices, the request goes to devicesApplyPOST function
      // and the deviceList variable here contain *all* the devices even they are not selected.
      // therefore we need to filter this array by devices array that comes from request body.
      // if the user select only one device, the data.devices is equals to null
      // and this device is passed in the url path
      if (data.devices) {
        deviceList = deviceList.filter(d => data.devices.hasOwnProperty(d._id));
      }

      // get the devices id by updated device list
      deviceIds = deviceList.map(d => d._id);

      if (op === 'deploy') {
        if (!app || app.removed) {
          throw createError(500, `Application ${id} does not purchased`);
        }
      }

      const { valid, err } = validateApplication(app, op, deviceIds);
      if (!valid) {
        throw createError(500, err);
      }

      // Save status in the devices
      const query = {
        _id: { $in: deviceIds },
        org: org
      };

      let update;

      if (op === 'deploy') {
        for (let i = 0; i < deviceList.length; i++) {
          const device = deviceList[i];
          const query = { _id: device._id };

          const appExists = device.applications && device.applications.find(
            a => a.applicationInfo && a.applicationInfo.toString() === app._id.toString());

          if (appExists) {
            if (appExists.status === 'installing') {
              throw createError(500, `Device ${device.name} has a pending installation job`);
            }

            query['applications.applicationInfo'] = id;
            update = {
              $set: { 'applications.$.status': 'installing' }
            };
          } else {
            update = {
              $push: {
                applications: {
                  applicationInfo: app._id,
                  status: 'installing',
                  requestTime: requestTime
                }
              }
            };
          }

          // this updated should be for each device separately
          // because some of them already have this application and some of them haven't
          await devices.updateOne(query, update, { upsert: false }).session(session);
        }

        // set update to null because we are already updated in this case
        update = null;
      } else if (op === 'upgrade') {
        query['applications.applicationInfo'] = id;

        update = {
          $set: { 'applications.$.status': 'upgrading' }
        };
      } else if (op === 'config') {
        query['applications.applicationInfo'] = id;

        update = {
          $set: { 'applications.$.status': 'installing' }
        };
      } else if (op === 'uninstall') {
        query['applications.applicationInfo'] = id;

        update = {
          $set: { 'applications.$.status': 'uninstalling' }
        };
      }

      if (update) {
        await devices.updateMany(query, update, { upsert: false }).session(session);
      }
    });
  } catch (error) {
    throw error.name === 'MongoError' ? new Error() : error;
  } finally {
    session.endSession();
  }

  // Queue applications jobs. Fail the request if
  // there are jobs that failed to be queued
  const jobs = await queueApplicationJob(
    deviceList,
    op,
    requestTime,
    app,
    user,
    org
  );

  const failedToQueue = [];
  const succeededToQueue = [];
  jobs.forEach((job) => {
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
    const failedDevices = failedToQueue.map((ent) => {
      const { job } = ent.reason;
      const { _id } = job.data.response.data.application.device;
      return _id;
    });

    logger.error('Application jobs queue failed', {
      params: { jobId: failedToQueue[0].reason.job.id, devices: failedDevices }
    });

    // Update devices application status in the database
    await devices.updateMany(
      {
        _id: { $in: failedDevices },
        org: org,
        'applications.applicationInfo': app._id
      },
      { $set: { 'applications.$.status': 'job queue failed' } },
      { upsert: false }
    );

    status = 'partially completed';
    message = `${succeededToQueue.length} of ${jobs.length} application jobs added`;
  }

  return {
    ids: succeededToQueue,
    status,
    message
  };
};

/**
 * Called when add/remove application is job completed.
 * Updates the status of the application in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async (jobId, res) => {
  logger.info('Application job completed', {
    params: { result: res, jobId: jobId }
  });

  const { op, org, app } = res.application;
  const { _id } = res.application.device;
  try {
    const update =
      op === 'deploy' || op === 'upgrade' || op === 'config'
        ? { $set: { 'applications.$.status': 'installed' } }
        : { $set: { 'applications.$.status': 'uninstalled' } };

    // on complete, update db with updated data
    if (op === 'upgrade') {
      // update version on db
      await applications.updateOne(
        { org: org, _id: app._id },
        { $set: { installedVersion: app.libraryApp.latestVersion, pendingToUpgrade: false } }
      );
    }

    await devices.updateOne(
      {
        _id: _id,
        org: org,
        'applications.applicationInfo': app._id
      },
      update,
      { upsert: false }
    );

    // do actions on job complete
    await onJobComplete(org, app, op, ObjectId(_id));
  } catch (err) {
    logger.error('Device application status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
};

/**
 * Called when add/remove application job fails and
 * Updates the status of the application in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.error('Application job failed', {
    params: { result: res, jobId: jobId }
  });

  const { op, org, app } = res.application;
  const { _id } = res.application.device;

  try {
    let status = '';

    switch (op) {
      case 'deploy':
        status = 'installation failed';
        break;
      case 'config':
        status = 'configuration failed';
        break;
      case 'uninstall':
        status = 'uninstallation failed';
        break;
      default:
        status = 'job failed';
        break;
    }

    await devices.updateOne(
      { _id: _id, org: org, 'applications.applicationInfo': app._id },
      { $set: { 'applications.$.status': status } },
      { upsert: false }
    );

    // do actions on job failed
    await onJobFailed(org, app, op, _id);
  } catch (err) {
    logger.error('Device policy status update failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
  }
};

/**
 * Called when add/remove application job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion/failure
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  const { org, app, device, op } = job.data.response.data.application;
  const { _id } = device;

  if (['inactive', 'delayed'].includes(job._state)) {
    logger.info('Application job removed', {
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
          'applications.applicationInfo': app._id
        },
        { $set: { 'applications.$.status': status } },
        { upsert: false }
      );

      // do actions on app removed
      await onJobRemoved(org, app, op, ObjectId(_id));
    } catch (err) {
      logger.error('Device application status update failed', {
        params: { job: job, status: status, err: err.message }
      });
    }
  }
};

const queueApplicationJob = async (
  deviceList,
  op,
  requestTime,
  application,
  user,
  org
) => {
  const jobs = [];

  // set job title to be shown to the user on Jobs screen
  // and job message to be handled by the device
  let jobTitle = '';
  let message = '';
  if (op === 'deploy') {
    jobTitle = `Install ${application.libraryApp.name} application`;
    message = 'install-service';
  } else if (op === 'upgrade') {
    jobTitle = `Upgrade ${application.libraryApp.name} application`;
    message = 'upgrade-service';
  } else if (op === 'config') {
    jobTitle = `Update ${application.libraryApp.name} configuration`;
    message = 'modify-service';
  } else if (op === 'uninstall') {
    jobTitle = `Uninstall ${application.libraryApp.name} application`;
    message = 'uninstall-service';
  } else {
    return jobs;
  }

  // generate job for each selected device
  for (let i = 0; i < deviceList.length; i++) {
    const dev = deviceList[i];

    const params = await getJobParams(dev, application, op);

    const tasks = [{
      entity: 'agent',
      message: message,
      params: params
    }];

    // response data
    const data = {
      application: {
        device: { _id: dev._id },
        app: application,
        requestTime: requestTime,
        op: op,
        org: org
      }
    };

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
          method: 'application',
          data: data
        },
        // Metadata
        { priority: 'high', attempts: op === 'deploy' ? 2 : 1, removeOnComplete: false },
        // Complete callback
        null
      )
    );
  }

  return Promise.allSettled(jobs);
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error,
  remove: remove
};
