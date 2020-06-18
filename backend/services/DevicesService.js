// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

const Service = require('./Service');
const configs = require('../configs')();
const { devices, staticroutes, dhcpModel } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const { deviceStats } = require('../models/analytics/deviceStats');
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const mongoConns = require('../mongoConns.js')();
const mongoose = require('mongoose');
const pick = require('lodash/pick');
const uniqBy = require('lodash/uniqBy');
const isEqual = require('lodash/isEqual');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const flexibilling = require('../flexibilling');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateDevice, getAllOrganizationLanSubnets } = require('../deviceLogic/validators');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');

class DevicesService {
  /**
   * Execute an action on the device side
   *
   * action String Command to execute
   * commandRequest CommandRequest  (optional)
   * no response value expected for this operation
   **/
  static async devicesApplyPOST ({ org, deviceCommand }, { user }, response) {
    try {
      // Find all devices of the organization
      const orgList = await getAccessTokenOrgList(user, org, true);
      const opDevices = await devices.find({ org: { $in: orgList } })
        .populate('interfaces.pathlabels', '_id name description color type');
      // Apply the device command
      const { ids, status, message } = await dispatcher.apply(opDevices, deviceCommand.method,
        user, { org: orgList[0], ...deviceCommand });
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));
      return Service.successResponse({ ids, status, message }, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Execute an action on the device side
   *
   * action String Command to execute
   * commandRequest CommandRequest  (optional)
   * no response value expected for this operation
   **/
  static async devicesIdApplyPOST ({ id, org, deviceCommand }, { user }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const opDevice = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      })
        .populate('interfaces.pathlabels', '_id name description color type'); ;

      if (opDevice.length !== 1) return Service.rejectResponse('Device not found');

      const { ids, status, message } = await dispatcher.apply(opDevice, deviceCommand.method,
        user, { org: orgList[0], ...deviceCommand });
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));
      return Service.successResponse({ ids, status, message }, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Select the API fields from mongo Device Object
   *
   * @param {mongo Device Object} item
   */
  static selectDeviceParams (item) {
    // Pick relevant fields
    const retDevice = pick(item, [
      'org',
      'description',
      'defaultRoute',
      'deviceToken',
      'machineId',
      'site',
      'hostname',
      'name',
      '_id',
      'isApproved',
      'fromToken',
      'account',
      'ipList',
      'policies',
      // Internal array, objects
      'labels',
      'upgradeSchedule',
      'sync']);
    retDevice.deviceStatus = (retDevice.deviceStatus === '1');

    // pick interfaces
    const retInterfaces = item.interfaces.map(i => {
      const retIf = pick(i, [
        'IPv6',
        'PublicIP',
        'gateway',
        'IPv4',
        'type',
        'MAC',
        'routing',
        'IPv6Mask',
        'isAssigned',
        'driver',
        'IPv4Mask',
        'name',
        'pciaddr',
        '_id',
        'pathlabels'
      ]);
      retIf._id = retIf._id.toString();
      return retIf;
    });

    const retStaticRoutes = item.staticroutes.map(r => {
      const retRoute = pick(r, [
        '_id',
        'destination',
        'gateway',
        'ifname',
        'metric'
      ]);
      retRoute._id = retRoute._id.toString();
      return retRoute;
    });

    const retDhcpList = item.dhcp.map(d => {
      const retDhcp = pick(d, [
        '_id',
        'interface',
        'rangeStart',
        'rangeEnd',
        'dns',
        'status'
      ]);

      const macAssignList = d.macAssign.map(m => {
        return pick(m, [
          'host', 'mac', 'ipv4'
        ]);
      });

      retDhcp.macAssign = macAssignList;
      retDhcp._id = retDhcp._id.toString();
      return retDhcp;
    });

    // Update with additional objects
    retDevice._id = retDevice._id.toString();
    retDevice.account = retDevice.account.toString();
    retDevice.org = retDevice.org.toString();
    retDevice.upgradeSchedule = pick(item.upgradeSchedule, ['jobQueued', '_id', 'time']);
    retDevice.upgradeSchedule._id = retDevice.upgradeSchedule._id.toString();
    retDevice.upgradeSchedule.time = (retDevice.upgradeSchedule.time)
      ? retDevice.upgradeSchedule.time.toISOString() : null;
    retDevice.versions = pick(item.versions, ['agent', 'router', 'device', 'vpp', 'frr']);
    retDevice.interfaces = retInterfaces;
    retDevice.staticroutes = retStaticRoutes;
    retDevice.dhcp = retDhcpList;
    retDevice.isConnected = connections.isConnected(retDevice.machineId);
    // Add interface stats to mongoose response
    retDevice.deviceStatus = retDevice.isConnected
      ? deviceStatus.getDeviceStatus(retDevice.machineId) || {} : {};

    return retDevice;
  }

  /**
   * Get all registered devices
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async devicesGET ({ org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const result = await devices.find({ org: { $in: orgList } })
        .populate('interfaces.pathlabels', '_id name description color type')
        .populate('policies.multilink.policy', '_id name description');

      const devicesMap = result.map(item => {
        return DevicesService.selectDeviceParams(item);
      });

      return Service.successResponse(devicesMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async devicesUpgdSchedPOST ({ org, devicesUpgradeRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const query = { _id: { $in: devicesUpgradeRequest.devices }, org: { $in: orgList } };
      const numOfIdsFound = await devices.countDocuments(query);

      // The request is considered invalid if not all device IDs
      // are found in the database. This is done to prevent a partial
      // schedule of the devices in case of a user's mistake.
      if (numOfIdsFound < devicesUpgradeRequest.devices.length) {
        return Service.rejectResponse('Some devices were not found');
      }

      const set = {
        $set: {
          upgradeSchedule: {
            time: devicesUpgradeRequest.date,
            jobQueued: false
          }
        }
      };

      const options = { upsert: false, useFindAndModify: false };
      await devices.updateMany(query, set, options);
      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async devicesIdUpgdSchedPOST ({ id, org, deviceUpgradeRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const query = { _id: id, org: { $in: orgList } };
      const set = {
        $set: {
          upgradeSchedule: {
            time: deviceUpgradeRequest.date,
            jobQueued: false
          }
        }
      };

      const options = { upsert: false, useFindAndModify: false };
      const res = await devices.updateOne(query, set, options);
      if (res.n === 0) {
        return Service.rejectResponse('Device not found');
      } else {
        return Service.successResponse(null, 204);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get device software version
   *
   * returns DeviceLatestVersion
   **/
  static async devicesLatestVersionsGET () {
    try {
      const swUpdater = DevSwUpdater.getSwVerUpdaterInstance();
      const { versions, versionDeadline } = await swUpdater.getLatestSwVersions();
      return Service.successResponse({
        versions,
        versionDeadline
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device
   *
   * id String Numeric ID of the Device to retrieve
   * Returns Device
   **/
  static async devicesIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const result = await devices.findOne({ _id: id, org: { $in: orgList } })
        .populate('interfaces.pathlabels', '_id name description color type')
        .populate('policies.multilink.policy', '_id name description');
      const device = DevicesService.selectDeviceParams(result);

      return Service.successResponse([device]);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device configuration
   *
   * id String Numeric ID of the Device to retrieve configuration from
   * Returns Device Configuration
   **/
  static async devicesIdConfigurationGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse('Device not found', 404);
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          configurations: []
        });
      }

      const deviceConf = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-router-config' }
      );

      if (!deviceConf.ok) {
        logger.error('Failed to get device configuration', {
          params: {
            deviceId: id,
            response: deviceConf.message
          }
        });
        return Service.rejectResponse('Failed to get device configuration');
      }

      return Service.successResponse({
        status: 'connected',
        configuration: deviceConf.message
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device logs information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * filter String Filter to be applied (optional)
   * returns DeviceLog
   **/
  static async devicesIdLogsGET ({ id, org, offset, limit, filter }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse('Device not found');
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          logs: []
        });
      }

      const deviceLogs = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        {
          entity: 'agent',
          message: 'get-device-logs',
          params: {
            lines: limit || '100',
            filter: filter || 'all'
          }
        }
      );

      if (!deviceLogs.ok) {
        logger.error('Failed to get device logs', {
          params: {
            deviceId: id,
            response: deviceLogs.message
          }
        });
        return Service.rejectResponse('Failed to get device logs', 500);
      }

      return Service.successResponse({
        status: 'connected',
        logs: deviceLogs.message
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete device
   *
   * id String Numeric ID of the Device to delete
   * no response value expected for this operation
   **/
  static async devicesIdDELETE ({ id, org }, { user }) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const orgList = await getAccessTokenOrgList(user, org, true);
      const tunnelCount = await tunnelsModel.countDocuments({
        $or: [{ deviceA: id }, { deviceB: id }],
        isActive: true,
        org: { $in: orgList }
      }).session(session);

      if (tunnelCount > 0) {
        logger.debug('Tunnels found when deleting device',
          { params: { deviceId: id }, user: user });
        throw new Error('All device tunnels must be deleted before deleting a device');
      }

      const delDevices = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      }).session(session);

      if (!delDevices.length) throw new Error('Device for deletion not found');
      connections.deviceDisconnect(delDevices[0].machineId);
      const deviceCount = await devices.countDocuments({
        account: delDevices[0].account
      }).session(session);

      // Unregister a device (by adding -1)
      await flexibilling.registerDevice({
        account: delDevices[0].account,
        count: deviceCount,
        increment: -1
      }, session);

      // Now we can remove the device
      await devices.remove({
        _id: id,
        org: { $in: orgList }
      }).session(session);

      await session.commitTransaction();
      session = null;

      return Service.successResponse(null, 204);
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify device
   *
   * id String Numeric ID of the Device to modify
   * deviceRequest DeviceRequest  (optional)
   * returns Device
   **/
  static async devicesIdPUT ({ id, org, deviceRequest }, { user }, response) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();

      const orgList = await getAccessTokenOrgList(user, org, true);
      const origDevice = await devices.findOne({
        _id: id,
        org: { $in: orgList }
      })
        .session(session)
        .populate('interfaces.pathlabels', '_id name description color type');

      // Don't allow any changes if the device is not approved
      if (!origDevice.isApproved && !deviceRequest.isApproved) {
        throw new Error('Device must be first approved');
      }

      // Validate device changes only for approved devices,
      // and only if the request contains interfaces.
      if (origDevice.isApproved && deviceRequest.interfaces) {
        // check LAN subnet overlap if updated device is running
        const status = deviceStatus.getDeviceStatus(origDevice.machineId);
        const needCheckLanOverlaps = (status && status.state && status.state === 'running');

        let orgLanSubnets = [];

        if (needCheckLanOverlaps) {
          orgLanSubnets = await getAllOrganizationLanSubnets(origDevice.org);
        }

        // add device id to device request
        const { valid, err } = validateDevice({
          ...deviceRequest,
          _id: origDevice._id
        }, needCheckLanOverlaps, orgLanSubnets);

        if (!valid) {
          logger.warn('Device update failed',
            {
              params: { device: deviceRequest, err: err }
            });
          throw new Error(err);
        }
      }

      // If device changed to not approved disconnect it's socket
      if (deviceRequest.isApproved === false) connections.deviceDisconnect(origDevice.machineId);

      // TBD: Remove these fields from the yaml PUT request
      delete deviceRequest.machineId;
      delete deviceRequest.org;
      delete deviceRequest.hostname;
      delete deviceRequest.ipList;
      delete deviceRequest.fromToken;
      delete deviceRequest.deviceToken;
      delete deviceRequest.state;
      delete deviceRequest.emailTokens;
      delete deviceRequest.defaultAccount;
      delete deviceRequest.defaultOrg;

      const updDevice = await devices.findOneAndUpdate(
        { _id: id, org: { $in: orgList } },
        deviceRequest,
        { new: true, upsert: false, runValidators: true }
      )
        .session(session)
        .populate('interfaces.pathlabels', '_id name description color type');

      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      let modifyDevResult = [];
      if (origDevice) {
        modifyDevResult = await dispatcher.apply([origDevice], 'modify', user, {
          newDevice: updDevice
        });
      }

      await session.commitTransaction();
      session = null;

      const status = modifyDevResult.ids.length > 0 ? 202 : 200;
      const ids = [modifyDevResult.ids[0]];
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));
      const deviceObj = DevicesService.selectDeviceParams(updDevice);
      return Service.successResponse(deviceObj, status);
    } catch (e) {
      if (session) session.abortTransaction();

      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device routes information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async devicesIdRoutesGET ({ id, org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const device = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!device || device.length === 0) {
        return Service.rejectResponse('Device not found');
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          status: 'disconnected',
          osRoutes: [],
          vppRoutes: []
        });
      }

      const deviceOsRoutes = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-os-routes' }
      );

      if (!deviceOsRoutes.ok) {
        logger.error('Failed to get device routes', {
          params: {
            deviceId: id,
            response: deviceOsRoutes.message
          },
          req: null
        });
        return Service.rejectResponse('Failed to get device routes');
      }
      const response = {
        status: 'connected',
        osRoutes: deviceOsRoutes.message,
        vppRoutes: []
      };
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device static routes information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns StaticRoute
   **/
  static async devicesIdStaticroutesGET ({ id, org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse('Device not found');
      }

      const device = deviceObject[0];
      let routes = [];

      if (device.staticroutes.length) {
        routes = device.staticroutes;
      }

      routes = routes.map(value => {
        return {
          _id: value.id,
          destination: value.destination,
          gateway: value.gateway,
          ifname: value.ifname,
          metric: value.metric,
          status: value.status
        };
      });
      return Service.successResponse(routes);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete static route
   *
   * id String Numeric ID of the Device
   * route String Numeric ID of the Route to delete
   * no response value expected for this operation
   **/
  static async devicesIdStaticroutesRouteDELETE ({ id, org, route }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const device = await devices.findOneAndUpdate(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        },
        { $set: { 'staticroutes.$[elem].status': 'waiting' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(id) }]
        }
      );

      if (!device) throw new Error('Device not found');
      const deleteRoute = device.staticroutes.filter((s) => {
        return (s.id === route);
      });

      if (deleteRoute.length !== 1) throw new Error('Static route not found');
      const copy = Object.assign({}, deleteRoute[0].toObject());
      copy.method = 'staticroutes';
      copy._id = route;
      copy.action = 'del';
      await dispatcher.apply(device, copy.method, user, copy);
      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Create new static route
   *
   * id String Numeric ID of the Device
   * staticRouteRequest StaticRouteRequest  (optional)
   * returns DeviceStaticRouteInformation
   **/
  static async devicesIdStaticroutesPOST ({ id, org, staticRouteRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse('Device not found');
      }
      if (!deviceObject[0].isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse('Device must be first approved', 400);
      }
      const device = deviceObject[0];

      // eslint-disable-next-line new-cap
      const route = new staticroutes({
        destination: staticRouteRequest.destination,
        gateway: staticRouteRequest.gateway,
        ifname: staticRouteRequest.ifname,
        metric: staticRouteRequest.metric,
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

      const copy = Object.assign({}, staticRouteRequest);

      copy.method = 'staticroutes';
      copy._id = route.id;
      await dispatcher.apply(device, copy.method, user, copy);

      const result = {
        _id: route._id.toString(),
        gateway: route.gateway,
        destination: route.destination,
        ifname: route.ifname,
        metric: route.metric
      };

      return Service.successResponse(result, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify static route
   *
   * id String Numeric ID of the Device
   * route String Numeric ID of the Route to modify
   * staticRouteRequest StaticRouteRequest  (optional)
   * returns StaticRoute
   **/
  static async devicesIdStaticroutesRoutePATCH ({ id, org, staticRouteRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse('Device not found');
      }
      if (!deviceObject[0].isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse('Device must be first approved', 400);
      }

      const device = deviceObject[0];
      const copy = Object.assign({}, staticRouteRequest);

      copy.method = 'staticroutes';
      copy.action = staticRouteRequest.status === 'add-failed' ? 'add' : 'del';
      await dispatcher.apply(device, copy.method, user, copy);
      return Service.successResponse({ deviceId: device.id });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async queryDeviceStats ({ id, org, startTime, endTime }) {
    const match = { org: mongoose.Types.ObjectId(org) };

    if (id) match.device = mongoose.Types.ObjectId(id);
    if (startTime && endTime) {
      match.$and = [{ time: { $gte: startTime } }, { time: { $lte: endTime } }];
    } else if (startTime) match.time = { $gte: startTime };
    else if (endTime) match.time = { $lte: endTime };

    const pipeline = [
      { $match: match },
      { $project: { time: 1, stats: { $objectToArray: '$stats' } } },
      { $unwind: '$stats' },
      {
        $group:
              {
                _id: { time: '$time', interface: 'All' },
                rx_bps: { $sum: '$stats.v.rx_bps' },
                tx_bps: { $sum: '$stats.v.tx_bps' },
                rx_pps: { $sum: '$stats.v.rx_pps' },
                tx_pps: { $sum: '$stats.v.tx_pps' }
              }
      },
      {
        $project: {
          _id: 0,
          time: '$_id.time',
          interface: '$_id.interface',
          rx_bps: '$rx_bps',
          tx_bps: '$tx_bps',
          rx_pps: '$rx_pps',
          tx_pps: '$tx_pps'
        }
      },
      { $sort: { time: -1 } }
    ];

    const stats = await deviceStats.aggregate(pipeline).allowDiskUse(true);
    return stats;
  }

  /**
   * Retrieve devices statistics information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceStatistics
   **/
  static async devicesStatisticsGET ({ org }, { user }) {
    try {
      const startTime = Math.floor(new Date().getTime() / 1000) - 7200;
      const endTime = null;

      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceStats({
        org: orgList[0].toString(),
        id: null, // null get all devices stats
        startTime: startTime,
        endTime: endTime
      });
      return Service.successResponse(stats);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device statistics information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceStatistics
   **/
  static async devicesIdStatisticsGET ({ id, org }, { user }) {
    try {
      const startTime = Math.floor(new Date().getTime() / 1000) - 7200;
      const endTime = null;

      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceStats({
        org: orgList[0].toString(),
        id: id,
        startTime: startTime,
        endTime: endTime
      });
      return Service.successResponse(stats);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete DHCP
   *
   * id String Numeric ID of the Device
   * dhcpId String Numeric ID of the DHCP to delete
   * org String Organization to be filtered by (optional)
   * no response value expected for this operation
   **/
  static async devicesIdDhcpDhcpIdDELETE ({ id, dhcpId, force, org }, { user }, response) {
    try {
      const isForce = (force === 'yes');
      const orgList = await getAccessTokenOrgList(user, org, true);
      const device = await devices.findOneAndUpdate(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        },
        { $set: { 'dhcp.$[elem].status': 'del-wait' } },
        {
          arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(dhcpId) }],
          new: false
        }
      );

      if (!device) throw new Error('Device not found');
      const deleteDhcp = device.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });

      if (deleteDhcp.length !== 1) throw new Error('DHCP ID not found');

      const deleteDhcpObj = deleteDhcp[0].toObject();

      // If previous status was del-wait, no need to resend the job
      if (deleteDhcpObj.status !== 'del-wait') {
        const copy = Object.assign({}, deleteDhcpObj);
        copy.method = 'dhcp';
        copy._id = dhcpId;
        copy.action = 'del';
        const { ids } = await dispatcher.apply(device, copy.method, user, copy);
        response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));
      }

      // If force delete specified, delete the entry regardless of the job status
      if (isForce) {
        await devices.findOneAndUpdate(
          { _id: device._id },
          {
            $pull: {
              dhcp: {
                _id: mongoose.Types.ObjectId(dhcpId)
              }
            }
          }
        );
      }

      return Service.successResponse({}, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get DHCP by ID
   *
   * id String Numeric ID of the Device
   * dhcpId String Numeric ID of the DHCP to get
   * org String Organization to be filtered by (optional)
   * returns Dhcp
   **/
  static async devicesIdDhcpDhcpIdGET ({ id, dhcpId, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const device = await devices.findOne(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }
      );

      if (!device) throw new Error('Device not found');
      const resultDhcp = device.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });
      if (resultDhcp.length !== 1) throw new Error('DHCP ID not found');

      const result = {
        _id: resultDhcp[0].id,
        interface: resultDhcp[0].interface,
        rangeStart: resultDhcp[0].rangeStart,
        rangeEnd: resultDhcp[0].rangeEnd,
        dns: resultDhcp[0].dns,
        macAssign: resultDhcp[0].macAssign,
        status: resultDhcp[0].status
      };

      return Service.successResponse(result, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify DHCP
   *
   * id String Numeric ID of the Device
   * dhcpId String Numeric ID of the DHCP to modify
   * org String Organization to be filtered by (optional)
   * dhcpRequest DhcpRequest  (optional)
   * returns Dhcp
   **/
  static async devicesIdDhcpDhcpIdPUT ({ id, dhcpId, org, dhcpRequest }, { user }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        throw new Error('Device not found');
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }
      // Currently we allow only one change at a time to the device
      if (deviceObject.dhcp.some(d => d.status.includes('wait'))) {
        throw new Error('Only one device change is allowed at any time');
      }
      const dhcpFiltered = deviceObject.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });
      if (dhcpFiltered.length !== 1) throw new Error('DHCP ID not found');
      const origDhcp = dhcpFiltered[0].toObject();
      const origCmpDhcp = {
        _id: origDhcp._id.toString(),
        dns: origDhcp.dns,
        interface: origDhcp.interface,
        macAssign: origDhcp.macAssign.map(m => ({ host: m.host, mac: m.mac, ipv4: m.ipv4 })),
        rangeStart: origDhcp.rangeStart,
        rangeEnd: origDhcp.rangeEnd
      };

      const dhcpData = {
        _id: dhcpId,
        interface: dhcpRequest.interface,
        rangeStart: dhcpRequest.rangeStart,
        rangeEnd: dhcpRequest.rangeEnd,
        dns: dhcpRequest.dns,
        macAssign: dhcpRequest.macAssign,
        status: 'add-wait'
      };

      // Check if any difference exists between request to current dhcp,
      // in that case no need to resend data
      if (!isEqual(dhcpRequest, origCmpDhcp)) {
        const copy = Object.assign({}, dhcpRequest);
        copy.method = 'dhcp';
        copy.action = 'modify';
        copy.origDhcp = origCmpDhcp;
        const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
        response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));

        await devices.findOneAndUpdate(
          { _id: deviceObject._id },
          { $set: { 'dhcp.$[elem]': dhcpData } },
          { arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(dhcpId) }] });
      }

      return Service.successResponse(dhcpData, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * ReApply DHCP
   *
   * id String Numeric ID of the Device
   * dhcpId String Numeric ID of the DHCP to modify
   * org String Organization to be filtered by (optional)
   * dhcpRequest DhcpRequest  (optional)
   * returns Dhcp
   **/
  static async devicesIdDhcpDhcpIdPATCH ({ id, dhcpId, org }, { user }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        throw new Error('Device not found');
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }
      // Currently we allow only one change at a time to the device
      if (deviceObject.dhcp.some(d => d.status.includes('wait'))) {
        throw new Error('Only one device change is allowed at any time');
      }
      const dhcpFiltered = deviceObject.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });
      if (dhcpFiltered.length !== 1) throw new Error('DHCP ID not found');
      const dhcpObject = dhcpFiltered[0].toObject();

      // allow to patch only in the case of failed
      if (dhcpObject.status !== 'add-failed' && dhcpObject.status !== 'remove-failed') {
        throw new Error('Only allowed for add or removed failed jobs');
      }

      const copy = Object.assign({}, dhcpObject);
      copy.method = 'dhcp';
      copy.action = dhcpObject.status === 'add-failed' ? 'add' : 'del';
      const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));

      const dhcpData = {
        _id: dhcpObject.id,
        interface: dhcpObject.interface,
        rangeStart: dhcpObject.rangeStart,
        rangeEnd: dhcpObject.rangeEnd,
        dns: dhcpObject.dns,
        macAssign: dhcpObject.macAssign,
        status: dhcpObject.status
      };

      return Service.successResponse(dhcpData, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device DHCP information
   *
   * id String Numeric ID of the Device to fetch information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * org String Organization to be filtered by (optional)
   * returns List
   **/
  static async devicesIdDhcpGET ({ id, offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const device = await devices.findOne(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }
      );

      if (!device) throw new Error('Device not found');
      let result = [];
      const start = offset || 0;
      const size = limit || device.dhcp.length;
      if (device.dhcp && device.dhcp.length > 0 && start < device.dhcp.length) {
        const end = Math.min(start + size, device.dhcp.length);
        result = device.dhcp.slice(start, end);
      }

      const mappedResult = result.map(r => {
        return {
          _id: r.id,
          interface: r.interface,
          rangeStart: r.rangeStart,
          rangeEnd: r.rangeEnd,
          dns: r.dns,
          macAssign: r.macAssign,
          status: r.status
        };
      });

      return Service.successResponse(mappedResult, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Validate that the dhcp request
   * @param {Object} dhcpRequest - request values
   * @throw error, if not valid
   */
  static validateDhcpRequest (dhcpRequest) {
    // Check that no repeated mac, host or IP
    const macLen = dhcpRequest.macAssign.length;
    const uniqMacs = uniqBy(dhcpRequest.macAssign, 'mac');
    const uniqHosts = uniqBy(dhcpRequest.macAssign, 'host');
    const uniqIPs = uniqBy(dhcpRequest.macAssign, 'ipv4');
    if (uniqMacs.length !== macLen) throw new Error('MAC bindings MACs are not unique');
    if (uniqHosts.length !== macLen) throw new Error('MAC bindings hosts are not unique');
    if (uniqIPs.length !== macLen) throw new Error('MAC bindings IPs are not unique');
  }

  /**
   * Add DHCP server
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by (optional)
   * dhcpRequest DhcpRequest  (optional)
   * returns Dhcp
   **/
  static async devicesIdDhcpPOST ({ id, org, dhcpRequest }, { user }, response) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const orgList = await getAccessTokenOrgList(user, org, true);
      DevicesService.validateDhcpRequest(dhcpRequest);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      }).session(session);
      if (!deviceObject) {
        throw new Error('Device not found');
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }

      // Verify that no dhcp has been defined for the interface
      const dhcpObject = deviceObject.dhcp.filter((s) => {
        return (s.interface === dhcpRequest.interface);
      });
      if (dhcpObject.length > 0) throw new Error('DHCP already configured for that interface');

      const dhcpData = {
        interface: dhcpRequest.interface,
        rangeStart: dhcpRequest.rangeStart,
        rangeEnd: dhcpRequest.rangeEnd,
        dns: dhcpRequest.dns,
        macAssign: dhcpRequest.macAssign,
        status: 'add-wait'
      };

      // eslint-disable-next-line new-cap
      const dhcp = new dhcpModel(dhcpData);
      dhcp.$session(session);

      await devices.findOneAndUpdate(
        { _id: deviceObject._id },
        {
          $push: {
            dhcp: dhcp
          }
        },
        { new: true }
      ).session(session);

      const copy = Object.assign({}, dhcpRequest);

      copy.method = 'dhcp';
      copy._id = dhcp.id;
      copy.action = 'add';
      const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
      const result = { ...dhcpData, _id: dhcp._id.toString() };
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));

      await session.commitTransaction();
      session = null;

      return Service.successResponse(result, 202);
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get Device Status Information
   *
   * id String Numeric ID of the Device to retrieve configuration
   * org String Organization to be filtered by (optional)
   * returns DeviceStatus
   **/
  static async devicesIdStatusGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const { sync, machineId, isApproved } = await devices.findOne(
        { _id: id, org: { $in: orgList } },
        'sync machineId isApproved'
      ).lean();

      const isConnected = connections.isConnected(machineId);
      return Service.successResponse({
        sync,
        isApproved,
        connection: `${isConnected ? '' : 'dis'}connected`
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Invalid input',
        e.status || 500
      );
    }
  }

  /**
   * Returns an URL of jobs list request
   * @param {Array} jobsIds - array of jobs ids
   * @param {string} orgId - ID of the organzation
   */
  static jobsListUrl (jobsIds, orgId) {
    return `${configs.get('restServerUrl')}/api/jobs?status=all&ids=${
      jobsIds.join('%2C')}&org=${orgId}`;
  }
}

module.exports = DevicesService;
