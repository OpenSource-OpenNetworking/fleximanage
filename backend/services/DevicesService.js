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
const pick = require('lodash/pick');
const path = require('path');
const uniqBy = require('lodash/uniqBy');
const isEqual = require('lodash/isEqual');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const flexibilling = require('../flexibilling');
const dispatcher = require('../deviceLogic/dispatcher');
const { validateOperations } = require('../deviceLogic/interfaces');
const { validateDevice, validateDhcpConfig } = require('../deviceLogic/validators');
const { getAllOrganizationLanSubnets } = require('../utils/deviceUtils');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const { getMajorVersion } = require('../versioning');
const wifiChannels = require('../utils/wifi-channels');
const apnsJson = require(path.join(__dirname, '..', 'utils', 'mcc_mnc_apn.json'));
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
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
      'sync']);
    retDevice.deviceStatus = (retDevice.deviceStatus === '1');

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
          'internetAccess',
          'monitorInternet',
          'gateway',
          'metric',
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
          'deviceParams'
        ]);
        retIf._id = retIf._id.toString();
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
          'metric'
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

      let api = 'get-device-config';
      const majorAgentVersion = getMajorVersion(device[0].versions.agent);
      if (majorAgentVersion < 3) {
        api = 'get-router-config';
      }

      const deviceConf = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        { entity: 'agent', message: api }
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
        status: 'connected',
        configuration
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
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
        throw new Error('Device or Interface not found');
      };

      const deviceStatus = connections.isConnected(deviceObject.machineId);
      const selectedInterface = deviceObject.interfaces.find(i => {
        return i._id.toString() === interfaceId;
      });
      let interfaceInfo = {};

      const interfaceType = selectedInterface.deviceType;
      if (deviceStatus) {
        const agentMessages = {
          lte: 'get-lte-info',
          wifi: 'get-wifi-info'
        }[interfaceType];

        if (agentMessages) {
          const response = await connections.deviceSendMessage(
            null,
            deviceObject.machineId,
            {
              entity: 'agent',
              message: agentMessages,
              params: { dev_id: selectedInterface.devId }
            }
          );
          if (!response.ok) {
            logger.error('Failed to get interface info', {
              params: {
                deviceId: id, response: response.message
              }
            });
          } else {
            interfaceInfo = response.message;
          }
        }
      }

      if (interfaceType === 'wifi') {
        interfaceInfo = { ...interfaceInfo, wifiChannels };
      } else if (interfaceType === 'lte' && Object.keys(interfaceInfo).length > 0) {
        let defaultApn = interfaceInfo.default_settings
          ? interfaceInfo.default_settings.APN : null;
        const mcc = interfaceInfo.system_info.mcc;
        const mnc = interfaceInfo.system_info.mnc;

        if (!defaultApn && mcc && mnc) {
          const key = mcc + '-' + mnc;
          if (apnsJson[key]) {
            defaultApn = apnsJson[key];
          }
        }

        interfaceInfo = {
          ...interfaceInfo,
          default_settings: {
            ...interfaceInfo.default_settings,
            APN: defaultApn
          }
        };

        // update pin state
        await devices.updateOne(
          { _id: id, org: { $in: orgList }, 'interfaces._id': interfaceId },
          {
            $set: {
              'interfaces.$.deviceParams.initial_pin1_state': interfaceInfo.pin_state,
              'interfaces.$.deviceParams.default_settings': interfaceInfo.default_settings
            }
          }
        );
      }

      return Service.successResponse({
        interfaceInfo
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

  static async devicesIdPacketTracesGET ({ id, org, packets, timeout }, { user }) {
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
          traces: []
        });
      }

      const devicePacketTraces = await connections.deviceSendMessage(
        null,
        device[0].machineId,
        {
          entity: 'agent',
          message: 'get-device-packet-traces',
          params: {
            packets: packets || '100',
            timeout: timeout || '5'
          }
        }
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
        status: 'connected',
        traces: devicePacketTraces.message
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

            // Unassigned interfaces are not controlled from manage
            // we only get these parameters from the device itself
            if (!updIntf.isAssigned) {
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
                  `Not allowed to change metric of unassigned interfaces (${origIntf.name})`
                );
              }
              updIntf.metric = origIntf.metric;
            };
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

      // validate DHCP info if it exists
      if (Array.isArray(deviceRequest.dhcp)) {
        for (const dhcpRequest of deviceRequest.dhcp) {
          DevicesService.validateDhcpRequest(deviceToValidate, dhcpRequest);
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
        .populate('interfaces.pathlabels', '_id name description color type');
      await session.commitTransaction();
      session = null;

      // If the change made to the device fields requires a change on the
      // device itself, add a 'modify' job to the device's queue.
      let modifyDevResult = [];
      if (origDevice) {
        modifyDevResult = await dispatcher.apply([origDevice], 'modify', user, {
          org: orgList[0],
          newDevice: updDevice
        });
      }

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
      const device = await devices.findOne(
        {
          _id: mongoose.Types.ObjectId(id),
          org: { $in: orgList }
        }
      );

      if (!device) throw new Error('Device not found');
      const deleteRoute = device.staticroutes.filter((s) => {
        return (s.id === route);
      });

      if (deleteRoute.length !== 1) throw new Error('Static route not found');
      const copy = Object.assign({}, deleteRoute[0].toObject());
      copy.org = orgList[0];
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
        metric: staticRouteRequest.metric
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
      copy.org = orgList[0];
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
      copy.org = orgList[0];
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
      match.$and = [{ time: { $gte: startTime } }, { time: { $lte: endTime } }];
    } else if (startTime) match.time = { $gte: startTime };
    else if (endTime) match.time = { $lte: endTime };

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
      match.$and = [{ time: { $gte: startTime } }, { time: { $lte: endTime } }];
    } else if (startTime) match.time = { $gte: startTime };
    else if (endTime) match.time = { $lte: endTime };

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
      match.$and = [{ time: { $gte: startTime } }, { time: { $lte: endTime } }];
    } else if (startTime) match.time = { $gte: startTime };
    else if (endTime) match.time = { $lte: endTime };

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
        copy.org = orgList[0];
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

      const majorAgentVersion = getMajorVersion(deviceObject.versions.agent);

      if (majorAgentVersion < 2) {
        const origDhcp = dhcpFiltered[0].toObject();
        const origCmpDhcp = {
          _id: origDhcp._id.toString(),
          dns: origDhcp.dns,
          interface: origDhcp.interface,
          macAssign: origDhcp.macAssign.map(m => ({ host: m.host, mac: m.mac, ipv4: m.ipv4 })),
          rangeStart: origDhcp.rangeStart,
          rangeEnd: origDhcp.rangeEnd
        };

        // Check if any difference exists between request to current dhcp,
        // in that case no need to resend data
        if (!isEqual(dhcpRequest, origCmpDhcp)) {
          DevicesService.validateDhcpRequest(deviceObject, dhcpRequest);
          const copy = Object.assign({}, dhcpRequest);
          copy.org = orgList[0];
          copy.method = 'dhcp';
          copy.action = 'modify';
          copy.origDhcp = origCmpDhcp;
          const { ids } = await dispatcher.apply(deviceObject, copy.method, user, copy);
          response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));

          const dhcpData = {
            _id: dhcpId,
            interface: dhcpRequest.interface,
            rangeStart: dhcpRequest.rangeStart,
            rangeEnd: dhcpRequest.rangeEnd,
            dns: dhcpRequest.dns,
            macAssign: dhcpRequest.macAssign,
            status: 'add-wait'
          };

          await devices.findOneAndUpdate(
            { _id: deviceObject._id },
            { $set: { 'dhcp.$[elem]': dhcpData } },
            { arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(dhcpId) }] });
          return Service.successResponse(dhcpData, 202);
        }
      }

      if (majorAgentVersion >= 2) {
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
        response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));
        return Service.successResponse(dhcpData, 202);
      }
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
      copy.org = orgList[0];
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
    if (interfaceObj.type !== 'LAN') {
      throw new Error('DHCP can be defined only for LAN interfaces');
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
  static async devicesIdDhcpPOST ({ id, org, dhcpRequest }, { user }, response) {
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
        throw new Error('Device not found');
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
      response.setHeader('Location', DevicesService.jobsListUrl(ids, orgList[0]));

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
        throw new Error('Device or Interface not found');
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
            message: 'modify-lte-pin'
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
                null
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
            return Service.rejectResponse('Device must be connected', 500);
          }
          const response = await connections.deviceSendMessage(
            null,
            deviceObject.machineId,
            {
              entity: 'agent',
              message: agentAction.message,
              params: params
            }
          );

          if (!response.ok) {
            logger.error('Failed to perform interface operation', {
              params: {
                deviceId: id, response: response.message
              }
            });

            const regex = new RegExp(/(?<=failed: ).+?(?=\()/g);
            const err = response.message.match(regex).join(',');
            return Service.rejectResponse(err, 500);
          }
        }
      }

      return Service.successResponse({}, 200);
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
        throw new Error('Device not found');
      }
      if (!deviceObject.isApproved) {
        throw new Error('Device must be first approved');
      }
      if (!connections.isConnected(deviceObject.machineId)) {
        throw new Error('Device not connected');
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
        request
      );

      return Service.successResponse(result, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
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
