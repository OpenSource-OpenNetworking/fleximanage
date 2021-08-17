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

const express = require('express');
const bodyParser = require('body-parser');
const { devices, staticroutes } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const wrapper = require('./wrapper');
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const cors = require('./cors');
const { verifyPermission } = require('../authenticate');
const mongoose = require('mongoose');
const mongoConns = require('../mongoConns.js')();
const createError = require('http-errors');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateDevice } = require('../deviceLogic/validators');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const Joi = require('@hapi/joi');

const flexibilling = require('../flexibilling');

const devicesRouter = express.Router();
devicesRouter.use(bodyParser.json());

// Routes supported under /devices
// /                        - Operations on all devices (GET, POST, DELETE)
// /apply                   - Apply logic operation for all devices, logic type in the message body
// /latestVersions          - GET devices latest software versions
// /:deviceID               - Operations on a specific device (GET, PUT, DELETE)
// /:deviceID/interfaces    - Operations on device interfaces
// /:deviceID/apply         - Apply logic operation for a specific device
// /:deviceID/configuration - Get configuration of a specific device
// /:deviceID/logs          - Get logs of a specific device
// /:deviceID/routes        - Get routes of a specific device
// /:deviceID/send          - Send API message to a specific device, ** only for testing **

const formatErr = (err, msg) => {
  // Check for unique error
  if (err.name === 'MongoError' && err.code === 11000) {
    return ({ status: 500, error: 'Device ' + msg.name + ' already exists' });
  } else if (err.message) {
    return ({ status: 500, error: err.message });
  } else {
    return ({ status: 500, error: 'Unable to format error' });
  }
};

const checkUpdReq = (qtype, req) => new Promise(function (resolve, reject) {
  if (qtype === 'DELETE') {
    // Make sure no tunnels exist for a deleted device
    // TBD: Remove this limitation when we add queue support
    tunnelsModel.find({
      $or: [{ deviceA: req.params.deviceId }, { deviceB: req.params.deviceId }],
      isActive: true,
      org: req.user.defaultOrg._id
    })
      .then(async (tunnelFound) => {
        if (tunnelFound.length > 0) {
          logger.warn('Tunnels found when deleting device',
            { params: { deviceId: req.params.deviceId }, req: req });
          reject(new Error('All device tunnels must be deleted before deleting a device'));
        } else {
          // start session/transaction
          const session = await mongoConns.getMainDB().startSession();
          await session.startTransaction();
          // Disconnect deleted device socket
          devices.find({
            _id: mongoose.Types.ObjectId(req.params.deviceId),
            org: req.user.defaultOrg._id
          }).session(session)
            .then(async (mres) => {
              if (!mres.length) throw new Error('Device for deletion not found');
              connections.deviceDisconnect(mres[0].machineId);
              const deviceCount = await devices.countDocuments({
                account: mres[0].account
              }).session(session);

              const deviceOrgCount = await devices.countDocuments({
                account: mres[0].account, org: req.user.defaultOrg._id
              }).session(session);
              // Unregister a device (by adding -1)
              await flexibilling.registerDevice({
                account: mres[0].account,
                org: req.user.defaultOrg._id,
                count: deviceCount,
                orgCount: deviceOrgCount,
                increment: -1
              }, session);
              resolve({ ok: 1, session });
            }, async (err) => {
              if (session) { await session.abortTransaction(); };
              logger.warn('Error finding device', {
                params: { method: qtype, err: err.message },
                req: req
              });
              reject(err);
            })
            .catch(async (err) => {
              if (session) { await session.abortTransaction(); };
              logger.warn('Error finding device', {
                params: { method: qtype, err: err.message },
                req: req
              });
              reject(err);
            });
        }
      }, (err) => {
        reject(new Error('Delete device, tunnels find error, please try again'));
      })
      .catch((err) => {
        reject(new Error('Delete device, tunnels find error, please try again'));
      });
  } else if (qtype === 'PUT') {
    devices.find({
      _id: mongoose.Types.ObjectId(req.params.deviceId),
      org: req.user.defaultOrg._id
    })
      .then((mres) => {
        // Don't allow any changes if the device is not approved
        if (!mres[0].isApproved && !req.body.isApproved) {
          return reject(new Error('Device must be first approved'));
        }

        // Validate device changes only for approved devices,
        // and only if the request contains interfaces.
        if (mres[0].isApproved && req.body.interfaces) {
          const { valid, err } = validateDevice(req.body);
          if (!valid) {
            logger.warn('Device update failed',
              {
                params: { device: req.body, err: err },
                req: req
              });
            return reject(new Error(err));
          }
        }

        // If device changed to not approved disconnect it's socket
        if (req.body.isApproved === false) connections.deviceDisconnect(mres[0].machineId);
        // Don't allow to update the unchangeable fields
        delete req.body.machineId;
        delete req.body.org;
        delete req.body.hostname;
        delete req.body.ipList;
        delete req.body.fromToken;
        delete req.body.deviceToken;
        delete req.body.state;
        delete req.body.emailTokens;
        delete req.body.defaultAccount;
        delete req.body.defaultOrg;

        // Currently we allow only one change at a time to the device,
        // to prevent inconsistencies between the device and the MGMT database.
        // Therefore, we block the request if there's a pending change in the queue.
        if (mres[0].pendingDevModification) {
          return reject(new Error('Only one device change is allowed at any time'));
        }
        resolve({ ok: 1 });
      }, (err) => {
        logger.warn('Error finding device', {
          params: { method: qtype, err: err.message },
          req: req
        });
        reject(err);
      })
      .catch((err) => {
        logger.warn('Error finding device', {
          params: { method: qtype, err: err.message },
          req: req
        });
        reject(err);
      });
  } else {
    resolve({ ok: 1 });
  }
});

const updResp = (qtype, req, res, next, resp, origDoc = null) => {
  // Disabling this line assuming this code is about to be removed.
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    if (qtype === 'DELETE') {
      resolve({ ok: 1 });
    } else if (qtype === 'GET') {
      // Update connected property for all returned devices
      resp.forEach(d => {
        d.isConnected = connections.isConnected(d.machineId);
        // Add interface stats to mongoose response
        d.set(
          'deviceStatus',
          d.isConnected ? deviceStatus.getDeviceStatus(d.machineId) || 0 : 0,
          { strict: false }
        );

        // // Add tunnel status
        // d.set("tunnelStatus",
        //     d.isConnected ? (deviceStatus.getTunnelStatus(d.machineId) || null) : null,
        //     { strict: false });

        // TBD: If no interfaces found try to read from device and update database
        /*
            if (d.interfaces.length == 0) {
                console.log("No, interfaces. Try reading from device...");
                console.log(JSON.stringify(
                  updDeviceInterfaces(req.user.defaultOrg._id, d.machineId)));
            } else {
                console.log("Interfaces found...");
                console.log(JSON.stringify(d.interfaces));
            }
            */
      });
      resolve({ ok: 1 });
    } else if (qtype === 'PUT') {
      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      if (origDoc) {
        try {
          await dispatcher.apply([origDoc], 'modify', req.user, {
            newDevice: resp
          });
          return resolve({ ok: 1 });
        } catch (err) {
          return reject(err);
        }
      }

      resolve({ ok: 1 });
    } else {
      resolve({ ok: 1 });
    }
  });
};

const checkDeviceBaseApi = (qtype, req) => new Promise(function (resolve, reject) {
  // Creating new devices should be done only via the /register API
  if (qtype === 'POST') {
    return reject(new Error('Device creation should be done via registration process'));
  }
});

wrapper.assignRoutes(
  devicesRouter,
  'devices',
  '/',
  devices,
  formatErr,
  checkDeviceBaseApi,
  updResp
);

// Get devices latest software version
devicesRouter.route('/latestVersions')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, async (req, res, next) => {
    try {
      const swUpdater = await DevSwUpdater.getSwVerUpdaterInstance();
      return res
        .status(200)
        .send({
          versions: swUpdater.getLatestSwVersions(),
          versionDeadline: swUpdater.getVersionUpDeadline()
        });
    } catch (err) {
      return next(err);
    }
  });

// upgrade scheduler
devicesRouter.route('/upgdSched')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.corsWithOptions, async (req, res, next) => {
    try {
      const query = { _id: { $in: req.body.devices } };
      const numOfIdsFound = await devices.countDocuments(query);

      // The request is considered invalid if not all device IDs
      // are found in the database. This is done to prevent a partial
      // schedule of the devices in case of a user's mistake.
      if (numOfIdsFound < req.body.devices.length) {
        return next(createError(404, 'Some devices were not found'));
      }

      const set = { $set: { upgradeSchedule: { time: req.body.date, jobQueued: false } } };
      const options = { upsert: false, useFindAndModify: false };
      await devices.updateMany(query, set, options);
    } catch (err) {
      return next(err);
    }
    return res.status(200).send({});
  });

// device-specific upgrade scheduler
devicesRouter.route('/:deviceId/upgdSched')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.corsWithOptions, async (req, res, next) => {
    try {
      const query = { _id: req.params.deviceId };
      const set = { $set: { upgradeSchedule: { time: req.body.date, jobQueued: false } } };
      const options = { upsert: false, useFindAndModify: false };
      const res = await devices.updateOne(query, set, options);
      if (res.n === 0) return next(createError(404));
    } catch (err) {
      return next(err);
    }
    return res.status(200).send({});
  });

// Apply operation for all devices
devicesRouter.route('/apply')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.corsWithOptions, verifyPermission('devices', 'post'), (req, res, next) => {
    // Find all devices of the organization
    devices.find({ org: req.user.defaultOrg._id })
      .then(async (devices) => {
        await dispatcher.apply(devices, req.body.method, req.user, req.body);
        return res.status(200).send({});
      }, (err) => { next(err); })
      .catch((err) => {
        logger.warn('Apply operation failed', { params: { err: err.message }, req: req });
        return next(createError(500, 'Device Sync'));
      });
  });

// wrapper routes
wrapper.assignRoutes(
  devicesRouter,
  'devices',
  '/:deviceId',
  devices,
  formatErr,
  checkUpdReq,
  updResp
);
wrapper.assignRoutes(
  devicesRouter,
  'devices',
  '/:deviceId/interfaces',
  devices,
  formatErr,
  null,
  null
);

// apply command handler
devicesRouter.route('/:deviceId/apply')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.corsWithOptions, verifyPermission('devices', 'post'), (req, res, next) => {
    devices
      .find({
        _id: mongoose.Types.ObjectId(req.params.deviceId),
        org: req.user.defaultOrg._id
      })
      .then(async device => {
        if (device.length === 1) {
          await dispatcher.apply(device, req.body.method, req.user, req.body);
          return res.status(200).send({});
        } else {
          return next(createError(500, 'Device error'));
        }
      },
      err => {
        next(err);
      })
      .catch(err => {
        logger.warn('Apply operation failed', {
          params: { err: err.message },
          req: req
        });
        return next(createError(500, 'Apply device'));
      });
  });

devicesRouter.route('/:deviceId/configuration')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, verifyPermission('devices', 'get'), async (req, res, next) => {
    try {
      const device = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
      if (!device || device.length === 0) return next(createError(404, 'Device not found'));

      if (!connections.isConnected(device[0].machineId)) {
        return res.status(200).send({
          status: 'disconnected',
          configurations: []
        });
      }

      const deviceConf = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-config' },
        15000
      );

      if (!deviceConf.ok) {
        logger.error('Failed to get device configuration', {
          params: {
            deviceId: req.params.deviceId,
            response: deviceConf.message
          },
          req: req
        });
        return next(createError(500, 'Failed to get device configuration'));
      }

      return res.status(200).send({
        status: 'connected',
        configuration: deviceConf.message
      });
    } catch (err) {
      return next(createError(500));
    }
  });

const verifyLogsRequest = (req, res, next) => {
  const schema = Joi.object().keys({
    lines: Joi.number().integer().max(10000),
    filter: Joi.string().valid('all', 'fwagent')
  });
  const result = Joi.validate(req.query, schema);
  if (result.error) {
    return next(createError(400, result.error.details[0].message));
  }
  return next();
};

// Retrieves logs from device
devicesRouter.route('/:deviceId/logs')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions,
    verifyLogsRequest,
    verifyPermission('devices', 'get'),
    async (req, res, next) => {
      try {
        const device = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
        if (!device || device.length === 0) return next(createError(404, 'Device not found'));

        if (!connections.isConnected(device[0].machineId)) {
          return res.status(200).send({
            status: 'disconnected',
            log: []
          });
        }

        const deviceLogs = await connections.deviceSendMessage(
          null,
          device[0].machineId,
          {
            entity: 'agent',
            message: 'get-device-logs',
            params: {
              lines: req.query.lines || '100',
              filter: req.query.filter || 'all'
            }
          },
          15000
        );

        if (!deviceLogs.ok) {
          logger.error('Failed to get device logs', {
            params: {
              deviceId: req.params.deviceId,
              response: deviceLogs.message
            },
            req: req
          });
          return next(createError(500, 'Failed to get device logs'));
        }

        return res.status(200).send({
          status: 'connected',
          logs: deviceLogs.message
        });
      } catch (err) {
        return next(createError(500));
      }
    });

// Retrieves the list of routes from device
devicesRouter.route('/:deviceId/routes')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, verifyPermission('devices', 'get'), async (req, res, next) => {
    try {
      const device = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
      if (!device || device.length === 0) return next(createError(404, 'Device not found'));

      if (!connections.isConnected(device[0].machineId)) {
        return res.status(200).send({
          status: 'disconnected',
          osRoutes: [],
          vppRoutes: []
        });
      }

      const deviceOsRoutes = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-os-routes' },
        15000
      );

      if (!deviceOsRoutes.ok) {
        logger.error('Failed to get device routes', {
          params: {
            deviceId: req.params.deviceId,
            response: deviceOsRoutes.message
          },
          req: req
        });
        return next(createError(500, 'Failed to get device routes'));
      }
      const response = {
        status: 'connected',
        osRoutes: deviceOsRoutes.message,
        vppRoutes: []
      };
      return res.status(200).send(response);
    } catch (err) {
      return next(createError(500));
    }
  });

// Retrieves the list of static routes from device
devicesRouter.route('/:deviceId/staticroutes')
  .options(cors.corsWithOptions,
    verifyPermission('devices', 'get'),
    async (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, async (req, res, next) => {
    try {
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(req.params.deviceId)
      });
      if (!deviceObject || deviceObject.length === 0) {
        return next(createError(404, 'Device not found'));
      }

      const device = deviceObject[0];
      const routes = device.staticroutes.map(value => {
        return {
          id: value.id,
          destination_network: value.destination,
          gateway_ip: value.gateway,
          ifname: value.ifname,
          metric: value.metric,
          status: value.status
        };
      });

      return res.status(200).send(routes);
    } catch (err) {
      return next(createError(500));
    }
  })
  .post(cors.corsWithOptions, verifyPermission('devices', 'post'), async (req, res, next) => {
    const deviceObject = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
    if (!deviceObject || deviceObject.length === 0) {
      return next(createError(404, 'Device not found'));
    }
    if (!deviceObject[0].isApproved && !req.body.isApproved) {
      return next(createError(400, 'Device must be first approved'));
    }
    const device = deviceObject[0];

    try {
      // eslint-disable-next-line new-cap
      const route = new staticroutes({
        destination: req.body.destination_network,
        gateway: req.body.gateway_ip,
        ifname: req.body.ifname,
        metric: req.body.metric,
        status: 'waiting'
      });

      await devices.findOneAndUpdate(
        { _id: device._id },
        {
          $push: {
            staticroutes: route
          }
        },
        { new: true }
      );

      req.body.method = 'staticroutes';
      req.body.id = route.id;
      await dispatcher.apply(device, req.body.method, req.user, req.body);
      return res.status(200).send({});
    } catch (error) {
      return next(createError(500, 'Failed to add a route'));
    }
  });

// update static route
devicesRouter.route('/:deviceId/staticroutes/:routeId')
  .options(cors.corsWithOptions,
    verifyPermission('devices', 'get'),
    async (req, res) => { res.sendStatus(200); })
  .patch(cors.corsWithOptions, verifyPermission('devices', 'post'), async (req, res, next) => {
    const deviceObject = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
    if (!deviceObject || deviceObject.length === 0) {
      return next(createError(404, 'Device not found'));
    }
    if (!deviceObject[0].isApproved && !req.body.isApproved) {
      return next(createError(400, 'Device must be first approved'));
    }

    const device = deviceObject[0];
    req.body.method = 'staticroutes';
    req.body.action = req.body.status === 'add-failed' ? 'add' : 'del';
    await dispatcher.apply(device, req.body.method, req.user, req.body);
    return res.status(200).send({ deviceId: device.id });
  })
// delete static route
  .delete(cors.corsWithOptions, verifyPermission('devices', 'del'), async (req, res, next) => {
    const deviceObject = await devices.find({ _id: mongoose.Types.ObjectId(req.params.deviceId) });
    if (!deviceObject || deviceObject.length === 0) {
      return next(createError(404, 'Device not found'));
    }

    const device = deviceObject[0];

    await devices.findOneAndUpdate(
      { _id: mongoose.Types.ObjectId(req.params.deviceId) },
      { $set: { 'staticroutes.$[elem].status': 'waiting' } },
      {
        arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(req.body.id) }]
      }
    );

    req.body.method = 'staticroutes';
    req.body.id = req.params.routeId;
    req.body.action = 'del';
    await dispatcher.apply(device, req.body.method, req.user, req.body);
    return res.status(200).send({ deviceId: device.id });
  });

// Default exports
module.exports = devicesRouter;
