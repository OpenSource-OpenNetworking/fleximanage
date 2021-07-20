// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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

const configs = require('../configs.js')();
const express = require('express');
const createError = require('http-errors');
const bodyParser = require('body-parser');
const cors = require('./cors');
const tokens = require('../models/tokens');
const { devices } = require('../models/devices');
const jwt = require('jsonwebtoken');
const mongoConns = require('../mongoConns.js')();
const { verifyAgentVersion } = require('../versioning');
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const webHooks = require('../utils/webhooks')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const url = require('url');
// billing support
const flexibilling = require('../flexibilling');

const connectRouter = express.Router();
connectRouter.use(bodyParser.json());

// error formatter
const formatErr = (err, msg) => {
  // Check for unique error
  if (err.name === 'MongoError' && err.code === 11000) {
    return {
      status: 407,
      error: 'Device ' + msg.machine_id + ' already exists, must be deleted first'
    };
  } else if (err.message) {
    return ({ status: 408, error: err.message });
  } else {
    return ({ status: 500, error: 'Unable to format error' });
  }
};

// Generate token
const genToken = function (data) {
  return jwt.sign(data, configs.get('deviceTokenSecretKey'));
};

// Express middleware for /register API
const checkDeviceVersion = async (req, res, next) => {
  const agentVer = req.body.fwagent_version;
  const { valid, statusCode, err } = verifyAgentVersion(agentVer);
  if (!valid) {
    logger.warn('Device version validation failed', {
      params: {
        agentVersion: agentVer,
        reason: err,
        machineId: req.body.machine_id
      },
      req: req
    });
    const swUpdater = DevSwUpdater.getSwVerUpdaterInstance();
    const { versions } = await swUpdater.getLatestSwVersions();
    console.log('versions=' + versions);
    res.setHeader('latestVersion', versions.device); // set last device version
    return next(createError(statusCode, err));
  }
  next();
};

// Register device. When device connects for the first
// time, it tries to authenticate by accessing this URL
// Register Error Codes:
// 400 - Wrong version or Too high Agent version
// 401 - Invalid token
// 402 - Maximum number of free devices reached
// 403 - Too low Agent version
// 404 - Token not found
// 405 -
// 406 -
// 407 - Device Already Exists
// 408 - Mongo error
// 500 - General Error
connectRouter.route('/register')
  .post(cors.cors, checkDeviceVersion, (req, res, next) => {
    var sourceIP = req.ip || 'Unknown';
    if (sourceIP.substr(0, 7) === '::ffff:') sourceIP = sourceIP.substr(7);
    jwt.verify(req.body.token, configs.get('deviceTokenSecretKey'), function (err, decoded) {
      if (err) {
        return next(createError(401, 'Invalid token'));
      } else {
        if (!decoded.org || !decoded.account) return next(createError(401, 'Invalid token'));
        tokens.find({ token: req.body.token, org: decoded.org })
          .then(async (resp) => {
            if (resp.length === 1) { // exactly one token found
              // create device and add token new token to the device
              const deviceToken = genToken({
                machine_id: req.body.machine_id,
                machine_name: req.body.machine_name
              });

              // Try to auto populate interfaces parameters
              const ifs = JSON.parse(req.body.interfaces);

              // Get an interface with gateway and the lowest metric
              const defaultIntf = ifs ? ifs.reduce((res, intf) =>
                intf.gateway && (!res || +res.metric > +intf.metric)
                  ? intf : res, undefined) : undefined;
              const lowestMetric = defaultIntf && defaultIntf.metric
                ? defaultIntf.metric : '0';

              let autoAssignedMetric = 100;
              ifs.forEach((intf) => {
                intf.isAssigned = false;
                intf.useStun = true;
                intf.useFixedPublicPort = false;
                intf.internetAccess = intf.internetAccess === undefined ? ''
                  : intf.internetAccess ? 'yes' : 'no';
                if (!defaultIntf && intf.name === req.body.default_dev) {
                  // old version agent
                  intf.PublicIP = intf.public_ip || sourceIP;
                  intf.PublicPort = intf.public_port || '';
                  intf.NatType = intf.nat_type || '';
                  intf.type = 'WAN';
                  intf.dhcp = intf.dhcp || 'no';
                  intf.gateway = req.body.default_route;
                  intf.metric = '0';
                } else if (intf.gateway || intf.deviceType === 'lte') {
                  intf.type = 'WAN';
                  intf.dhcp = intf.dhcp || 'no';
                  if (intf.deviceType === 'lte') {
                    // LTE devices are not enabled at registration stage so they can't have a metric
                    intf.metric = '';
                  } else {
                    intf.metric = (!intf.metric && intf.gateway === req.body.default_route)
                      ? '0' : intf.metric || (autoAssignedMetric++).toString();
                  }
                  intf.PublicIP = intf.public_ip || (intf.metric === lowestMetric ? sourceIP : '');
                  intf.PublicPort = intf.public_port || '';
                  intf.NatType = intf.nat_type || '';
                } else {
                  intf.type = 'LAN';
                  intf.dhcp = 'no';
                  intf.routing = 'OSPF';
                  intf.gateway = '';
                  intf.metric = '';
                }
              });

              // Prepare device versions array
              const versions = {
                agent: req.body.fwagent_version || '',
                router: req.body.router_version || '',
                device: req.body.device_version || ''
              };

              // Check that account didn't cross its device limit
              const account = decoded.account;
              // Get max allowed devices for free from the ChargeBee plan
              const maxDevices = await flexibilling.getMaxDevicesAllowed(account);

              // Initialize session
              let session;
              let keepCount; // current number of docs per account
              mongoConns.getMainDB().startSession()
                .then((_session) => {
                  session = _session;
                  return session.startTransaction();
                })
                .then(() => {
                  return devices.countDocuments({ account: account }).session(session);
                })
                .then(async (count) => {
                  keepCount = count;
                  if (count >= maxDevices) {
                    if (session) await session.abortTransaction();
                    return next(createError(402, 'Maximum number of free devices reached'));
                  }

                  // Create the device
                  devices.create([{
                    account: decoded.account,
                    org: decoded.org,
                    name: '',
                    description: '',
                    hostname: req.body.machine_name,
                    ipList: req.body.ip_list,
                    machineId: req.body.machine_id,
                    serial: req.body.serial || '0',
                    fromToken: resp[0].name,
                    interfaces: ifs,
                    deviceToken: deviceToken,
                    isApproved: false,
                    isConnected: false,
                    versions: versions
                  }], { session: session })
                    .then(async (result) => {
                      await flexibilling.registerDevice({
                        account: result[0].account,
                        count: keepCount,
                        increment: 1
                      }, session);

                      // commit transaction
                      await session.commitTransaction();
                      session = null;

                      // Send register device webhook for first device
                      if (keepCount === 0) {
                        const webHookMessage = {
                          _id: result[0]._id.toString(),
                          account: decoded.account,
                          org: decoded.org
                        };
                        if (!await webHooks.sendToWebHook(configs.get('webHookRegisterDeviceUrl'),
                          webHookMessage,
                          configs.get('webHookRegisterDeviceSecret'))) {
                          logger.error('Web hook call failed for registered device',
                            { params: { message: webHookMessage } });
                        }
                      }

                      logger.info('Device registered successfully',
                        {
                          params: {
                            _id: result[0]._id.toString(),
                            deviceId: req.body.machine_id,
                            account: decoded.account,
                            org: decoded.org
                          },
                          req: req
                        });
                      res.statusCode = 200;
                      res.setHeader('Content-Type', 'application/json');

                      let server = configs.get('agentBroker');
                      if (decoded.server) {
                        const urlSchema = new url.URL(decoded.server);
                        server = `${urlSchema.hostname}:${urlSchema.port}`;
                      }

                      res.json({ deviceToken: deviceToken, server: server });
                    }, async (err) => {
                      // abort transaction on error
                      if (session) {
                        await session.abortTransaction();
                        session = null;
                      }

                      logger.warn('Device registration failed',
                        { params: { deviceId: req.body.machine_id, err: err }, req: req });
                      const fErr = formatErr(err, req.body);
                      return next(createError(fErr.status, fErr.error));
                    })
                    .catch(async (err) => {
                      if (session) {
                        // abort transaction on error
                        await session.abortTransaction();
                        session = null;
                      }
                      next(err);
                    });
                }, (err) => next(err))
                .catch((err) => next(err));
            } else if (resp.length === 0) {
              return next(createError(404, 'Token not found'));
            } else {
              return next(
                createError(
                  500,
                  'general token error, please contact the administrator'
                )
              );
            }
          }, (err) => next(err))
          .catch((err) => next(err));
      }
    }
    );
  });

// Default exports
module.exports = {
  connectRouter: connectRouter,
  checkDeviceVersion: checkDeviceVersion
};
