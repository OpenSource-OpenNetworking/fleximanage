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
const { mapLteNames, getCpuInfo } = require('../utils/deviceUtils');
const geoip = require('geoip-lite');
const validators = require('../models/validators.js');
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
    // console.log('versions=' + versions);
    res.setHeader('latestVersion', versions.device); // set last device version
    return next(createError(statusCode, err));
  }
  next();
};

// Try to determine the coordinates for a device
function getCoordinates (interfaces, sourceIp) {
  let ll = null;
  const lookupIp = (ip) => {
    const geoIpInfo = geoip.lookup(ip);
    if (geoIpInfo) {
      ll = geoIpInfo.ll;
      return true; // Stop the interface loop
    }
    return false;
  };
  // Try first to find location based on source IP
  if (!sourceIp || !lookupIp(sourceIp)) {
    if (interfaces) {
      interfaces
        // Check WAN interfaces IPs
        .filter((i) => i.type === 'WAN')
        // Put LTE last
        .sort((i1, i2) => {
          if (i1.deviceType === 'lte' && i2.deviceType !== 'lte') return 1;
          if (i1.deviceType !== 'lte' && i2.deviceType === 'lte') return -1;
          return 0;
        })
        // Try to find first location
        .some((i) => {
        // Try to match public IP first
          if (i.PublicIP) return lookupIp(i.PublicIP);
          if (i.IPv4) return lookupIp(i.IPv4);
        });
    }
  }
  return ll;
}

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

              if (!ifs || !Array.isArray(ifs) || ifs.length === 0) {
                return next(createError(500, 'Device without interfaces is not allowed'));
              }

              // first filter out not supported interfaces and allow to register with the rest
              const interfaces = ifs.filter((i, idx) => validators.validateDevId(i.devId));
              if (ifs.length !== interfaces.length) {
                logger.warn('Unsupported interfaces were filtered out',
                  { params: { ifs, interfaces } });
              }

              if (interfaces.length === 0) {
                return next(createError(500, 'The interfaces are not supported'));
              }

              // Get an interface with gateway and the lowest metric
              const defaultIntf = interfaces.reduce((res, intf) =>
                intf.gateway && (!res || +res.metric > +intf.metric)
                  ? intf : res, undefined);
              const lowestMetric = defaultIntf && defaultIntf.metric
                ? defaultIntf.metric : '0';

              let highestMetric = 0;
              const setAutoMetricIndexes = new Set();
              interfaces.forEach((intf, idx) => {
                // VLAN identification by devId, example "vlan.10.pci:0000:00:08.00"
                const idParts = intf.devId.split('.');
                if (idParts.length > 2 && idParts[0] === 'vlan' && idParts[1]) {
                  intf.vlanTag = idParts[1];
                  intf.parentDevId = idParts.slice(2).join('.');
                }
                intf.locked = true;
                intf.isAssigned = false;
                intf.useStun = true;
                intf.useFixedPublicPort = false;
                intf.linkStatus = intf.link;
                intf.internetAccess = intf.internetAccess === undefined ? ''
                  : intf.linkStatus !== 'down' && intf.internetAccess ? 'yes' : 'no';
                intf.mtu = !isNaN(intf.mtu) ? +intf.mtu : 1500;
                if (!defaultIntf && intf.name === req.body.default_dev) {
                  // old version agent
                  intf.PublicIP = intf.public_ip || sourceIP;
                  intf.PublicPort = intf.public_port || '';
                  intf.NatType = intf.nat_type || '';
                  intf.type = 'WAN';
                  intf.dhcp = intf.dhcp || 'no';
                  intf.gateway = req.body.default_route;
                  intf.metric = '0';
                } else if (intf.gateway || ['lte', 'pppoe'].includes(intf.deviceType)) {
                  intf.type = 'WAN';
                  intf.dhcp = intf.dhcp || 'no';
                  if (intf.deviceType === 'lte') {
                    intf.deviceParams = mapLteNames(intf.deviceParams);
                    intf.metric = null;
                  } else {
                    intf.metric = (!intf.metric && intf.gateway === req.body.default_route)
                      ? '0' : intf.metric || null;
                  }
                  intf.PublicIP = intf.public_ip || (intf.metric === lowestMetric ? sourceIP : '');
                  intf.PublicPort = intf.public_port || '';
                  intf.NatType = intf.nat_type || '';
                  if (intf.deviceType === 'pppoe') {
                    intf.dhcp = 'yes';
                  }

                  // to calculate auto metrics, store the highest configured metric
                  // and the interfaces that we need to add an auto metric.
                  if (intf.metric) {
                    highestMetric = Math.max(highestMetric, parseInt(intf.metric));
                  } else {
                    setAutoMetricIndexes.add(idx);
                  }
                } else {
                  intf.type = 'LAN';
                  // set LAN as DHCP only if it's DHCP in Linux and has IP address.
                  // Otherwise set it to static on registration.
                  intf.dhcp = intf.dhcp === 'yes' && intf.IPv4 !== '' ? 'yes' : 'no';
                  intf.routing = 'OSPF';
                  intf.gateway = '';
                  intf.metric = '';
                }
              });

              // set auto metrics for interfaces without a metric.
              // This loop done at the end to avoid metric duplication
              setAutoMetricIndexes.forEach(i => {
                highestMetric += 100;
                interfaces[i].metric = highestMetric;
              });

              // Prepare device versions array
              const versions = {
                agent: req.body.fwagent_version || '',
                router: req.body.router_version || '',
                device: req.body.device_version || ''
              };

              const requestCpuInfo = req.body.cpuInfo
                ?.replaceAll('\'', '"').replaceAll('False', 'false').replaceAll('True', 'true');
              const cpuInfo = getCpuInfo(requestCpuInfo ? JSON.parse(requestCpuInfo) : null);
              const requestDistro = JSON.parse(req.body.distro?.replaceAll('\'', '"') || '{}');

              // Check that account didn't cross its device limit
              const account = decoded.account;
              // Get max allowed devices for free from the ChargeBee plan
              const maxDevices = await flexibilling.getMaxDevicesAllowed(account);

              // Initialize session
              let session;
              let keepCount; // current number of docs per account
              let keepOrgCount; // current number of docs per account
              mongoConns.getMainDB().startSession()
                .then((_session) => {
                  session = _session;
                  return session.startTransaction();
                })
                .then(() => {
                  return devices.countDocuments({
                    account: account, org: decoded.org
                  }).session(session);
                })
                .then((orgCount) => {
                  keepOrgCount = orgCount;
                  return devices.countDocuments({ account: account }).session(session);
                })
                .then(async (count) => {
                  keepCount = count;
                  if (count >= maxDevices) {
                    if (session) await session.abortTransaction();
                    return next(createError(402, 'Maximum number of free devices reached'));
                  }

                  // Get device location
                  let ll = getCoordinates(interfaces, sourceIP);
                  if (!ll) ll = [40.416775, -3.703790]; // Default coordinate

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
                    interfaces: interfaces,
                    deviceToken: deviceToken,
                    isApproved: false,
                    isConnected: false,
                    coords: ll,
                    cpuInfo: cpuInfo,
                    distro: {
                      version: requestDistro?.version ?? '',
                      codename: requestDistro?.codename ?? ''
                    },
                    versions: versions
                  }], { session: session })
                    .then(async (result) => {
                      await flexibilling.registerDevice({
                        account: result[0].account,
                        count: keepCount,
                        org: decoded.org,
                        orgCount: keepOrgCount,
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
