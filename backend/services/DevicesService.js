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
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const { deviceStats } = require('../models/analytics/deviceStats');
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const mongoConns = require('../mongoConns.js')();
const mongoose = require('mongoose');
const validator = require('validator');
const net = require('net');
const pick = require('lodash/pick');
const path = require('path');
const uniqBy = require('lodash/uniqBy');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const flexibilling = require('../flexibilling');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateOperations } = require('../deviceLogic/interfaces');
const {
  validateDevice,
  validateDhcpConfig,
  validateStaticRoute
} = require('../deviceLogic/validators');
const { getAllOrganizationLanSubnets, mapLteNames, mapWifiNames } = require('../utils/deviceUtils');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const wifiChannels = require('../utils/wifi-channels');
const apnsJson = require(path.join(__dirname, '..', 'utils', 'mcc_mnc_apn.json'));
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const cidr = require('cidr-tools');
const { TypedError, ErrorTypes } = require('../utils/errors');

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
      const opDevices = await devices.find({ org: { $in: orgList } })
        .populate('interfaces.pathlabels', '_id name description color type');
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
      })
        .populate('interfaces.pathlabels', '_id name description color type'); ;

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
  static selectDeviceParams (item) {
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
      // Internal array, objects
      'labels',
      'upgradeSchedule',
      'sync',
      'ospf'
    ]);

    retDevice.isConnected = connections.isConnected(retDevice.machineId);

    // pick interfaces
    let retInterfaces;
    if (item.interfaces) {
      retInterfaces = item.interfaces.map(i => {
        const retIf = pick(i, [
          'IPv6',
          'PublicIP',
          'PublicPort',
          'NatType',
          'useStun',
          'useFixedPublicPort',
          'internetAccess',
          'monitorInternet',
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
          'dnsServers',
          'dnsDomains',
          'useDhcpDnsServers',
          'ospf'
        ]);
        retIf._id = retIf._id.toString();
        // if device is not connected then internet access status is unknown
        retIf.internetAccess = retDevice.isConnected ? retIf.internetAccess : '';
        return retIf;
      });
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
          'redistributeViaOSPF'
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
          'status'
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
          'interfaces'
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
  static async devicesGET ({ org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const result = await devices.find({ org: { $in: orgList } })
        .skip(offset)
        .limit(limit)
        .populate('interfaces.pathlabels', '_id name description color type')
        .populate('policies.firewall.policy', '_id name description')
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
        return Service.rejectResponse('Some devices were not found', 404);
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
            response = mapLteNames(response);
            let defaultApn = response.defaultSettings ? response.defaultSettings.apn : null;
            const mcc = response.systemInfo.mcc;
            const mnc = response.systemInfo.mnc;

            if (mcc && mnc) {
              const key = mcc + '-' + mnc;
              if (apnsJson[key]) {
                defaultApn = apnsJson[key];
              }
            }

            // update pin state
            await devices.updateOne(
              { _id: id, org: { $in: orgList }, 'interfaces._id': interfaceId },
              {
                $set: {
                  'interfaces.$.deviceParams.initial_pin1_state': status.pinState,
                  'interfaces.$.deviceParams.default_settings': status.defaultSettings
                }
              }
            );

            return {
              ...response,
              defaultSettings: {
                ...response.defaultSettings,
                apn: defaultApn
              }
            };
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
            return { ...response, wifiChannels };
          }
        }
      };

      const ifc = deviceObject.interfaces.find(i => i._id.toString() === interfaceId);
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

      if (!connections.isConnected(device[0].machineId)) {
        return Service.successResponse({
          error: null,
          deviceStatus: 'disconnected',
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

      const delDevice = await devices.findOne({
        _id: mongoose.Types.ObjectId(id),
        org: { $in: orgList }
      }).session(session);

      if (!delDevice) {
        session.abortTransaction();
        return Service.rejectResponse('Device for deletion not found', 404);
      }

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

      connections.deviceDisconnect(delDevice.machineId);
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
  static async devicesIdPUT ({ id, org, deviceRequest }, { user, server }, response) {
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

      if (!origDevice) {
        return Service.rejectResponse('Device not found', 404);
      }

      // Don't allow any changes if the device is not approved
      if (!origDevice.isApproved && !deviceRequest.isApproved) {
        throw new Error('Device must be first approved');
      }

      // check LAN subnet overlap if updated device is running
      const devStatus = deviceStatus.getDeviceStatus(origDevice.machineId);
      const isRunning = (devStatus && devStatus.state && devStatus.state === 'running');

      let orgLanSubnets = [];

      if (isRunning && configs.get('forbidLanSubnetOverlaps', 'boolean')) {
        orgLanSubnets = await getAllOrganizationLanSubnets(origDevice.org);
      }

      // Make sure interfaces are not deleted, only modified
      if (Array.isArray(deviceRequest.interfaces)) {
        // not allowed to assign path labels of a different organization
        let orgPathLabels = await pathLabelsModel.find({ org: origDevice.org }, '_id').lean();
        orgPathLabels = orgPathLabels.map(pl => pl._id.toString());
        const notAllowedPathLabels = deviceRequest.interfaces.map(intf =>
          !Array.isArray(intf.pathlabels) ? []
            : intf.pathlabels.map(pl => pl._id).filter(id => !orgPathLabels.includes(id))
        ).flat();
        if (notAllowedPathLabels.length) {
          logger.error('Not allowed path labels', { params: { notAllowedPathLabels } });
          throw new Error('Not allowed to assign path labels of a different organization');
        };
        deviceRequest.interfaces = await Promise.all(origDevice.interfaces.map(async origIntf => {
          const updIntf = deviceRequest.interfaces.find(rif => origIntf._id.toString() === rif._id);
          if (updIntf) {
            // Public port and NAT type is assigned by system only
            updIntf.PublicPort = updIntf.useStun ? origIntf.PublicPort : configs.get('tunnelPort');
            updIntf.NatType = updIntf.useStun ? origIntf.NatType : 'Static';
            updIntf.internetAccess = origIntf.internetAccess;
            // Device type is assigned by system only
            updIntf.deviceType = origIntf.deviceType;

            // Check tunnels connectivity
            if (origIntf.isAssigned) {
              // if interface unassigned make sure it's not used by any tunnel
              if (!updIntf.isAssigned) {
                const numTunnels = await tunnelsModel
                  .countDocuments({
                    isActive: true,
                    $or: [{ interfaceA: origIntf._id }, { interfaceB: origIntf._id }]
                  });
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
                    });
                  if (numTunnels > 0) {
                  // eslint-disable-next-line max-len
                    throw new Error('Removed label used by existing tunnels, please delete related tunnels before');
                  }
                }
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
                  throw new Error(
                    `WAN interface ${origIntf.name} \
                    has firewall rules. Please remove rules before modifying.`
                  );
                }
                if (hadOutbound && updIntf.type !== 'LAN') {
                  throw new Error(
                    `LAN Interface ${origIntf.name} \
                    has firewall rules. Please remove rules before modifying.`
                  );
                }
              }
              if ((hasOutbound || hasInbound) && !updIntf.isAssigned) {
                throw new Error(
                  `Installing firewall on unassigned interface ${origIntf.name} is not allowed`
                );
              }
              if (hasOutbound && updIntf.type !== 'LAN') {
                throw new Error(
                  `${updIntf.type} Interface ${origIntf.name} configured with outbound rules. \
                  Outbound rules are allowed on LAN only.`
                );
              }
              if (hasInbound && updIntf.type !== 'WAN') {
                throw new Error(
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
                throw new Error(
                  `Not allowed to modify parameters of unassigned interfaces (${origIntf.name})`
                );
              }
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
                throw new Error(
                  `Changing metric of unassigned interfaces (${origIntf.name}) is not allowed`
                );
              }
              updIntf.metric = origIntf.metric;
            };
            // don't update MTU on an unassigned interface,
            if (!updIntf.isAssigned && updIntf.mtu && updIntf.mtu !== origIntf.mtu) {
              throw new Error(
                `Changing MTU of unassigned interfaces (${origIntf.name}) is not allowed`
              );
            }

            // don't allow set OSPF keyID without key and vise versa
            const keyId = updIntf.ospf.keyId;
            const key = updIntf.ospf.key;
            if ((keyId && !key) || (!keyId && key)) {
              throw new Error(
                `(${origIntf.name}) Not allowed to save OSPF key ID without key and vice versa`
              );
            }

            if (updIntf.isAssigned && updIntf.type === 'WAN') {
              const dhcp = updIntf.dhcp;
              const servers = updIntf.dnsServers;
              const domains = updIntf.dnsDomains;

              // Prevent static IP without dns servers
              if (dhcp === 'no' && servers.length === 0) {
                throw new Error(`DNS ip address is required for ${origIntf.name}`);
              }

              // Prevent override dhcp DNS info without dns servers
              if (dhcp === 'yes' && !updIntf.useDhcpDnsServers && servers.length === 0) {
                throw new Error(`DNS ip address is required for ${origIntf.name}`);
              }

              const isValidIpList = servers.every(ip => net.isIPv4(ip));
              if (!isValidIpList) {
                throw new Error(`DNS ip addresses are not valid for (${origIntf.name})`);
              }

              const isValidDomainList = domains.every(domain => {
                return validator.isFQDN(domain, { require_tld: false });
              });
              if (!isValidDomainList) {
                throw new Error(`DNS domain list is not valid for (${origIntf.name})`);
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

      // Map dhcp config if needed
      if (Array.isArray(deviceRequest.dhcp)) {
        deviceRequest.dhcp = deviceRequest.dhcp.map(d => {
          const ifc = deviceRequest.interfaces.find(i => i.devId === d.interface);
          if (!ifc) return d;
          const origIfc = origDevice.interfaces.find(i => i.devId === ifc.devId);
          if (!origIfc) return d;

          // if the interface is going to be unassigned now but it was assigned
          // and it was in a bridge,
          // we check if we can reassociate the dhcp to another assigned interface in the bridge.
          // For example: eth3 and eth4 was in a bridge and dhcp was configured to eth3.
          // now, the user unassigned the eth3. In this case we reassociate the dhcp to the eth4.
          if (!ifc.isAssigned && origIfc.isAssigned) {
            const anotherBridgedIfc = deviceRequest.interfaces.find(i =>
              i.devId !== ifc.devId && i.IPv4 === ifc.IPv4 && i.isAssigned);
            if (anotherBridgedIfc) {
              return { ...d, interface: anotherBridgedIfc.devId };
            }
          }

          // if the IP of the interface is changed and it was in a bridge,
          // we check if we can reassociate the dhcp to another assigned
          // interface which has the orig IP.
          // For example: eth3 and eth4 was in a bridge and dhcp was configured to eth3.
          // now, the user changed the IP of eth3. In this case we reassociate the dhcp to the eth4.
          if (ifc.isAssigned && ifc.IPv4 !== origIfc.IPv4) {
            const anotherAssignWithSameIp = deviceRequest.interfaces.find(i =>
              i.devId !== ifc.devId && i.IPv4 === origIfc.IPv4 && i.isAssigned);
            if (anotherAssignWithSameIp) {
              return { ...d, interface: anotherAssignWithSameIp.devId };
            }
          }

          return d;
        });

        // validate DHCP info if it exists
        for (const dhcpRequest of deviceRequest.dhcp) {
          DevicesService.validateDhcpRequest(deviceToValidate, dhcpRequest);
        }
      }

      // validate static routes
      if (Array.isArray(deviceRequest.staticroutes)) {
        const tunnels = await tunnelsModel.find({
          isActive: true,
          $or: [{ deviceA: origDevice._id }, { deviceB: origDevice._id }]
        }, { num: 1 }).lean();
        for (const route of deviceRequest.staticroutes) {
          const { valid, err } = validateStaticRoute(deviceToValidate, tunnels, route);
          if (!valid) {
            logger.warn('Wrong static route parameters',
              {
                params: { route, err }
              });
            throw new Error(err);
          }
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
          throw new Error(err);
        }
      }

      const { valid, err } = validateDevice(deviceToValidate, isRunning, orgLanSubnets);

      if (!valid) {
        logger.warn('Device update failed',
          {
            params: { device: deviceRequest, devStatus, err }
          });
        throw new Error(err);
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

      const updDevice = await devices.findOneAndUpdate(
        { _id: id, org: { $in: orgList } },
        { ...deviceRequest },
        { new: true, upsert: false, runValidators: true }
      )
        .session(session)
        .populate('interfaces.pathlabels', '_id name description color type')
        .populate('policies.firewall.policy', '_id name description rules')
        .populate('policies.multilink.policy', '_id name description');
      await session.commitTransaction();
      session = null;

      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      const modifyDevResult = await dispatcher.apply([origDevice], 'modify', user, {
        org: orgList[0],
        newDevice: updDevice
      });

      const status = modifyDevResult.ids.length > 0 ? 202 : 200;
      DevicesService.setLocationHeader(server, response, modifyDevResult.ids, orgList[0]);
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
      throw new Error('Interface is required to define DHCP');
    };
    const interfaceObj = device.interfaces.find(i => {
      return i.devId === dhcpRequest.interface;
    });
    if (!interfaceObj) {
      throw new Error(`Unknown interface: ${dhcpRequest.interface} in DHCP parameters`);
    }
    if (!interfaceObj.isAssigned) {
      throw new Error('DHCP can be defined only for assigned interfaces');
    }
    if (interfaceObj.type !== 'LAN') {
      throw new Error('DHCP can be defined only for LAN interfaces');
    }

    // check that DHCP Range Start/End IP are on the same subnet with interface IP
    if (!cidr.overlap(`${interfaceObj.IPv4}/${interfaceObj.IPv4Mask}`, dhcpRequest.rangeStart)) {
      throw new Error('DHCP Range Start IP address is not on the same subnet with interface IP');
    }
    if (!cidr.overlap(`${interfaceObj.IPv4}/${interfaceObj.IPv4Mask}`, dhcpRequest.rangeEnd)) {
      throw new Error('DHCP Range End IP address is not on the same subnet with interface IP');
    }
    // check that DHCP range End address IP is greater than Start IP address
    const ip2int = IP => IP.split('.')
      .reduce((res, val, idx) => res + (+val) * 256 ** (3 - idx), 0);
    if (ip2int(dhcpRequest.rangeStart) > ip2int(dhcpRequest.rangeEnd)) {
      throw new Error('DHCP Range End IP address must be greater than Start IP address');
    }
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
            job: false,
            message: 'reset-lte'
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
                { priority: 'medium', attempts: 1, removeOnComplete: false },
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
      const { sync, machineId, isApproved, interfaces } = await devices.findOne(
        { _id: id, org: { $in: orgList } },
        'sync machineId isApproved interfaces.devId interfaces.internetAccess'
      ).lean();
      const isConnected = connections.isConnected(machineId);
      return Service.successResponse({
        sync,
        isApproved,
        connection: `${isConnected ? '' : 'dis'}connected`,
        interfaces
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
  static async devicesIdRoutingOSPFPUT ({ id, org, ospfConfigs }, { user }, response) {
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
      DevicesService.setLocationHeader(response, ids, orgList[0]);
      return Service.successResponse(ospfConfigs, 202);
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
   * @param {string} orgId - ID of the organzation
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

module.exports = DevicesService;
