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
const pathLabelsModel = require('../models/pathlabels');
const notificationsModel = require('../models/notifications');
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const statusesInDb = require('../periodic/statusesInDb')();
const { deviceStats } = require('../models/analytics/deviceStats');
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const mongoConns = require('../mongoConns.js')();
const mongoose = require('mongoose');
const validator = require('validator');
const net = require('net');
const pick = require('lodash/pick');
const isEqual = require('lodash/isEqual');
const uniqBy = require('lodash/uniqBy');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const flexibilling = require('../flexibilling');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateOperations } = require('../deviceLogic/interfaces');
const {
  validateDevice,
  validateDhcpConfig,
  validateStaticRoute,
  validateQOSPolicy
} = require('../deviceLogic/validators');
const {
  mapLteNames, mapWifiNames, getBridges, parseLteStatus, getCpuInfo
} = require('../utils/deviceUtils');
const { getAllOrganizationSubnets, getAllOrganizationBGPDevices } = require('../utils/orgUtils');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const { generateTunnelParams } = require('../utils/tunnelUtils');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const cidr = require('cidr-tools');
const { TypedError, ErrorTypes } = require('../utils/errors');
const { getMatchFilters } = require('../utils/filterUtils');
const TunnelsService = require('./TunnelsService');
const eventsReasons = require('../deviceLogic/events/eventReasons');
const publicAddrInfoLimiter = require('../deviceLogic/publicAddressLimiter');
const applications = require('../models/applications');
const applicationStore = require('../models/applicationStore');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const createError = require('http-errors');

class DevicesService {
  /**
   * Execute an action on the device side
   *
   * action String Command to execute
   * commandRequest CommandRequest  (optional)
   * no response value expected for this operation
   **/
  static async devicesApplyPOST ({ org, deviceCommand }, { user, server }, response) {
    try {
      // Find all devices of the organization
      const orgList = await getAccessTokenOrgList(user, org, true);
      const devicesIds = deviceCommand.devices && Object.keys(deviceCommand.devices);
      const filter = { org: { $in: orgList } };
      if (devicesIds && devicesIds.length > 0) {
        filter._id = { $in: devicesIds };
      }
      const opDevices = await devices.find(filter);
      if (opDevices.length === 0) {
        return Service.rejectResponse('Devices not found', 404);
      }
      // Apply the device command
      const { ids, status, message } = await dispatcher.apply(opDevices, deviceCommand.method,
        user, { org: orgList[0], ...deviceCommand });
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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
  static async devicesIdApplyPOST ({ id, org, deviceCommand }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const opDevice = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });

      if (opDevice.length !== 1) return Service.rejectResponse('Device not found', 404);

      const { ids, status, message } = await dispatcher.apply(opDevice, deviceCommand.method,
        user, { org: orgList[0], ...deviceCommand });
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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
  static async selectDeviceParams (item) {
    const deviceId = item._id.toString();

    // Pick relevant fields
    const retDevice = pick(item, [
      'org',
      'description',
      'deviceToken',
      'machineId',
      'site',
      'hostname',
      'serial',
      'name',
      '_id',
      'isApproved',
      'fromToken',
      'account',
      'ipList',
      'policies',
      'applications',
      // Internal array, objects
      'labels',
      'upgradeSchedule',
      'sync',
      'ospf',
      'coords',
      'bgp',
      'routingFilters',
      'cpuInfo'
    ]);

    retDevice.isConnected = connections.isConnected(retDevice.machineId);
    retDevice.state = deviceStatus.getDeviceStatus(retDevice.machineId) || 'pending';

    // pick interfaces
    let retInterfaces;
    if (item.interfaces) {
      retInterfaces = await Promise.all(item.interfaces.map(async i => {
        const retIf = pick(i, [
          'IPv6',
          'PublicIP',
          'PublicPort',
          'NatType',
          'useStun',
          'useFixedPublicPort',
          'internetAccess',
          'monitorInternet',
          'linkStatus',
          'gateway',
          'metric',
          'mtu',
          'dhcp',
          'IPv4',
          'type',
          'MAC',
          'routing',
          'IPv6Mask',
          'isAssigned',
          'driver',
          'IPv4Mask',
          'name',
          'devId',
          '_id',
          'pathlabels',
          'deviceType',
          'configuration',
          'deviceParams',
          'qosPolicy',
          'bandwidthMbps',
          'dnsServers',
          'dnsDomains',
          'useDhcpDnsServers',
          'ospf'
        ]);
        retIf._id = retIf._id.toString();
        if (retIf.qosPolicy) {
          retIf.qosPolicy = (retIf.qosPolicy._id ? retIf.qosPolicy._id : retIf.qosPolicy)
            .toString();
        }
        // if device is not connected then internet access status is unknown
        retIf.internetAccess = retDevice.isConnected ? retIf.internetAccess : '';
        retIf.linkStatus = retDevice.isConnected ? retIf.linkStatus : '';

        retIf.isPublicAddressRateLimited =
          await publicAddrInfoLimiter.isBlocked(`${deviceId}:${retIf._id}`);

        return retIf;
      }));
    } else retInterfaces = [];

    let retStaticRoutes;
    if (item.staticroutes) {
      retStaticRoutes = item.staticroutes.map(r => {
        const retRoute = pick(r, [
          '_id',
          'destination',
          'gateway',
          'ifname',
          'metric',
          'redistributeViaOSPF',
          'redistributeViaBGP',
          'isPending',
          'pendingReason',
          'onLink'
        ]);
        retRoute._id = retRoute._id.toString();
        return retRoute;
      });
    } else retStaticRoutes = [];

    let retDhcpList;
    if (item.dhcp) {
      retDhcpList = item.dhcp.map(d => {
        const retDhcp = pick(d, [
          '_id',
          'interface',
          'rangeStart',
          'rangeEnd',
          'dns',
          'status',
          'isPending',
          'pendingReason'
        ]);

        let macAssignList;
        if (d.macAssign) {
          macAssignList = d.macAssign.map(m => {
            return pick(m, [
              'host', 'mac', 'ipv4'
            ]);
          });
        } else macAssignList = [];

        retDhcp.macAssign = macAssignList;
        retDhcp._id = retDhcp._id.toString();
        return retDhcp;
      });
    } else retDhcpList = [];

    const retFirewallRules = (item.firewall && item.firewall.rules)
      ? item.firewall.rules.map(r => {
        const retRule = pick(r, [
          '_id',
          'description',
          'priority',
          'enabled',
          'direction',
          'inbound',
          'classification',
          'action',
          'internalIP',
          'internalPortStart',
          'interfaces',
          'system',
          'reference'
        ]);
        retRule._id = retRule._id.toString();
        return retRule;
      }) : [];

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
    retDevice.deviceSpecificRulesEnabled = item.deviceSpecificRulesEnabled;
    retDevice.firewall = {
      rules: retFirewallRules
    };
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
  static async devicesGET (requestParams, { user }, response) {
    const { org, offset, limit, sortField, sortOrder, filters } = requestParams;
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const updateStatusInDb = (filters && /state|isConnected|sync/.test(filters)) ||
        /state|isConnected|sync/.test(sortField);
      if (updateStatusInDb) {
        // need to update changed statuses from memory to DB
        await statusesInDb.updateDevicesStatuses(orgList);
      }

      let parsedFilters = [];
      if (filters) {
        parsedFilters = JSON.parse(filters);
      }

      const pipeline = [
        {
          $match: {
            org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) }
          }
        },
        {
          $lookup: {
            from: 'multilinkpolicies',
            localField: 'policies.multilink.policy',
            foreignField: '_id',
            as: 'policies.multilink.policy'
          }
        },
        {
          $unwind: {
            path: '$policies.multilink.policy',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: 'firewallpolicies',
            localField: 'policies.firewall.policy',
            foreignField: '_id',
            as: 'policies.firewall.policy'
          }
        },
        {
          $unwind: {
            path: '$policies.firewall.policy',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: 'qospolicies',
            localField: 'policies.qos.policy',
            foreignField: '_id',
            as: 'policies.qos.policy'
          }
        },
        {
          $unwind: {
            path: '$policies.qos.policy',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: 'pathlabels',
            localField: 'interfaces.pathlabels',
            foreignField: '_id',
            as: 'pathlabels'
          }
        },
        {
          $addFields: {
            _id: { $toString: '$_id' },
            'deviceStatus.state': {
              $cond: [{ $eq: ['$isConnected', true] }, '$status', 'pending']
            },
            'sync.statePrev': '$sync.state',
            'sync.state': {
              $cond: [{ $eq: ['$isConnected', true] }, '$sync.state', 'unknown']
            }
          }
        }
      ];

      // The stages associated with apps are relatively heavy.
      // They are used only for filtering. No need to run them every time
      if (parsedFilters.find(f => f.key.includes('applications'))) {
        pipeline.push(...deviceApplicationFilters);
      }

      if (parsedFilters.length > 0) {
        const matchFilters = getMatchFilters(parsedFilters);
        if (matchFilters.length > 0) {
          pipeline.push({
            $match: { $and: matchFilters }
          });
        }
      }
      if (sortField) {
        const order = sortOrder.toLowerCase() === 'desc' ? -1 : 1;
        pipeline.push({
          $sort: { [sortField]: order }
        });
      };
      const paginationParams = [{
        $skip: offset > 0 ? +offset : 0
      }];
      if (limit !== undefined) {
        paginationParams.push({ $limit: +limit });
      };

      if (requestParams.response === 'summary') {
        pipeline.push({
          $project: {
            org: { $toString: '$org' },
            isApproved: 1,
            isConnected: 1,
            name: 1,
            description: 1,
            serial: 1,
            hostname: 1,
            machineId: 1,
            sync: 1,
            versions: 1,
            coords: 1,
            interfaces: { isAssigned: 1, name: 1, type: 1, IPv4: 1, PublicIP: 1, devId: 1 },
            pathlabels: { name: 1, description: 1, color: 1, type: 1 },
            'policies.multilink': { status: 1, policy: { name: 1, description: 1 } },
            'policies.firewall': { status: 1, policy: { name: 1, description: 1 } },
            'policies.qos': { status: 1, policy: { name: 1, description: 1 } },
            applications: 1,
            cpuInfo: 1,
            deviceState: '$deviceStatus.state'
          }
        });
      } else if (requestParams.response === 'ids') {
        pipeline.push({ $project: { _id: 1, name: 1 } });
      } else {
        // fields to return in detailed response
        const respFields = [
          'org',
          'description',
          'deviceToken',
          'machineId',
          'site',
          'hostname',
          'serial',
          'name',
          'isApproved',
          'fromToken',
          'account',
          'ipList',
          'policies',
          'pathlabels',
          'versions',
          'staticroutes',
          'dhcp',
          'deviceSpecificRulesEnabled',
          'firewall',
          'qosPolicy',
          'bandwidthMbps',
          'upgradeSchedule',
          'sync',
          'ospf',
          'isConnected',
          'deviceState',
          'cpuInfo',
          'coords'
        ];
        // populate pathlabels for every interface
        pipeline.push({
          $unwind: {
            path: '$interfaces',
            preserveNullAndEmptyArrays: true
          }
        }, {
          $lookup: {
            from: 'pathlabels',
            localField: 'interfaces.pathlabels',
            foreignField: '_id',
            as: 'interfaces.pathlabels'
          }
        }, {
          $addFields: {
            'interfaces.pathlabels': {
              $map: {
                input: '$interfaces.pathlabels',
                as: 'pl',
                in: {
                  _id: { $toString: '$$pl._id' },
                  name: '$$pl.name',
                  description: '$$pl.description',
                  color: '$$pl.color',
                  type: '$$pl.type'
                }
              }
            }
          }
        }, {
          $group: {
            _id: '$_id',
            // name: { $first: '$name' },
            ...respFields.reduce((r, f) => ({ ...r, [f]: { $first: '$' + f } }), { }),
            interfaces: { $push: '$interfaces' }
          }
        });
      }
      pipeline.push({
        $facet: {
          records: paginationParams,
          meta: [{ $count: 'total' }]
        }
      });

      const paginated = await devices.aggregate(pipeline).allowDiskUse(true);
      if (paginated[0].meta.length > 0) {
        response.setHeader('records-total', paginated[0].meta[0].total);
      };
      let devicesMap;
      if (requestParams.response === 'summary') {
        // add pending notifications count for the summary request
        const pendingNotificationsArr = await notificationsModel.aggregate([
          {
            $match: {
              status: 'unread',
              device: { $in: paginated[0].records.map(d => mongoose.Types.ObjectId(d._id)) }
            }
          },
          {
            $group: {
              _id: '$device',
              count: { $sum: 1 }
            }
          },
          {
            $project: {
              _id: { $toString: '$_id' },
              count: 1
            }
          }
        ]);
        devicesMap = paginated[0].records.map(d => {
          const { count } = pendingNotificationsArr.find(n => n._id === d._id) || { count: 0 };
          d.pendingNotifications = count;
          if (!updateStatusInDb) {
            // get the actual status from memory if it was not updated in DB
            d.isConnected = connections.isConnected(d.machineId);
            d.deviceStatus = d.isConnected
              ? deviceStatus.getDeviceStatus(d.machineId) || { state: d.deviceState } : {};
            if (d.isConnected) {
              // sync is set to 'unknown' in query for correct filtering if device not connected
              d.sync.state = d.sync.statePrev;
            }
          } else {
            d.deviceStatus = { state: d.deviceState };
          }
          return d;
        });
      } else if (requestParams.response === 'ids') {
        devicesMap = paginated[0].records;
      } else {
        devicesMap = await Promise.all(paginated[0].records.map(async d => {
          return await DevicesService.selectDeviceParams(d);
        }));
      }
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
        return Service.rejectResponse('Some devices were not found', 404);
      }

      const set = {
        $set: {
          upgradeSchedule: {
            time: devicesUpgradeRequest.date,
            latestTry: null,
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
            latestTry: null,
            jobQueued: false
          }
        }
      };

      const options = { upsert: false, useFindAndModify: false };
      const res = await devices.updateOne(query, set, options);
      if (res.n === 0) {
        return Service.rejectResponse('Device not found', 404);
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
        .populate('policies.firewall.policy', '_id name description rules')
        .populate('policies.multilink.policy', '_id name description')
        .populate('policies.qos.policy', '_id name description')
        .populate({
          path: 'applications.app',
          populate: {
            path: 'appStoreApp'
          }
        });

      if (!result) {
        return Service.rejectResponse('Device not found', 404);
      }

      const device = await DevicesService.selectDeviceParams(result);

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
    let deviceStatus = 'unknown';
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
          error: null,
          deviceStatus: 'disconnected',
          configuration: []
        });
      }
      deviceStatus = 'connected';

      const deviceConf = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-config' },
        configs.get('directMessageTimeout', 'number')
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

      // Skip items with empty params
      const configuration = !Array.isArray(deviceConf.message) ? []
        : deviceConf.message.filter(item => item.params);

      return Service.successResponse({
        error: null,
        deviceStatus: 'connected',
        configuration
      });
    } catch (e) {
      return DevicesService.handleRequestError(e,
        { deviceStatus: deviceStatus, configuration: [] });
    }
  }

  static async devicesIdInterfacesIdStatusGET ({ id, interfaceId, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      const deviceObject = await devices.findOne({
        _id: id,
        org: { $in: orgList },
        'interfaces._id': interfaceId
      }).lean();

      if (!deviceObject) {
        return Service.rejectResponse('Device or Interface not found', 404);
      };

      const ifc = deviceObject.interfaces.find(i => i._id.toString() === interfaceId);

      const supportedMessages = {
        lte: {
          message: 'get-lte-info',
          defaultResponse: {
            connectivity: false,
            simStatus: null,
            signals: {},
            hardwareInfo: {},
            packetServiceState: {},
            phoneNumber: null,
            systemInfo: {},
            defaultSettings: {},
            pinState: {},
            connectionState: null,
            registrationNetworkState: {}
          },
          parseResponse: async response => {
            response = parseLteStatus(response);

            const apnIsDiff = !isEqual(ifc.deviceParams.defaultSettings, response.defaultSettings);
            const pinStateIsDiff = !isEqual(ifc.deviceParams.initial_pin1_state, response.pinState);

            const update = {};
            if (apnIsDiff) {
              update['interfaces.$.deviceParams.defaultSettings'] = response.defaultSettings;
            }
            if (pinStateIsDiff) {
              update['interfaces.$.deviceParams.initial_pin1_state'] = response.pinState;
            }

            if (Object.keys(update).length > 0) {
              await devices.updateOne(
                { _id: id, org: { $in: orgList }, 'interfaces._id': interfaceId },
                { $set: update }
              );
            }

            return response;
          }
        },
        wifi: {
          message: 'get-wifi-info',
          defaultResponse: {
            clients: [],
            accessPointStatus: false
          },
          parseResponse: async response => {
            response = mapWifiNames(response);
            return response;
          }
        }
      };

      const message = supportedMessages[ifc.deviceType];
      if (!message) {
        throw new Error('Unsupported request');
      }

      if (!connections.isConnected(deviceObject.machineId)) {
        return Service.successResponse({
          error: null,
          deviceStatus: 'disconnected',
          status: message.defaultResponse
        });
      }

      let response = message.defaultResponse;
      try {
        response = await connections.deviceSendMessage(
          null,
          deviceObject.machineId,
          {
            entity: 'agent',
            message: message.message,
            params: { dev_id: ifc.devId }
          },
          configs.get('directMessageTimeout', 'number')
        );
      } catch (e) {
        return DevicesService.handleRequestError(e,
          { deviceStatus: 'connected', status: response });
      }

      if (!response.ok) {
        logger.error('Failed to get interface info', {
          params: {
            deviceId: id, response: response.message
          }
        });
        return Service.rejectResponse('Failed to get interface status', 500);
      }

      let status = response.message;
      if (message.parseResponse) {
        status = await message.parseResponse(status);
      }

      return Service.successResponse({
        error: null,
        deviceStatus: 'connected',
        status
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
        return Service.rejectResponse('Device not found', 404);
      }

      const isApplication = await applicationStore.findOne({ identifier: filter });
      if (isApplication) {
        const installedApp = await applications.aggregate([
          { $match: { org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) } } },
          {
            $lookup: {
              from: 'applicationStore',
              localField: 'appStoreApp',
              foreignField: '_id',
              as: 'app'
            }
          },
          { $unwind: '$app' },
          { $match: { 'app.identifier': filter } }
        ]).allowDiskUse(true);

        if (!installedApp.length) {
          return Service.rejectResponse('Application is not installed', 404);
        }
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          error: null,
          deviceStatus: 'disconnected',
          logs: []
        });
      }

      const params = {
        lines: limit || '100',
        filter: filter || 'all'
      };

      if (isApplication) {
        params.application = {
          identifier: filter
        };
        params.filter = 'application';
      }

      const deviceLogs = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        {
          entity: 'agent',
          message: 'get-device-logs',
          params: params
        },
        configs.get('directMessageTimeout', 'number')
      );

      if (!deviceLogs.ok) {
        let errorMessage = '';
        switch (filter) {
          case 'fwagent':
            errorMessage = 'Failed to get flexiEdge agent logs';
            break;
          case 'syslog':
            errorMessage = 'Failed to get syslog logs';
            break;
          case 'dhcp':
            errorMessage =
              'Failed to get DHCP Server logs.' +
              ' Please verify DHCP Server is enabled on the device';
            break;
          case 'vpp':
            errorMessage = 'Failed to get VPP logs';
            break;
          case 'ospf':
            errorMessage = 'Failed to get OSPF logs';
            break;
          case 'hostapd':
            errorMessage = 'Failed to get Hostapd logs';
            break;
          case 'agentui':
            errorMessage = 'Failed to get flexiEdge UI logs';
            break;
          case 'application_ids':
            errorMessage = 'Failed to get Application Identification logs';
            break;
          default:
            errorMessage = 'Failed to get device logs';
        }
        logger.error(errorMessage, {
          params: {
            deviceId: id,
            response: deviceLogs.message,
            filter: filter
          }
        });
        return Service.rejectResponse(errorMessage, 500);
      }

      return Service.successResponse({
        error: null,
        deviceStatus: 'connected',
        logs: deviceLogs.message
      });
    } catch (e) {
      return DevicesService.handleRequestError(e, { deviceStatus: 'connected', logs: [] });
    }
  }

  static async devicesIdPacketTracesGET ({ id, org, packets, timeout }, { user }) {
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
          error: null,
          deviceStatus: 'disconnected',
          traces: []
        });
      }

      timeout = timeout || 5;
      const devicePacketTraces = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        {
          entity: 'agent',
          message: 'get-device-packet-traces',
          params: {
            packets: packets || 100,
            timeout: timeout
          }
        },
        timeout + configs.get('directMessageTimeout', 'number')
      );

      if (!devicePacketTraces.ok) {
        logger.error('Failed to get device packet traces', {
          params: {
            deviceId: id,
            response: devicePacketTraces.message
          }
        });
        return Service.rejectResponse('Failed to get device packet traces', 500);
      }

      return Service.successResponse({
        error: null,
        deviceStatus: 'connected',
        traces: devicePacketTraces.message
      });
    } catch (e) {
      return DevicesService.handleRequestError(e, { deviceStatus: 'connected', traces: [] });
    }
  }

  /**
   * Delete all devices matched the filters
   *
   * no response value expected for this operation
   **/
  static async devicesDELETE ({ org, devicesDeleteRequest }, { user }) {
    let orgList;
    try {
      let delDevices;
      let devIds;
      await mongoConns.mainDBwithTransaction(async (session) => {
        orgList = await getAccessTokenOrgList(user, org, true);
        const query = { org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) } };
        const { ids, filters } = devicesDeleteRequest;
        if (ids && filters) {
          throw createError(400, 'Only ids or filters can be specified as a parameter');
        } else if (filters === 'all') {
          // Delete all devices request protection
          logger.debug('Delete All devices request received');
        } else if (filters && (!Array.isArray(filters) || filters.length === 0)) {
          throw createError(400, 'To delete ALL devices please add filters=\'all\' parameter');
        } else if (filters) {
          const matchFilters = getMatchFilters(filters);
          if (matchFilters.length > 0) {
            query.$and = matchFilters;
          } else {
            throw createError(400, 'There is an error in specified filters');
          }
        } else if (ids) {
          query._id = { $in: ids.map(id => mongoose.Types.ObjectId(id)) };
        } else {
          throw createError(400, 'Ids or filters must be specified as a parameter');
        }
        delDevices = await devices.find(query).session(session);
        if (delDevices.length === 0) {
          throw createError(400, 'Devices for deletion not found');
        }
        devIds = delDevices.map(d => d._id);
        const tunnelCount = await tunnelsModel.countDocuments({
          $or: [{ deviceA: { $in: devIds } }, { deviceB: { $in: devIds } }],
          isActive: true,
          org: { $in: orgList }
        }).session(session);

        if (tunnelCount > 0) {
          logger.debug('Tunnels found when deleting device',
            { params: { filters }, user: user });
          throw createError(400, 'All devices tunnels must be deleted before deleting devices');
        }

        const deviceCount = await devices.countDocuments({
          account: delDevices[0].account
        }).session(session);

        const orgCount = await devices.countDocuments({
          account: delDevices[0].account, org: orgList[0]
        }).session(session);

        // Unregister a device (by adding - count)
        await flexibilling.registerDevice({
          account: delDevices[0].account,
          org: orgList[0],
          count: deviceCount,
          orgCount: orgCount,
          increment: -delDevices.length
        }, session);

        // Now we can remove the device
        await devices.deleteMany(query).session(session);
      });

      for (const dev of delDevices) {
        connections.deviceDisconnect(dev.machineId);
      }

      logger.info('Delete devices by filter success', {
        params: {
          ids: devIds,
          account: delDevices[0].account,
          org: orgList[0]
        }
      });

      return Service.successResponse(null, 204);
    } catch (e) {
      logger.error('Delete devices by filter failed', {
        params: {
          org: orgList ? orgList[0] : 'unknown',
          request: devicesDeleteRequest
        }
      });
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
    let orgList;
    let delDevice;
    try {
      await mongoConns.mainDBwithTransaction(async (session) => {
        orgList = await getAccessTokenOrgList(user, org, true);

        delDevice = await devices.findOne({
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }).session(session);

        if (!delDevice) {
          throw createError(404, 'Device for deletion not found');
        }

        const tunnelCount = await tunnelsModel.countDocuments({
          $or: [{ deviceA: id }, { deviceB: id }],
          isActive: true,
          org: { $in: orgList }
        }).session(session);

        if (tunnelCount > 0) {
          logger.debug('Tunnels found when deleting device',
            { params: { deviceId: id }, user: user });
          throw createError(400, 'All device tunnels must be deleted before deleting a device');
        }

        const deviceCount = await devices.countDocuments({
          account: delDevice.account
        }).session(session);

        const orgCount = await devices.countDocuments({
          account: delDevice.account, org: orgList[0]
        }).session(session);

        // Unregister a device (by adding -1)
        await flexibilling.registerDevice({
          account: delDevice.account,
          org: orgList[0],
          count: deviceCount,
          orgCount: orgCount,
          increment: -1
        }, session);

        // Now we can remove the device
        await devices.remove({
          _id: id,
          org: { $in: orgList }
        }).session(session);
      });

      connections.deviceDisconnect(delDevice.machineId);

      logger.info('Device by ID deleted successfully', {
        params: {
          _id: id.toString(),
          machineId: delDevice.machineId,
          account: delDevice.account,
          org: orgList[0]
        }
      });

      return Service.successResponse(null, 204);
    } catch (e) {
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
  static async devicesIdPUT ({ id, org, deviceRequest }, { user, server }, response) {
    let sessionCopy;

    try {
      let orgList;
      let origDevice;
      let updDevice;

      // We set closeSession to false since apply uses documents with the session
      // The session is closed at the end of the API
      sessionCopy = await mongoConns.mainDBwithTransaction(async (session) => {
        orgList = await getAccessTokenOrgList(user, org, true);
        origDevice = await devices.findOne({
          _id: id,
          org: { $in: orgList }
        })
          .session(session)
          .populate('policies.firewall.policy', '_id name rules')
          .populate('interfaces.pathlabels', '_id name description color type')
          .populate({
            path: 'applications.app',
            populate: {
              path: 'appStoreApp'
            }
          });

        if (!origDevice) {
          throw createError(404, 'Device not found');
        }

        // Don't allow empty device name
        // if the 'name' parameter skipped in the request we use the original value
        if ((!origDevice.name || deviceRequest.hasOwnProperty('name')) && !deviceRequest.name) {
          throw new Error('Device name must be set');
        }

        // Don't allow any changes if the device is not approved
        if (!origDevice.isApproved && !deviceRequest.isApproved) {
          throw createError(400, 'Device must be first approved');
        }

        // check LAN subnet overlap if updated device is running
        const devStatus = deviceStatus.getDeviceStatus(origDevice.machineId);
        const isRunning = (devStatus && devStatus.state && devStatus.state === 'running');

        let orgSubnets = [];
        if (isRunning && configs.get('forbidLanSubnetOverlaps', 'boolean')) {
          orgSubnets = await getAllOrganizationSubnets(origDevice.org);
        }
        const orgBgp = await getAllOrganizationBGPDevices(origDevice.org);

        const origTunnels = await tunnelsModel.find({
          isActive: true,
          $or: [{ deviceA: origDevice._id }, { deviceB: origDevice._id }]
        }).session(session).lean();

        // Make sure interfaces are not deleted, only modified
        if (Array.isArray(deviceRequest.interfaces)) {
          // not allowed to assign path labels of a different organization
          let orgPathLabels = await pathLabelsModel.find({ org: origDevice.org }, '_id')
            .session(session).lean();
          orgPathLabels = orgPathLabels.map(pl => pl._id.toString());
          const notAllowedPathLabels = deviceRequest.interfaces.map(intf =>
            !Array.isArray(intf.pathlabels) ? []
              : intf.pathlabels.map(pl => pl._id).filter(id => !orgPathLabels.includes(id))
          ).flat();
          if (notAllowedPathLabels.length) {
            logger.error('Not allowed path labels', { params: { notAllowedPathLabels } });
            throw createError(400, 'Not allowed to assign path labels of a different organization');
          };
          deviceRequest.interfaces = await Promise.all(origDevice.interfaces.map(async origIntf => {
            const interfaceId = origIntf._id.toString();
            const updIntf = deviceRequest.interfaces.find(rif => interfaceId === rif._id);
            if (updIntf) {
              // if the user disabled the STUN for this interface
              // we release the high rate blockage if exists
              const isStunDisabledNow = origIntf.useStun === true && updIntf.useStun === false;

              // if the user changed the static IP/port for this interface
              // we release the high rate blockage if exists
              let isStaticPublicInfoChanged = false;
              if (updIntf.useStun === false) {
                const isPublicPortChanged = origIntf.PublicPort !== updIntf.PublicPort;
                const isPublicIpChanged = origIntf.PublicIP !== updIntf.PublicIP;
                if (isPublicPortChanged || isPublicIpChanged) {
                  isStaticPublicInfoChanged = true;
                }
              }

              // if the user changed the portForwarding option
              // we release the high rate blockage if exists
              const isPortForwardingChanged =
                origIntf.useFixedPublicPort !== updIntf.useFixedPublicPort;

              if (isStunDisabledNow || isStaticPublicInfoChanged || isPortForwardingChanged) {
                const deviceId = origDevice._id.toString();
                await publicAddrInfoLimiter.release(`${deviceId}:${interfaceId}`);
              }

              // Public port and NAT type is assigned by system only
              updIntf.PublicPort = updIntf.useStun
                ? origIntf.PublicPort : configs.get('tunnelPort');
              updIntf.NatType = updIntf.useStun ? origIntf.NatType : 'Static';
              updIntf.internetAccess = origIntf.internetAccess;
              updIntf.linkStatus = origIntf.linkStatus;
              // Device type is assigned by system only
              updIntf.deviceType = origIntf.deviceType;

              // This field is set by changed to true by events logic only
              updIntf.hasIpOnDevice = origIntf.hasIpOnDevice;

              // Check tunnels connectivity
              if (origIntf.isAssigned) {
                // if interface unassigned make sure it's not used by any tunnel
                if (!updIntf.isAssigned) {
                  const numTunnels = await tunnelsModel
                    .countDocuments({
                      isActive: true,
                      $or: [{ interfaceA: origIntf._id }, { interfaceB: origIntf._id }]
                    }).session(session);
                  if (numTunnels > 0) {
                    // eslint-disable-next-line max-len
                    throw new Error('Unassigned interface used by existing tunnels, please delete related tunnels before');
                  }
                } else {
                  // interface still assigned, check if removed path labels not used by any tunnel
                  const pathlabels = (Array.isArray(updIntf.pathlabels))
                    ? updIntf.pathlabels.map(p => p._id.toString()) : [];
                  const remLabels = (Array.isArray(origIntf.pathlabels))
                    ? origIntf.pathlabels.filter(
                      p => !pathlabels.includes(p._id.toString())
                    ) : [];
                  if (remLabels.length > 0) {
                    const remLabelsArray = remLabels.map(p => p._id);
                    const numTunnels = await tunnelsModel
                      .countDocuments({
                        isActive: true,
                        $or: [{ interfaceA: origIntf._id }, { interfaceB: origIntf._id }],
                        pathlabel: { $in: remLabelsArray }
                      }).session(session);
                    if (numTunnels > 0) {
                    // eslint-disable-next-line max-len
                      throw createError(400, 'Removed label used by existing tunnels, please delete related tunnels before');
                    }
                  }
                }
              }

              // check interface specific validation
              if (updIntf?.qosPolicy) {
                const { valid, err } = validateQOSPolicy([origDevice]);
                if (!valid) {
                  throw new Error(err);
                }
              }

              // check firewall rules
              if (deviceRequest.firewall) {
                let hadInbound = false;
                let hadOutbound = false;
                let hasInbound = false;
                let hasOutbound = false;
                for (const rule of deviceRequest.firewall.rules) {
                  if (rule.direction === 'inbound') {
                    if (rule.classification.destination.ipProtoPort.interface === origIntf.devId) {
                      hadInbound = true;
                    }
                    if (rule.classification.destination.ipProtoPort.interface === updIntf.devId) {
                      hasInbound = true;
                    }
                  }
                  if (rule.direction === 'outbound') {
                    if (rule.interfaces.includes(origIntf.devId)) {
                      hadOutbound = true;
                    }
                    if (rule.interfaces.includes(updIntf.devId)) {
                      hasOutbound = true;
                    }
                  }
                }
                if (origIntf.type !== updIntf.type) {
                  if (hadInbound && updIntf.type !== 'WAN') {
                    throw createError(400,
                      `WAN interface ${origIntf.name} \
                      has firewall rules. Please remove rules before modifying.`
                    );
                  }
                  if (hadOutbound && updIntf.type !== 'LAN') {
                    throw createError(400,
                      `LAN Interface ${origIntf.name} \
                      has firewall rules. Please remove rules before modifying.`
                    );
                  }
                }
                if ((hasOutbound || hasInbound) && !updIntf.isAssigned) {
                  throw createError(400,
                    `Installing firewall on unassigned interface ${origIntf.name} is not allowed`
                  );
                }
                if (hasOutbound && updIntf.type !== 'LAN') {
                  throw createError(400,
                    `${updIntf.type} Interface ${origIntf.name} configured with outbound rules. \
                    Outbound rules are allowed on LAN only.`
                  );
                }
                if (hasInbound && updIntf.type !== 'WAN') {
                  throw createError(400,
                    `${updIntf.type} Interface ${origIntf.name} configured with inbound rules. \
                    Inbound rules are allowed on WAN only.`
                  );
                }
              }

              // Unassigned interfaces are not controlled from manage
              // we only get these parameters from the device itself.
              // It might be that the IP of the LTE interface is changed when a user
              // changes the unassigned LTE configuration.
              // In this case, we don't want to throw the below error
              if (!updIntf.isAssigned && updIntf.deviceType !== 'lte') {
                if ((updIntf.IPv4 && updIntf.IPv4 !== origIntf.IPv4) ||
                  (updIntf.IPv4Mask && updIntf.IPv4Mask !== origIntf.IPv4Mask) ||
                  (updIntf.gateway && updIntf.gateway !== origIntf.gateway)) {
                  throw createError(400,
                    `Not allowed to modify parameters of unassigned interfaces (${origIntf.name})`
                  );
                }
              };
              // Not allowed to modify parameters of PPPoE interfaces
              if (updIntf.deviceType === 'pppoe') {
                if ((updIntf.IPv4 && updIntf.IPv4 !== origIntf.IPv4) ||
                  (updIntf.IPv4Mask && updIntf.IPv4Mask !== origIntf.IPv4Mask) ||
                  (updIntf.hasOwnProperty('dhcp') && updIntf.dhcp !== 'yes') ||
                  (updIntf.hasOwnProperty('metric') && updIntf.metric !== origIntf.metric) ||
                  (updIntf.hasOwnProperty('mtu') && updIntf.mtu !== origIntf.mtu) ||
                  (updIntf.gateway && updIntf.gateway !== origIntf.gateway)) {
                  throw createError(400,
                    `Not allowed to modify parameters of PPPoE interfaces (${origIntf.name})`
                  );
                }
                // For PPPoE interfaces we use linux network parameters
                updIntf.IPv4 = origIntf.IPv4;
                updIntf.IPv4Mask = origIntf.IPv4Mask;
                updIntf.gateway = origIntf.gateway;
                updIntf.dhcp = 'yes';
                updIntf.metric = origIntf.metric;
                updIntf.mtu = origIntf.mtu;
              };
              // For unasigned and non static interfaces we use linux network parameters
              if (!updIntf.isAssigned || updIntf.dhcp === 'yes') {
                updIntf.IPv4 = origIntf.IPv4;
                updIntf.IPv4Mask = origIntf.IPv4Mask;
                updIntf.gateway = origIntf.gateway;
              };
              // don't update metric on an unassigned interface,
              // except lte interface because we enable lte connection on it,
              // hence we need the metric fo it
              if (!updIntf.isAssigned && updIntf.deviceType !== 'lte') {
                if (updIntf.metric && updIntf.metric !== origIntf.metric) {
                  throw createError(400,
                    `Changing metric of unassigned interfaces (${origIntf.name}) is not allowed`
                  );
                }
                updIntf.metric = origIntf.metric;
              };
              // don't update MTU on an unassigned interface,
              if (!updIntf.isAssigned && updIntf.mtu && updIntf.mtu !== origIntf.mtu) {
                throw createError(400,
                  `Changing MTU of unassigned interfaces (${origIntf.name}) is not allowed`
                );
              }

              // don't allow set OSPF keyID without key and vise versa
              const keyId = updIntf.ospf.keyId;
              const key = updIntf.ospf.key;
              if ((keyId && !key) || (!keyId && key)) {
                throw createError(400,
                  `(${origIntf.name}) Not allowed to save OSPF key ID without key and vice versa`
                );
              }

              if (updIntf.isAssigned && updIntf.routing === 'BGP' && !deviceRequest.bgp.enable) {
                throw new Error(
                  `Can't set BGP on ${origIntf.name}. ` +
                  'BGP is disabled, please configure BGP from routing settings first'
                );
              }

              if (updIntf.isAssigned && updIntf.type === 'WAN') {
                const dhcp = updIntf.dhcp;
                const servers = updIntf.dnsServers;
                const domains = updIntf.dnsDomains;

                // Prevent static IP without dns servers
                if (dhcp === 'no' && servers.length === 0) {
                  throw createError(400, `DNS ip address is required for ${origIntf.name}`);
                }

                // Prevent override dhcp DNS info without dns servers
                if (dhcp === 'yes' && !updIntf.useDhcpDnsServers && servers.length === 0) {
                  throw createError(400, `DNS ip address is required for ${origIntf.name}`);
                }

                const isValidIpList = servers.every(ip => net.isIPv4(ip));
                if (!isValidIpList) {
                  throw createError(400, `DNS ip addresses are not valid for (${origIntf.name})`);
                }

                const isValidDomainList = domains.every(domain => {
                  return validator.isFQDN(domain, { require_tld: false });
                });
                if (!isValidDomainList) {
                  throw createError(400, `DNS domain list is not valid for (${origIntf.name})`);
                }
              }

              if (updIntf.isAssigned !== origIntf.isAssigned ||
                updIntf.type !== origIntf.type ||
                updIntf.dhcp !== origIntf.dhcp ||
                updIntf.IPv4 !== origIntf.IPv4 ||
                updIntf.IPv4Mask !== origIntf.IPv4Mask ||
                updIntf.gateway !== origIntf.gateway
              ) {
                updIntf.modified = true;
              }
              return updIntf;
            }
            return origIntf;
          }));
        };

        // add device id to device request
        const deviceToValidate = {
          ...deviceRequest,
          _id: origDevice._id
        };
        // unspecified 'interfaces' are allowed for backward compatibility of some integrations
        if (typeof deviceToValidate.interfaces === 'undefined') {
          deviceToValidate.interfaces = origDevice.interfaces;
        }

        const ver = getMajorVersion(origDevice.versions.agent);

        // Map dhcp config if needed
        if (Array.isArray(deviceRequest.dhcp)) {
          deviceRequest.dhcp = deviceRequest.dhcp.map(d => {
            const ifc = deviceRequest.interfaces.find(i => i.devId === d.interface);
            if (!ifc) return d;

            const origIfc = origDevice.interfaces.find(i => i.devId === ifc.devId);
            if (!origIfc) return d;

            if (origIfc.IPv4 === '' || origIfc.IPv4Mask === '') return d;

            const origIp = `${origIfc.IPv4}/${origIfc.IPv4Mask}`;

            const oldBridges = getBridges(origDevice.interfaces);
            const newBridges = getBridges(deviceRequest.interfaces);

            // ********************************************************* //
            // The following checks are relate to the bridged interface
            // if the orig interface wasn't in a bridge, skip the checks
            // ********************************************************* //
            if (!(origIp in oldBridges)) {
              return d;
            }

            // if the interface is going to be unassigned now but it was assigned
            // we check if we can re-associate the dhcp to another assigned interface in the bridge.
            // For example: eth3, eth4, eth5 was in a bridge and dhcp was configured to eth3.
            // now, the user unassigned the eth3. In this case we re-associate the dhcp to the eth4.
            if (!ifc.isAssigned && origIfc.isAssigned && origIp in newBridges) {
              const reassociatedBridgedIfc = newBridges[origIp][0];
              if (reassociatedBridgedIfc) {
                return { ...d, interface: reassociatedBridgedIfc };
              }
            }

            // if the IP of the interface is changed and its going to be removed from the bridge,
            // we check if we can re-associate the dhcp to one of the existing
            // bridged interfaces.
            // For example: eth3, eth4 and eth5 was in a bridge and dhcp was configured to eth3.
            // now, the user changed the eth3 IP. In this case we re-associate the dhcp to the eth4.
            if (ifc.isAssigned && ifc.IPv4 !== origIfc.IPv4 && origIp in newBridges) {
              const reassociatedBridgedIfc = newBridges[origIp][0];
              if (reassociatedBridgedIfc) {
                return { ...d, interface: reassociatedBridgedIfc };
              }
            }

            return d;
          });

          // validate DHCP info if it exists
          for (const dhcpRequest of deviceRequest.dhcp) {
            DevicesService.validateDhcpRequest(deviceToValidate, dhcpRequest);
          }
        }

        if (deviceRequest?.bgp?.enable) {
          const major = getMajorVersion(origDevice.versions.agent);
          const minor = getMinorVersion(origDevice.versions.agent);
          if (major <= 5 && minor < 3) {
            throw createError(400,
              'The device does not run the required flexiWAN version for BGP. ' +
              'Please disable BGP or upgrade the device');
          }
        } else {
          // if bgp disabled, make sure no tunnel created with BGP on this device
          if (origTunnels.some(t => t?.advancedOptions?.routing === 'bgp')) {
            throw createError(400,
              'BGP cannot be disabled because there are tunnels created with BGP ' +
              'routing protocol. Please delete them first');
          }
        }

        // validate static routes
        if (Array.isArray(deviceRequest.staticroutes)) {
          // if route is via a pending tunnel, set it as pending
          const incompleteTunnels = origTunnels.filter(t => t.isPending);
          const interfacesWithoutIp = deviceRequest.interfaces.filter(i => i.IPv4 === '');

          deviceRequest.staticroutes = deviceRequest.staticroutes.map(s => {
            // if _id exists in the orig device object - dont allow to change the pending fields
            const origRoute = origDevice.staticroutes.find(
              os => s._id && os._id.toString() === s._id);
            if (origRoute) {
              s.isPending = origRoute.isPending;
              s.pendingReason = origRoute.pendingReason;
            }

            for (const t of incompleteTunnels) {
              const { ip1, ip2 } = generateTunnelParams(t.num);
              if (ip1 === s.gateway || ip2 === s.gateway) {
                s.isPending = true;
                s.pendingReason = eventsReasons.tunnelIsPending(t.num);
                return s;
              }
            }

            // don't set as pending for old version since we don't sent the IP for bridged interface
            if (ver >= 5) {
              for (const ifc of interfacesWithoutIp) {
                if (ifc.IPv4 === s.gateway) {
                  s.isPending = true;
                  s.pendingReason = eventsReasons.interfaceHasNoIp(ifc.name, origDevice.name);
                  return s;
                }
              }
            }

            return s;
          });

          const staticRoutesUniqueKeys = {};
          for (const route of deviceRequest.staticroutes) {
            const { valid, err } = validateStaticRoute(deviceToValidate, origTunnels, route);
            if (!valid) {
              logger.warn('Wrong static route parameters',
                {
                  params: { route, err }
                });
              throw createError(400, err);
            }
            const staticRouteKey = `${route.destination} via ${route.gateway}`;
            if (staticRoutesUniqueKeys.hasOwnProperty(staticRouteKey)) {
              const errorMsg = `Duplicated static routes detected: ${staticRouteKey}`;
              logger.warn(errorMsg, { params: { route } });
              throw createError(400, errorMsg);
            }
            staticRoutesUniqueKeys[staticRouteKey] = true;
          }
        }

        // Don't allow to modify/assign/unassign
        // interfaces that are assigned with DHCP
        if (Array.isArray(deviceRequest.interfaces)) {
          let dhcp = [...origDevice.dhcp];
          if (Array.isArray(deviceRequest.dhcp)) {
            // check only for the remaining dhcp configs
            dhcp = dhcp.filter(orig =>
              deviceRequest.dhcp.find(upd => orig.interface === upd.interface)
            );
          }
          const modifiedInterfaces = deviceRequest.interfaces
            .filter(intf => intf.modified)
            .map(intf => {
              return {
                devId: intf.devId,
                type: intf.type,
                addr: intf.IPv4 && intf.IPv4Mask ? `${intf.IPv4}/${intf.IPv4Mask}` : '',
                gateway: intf.gateway
              };
            });
          const { valid, err } = validateDhcpConfig(
            { ...origDevice.toObject(), dhcp },
            modifiedInterfaces
          );
          if (!valid) {
            logger.warn('Device update failed',
              {
                params: { device: deviceRequest, err }
              });
            throw createError(400, err);
          }
        }

        // make sure that system rules not deleted or modified
        const origSystemRules = origDevice.firewall.rules.filter(r => r.system);
        if ('firewall' in deviceRequest && Array.isArray(deviceRequest.firewall.rules)) {
          for (const origSystemRule of origSystemRules) {
            const origId = origSystemRule._id.toString();
            const idx = deviceRequest.firewall.rules.findIndex(r => r._id === origId);
            if (idx === -1) {
              // system rule doesn't exist in the incoming rules
              throw new Error('Firewall system rule cannot be deleted');
            } else {
              // system rule cannot be modified but disabled/enabled only.
              // set it back to the orig rule except of the "enabled" field
              deviceRequest.firewall.rules[idx] = {
                ...origSystemRule.toObject(),
                enabled: deviceRequest.firewall.rules[idx].enabled
              };
            }
          }

          for (const newRule of deviceRequest.firewall.rules) {
            // prevent user to set negative value for non system rule
            if (!newRule.system && newRule.priority < 0) {
              throw new Error('A user\'s firewall rule cannot have a priority lower than 0');
            }

            if (!newRule._id) {
              // don't allow to create new rule as system rule
              if (newRule.system) {
                throw new Error('A system rule cannot be created by a user');
              }
            } else {
              // don't allow to change existing user rule to a system rule
              const newRuleId = newRule._id.toString();
              if (newRule.system && !origSystemRules.some(o => newRuleId === o._id.toString())) {
                throw new Error('A system rule cannot be created by a user');
              }
            }
          };
        } else if (origSystemRules.length > 0) {
          // there are system rules in the origDevice,
          // but incoming modified device has no system rules
          throw new Error('Firewall system rule cannot be deleted');
        }

        // Need to validate device specific rules combined with global policy rules
        if (deviceToValidate.firewall) {
          deviceToValidate.policies = {
            firewall: origDevice.policies.firewall.toObject()
          };
        }

        // don't  allow to change "versions" and "cpuInfo"
        deviceToValidate.versions = origDevice.versions;
        deviceToValidate.cpuInfo = getCpuInfo(origDevice.cpuInfo);
        // allow change power saving for agent versions >= 6
        if (getMajorVersion(origDevice.versions.agent) >= 6) {
          deviceToValidate.cpuInfo.powerSaving = deviceRequest.cpuInfo.powerSaving;
        }
        deviceRequest.cpuInfo = deviceToValidate.cpuInfo;

        const { valid, err } = validateDevice(deviceToValidate, isRunning, orgSubnets, orgBgp);

        if (!valid) {
          logger.warn('Device update failed',
            {
              params: { device: deviceRequest, devStatus, err }
            });
          throw createError(400, err);
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
        delete deviceRequest.sync;

        updDevice = await devices.findOneAndUpdate(
          { _id: id, org: { $in: orgList } },
          { ...deviceRequest },
          { new: true, upsert: false, runValidators: true }
        )
          .session(session)
          // should be populated exactly as devicesIdGet response
          .populate('interfaces.pathlabels', '_id name description color type')
          .populate('policies.firewall.policy', '_id name description rules')
          .populate('policies.multilink.policy', '_id name description')
          .populate('policies.qos.policy', '_id name description')
          .populate({
            path: 'applications.app',
            populate: {
              path: 'appStoreApp'
            }
          });
      }, false);

      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      const modifyDevResult = await dispatcher.apply([origDevice], 'modify', user, {
        org: orgList[0],
        newDevice: updDevice
      });

      const status = modifyDevResult.ids.length > 0 ? 202 : 200;
      DevicesService.setLocationHeader(server, response, modifyDevResult.ids, orgList[0]);
      const deviceObj = await DevicesService.selectDeviceParams(updDevice);
      return Service.successResponse(deviceObj, status);
    } catch (e) {
      logger.error('update device failed', { params: { message: e.message, stack: e.stack } });
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    } finally {
      if (sessionCopy) sessionCopy.endSession();
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
        return Service.rejectResponse('Device not found', 404);
      }

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          error: null,
          deviceStatus: 'disconnected',
          osRoutes: [],
          vppRoutes: []
        });
      }

      const deviceOsRoutes = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: 'get-device-os-routes' },
        configs.get('directMessageTimeout', 'number')
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
        error: null,
        deviceStatus: 'connected',
        osRoutes: deviceOsRoutes.message,
        vppRoutes: []
      };
      return Service.successResponse(response);
    } catch (e) {
      return DevicesService.handleRequestError(e,
        { deviceStatus: 'connected', osRoutes: [], vppRoutes: [] });
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
        return Service.rejectResponse('Device not found', 404);
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
          status: value.status,
          redistributeViaOSPF: value.redistributeViaOSPF
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
  static async devicesIdStaticroutesRouteDELETE ({ id, org, route }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const device = await devices.findOne(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }
      );

      if (!device) {
        return Service.rejectResponse('Device not found', 404);
      }

      const deleteRoute = device.staticroutes.filter((s) => {
        return (s.id === route);
      });
      if (deleteRoute.length !== 1) {
        return Service.rejectResponse('Static route not found', 404);
      }

      const copy = Object.assign({}, deleteRoute[0].toObject());
      copy.org = orgList[0];
      copy.method = 'staticroutes';
      copy._id = route;
      copy.action = 'del';
      const { ids } = await dispatcher.apply(device, copy.method, user, copy);
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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
  static async devicesIdStaticroutesPOST (request, { user, server }, response) {
    const { id, org, staticRouteRequest } = request;
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      let device = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!device) {
        return Service.rejectResponse('Device not found', 404);
      }
      if (!device.isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse('Device must be first approved', 400);
      }

      // eslint-disable-next-line new-cap
      const route = new staticroutes({
        destination: staticRouteRequest.destination,
        gateway: staticRouteRequest.gateway,
        ifname: staticRouteRequest.ifname,
        metric: staticRouteRequest.metric
      });

      const error = route.validateSync();
      if (error) {
        logger.warn('static route validation failed',
          {
            params: { staticRouteRequest, error }
          });
        throw new Error(error.message);
      }

      const tunnels = await tunnelsModel.find({
        isActive: true,
        $or: [{ deviceA: device._id }, { deviceB: device._id }]
      }, { num: 1 });
      const { valid, err } = validateStaticRoute(device, tunnels, route);
      if (!valid) {
        logger.warn('Adding a new static route failed',
          {
            params: { staticRouteRequest, err }
          });
        throw new Error(err);
      }

      device = await devices.findOneAndUpdate(
        { _id: device._id },
        {
          $push: {
            staticroutes: route
          }
        },
        { new: true, runValidators: true }
      );

      const copy = Object.assign({}, staticRouteRequest);
      copy.org = orgList[0];
      copy.method = 'staticroutes';
      copy._id = route.id;
      const { ids } = await dispatcher.apply(device, copy.method, user, copy);
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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
  static async devicesIdStaticroutesRoutePATCH (request, { user, server }, response) {
    const { id, org, staticRouteRequest } = request;
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.find({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject || deviceObject.length === 0) {
        return Service.rejectResponse('Device not found', 404);
      }
      if (!deviceObject[0].isApproved && !staticRouteRequest.isApproved) {
        return Service.rejectResponse('Device must be first approved', 400);
      }

      const device = deviceObject[0];
      const copy = Object.assign({}, staticRouteRequest);
      copy.org = orgList[0];
      copy.method = 'staticroutes';
      copy.action = staticRouteRequest.status === 'add-failed' ? 'add' : 'del';
      const { ids } = await dispatcher.apply(device, copy.method, user, copy);
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
      return Service.successResponse({ deviceId: device.id });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get device statistics from the database
   * @param {string} id      - device ID in mongodb, if not specified, get all devices stats
   * @param {string} ifNum   - device interface bus address
   *                           if not specified, get all device stats
   * @param {string} org     - organization ID in mongodb
   * @param {Date} startTime - start time to get stats, if not specified get all previous time
   * @param {Date} endTime   - end time to get stats, if not specified get to latest time
   * @return {Array} - Objects with device stats
   */
  static async queryDeviceStats ({ id, ifNum, org, startTime, endTime }) {
    const match = { org: mongoose.Types.ObjectId(org) };

    if (id) match.device = mongoose.Types.ObjectId(id);
    if (startTime && endTime) {
      match.$and = [{ time: { $gte: +startTime } }, { time: { $lte: +endTime } }];
    } else if (startTime) match.time = { $gte: +startTime };
    else if (endTime) match.time = { $lte: +endTime };

    const pipeline = [
      { $match: match },
      { $project: { time: 1, stats: { $objectToArray: '$stats' } } },
      { $unwind: '$stats' },
      ...(ifNum ? [{ $match: { 'stats.k': ifNum.replace('.', ':') } }] : []),
      {
        $group:
              {
                _id: { time: '$time', interface: (ifNum) || 'All' },
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
   * Get tunnel statistics from the database
   * @param {string} id          - device ID in mongodb, if not specified, get all stats
   * @param {string} tunnelnum   - tunnel number (usually a devId address)
   *                               if not specified, get all tunnels stats
   * @param {string} org         - organization ID in mongodb
   * @param {Date} startTime     - start time to get stats, if not specified get all previous time
   * @param {Date} endTime       - end time to get stats, if not specified get to latest time
   * @return {Array} - Objects with tunnel stats
   */
  static async queryDeviceTunnelStats ({ id, tunnelnum, org, startTime, endTime }) {
    const match = { org: mongoose.Types.ObjectId(org) };

    if (id) match.device = mongoose.Types.ObjectId(id);
    if (startTime && endTime) {
      match.$and = [{ time: { $gte: +startTime } }, { time: { $lte: +endTime } }];
    } else if (startTime) match.time = { $gte: +startTime };
    else if (endTime) match.time = { $lte: +endTime };

    const pipeline = [
      { $match: match },
      { $project: { time: 1, tunnels: { $objectToArray: '$tunnels' } } },
      { $unwind: '$tunnels' },
      ...(tunnelnum ? [{ $match: { 'tunnels.k': tunnelnum } }] : []),
      {
        $group:
              {
                _id: { time: '$time', tunnel: (tunnelnum) || 'All' },
                rx_bps: { $sum: '$tunnels.v.rx_bps' },
                tx_bps: { $sum: '$tunnels.v.tx_bps' },
                rx_pps: { $sum: '$tunnels.v.rx_pps' },
                tx_pps: { $sum: '$tunnels.v.tx_pps' },
                drop_rate: { $max: '$tunnels.v.drop_rate' },
                rtt: { $max: '$tunnels.v.rtt' },
                status: { $min: '$tunnels.v.status' }
              }
      },
      {
        $project: {
          _id: 0,
          time: '$_id.time',
          interface: '$_id.tunnel',
          rx_bps: '$rx_bps',
          tx_bps: '$tx_bps',
          rx_pps: '$rx_pps',
          tx_pps: '$tx_pps',
          drop_rate: '$drop_rate',
          rtt: '$rtt',
          status: '$status'
        }
      },
      { $sort: { time: -1 } }
    ];

    const stats = await deviceStats.aggregate(pipeline).allowDiskUse(true);
    return stats;
  }

  /**
   * Get device health from the database
   * @param {string} id      - device ID in mongodb, if not specified, get all devices stats
   * @param {string} org     - organization ID in mongodb
   * @param {Date} startTime - start time to get stats, if not specified get all previous time
   * @param {Date} endTime   - end time to get stats, if not specified get to latest time
   * @return {Array} - Objects with device stats
   */
  static async queryDeviceHealth ({ id, org, startTime, endTime }) {
    const match = { org: mongoose.Types.ObjectId(org) };
    if (id) match.device = mongoose.Types.ObjectId(id);
    if (startTime && endTime) {
      match.$and = [{ time: { $gte: +startTime } }, { time: { $lte: +endTime } }];
    } else if (startTime) match.time = { $gte: +startTime };
    else if (endTime) match.time = { $lte: +endTime };

    const pipeline = [
      { $match: match },
      {
        $project: {
          _id: 0,
          time: 1,
          cpu: '$health.cpu',
          disk: '$health.disk',
          mem: '$health.mem',
          temp: '$health.temp'
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
  static async devicesStatisticsGET ({ org, startTime, endTime }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceStats({
        org: orgList[0].toString(),
        ifNum: null, // null to get all interfaces stats
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
  static async devicesIdStatisticsGET ({ id, org, ifnum, startTime, endTime }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceStats({
        org: orgList[0].toString(),
        id: id,
        ifNum: ifnum,
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
   * Retrieve device tunnels
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns List
   **/
  static async devicesIdTunnelsGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const tunnels = await tunnelsModel.find({
        isActive: true,
        org: { $in: orgList },
        $or: [{ deviceA: id }, { deviceB: id }]
      }).populate('deviceA', 'name interfaces machineId')
        .populate('deviceB', 'name interfaces machineId')
        .populate('pathlabel')
        .populate('peer')
        .lean();

      const tunnelMap = tunnels.map((d) => {
        return TunnelsService.selectTunnelParams(d);
      });

      return Service.successResponse(tunnelMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve device tunnel statistics information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceTunnelStatistics
   **/
  static async devicesIdTunnelStatisticsGET ({ id, org, tunnelnum, startTime, endTime }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceTunnelStats({
        org: orgList[0].toString(),
        id: id,
        tunnelnum: tunnelnum,
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
   * Retrieve device health information
   *
   * id Object Numeric ID of the Device to fetch information about
   * returns DeviceHealth
   **/
  static async devicesIdHealthGET ({ id, org, startTime, endTime }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const stats = await DevicesService.queryDeviceHealth({
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
  static async devicesIdDhcpDhcpIdDELETE ({ id, dhcpId, force, org }, { user, server }, response) {
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

      if (!device) return Service.rejectResponse('Device not found', 404);
      const deleteDhcp = device.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });

      if (deleteDhcp.length !== 1) return Service.rejectResponse('DHCP ID not found', 404);

      const deleteDhcpObj = deleteDhcp[0].toObject();

      // If previous status was del-wait, no need to resend the job
      if (deleteDhcpObj.status !== 'del-wait') {
        const copy = Object.assign({}, deleteDhcpObj);
        copy.org = orgList[0];
        copy.method = 'dhcp';
        copy._id = dhcpId;
        copy.action = 'del';
        const { ids } = await dispatcher.apply(device, copy.method, user, copy);
        DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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

      return Service.successResponse(null, 202);
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

      if (!device) return Service.rejectResponse('Device not found', 404);
      const resultDhcp = device.dhcp.filter((s) => {
        return (s.id === dhcpId);
      });
      if (resultDhcp.length !== 1) return Service.rejectResponse('DHCP ID not found', 404);

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
  static async devicesIdDhcpDhcpIdPUT ({ id, dhcpId, org, dhcpRequest }, { user, server }, res) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        return Service.rejectResponse('Device not found', 404);
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
      if (dhcpFiltered.length !== 1) return Service.rejectResponse('DHCP ID not found', 404);

      DevicesService.validateDhcpRequest(deviceObject, dhcpRequest);

      const dhcpData = {
        _id: dhcpId,
        interface: dhcpRequest.interface,
        rangeStart: dhcpRequest.rangeStart,
        rangeEnd: dhcpRequest.rangeEnd,
        dns: dhcpRequest.dns,
        macAssign: dhcpRequest.macAssign
      };

      const updDevice = await devices.findOneAndUpdate(
        { _id: deviceObject._id },
        { $set: { 'dhcp.$[elem]': dhcpData } },
        { arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(dhcpId) }], new: true }
      );

      const { ids } = await dispatcher.apply([deviceObject], 'modify', user, {
        org: orgList[0],
        newDevice: updDevice
      });
      DevicesService.setLocationHeader(server, res, ids, orgList[0]);
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
  static async devicesIdDhcpDhcpIdPATCH ({ id, dhcpId, org }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        return Service.rejectResponse('Device not found', 404);
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
      if (dhcpFiltered.length !== 1) return Service.rejectResponse('DHCP ID not found', 404);
      const dhcpObject = dhcpFiltered[0].toObject();

      // allow to patch only in the case of failed
      if (dhcpObject.status !== 'add-failed' && dhcpObject.status !== 'remove-failed') {
        throw new Error('Only allowed for add or removed failed jobs');
      }

      const copy = Object.assign({}, dhcpObject);
      copy.org = orgList[0];
      copy.method = 'dhcp';
      copy.action = dhcpObject.status === 'add-failed' ? 'add' : 'del';
      const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
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

      if (!device) return Service.rejectResponse('Device not found', 404);
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
   * @param {Object} device - the device object
   * @param {Object} dhcpRequest - request values
   * @throw error, if not valid
   */
  static validateDhcpRequest (device, dhcpRequest) {
    if (!dhcpRequest.interface || dhcpRequest.interface === '') {
      throw new Error('Interface is required to define DHCP Server');
    };
    const interfaceObj = device.interfaces.find(i => {
      return i.devId === dhcpRequest.interface;
    });
    if (!interfaceObj) {
      throw new Error(`Unknown interface: ${dhcpRequest.interface} in DHCP Server parameters`);
    }
    if (!interfaceObj.isAssigned) {
      throw new Error('DHCP Server can be defined only for assigned interfaces');
    }
    if (interfaceObj.type !== 'LAN') {
      throw new Error('DHCP Server can be defined only for LAN interfaces');
    }
    if (interfaceObj.IPv4 === '') {
      // eslint-disable-next-line max-len
      throw new Error(`DHCP Server cannot be defined for interface ${interfaceObj.name} without IP`);
    }

    // check that DHCP Range Start/End IP are on the same subnet with interface IP
    if (!cidr.overlap(`${interfaceObj.IPv4}/${interfaceObj.IPv4Mask}`,
    `${dhcpRequest.rangeStart}/32`)) {
      // eslint-disable-next-line max-len
      throw new Error('DHCP Server Range Start IP address is not on the same subnet with interface IP');
    }
    if (!cidr.overlap(`${interfaceObj.IPv4}/${interfaceObj.IPv4Mask}`,
    `${dhcpRequest.rangeEnd}/32`)) {
      // eslint-disable-next-line max-len
      throw new Error('DHCP Server Range End IP address is not on the same subnet with interface IP');
    }
    // check that DHCP range End address IP is greater than Start IP address
    const ip2int = IP => IP.split('.')
      .reduce((res, val, idx) => res + (+val) * 256 ** (3 - idx), 0);
    if (ip2int(dhcpRequest.rangeStart) > ip2int(dhcpRequest.rangeEnd)) {
      throw new Error('DHCP Server Range End IP address must be greater than Start IP address');
    }
    // Check that no repeated mac, host or IP
    const macLen = dhcpRequest.macAssign.length;
    const uniqMacs = uniqBy(dhcpRequest.macAssign, 'mac');
    const uniqHosts = uniqBy(dhcpRequest.macAssign, 'host');
    const uniqIPs = uniqBy(dhcpRequest.macAssign, 'ipv4');
    if (uniqMacs.length !== macLen) {
      throw new Error('DHCP Server MAC bindings MACs are not unique');
    }
    if (uniqHosts.length !== macLen) {
      throw new Error('DHCP Server MAC bindings hosts are not unique');
    }
    if (uniqIPs.length !== macLen) {
      throw new Error('DHCP Server MAC bindings IPs are not unique');
    }
  }

  /**
   * Add DHCP server
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by (optional)
   * dhcpRequest DhcpRequest  (optional)
   * returns Dhcp
   **/
  static async devicesIdDhcpPOST ({ id, org, dhcpRequest }, { user, server }, response) {
    let session;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      }).session(session);
      if (!deviceObject) {
        return Service.rejectResponse('Device not found', 404);
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }
      DevicesService.validateDhcpRequest(deviceObject, dhcpRequest);

      // Verify that no dhcp has been defined for the interface
      const dhcpObject = deviceObject.dhcp.filter((s) => {
        return (s.interface === dhcpRequest.interface);
      });
      if (dhcpObject.length > 0) throw new Error('DHCP already configured for that interface');

      // for bridge feature we allow to set only one dhcp config
      // for one of the interface in the bridge
      const interfaceObj = deviceObject.interfaces.find(i => i.devId === dhcpRequest.interface);
      const addr = interfaceObj.IPv4;
      const bridgedInterfacesIds = deviceObject.interfaces.filter(i => {
        return i.devId !== dhcpRequest.interface && i.isAssigned && i.IPv4 === addr;
      }).map(i => i.devId);

      if (bridgedInterfacesIds.length) {
        const dhcp = deviceObject.dhcp.map(d => d.interface);
        const dhcpConfigured = bridgedInterfacesIds.some(i => dhcp.includes(i));
        if (dhcpConfigured) {
          throw new Error(`DHCP already configured for an interface in ${addr} bridge`);
        }
      }

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

      await session.commitTransaction();
      session = null;

      const copy = Object.assign({}, dhcpRequest);
      copy.method = 'dhcp';
      copy._id = dhcp.id;
      copy.action = 'add';
      copy.org = orgList[0];
      const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
      const result = { ...dhcpData, _id: dhcp._id.toString() };
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
      return Service.successResponse(result, 202);
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async devicesIdInterfacesIdActionPOST ({
    org, id, interfaceOperationReq, interfaceId
  }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      const deviceObject = await devices.findOne({
        _id: id,
        org: { $in: orgList },
        'interfaces._id': interfaceId
      }).lean();

      if (!deviceObject) {
        return Service.rejectResponse('Device or Interface not found', 404);
      };

      const selectedIf = deviceObject.interfaces.find(i => i._id.toString() === interfaceId);
      const { valid, err } = validateOperations(selectedIf, interfaceOperationReq);

      if (!valid) {
        logger.warn('interface perform operation failed',
          {
            params: { body: interfaceOperationReq, err: err }
          });
        return Service.rejectResponse(err, 500);
      }

      const interfaceType = selectedIf.deviceType;

      const actions = {
        lte: {
          reset: {
            job: true,
            message: 'reset-lte',
            title: 'Reset LTE modem'
          },
          pin: {
            job: false,
            message: 'modify-lte-pin',
            onError: async (jobId, err) => {
              try {
                err = JSON.parse(err.replace(/'/g, '"'));
                const data = mapLteNames(err.data);
                await devices.updateOne(
                  { _id: id, org: { $in: orgList }, 'interfaces._id': interfaceId },
                  {
                    $set: {
                      'interfaces.$.deviceParams.initial_pin1_state': data
                    }
                  }
                );
                return JSON.stringify({ err_msg: err.err_msg, data: data });
              } catch (err) { }
            },
            onComplete: async (jobId, response) => {
              if (response.message && response.message.data) {
                const data = mapLteNames(response.message.data);
                response.message.data = data;
                // update pin state
                await devices.updateOne(
                  { _id: id, org: { $in: orgList }, 'interfaces._id': interfaceId },
                  {
                    $set: {
                      'interfaces.$.deviceParams.initial_pin1_state': data
                    }
                  }
                );

                return data;
              }
            }
          }
        }
      };

      const agentAction = actions[interfaceType]
        ? actions[interfaceType][interfaceOperationReq.op]
          ? actions[interfaceType][interfaceOperationReq.op] : null : null;

      if (agentAction) {
        const params = interfaceOperationReq.params || {};
        params.dev_id = selectedIf.devId;

        if (agentAction.validate) {
          const { valid, err } = agentAction.validate();

          if (!valid) {
            logger.warn('interface perform operation failed',
              {
                params: { body: interfaceOperationReq, err: err }
              });
            return Service.rejectResponse(err, 500);
          }
        }

        if (agentAction.job) {
          const tasks = [{ entity: 'agent', message: agentAction.message, params: params }];
          const callback = agentAction.onComplete ? agentAction.onComplete : null;
          try {
            const job = await deviceQueues
              .addJob(
                deviceObject.machineId,
                user.username,
                orgList[0],
                // Data
                {
                  title: agentAction.title,
                  tasks: tasks
                },
                // Response data
                {
                  method: agentAction.message,
                  data: {
                    device: deviceObject._id,
                    org: orgList[0],
                    shouldUpdateTunnel: false
                  }
                },
                // Metadata
                { priority: 'normal', attempts: 1, removeOnComplete: false },
                // Complete callback
                callback
              );
            logger.info('Interface action job queued', { params: { job } });
          } catch (err) {
            logger.error('Interface action job failed', {
              params: { machineId: deviceObject.machineId, error: err.message }
            });
            return Service.rejectResponse(err.message, 500);
          }
        } else {
          const isConnected = connections.isConnected(deviceObject.machineId);
          if (!isConnected) {
            return Service.successResponse({
              error: null,
              deviceStatus: 'disconnected'
            });
          }

          let response = {};
          try {
            response = await connections.deviceSendMessage(
              null,
              deviceObject.machineId,
              {
                entity: 'agent',
                message: agentAction.message,
                params: params
              },
              configs.get('directMessageTimeout', 'number')
            );
          } catch (e) {
            return DevicesService.handleRequestError(e, { deviceStatus: 'connected' });
          }

          if (!response.ok) {
            logger.error('Failed to perform interface operation', {
              params: {
                deviceId: id, response: response.message
              }
            });

            const regex = new RegExp(/(?<=failed: ).+?(?=\()/g);
            let err = response.message.match(regex).join(',');

            if (agentAction.onError) {
              err = await agentAction.onError(null, err);
            }

            return Service.rejectResponse(err, 500);
          }

          if (agentAction.onComplete) {
            await agentAction.onComplete(null, response);
          }

          return Service.successResponse({
            ...response,
            deviceStatus: 'connected',
            error: null
          }, 200);
        }
      }

      return Service.successResponse({ deviceStatus: 'connected', error: null }, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Invalid input',
        e.status || 500
      );
    }
  };

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
      const device = await devices.findOne(
        { _id: id, org: { $in: orgList } },
        'sync machineId isApproved interfaces.devId interfaces.internetAccess interfaces.linkStatus'
      ).lean();
      if (!device) {
        return Service.rejectResponse('Device not found', 404);
      }
      const { sync, machineId, isApproved, interfaces } = device;
      const isConnected = connections.isConnected(machineId);

      const status = deviceStatus.getDeviceStatus(machineId) || {};
      const lteStatus = status.lteStatus;
      const wifiStatus = status.wifiStatus;

      return Service.successResponse({
        sync,
        isApproved,
        connection: `${isConnected ? '' : 'dis'}connected`,
        interfaces,
        lteStatus,
        wifiStatus
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Invalid input',
        e.status || 500
      );
    }
  }

  /**
   * Send Linux Command to Device
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by
   * sendRequest Send Command Request
   * returns Command Output Result
   **/
  static async devicesIdSendPOST ({ id, org, deviceSendRequest }, { user }, response) {
    try {
      if (!deviceSendRequest.api || !deviceSendRequest.entity) {
        throw new Error('Request must include entity and api fields');
      }
      const orgList = await getAccessTokenOrgList(user, org, false);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        return Service.rejectResponse('Device not found', 404);
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }
      if (!connections.isConnected(deviceObject.machineId)) {
        return Service.successResponse({
          error: null,
          deviceStatus: 'disconnected'
        });
      }

      const request = {
        entity: deviceSendRequest.entity,
        message: deviceSendRequest.api
      };
      if (deviceSendRequest.params) {
        request.params = deviceSendRequest.params;
      }

      const result = await connections.deviceSendMessage(
        null,
        deviceObject.machineId,
        request,
        100000 // 100 sec
      );

      return Service.successResponse({ ...result, error: null }, 200);
    } catch (e) {
      return DevicesService.handleRequestError(e, { deviceStatus: 'connected' });
    }
  }

  /**
   * Get OSPF configuration
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by (optional)
   * returns OSPF configuration
   **/
  static async devicesIdRoutingOSPFGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const device = await devices.findOne(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }
      );

      if (!device) return Service.rejectResponse('Device not found', 404);

      return Service.successResponse(device.ospf, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify OSPF configuration
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by
   * ospfConfigs ospfConfigs
   * returns OSPF configuration
   **/
  static async devicesIdRoutingOSPFPUT ({ id, org, ospfConfigs }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const deviceObject = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      });
      if (!deviceObject) {
        return Service.rejectResponse('Device not found', 404);
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }

      const updDevice = await devices.findOneAndUpdate(
        { _id: deviceObject._id },
        { $set: { ospf: ospfConfigs } },
        { new: true, runValidators: true }
      );

      const { ids } = await dispatcher.apply([deviceObject], 'modify', user, {
        org: orgList[0],
        newDevice: updDevice
      });
      DevicesService.setLocationHeader(server, response, ids, orgList[0]);
      return Service.successResponse(ospfConfigs, 202);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify device coordinates configuration
   *
   * id String Numeric ID of the Device
   * org String Organization to be filtered by
   * coordsConfig Coordinates Configs
   * returns coordinates configuration
   **/
  static async devicesIdCoordsPUT ({ id, org, coordsConfigs }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      if (!coordsConfigs.coords ||
        coordsConfigs.coords.length !== 2 ||
        coordsConfigs.coords.some((c) => typeof c !== 'number')) {
        throw new Error('Coordinates should contain an array of longitude, latitude numbers');
      }

      const updDevice = await devices.updateOne(
        { _id: mongoose.Types.ObjectId(id), org: { $in: orgList } },
        { $set: { coords: coordsConfigs.coords } },
        { runValidators: true, upsert: false }
      );

      if (updDevice.n !== 1) { // Device not matched
        throw new Error('Device not found');
      }

      return Service.successResponse(coordsConfigs, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Sets Location header of the response, used in some integrations
   * @param {Object} response - response to http request
   * @param {Array} jobsIds - array of jobs ids
   * @param {string} orgId - ID of the organization
   */
  static setLocationHeader (server, response, jobsIds, orgId) {
    if (jobsIds.length) {
      const locationHeader = `${server}/api/jobs?status=all&ids=${
        jobsIds.join('%2C')}&org=${orgId}`;
      response.setHeader('Location', locationHeader);
    }
  }

  static handleRequestError (e, payload, code = 200) {
    if (e instanceof TypedError && e.code === ErrorTypes.TIMEOUT.code) {
      return Service.successResponse({ ...payload, error: 'timeout' }, code);
    } else {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

const deviceApplicationFilters = [{
  // split applications array to objects. Note! this creates duplication in devices,
  // remember to group it back
  $unwind: {
    path: '$applications',
    preserveNullAndEmptyArrays: true
  }
},
{
  $lookup: {
    from: 'applications',
    localField: 'applications.app',
    foreignField: '_id',
    as: 'applications.app'
  }
},
{
  $unwind: {
    path: '$applications.app',
    preserveNullAndEmptyArrays: true
  }
},
{
  $lookup: {
    from: 'applicationStore',
    localField: 'applications.app.appStoreApp',
    foreignField: '_id',
    as: 'applications.app.appStoreApp'
  }
},
{
  $unwind: {
    path: '$applications.app.appStoreApp',
    preserveNullAndEmptyArrays: true
  }
},
{
  $group: {
    _id: '$_id',
    device: { $first: '$$ROOT' },
    applications: {
      $push: '$applications'
    }
  }
},
{
  $addFields: {
    'device.applications': {
      $filter: {
        input: '$applications',
        as: 'app',
        cond: {
          $ne: ['$$app.app', {}]
        }
      }
    }
  }
},
{
  $replaceRoot: { newRoot: '$device' }
}];

module.exports = DevicesService;
