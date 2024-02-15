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

const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const {
  prepareTunnelAddJob,
  prepareTunnelRemoveJob
} = require('../deviceLogic/tunnels');
const { validateModifyDeviceMsg, validateDhcpConfig } = require('./validators');
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const Vrrp = require('../models/vrrp');
const {
  complete: firewallPolicyComplete,
  error: firewallPolicyError,
  remove: firewallPolicyRemove,
  getDevicesFirewallJobInfo
} = require('./firewallPolicy');
const {
  complete: qosPolicyComplete,
  error: qosPolicyError,
  remove: qosPolicyRemove,
  getDevicesQOSJobInfo
} = require('./qosPolicy');
const { getLanNatJobInfo } = require('./lanNatPolicy');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const has = require('lodash/has');
const omit = require('lodash/omit');
const differenceWith = require('lodash/differenceWith');
const pullAllWith = require('lodash/pullAllWith');
const omitBy = require('lodash/omitBy');
const isEqual = require('lodash/isEqual');
const isEmpty = require('lodash/isEmpty');
const pick = require('lodash/pick');
const isObject = require('lodash/isObject');
const { buildInterfaces } = require('./interfaces');
const { getBridges } = require('../utils/deviceUtils');
const uniqWith = require('lodash/uniqWith');
const cloneDeep = require('lodash/cloneDeep');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const {
  transformInterfaces,
  transformRoutingFilters,
  transformOSPF,
  transformAdvancedRoutingConfig,
  transformVxlanConfig,
  transformBGP,
  transformDHCP,
  transformLte,
  transformStaticRoute
} = require('./jobParameters');

const modifyBGPParams = ['neighbors', 'networks', 'redistributeOspf'];

/**
 * Remove fields that should not be sent to the device from the interfaces array.
 * @param  {Array} interfaces an array of interfaces that will be sent to the device
 * @return {Array}            the same array after removing unnecessary fields
 */
const prepareIfcParams = (interfaces, newDevice) => {
  const bridges = getBridges(newDevice.interfaces);
  return interfaces.map(ifc => {
    const newIfc = cloneDeep(omit(ifc, ['_id', 'isAssigned', 'pathlabels']));

    newIfc.dev_id = newIfc.devId;
    delete newIfc.devId;
    delete newIfc.parentDevId;

    // Device should only be aware of DIA labels.
    const labels = [];
    ifc.pathlabels.forEach(label => {
      if (label.type === 'DIA') labels.push(label._id);
    });
    newIfc.multilink = { labels };

    // The agent should know if this interface should add to the bridge or removed from it, etc.
    // So, we indicate it with the bridge_addr field.
    // If this field is null, it means that this interface has no relation to a bridge.
    // If this field should be in a bridge, we set in this field the bridge IP.
    // We use the ip as key since it's the unique differentiate
    // between bridges from the "flexiManage" perspective.
    // We put this field only if the interface is LAN
    // and other assigned interfaces have the same IP.
    if (bridges[newIfc.addr]) {
      newIfc.bridge_addr = newIfc.addr;
    } else {
      newIfc.bridge_addr = null;
    }

    if (ifc.isAssigned) {
      if (ifc.type !== 'WAN') {
        // Don't send default GW and public info for LAN interfaces
        delete newIfc.gateway;
        delete newIfc.metric;
        delete newIfc.useStun;
        delete newIfc.monitorInternet;
        delete newIfc.dnsServers;
        delete newIfc.dnsDomains;
      }

      // If a user wants to use the DNS from DHCP server, we send empty array to the device
      if (ifc.type === 'WAN' && newIfc.dhcp === 'yes' && ifc.useDhcpDnsServers) {
        newIfc.dnsServers = [];
      }

      // Don't send unnecessary info for both types of interfaces
      delete newIfc.useFixedPublicPort; // used by flexiManage only for tunnels creation
      delete newIfc.PublicIP; // used by flexiManage only for tunnels creation
      delete newIfc.PublicPort; // used by flexiManage only for tunnels creation

      delete newIfc.useDhcpDnsServers; // used by flexiManage only for dns servers depiction

      if (newIfc.ospf) {
        // remove empty values since they are optional
        newIfc.ospf = omitBy(newIfc.ospf, val => val === '');
      }

      // Currently, when sending modify-x device the agent does smart replacement in a way
      // that if only one field exists in a sub-object, it adds this field
      // to the sub-object but it keeps the other existing fields.
      // So, in WiFi we need to send both keys (2.4GHz, and 5GHz) always.
      // Otherwise, if we will send only the enabled one, ans user changed the enabled band,
      // in some case, at the agent both can be enabled which is not supported.
      // Hence, we send both always.
      if (newIfc.deviceType === 'wifi') {
        if (!('2.4GHz' in newIfc.configuration)) {
          newIfc.configuration['2.4GHz'] = { enable: false };
        }
        if (!('5GHz' in newIfc.configuration)) {
          newIfc.configuration['5GHz'] = { enable: false };
        }
      }
    }
    return newIfc;
  });
};

/**
 * Composes aggregated device modification message (agent version >= 2)
 *
 * @param {*} messageParams input device modification params
 * @param {Object}  device the device to which the job should be queued
 * @returns list of the messages
 */
const prepareModificationMessages = (messageParams, device, newDevice) => {
  const requests = [];

  // Check against the old configured interfaces.
  // If they are the same, do not initiate modify-device job.
  if (has(messageParams, 'modify_interfaces')) {
    const interfaces = messageParams.modify_interfaces.interfaces || [];
    if (interfaces.length > 0) {
      const modifiedInterfaces = prepareIfcParams(interfaces, newDevice);
      requests.push(...modifiedInterfaces.map(item => {
        return {
          entity: 'agent',
          message: 'modify-interface',
          params: item
        };
      }));
    }
  }

  if (has(messageParams, 'modify_lte')) {
    const { remove, add } = messageParams.modify_lte;
    if (remove && remove.length > 0) {
      requests.push(...remove.map(item => {
        return {
          entity: 'agent',
          message: 'remove-lte',
          params: item
        };
      }));
    }

    if (add && add.length > 0) {
      requests.push(...add.map(item => {
        return {
          entity: 'agent',
          message: 'add-lte',
          params: item
        };
      }));
    }
  }

  // frr access lists
  if (has(messageParams, 'modify_routing_filters')) {
    const { remove, add } = messageParams.modify_routing_filters;

    if (remove && remove.length > 0) {
      requests.push(...remove.map(item => {
        return {
          entity: 'agent',
          message: 'remove-routing-filter',
          params: { ...item }
        };
      }));
    }

    if (add && add.length > 0) {
      requests.push(...add.map(item => {
        return {
          entity: 'agent',
          message: 'add-routing-filter',
          params: { ...item }
        };
      }));
    }
  }

  if (has(messageParams, 'modify_bgp')) {
    const { remove, add, modify } = messageParams.modify_bgp;

    if (remove) {
      requests.push({
        entity: 'agent',
        message: 'remove-routing-bgp',
        params: { ...remove }
      });
    }

    if (add) {
      requests.push({
        entity: 'agent',
        message: 'add-routing-bgp',
        params: { ...add }
      });
    }

    if (modify) {
      requests.push({
        entity: 'agent',
        message: 'modify-routing-bgp',
        params: {
          localAsn: modify.localAsn,
          ...pick(modify, modifyBGPParams)
        }
      });
    }
  }

  if (has(messageParams, 'modify_ospf')) {
    const { remove, add } = messageParams.modify_ospf;

    if (remove) {
      requests.push({
        entity: 'agent',
        message: 'remove-ospf',
        params: { ...remove }
      });
    }

    if (add) {
      requests.push({
        entity: 'agent',
        message: 'add-ospf',
        params: { ...add }
      });
    }
  }

  if (has(messageParams, 'modify_advanced_routing_config')) {
    const { remove, add } = messageParams.modify_advanced_routing_config;

    if (remove) {
      requests.push({
        entity: 'agent',
        message: 'remove-routing-general',
        params: { ...remove }
      });
    }

    if (add) {
      requests.push({
        entity: 'agent',
        message: 'add-routing-general',
        params: { ...add }
      });
    }
  }

  if (has(messageParams, 'modify_routes')) {
    const { remove, add } = messageParams.modify_routes;

    if (remove.length > 0) {
      requests.push(...remove.map(params => {
        return {
          entity: 'agent',
          message: 'remove-route',
          params: params
        };
      }));
    }

    if (add.length > 0) {
      requests.push(...add.map(params => {
        return {
          entity: 'agent',
          message: 'add-route',
          params: params
        };
      }));
    }
  }

  if (has(messageParams, 'modify_router.assignBridges')) {
    requests.push(...messageParams.modify_router.assignBridges.map(item => {
      return {
        entity: 'agent',
        message: 'add-switch',
        params: {
          addr: item
        }
      };
    }));
  }
  if (has(messageParams, 'modify_router.unassignBridges')) {
    requests.push(...messageParams.modify_router.unassignBridges.map(item => {
      return {
        entity: 'agent',
        message: 'remove-switch',
        params: {
          addr: item
        }
      };
    }));
  }

  if (has(messageParams, 'modify_router.assign')) {
    const ifcParams = prepareIfcParams(messageParams.modify_router.assign, newDevice);
    requests.push(...ifcParams.map(item => {
      return {
        entity: 'agent',
        message: 'add-interface',
        params: item
      };
    }));
  }
  if (has(messageParams, 'modify_router.unassign')) {
    const ifcParams = prepareIfcParams(messageParams.modify_router.unassign, newDevice);
    requests.push(...ifcParams.map(item => {
      return {
        entity: 'agent',
        message: 'remove-interface',
        params: item
      };
    }));
  }

  if (has(messageParams, 'modify_dhcp_config')) {
    const { dhcpRemove, dhcpAdd } = messageParams.modify_dhcp_config;

    if (dhcpRemove.length !== 0) {
      requests.push(...dhcpRemove.map(item => {
        return {
          entity: 'agent',
          message: 'remove-dhcp-config',
          params: item
        };
      }));
    }

    if (dhcpAdd.length !== 0) {
      requests.push(...dhcpAdd.map(item => {
        return {
          entity: 'agent',
          message: 'add-dhcp-config',
          params: item
        };
      }));
    }
  }

  if (has(messageParams, 'modify_firewall')) {
    requests.push(...messageParams.modify_firewall.tasks);
  }

  if (has(messageParams, 'modify_lan_nat')) {
    requests.push(...messageParams.modify_lan_nat.tasks);
  }

  if (has(messageParams, 'modify_qos')) {
    requests.push(...messageParams.modify_qos.tasks);
  }

  return requests;
};

/**
 * Queues a modify-device job to the device queue.
 * @param  {string}  org                   the organization to which the user belongs
 * @param  {string}  username              name of the user that requested the job
 * @param  {Array}   tasks                 the message to be sent to the device
 * @param  {Object}  device                the device to which the job should be queued
 * @param  {Object}  jobResponse           Additional data to include in the job response
 * @return {Promise}                       a promise for queuing a job
 */
const queueJob = async (org, username, tasks, device, jobResponse) => {
  const job = await deviceQueues.addJob(
    device.machineId,
    username,
    org,
    // Data
    { title: `Modify device ${device.hostname}`, tasks: tasks },
    // Response data
    {
      method: 'modify',
      data: {
        device: device._id,
        org: org,
        user: username,
        origDevice: device,
        ...jobResponse
      }
    },
    // Metadata
    { priority: 'normal', attempts: 1, removeOnComplete: false },
    // Complete callback
    null
  );

  logger.info('Modify device job queued', { params: { job } });
  return job;
};
/**
 * Performs required tasks before device modification
 * can take place. It removes all tunnels connected to
 * the modified interfaces and then queues the modify device job.
 * @param  {Object}  device         original device object, before the changes
 * @param  {Object}  newDevice      updated device object, after the changes
 * @param  {Object}  messageParams  object with all changes that will be sent to the device
 * @param  {Object}  user           the user that created the request
 * @param  {string}  org            organization to which the user belongs
 * @param  {set}     sendAddTunnels Set of tunnel ids to send add-tunnel job for
 * @param  {set}     sendRemoveTunnels Set of tunnel ids to send remove-tunnel job for
 * @param  {array}   ignoreTasks array of tasks that should be ignored.
 *                               Usually it means that in the current process,
                                 these jobs already sent and no need to resend them.
 * @return {Job}                    The queued modify-device job
 */
const queueModifyDeviceJob = async (
  device, newDevice, messageParams, user, org, sendAddTunnels, sendRemoveTunnels, ignoreTasks
) => {
  const jobs = [];
  const sentTasks = {};

  const interfacesIdsSet = new Set();
  const modifiedIfcsMap = {};
  let isBgpAsnChanged = false;

  // Changes in the interfaces require reconstruction of all tunnels
  // connected to these interfaces (since the tunnels parameters change).
  // Maintain all interfaces that have changed in a set that will
  // be used later to find all the tunnels that should be reconstructed.
  // We use a set, since multiple changes can be done in a single modify-device
  // message, hence the interface might appear in both modify-router and
  // modify-interfaces objects, and we want to remove the tunnel only once.
  if (has(messageParams, 'modify_router')) {
    const { assign, unassign } = messageParams.modify_router;
    (assign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
    (unassign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
  }
  if (has(messageParams, 'modify_interfaces')) {
    const interfaces = [...messageParams.modify_interfaces.interfaces];
    interfaces.forEach(ifc => {
      interfacesIdsSet.add(ifc._id);
      modifiedIfcsMap[ifc._id] = ifc;
    });
  }
  const modifiedInterfaces = Array.from(interfacesIdsSet);

  if (has(messageParams, 'modify_bgp')) {
    const { remove, add } = messageParams.modify_bgp;
    const oldAsn = remove?.localAsn;
    const newAsn = add?.localAsn;
    if (oldAsn && newAsn && oldAsn !== newAsn) {
      isBgpAsnChanged = true;
    }
  }

  // key: deviceId, value: object with 'device' (device object) and 'tasks' (list of tasks to send)
  const tasks = {
    [device._id]: {
      device,
      tasks: []
    }
  };

  // Send modify device job only if required parameters were changed
  const skipModifyJob = _isNeedToSkipModifyJob(messageParams, modifiedIfcsMap, device);
  if (!skipModifyJob) {
    tasks[device._id].tasks = prepareModificationMessages(messageParams, device, newDevice);
  }

  // Additional job response data
  if (messageParams.modify_firewall) {
    if (!('jobResponse' in tasks[device._id])) {
      tasks[device._id].jobResponse = {};
    }
    tasks[device._id].jobResponse = { firewallPolicy: messageParams.modify_firewall.data };
  }
  if (messageParams.modify_qos) {
    if (!('jobResponse' in tasks[device._id])) {
      tasks[device._id].jobResponse = {};
    }
    tasks[device._id].jobResponse.qosPolicy = messageParams.modify_qos.data;
  }

  // at this point we need to take care of tunnels.
  // Tunnel changes can be required here for several reasons:
  // 1. Interface that has a tunnel on it is changed by the user.
  //    e.g. IP might be changed by DHCP or user can change static IP of this interface.
  // 2. BGP ASN is changed and there is a tunnel that uses BGP protocol.
  //    In such case, we need to acknowledge the remote device of the tunnel
  //    with the new device ASN so it can configure the BGP neighbor correctly.
  // 3. Nothing changed on the interface but system needs to create/remove tunnel.
  //    It can happens with events, for example if interface's public port
  //    changed in high rate, we send remove jobs.
  //    Or if interface was pending due to high rate and now it becomes stabilized,
  //    We need to send add tunnel job regardless of interface configuration change.
  //
  // For these reasons, we need sometimes to remove or add tunnels.
  const modifiedTunnelIds = [];
  try {
    const tunnels = await tunnelsModel
      .find({
        org: org,
        $or: [
          // check the first two reasons above
          {
            $and: [
              { isActive: true },
              { isPending: { $ne: true } }, // no need to reconstruct pending tunnels
              {
                $or: [
                  // Tunnels that depends on a modified interface - Reason 1 above
                  { interfaceA: { $in: modifiedInterfaces } },
                  { interfaceB: { $in: modifiedInterfaces } },
                  // check if need to reconstruct due to remote ASN change - Reason 2 above
                  {
                    $and: [
                      { 'advancedOptions.routing': 'bgp' },
                      {
                        $or: [
                          { deviceA: { $in: isBgpAsnChanged ? [newDevice._id.toString()] : [] } },
                          { deviceB: { $in: isBgpAsnChanged ? [newDevice._id.toString()] : [] } }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          },
          // Tunnels regardless of interfaces' changes - Reason 3 above
          { _id: { $in: [...sendAddTunnels, ...sendRemoveTunnels] } }
        ]
      })
      .populate('deviceA')
      .populate('deviceB')
      .populate('org')
      .populate('peer');

    for (const tunnel of tunnels) {
      let { deviceA, deviceB, peer, _id, advancedOptions, org: tunnelOrg } = tunnel;

      // First check if need to send tunnel jobs regardless of interface change.
      const [
        removeTasksDeviceA, removeTasksDeviceB
      ] = await prepareTunnelRemoveJob(tunnel, true);

      if (sendRemoveTunnels.has(_id.toString())) {
        _addTunnelTasks(tasks, tunnel, removeTasksDeviceA, removeTasksDeviceB);
        continue;
      }

      const [addTasksDeviceA, addTasksDeviceB] = await prepareTunnelAddJob(tunnel, tunnelOrg, true);

      if (sendAddTunnels.has(_id.toString())) {
        _addTunnelTasks(tasks, tunnel, addTasksDeviceA, addTasksDeviceB);
        continue;
      }

      // Now check if need to send remove and add tunnel jobs due to BGP ASN change.
      if (isBgpAsnChanged && advancedOptions.routing === 'bgp') {
        _addTunnelTasks(tasks, tunnel, removeTasksDeviceA, removeTasksDeviceB);
        _addTunnelTasks(tasks, tunnel, addTasksDeviceA, addTasksDeviceB);

        // if "isBgpAsnChanged" we are sending pair of add and remove bgp.
        // But, the "addTunnelTasks" might add modify-bgp which we don't need after we have the add.
        // Hence, remove the modify from the list of tasks.
        tasks[device._id].tasks = tasks[device._id].tasks.filter(
          t => t.message !== 'modify-routing-bgp');
        continue;
      }

      // Now check if need to send tunnel jobs due to interface change.
      // In this case we need to check few things and decide based on them
      // if to trigger jobs or not.
      //
      // IMPORTANT: Since the interface changes have already been updated in the database
      // we have to use the original device for creating the tunnel-remove message.
      if (deviceA._id.toString() === device._id.toString()) {
        deviceA = device;
      } else {
        deviceB = device;
      };

      const origIfcA = deviceA.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceA.toString();
      });

      const origIfcB = peer ? null : deviceB.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceB.toString();
      });

      // For interface changes such as IP/mask we remove the tunnel
      // and readd it after the change has been applied on the device.
      // In such cases, we don't remove the tunnel from the database,
      // but rather only queue remove/add tunnel jobs to the devices.
      // For interfaces that are unassigned, or which path labels have
      // been removed, we remove the tunnel from both the devices and the MGMT

      const modifiedIfcA = modifiedIfcsMap[tunnel.interfaceA.toString()];
      const modifiedIfcB = peer ? null : modifiedIfcsMap[tunnel.interfaceB.toString()];
      const loggerParams = {
        machineA: deviceA.machineId,
        machineB: peer ? null : deviceB.machineId,
        tunnelNum: tunnel.num
      };
      // skip interfaces without IP or GW
      const missingNetParameters = _ifc => isObject(_ifc) && (_ifc.addr === '' ||
        (_ifc.dhcp === 'yes' && _ifc.gateway === ''));

      if (missingNetParameters(modifiedIfcA) || (!peer && missingNetParameters(modifiedIfcB))) {
        logger.info('Missing network parameters, the tunnel will not be rebuilt', {
          params: loggerParams
        });
        continue;
      }
      // if dhcp was changed from 'no' to 'yes'
      // then we need to wait for a new config from the agent
      const waitingDhcpInfoA =
        (isObject(modifiedIfcA) && modifiedIfcA.dhcp === 'yes' && origIfcA.dhcp !== 'yes');
      const waitingDhcpInfoB = peer
        ? false
        : (isObject(modifiedIfcB) && modifiedIfcB.dhcp === 'yes' && origIfcB.dhcp !== 'yes');

      if (waitingDhcpInfoA || waitingDhcpInfoB) {
        logger.info('Waiting a new config from DHCP, the tunnel will not be rebuilt', {
          params: loggerParams
        });
        continue;
      }
      // this could happen if both interfaces are modified at the same time
      // we need to skip adding duplicated jobs
      if (tunnel.pendingTunnelModification) {
        logger.warn('The tunnel is rebuilt from another modification request', {
          params: loggerParams
        });
        continue;
      }

      // if the device modification doesn't require the tunnels reconstruction
      // we will send the modify-tunnel message only
      const checkIfModifyTunnelRequired = async (tunnel, ifcA, ifcB, modIfcA, modIfcB) => {
        if (tunnel.peer) {
          return;
        }
        const sendJobToA = isObject(modIfcB) &&
          !isEqual(ifcB.bandwidthMbps, modIfcB.bandwidthMbps);
        const sendJobToB = isObject(modIfcA) &&
          !isEqual(ifcA.bandwidthMbps, modIfcA.bandwidthMbps);

        if (sendJobToA) {
          const addTunnelTask = addTasksDeviceA.find(t => t.message === 'add-tunnel');
          _addTunnelTasks(tasks, tunnel, [{ ...addTunnelTask, message: 'modify-tunnel' }], []);
        }

        if (sendJobToB) {
          const addTunnelTask = addTasksDeviceB.find(t => t.message === 'add-tunnel');
          _addTunnelTasks(tasks, tunnel, [], [{ ...addTunnelTask, message: 'modify-tunnel' }]);
        };
      };

      // only rebuild tunnels when IP, Public IP or port is changed
      const tunnelParametersModified = (origIfc, modifiedIfc) => {
        if (!isObject(modifiedIfc)) {
          return false;
        }

        const changed = modifiedIfc.addr !== `${origIfc.IPv4}/${origIfc.IPv4Mask}`;

        if (changed || peer) {
          return changed;
        }

        return (
          modifiedIfc.PublicIP !== origIfc.PublicIP ||
          modifiedIfc.PublicPort !== origIfc.PublicPort ||
          modifiedIfc.useFixedPublicPort !== origIfc.useFixedPublicPort
        );
      };
      const ifcAModified = tunnelParametersModified(origIfcA, modifiedIfcA);
      const ifcBModified = peer ? false : tunnelParametersModified(origIfcB, modifiedIfcB);

      if (!ifcAModified && !ifcBModified) {
        checkIfModifyTunnelRequired(tunnel, origIfcA, origIfcB, modifiedIfcA, modifiedIfcB);
        continue;
      }

      // no need to recreate the tunnel with local direct connection
      const isLocal = (ifcA, ifcB) => {
        return !ifcA.PublicIP || !ifcB.PublicIP ||
          ifcA.PublicIP === ifcB.PublicIP;
      };
      const skipLocal = peer
        ? false
        : (
          isObject(modifiedIfcA) &&
          modifiedIfcA.addr === `${origIfcA.IPv4}/${origIfcA.IPv4Mask}` &&
          isLocal(modifiedIfcA, origIfcB) &&
          isLocal(origIfcA, origIfcB)) ||
          (
            isObject(modifiedIfcB) &&
            modifiedIfcB.addr === `${origIfcB.IPv4}/${origIfcB.IPv4Mask}` &&
            isLocal(modifiedIfcB, origIfcA) &&
            isLocal(origIfcB, origIfcA)
          );

      if (skipLocal) {
        checkIfModifyTunnelRequired(tunnel, origIfcA, origIfcB, modifiedIfcA, modifiedIfcB);
        continue;
      }

      _addTunnelTasks(tasks, tunnel, removeTasksDeviceA, removeTasksDeviceB);
      _addTunnelTasks(tasks, tunnel, addTasksDeviceA, addTasksDeviceB);

      modifiedTunnelIds.push(tunnel._id);
      await setTunnelsPendingInDB([tunnel._id], org, true);
    }

    // at this point, list of jobs is ready.
    for (const deviceId in tasks) {
      const deviceTasks = tasks[deviceId].tasks;
      const device = tasks[deviceId].device;
      tasks[deviceId].jobResponse ??= {};

      const { modifyJob, finalTasks } = await processModifyJob(
        deviceTasks,
        device,
        org,
        user,
        ignoreTasks,
        tasks[deviceId].jobResponse
      );

      if (modifyJob) jobs.push(modifyJob);
      if (sentTasks) sentTasks[deviceId] = finalTasks ?? [];
    }
  } catch (err) {
    logger.error('Failed to handle device modification process', {
      params: { err: err.message }
    });
  } finally {
    if (modifiedTunnelIds.length > 0) {
      await setTunnelsPendingInDB(modifiedTunnelIds, org, false);
    }
  }

  return { jobs, sentTasks };
};

const _addTunnelTasks = (tasks, tunnel, tasksDeviceA, tasksDeviceB) => {
  const deviceAId = tunnel.deviceA?._id;
  const deviceBId = tunnel.deviceB?._id;

  if (!(deviceAId in tasks)) {
    tasks[deviceAId] = {
      device: tunnel.deviceA,
      tasks: []
    };
  }
  tasks[deviceAId].tasks.push(...tasksDeviceA);

  // peer has no deviceB
  if (!deviceBId) {
    return tasks;
  }

  if (!(deviceBId in tasks)) {
    tasks[deviceBId] = {
      device: tunnel.deviceB,
      tasks: []
    };
  }
  tasks[deviceBId].tasks.push(...tasksDeviceB);

  return tasks;
};

/**
 * Sets the job pending flag value. This flag is used to indicate
 * there's a pending modify-device job in the queue to prevent
 * queuing additional modify-device jobs.
 * @param  {string}  deviceID the id of the device
 * @param  {string}  org      the organization the device belongs to
 * @param  {boolean} flag     the value of the flag
 * @return {Promise}          a promise for updating the flab in the database
 */
const setJobPendingInDB = (deviceID, org, flag) => {
  return devices.update(
    { _id: deviceID, org: org },
    { $set: { pendingDevModification: flag } },
    { upsert: false }
  );
};

/**
 * Sets the tunnel rebuilding process pending flag value. This flag is used to indicate
 * there are pending delete-tunnel/add-tunnel jobs in the queue to prevent
 * duplication of jobs.
 * @param  {array}  tunnelIDs array of ids of tunnels
 * @param  {string}  org      the organization the tunnel belongs to
 * @param  {boolean} flag     the value of the flag
 * @return {Promise}          a promise for updating the flab in the database
 */
const setTunnelsPendingInDB = (tunnelIDs, org, flag) => {
  return tunnelsModel.updateMany(
    { _id: { $in: tunnelIDs }, org: org },
    { $set: { pendingTunnelModification: flag } },
    { upsert: false }
  );
};

/**
 * Creates a modify-routes object
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing an array of routes
 */
const prepareModifyRoutes = (origDevice, newDevice) => {
  // Handle changes in static routes
  // Extract only relevant fields from static routes database entries
  const [newStaticRoutes, origStaticRoutes] = [

    newDevice.staticroutes.filter(r => !r.isPending).map(route => {
      return transformStaticRoute(route);
    }),

    origDevice.staticroutes.filter(r => !r.isPending).map(route => {
      return transformStaticRoute(route);
    })
  ];

  // Compare new and original static routes arrays.
  // Add all static routes that do not exist in the
  // original routes array and remove all static routes
  // that do not appear in the new routes array
  const [addStaticRoutes, removeStaticRoutes] = [
    differenceWith(
      newStaticRoutes,
      origStaticRoutes,
      (origRoute, newRoute) => {
        return isEqual(origRoute, newRoute);
      }
    ),
    differenceWith(
      origStaticRoutes,
      newStaticRoutes,
      (origRoute, newRoute) => {
        return isEqual(origRoute, newRoute);
      }
    )
  ];

  return { add: addStaticRoutes, remove: removeStaticRoutes };
};

/**
 * Creates add/remove-routing-bgp jobs
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing add and remove ospf parameters
 */
const prepareModifyBGP = async (origDevice, newDevice) => {
  const [origBGP, newBGP] = [
    await transformBGP(origDevice),
    await transformBGP(newDevice)
  ];

  const origEnable = origDevice.bgp.enable;
  const newEnable = newDevice.bgp.enable;

  if (origEnable && !newEnable) {
    return { remove: origBGP, add: null, modify: null };
  }

  if (!origEnable && newEnable) {
    return { remove: null, add: newBGP, modify: null };
  }

  // if there is a change in critical settings, send pair of remove-routing-bgp and add-routing-bgp
  if (!isEqual(omit(origBGP, modifyBGPParams), omit(newBGP, modifyBGPParams))) {
    return { remove: origBGP, add: newBGP, modify: null };
  }

  // if there is a change in parameters that can trigger only modification but not removing all bgp
  // send only modify job
  if (!isEqual(pick(origBGP, modifyBGPParams), pick(newBGP, modifyBGPParams))) {
    return { remove: null, add: null, modify: newBGP };
  }

  // if there is no change at all, don't sent anything
  return { remove: null, add: null, modify: null };
};

/**
 * Creates add/remove-routing-filter jobs
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing add and remove routing filter parameters
 */
const prepareModifyRoutingFilters = (origDevice, newDevice) => {
  const [origLists, newLists] = [
    transformRoutingFilters(origDevice.routingFilters, origDevice.versions.agent),
    transformRoutingFilters(newDevice.routingFilters, newDevice.versions.agent)
  ];

  const [addRoutingFilters, removeRoutingFilters] = [
    differenceWith(
      newLists,
      origLists,
      (origList, newList) => {
        return isEqual(origList, newList);
      }
    ),
    differenceWith(
      origLists,
      newLists,
      (origList, newList) => {
        return isEqual(origList, newList);
      }
    )
  ];

  return { addRoutingFilters, removeRoutingFilters };
};

/**
 * Creates add/remove-ospf jobs
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing add and remove ospf parameters
 */
const prepareModifyOSPF = (origDevice, newDevice) => {
  const [origOSPF, newOSPF] = [
    transformOSPF(origDevice.ospf, origDevice.bgp),
    transformOSPF(newDevice.ospf, newDevice.bgp)
  ];

  if (isEqual(origOSPF, newOSPF)) {
    return { remove: null, add: null };
  }

  // if newOSPF is with empty values - send only remove-ospf
  if (!Object.keys(omitBy(newOSPF, val => val === '')).length) {
    return { remove: origOSPF, add: null };
  }

  // if origOSPF is with empty values - send only add-ospf
  if (!Object.keys(omitBy(origOSPF, val => val === '')).length) {
    return { remove: null, add: newOSPF };
  }

  // if there is a change, send pair of remove-ospf and add-ospf
  return { remove: origOSPF, add: newOSPF };
};

/**
 * Creates add/remove-routing-general jobs
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing add and remove ospf parameters
 */
const prepareModifyAdvancedRouting = (origDevice, newDevice) => {
  const [origAdvancedRouting, newAdvancedRouting] = [
    transformAdvancedRoutingConfig(origDevice?.advancedRouting ?? {}),
    transformAdvancedRoutingConfig(newDevice?.advancedRouting ?? {})
  ];

  if (isEqual(origAdvancedRouting, newAdvancedRouting)) {
    return { remove: null, add: null };
  }

  // if newAdvancedRouting is with empty values - send only remove-routing-general
  if (!Object.keys(omitBy(newAdvancedRouting, val => val === '')).length) {
    return { remove: origAdvancedRouting, add: null };
  }

  // if origAdvancedRouting is with empty values - send only add-routing-general
  if (!Object.keys(omitBy(origAdvancedRouting, val => val === '')).length) {
    return { remove: null, add: newAdvancedRouting };
  }

  // if there is a change,
  // send pair of remove-routing-general and add-routing-general
  return { remove: origAdvancedRouting, add: newAdvancedRouting };
};

/**
 * Creates a modify-dhcp object
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing an array of routes
 */
const prepareModifyDHCP = async (origDevice, newDevice) => {
  const vrrpGroups = await Vrrp.find(
    { org: origDevice.org, 'devices.device': origDevice._id }
  ).populate('devices.device').lean();

  // Extract only relevant fields from dhcp database entries
  const [newDHCP, origDHCP] = [
    newDevice.dhcp.filter(d => !d.isPending).map(dhcp => {
      return transformDHCP(dhcp, newDevice._id, vrrpGroups);
    }),

    origDevice.dhcp.filter(d => !d.isPending).map(dhcp => {
      return transformDHCP(dhcp, origDevice._id, vrrpGroups);
    })
  ];

  // Compare new and original dhcp arrays.
  // Add all dhcp entries that do not exist in the
  // original dhcp array and remove all dhcp entries
  // that do not appear in the new dhcp array
  let [dhcpAdd, dhcpRemove] = [
    differenceWith(
      newDHCP,
      origDHCP,
      (origRoute, newRoute) => {
        return isEqual(origRoute, newRoute);
      }
    ),
    differenceWith(
      origDHCP,
      newDHCP,
      (origRoute, newRoute) => {
        return isEqual(origRoute, newRoute);
      }
    )
  ];

  dhcpRemove = dhcpRemove.map(dhcp => {
    return {
      interface: dhcp.interface
    };
  });

  return { dhcpRemove, dhcpAdd };
};

const prepareAddRemoveLte = (origDevice, updatedDevice) => {
  const oldLteInterfaces = origDevice.interfaces.filter(item => item.deviceType === 'lte');
  const newLteInterfaces = updatedDevice.interfaces.filter(item => item.deviceType === 'lte');

  const result = { add: [], remove: [] };

  const lteInterfacesDiff = differenceWith(
    newLteInterfaces,
    oldLteInterfaces,
    (origIfc, newIfc) => {
      // no need to send job if LTE configuration changed but LTE is disable
      if (!origIfc.configuration.enable && !newIfc.configuration.enable) {
        return true;
      }

      return isEqual(origIfc.configuration, newIfc.configuration) &&
        isEqual(origIfc.metric, newIfc.metric);
    }
  );

  lteInterfacesDiff.forEach(lteIfc => {
    if (lteIfc.configuration.enable) {
      result.add.push(transformLte(lteIfc));
    } else {
      result.remove.push(transformLte(lteIfc));
    }
  });

  return result;
};

/**
 * Creates and queues the modify-device job. It compares
 * the current view of the device in the database with
 * the former view to deduce which fields have change.
 * it then creates an object with the changes and calls
 * queueModifyDeviceJob() to queue the job to the device.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (device, user, data) => {
  const orgId = data.org;
  const modifyParams = {};

  device[0] = await device[0]
    .populate('interfaces.pathlabels', '_id name type')
    .populate('interfaces.qosPolicy')
    .populate('policies.qos.policy')
    .populate({
      path: 'applications.app',
      populate: {
        path: 'appStoreApp'
      }
    }).execPopulate();

  data.newDevice = await data.newDevice
    .populate('interfaces.pathlabels', '_id name type')
    .populate('policies.firewall.policy', '_id name rules')
    .populate('interfaces.qosPolicy')
    .populate('policies.qos.policy')
    .execPopulate();

  data.sendAddTunnels ??= new Set();
  data.sendRemoveTunnels ??= new Set();
  data.ignoreTasks ??= [];

  // Create the default/static routes modification parameters
  const { remove: removeRoutes, add: addRoutes } = prepareModifyRoutes(device[0], data.newDevice);
  if (removeRoutes.length > 0 || addRoutes.length > 0) {
    modifyParams.modify_routes = { remove: removeRoutes, add: addRoutes };
  }

  // Create DHCP modification parameters
  const modifyDHCP = await prepareModifyDHCP(device[0], data.newDevice);
  if (modifyDHCP.dhcpRemove.length > 0 ||
      modifyDHCP.dhcpAdd.length > 0) {
    modifyParams.modify_dhcp_config = modifyDHCP;
  }

  // Create OSPF modification parameters
  const { remove: removeOSPF, add: addOSPF } = prepareModifyOSPF(device[0], data.newDevice);
  if (removeOSPF || addOSPF) {
    modifyParams.modify_ospf = { remove: removeOSPF, add: addOSPF };
  }

  // Create general routing modification parameters
  const { remove: removeGeneralRoutingConf, add: addGeneralRoutingConf } =
    prepareModifyAdvancedRouting(device[0], data.newDevice);
  if (removeGeneralRoutingConf || addGeneralRoutingConf) {
    modifyParams.modify_advanced_routing_config = {
      remove: removeGeneralRoutingConf,
      add: addGeneralRoutingConf
    };
  }

  // Create BGP modification parameters
  const {
    remove: removeBGP, add: addBGP, modify: modifyBGP
  } = await prepareModifyBGP(device[0], data.newDevice);
  if (removeBGP || addBGP || modifyBGP) {
    modifyParams.modify_bgp = { remove: removeBGP, add: addBGP, modify: modifyBGP };
  }

  // Create routing filters modification parameters
  const {
    removeRoutingFilters, addRoutingFilters
  } = prepareModifyRoutingFilters(device[0], data.newDevice);
  if (removeRoutingFilters.length > 0 || addRoutingFilters.length > 0) {
    modifyParams.modify_routing_filters = { remove: removeRoutingFilters, add: addRoutingFilters };
  }

  modifyParams.modify_router = {};
  const oldBridges = getBridges(device[0].interfaces);
  const newBridges = getBridges(data.newDevice.interfaces);

  const assignBridges = [];
  const unassignBridges = [];

  // Check add-switch
  for (const newBridge in newBridges) {
    // if new bridges doesn't exists in old bridges, we need to add-switch
    if (!oldBridges.hasOwnProperty(newBridge)) {
      assignBridges.push(newBridge);
    }
  }
  if (assignBridges.length) {
    modifyParams.modify_router.assignBridges = assignBridges;
  }

  // Check remove-switch
  for (const oldBridge in oldBridges) {
    // if old bridges doesn't exists in new bridges, we need to remove-switch
    if (!newBridges.hasOwnProperty(oldBridge)) {
      unassignBridges.push(oldBridge);
    }
  }
  if (unassignBridges.length) {
    modifyParams.modify_router.unassignBridges = unassignBridges;
  }

  // Create interfaces modification parameters
  // Compare the array of interfaces, and return
  // an array of the interfaces that have changed
  // First, extract only the relevant interface fields
  const origDeviceVersion = device[0].versions.agent;
  const origTransformedIfcs = transformInterfaces(
    device[0].interfaces, device[0].ospf, origDeviceVersion
  );
  const [origInterfaces, origIsAssigned] = [
    // add global ospf settings to each interface
    origTransformedIfcs,
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        devId: ifc.devId,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  const newDeviceVersion = data.newDevice.versions.agent;
  const newTransformedIfcs = transformInterfaces(
    data.newDevice.interfaces, data.newDevice.ospf, newDeviceVersion
  );
  const [newInterfaces, newIsAssigned] = [
    // add global ospf settings to each interface
    newTransformedIfcs,
    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        devId: ifc.devId,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  // Push missing VLAN interfaces as unassigned to initiate a remove-interface task
  origInterfaces.forEach(origIfc => {
    if (origIfc.parentDevId &&
      !newInterfaces.some(newIfc => origIfc.devId === newIfc.devId)) {
      newInterfaces.push({ ...origIfc, isAssigned: false });
      newIsAssigned.push({
        _id: origIfc._id,
        devId: origIfc.devId,
        isAssigned: false
      });
    }
  });

  // Handle changes in the 'assigned' field. assignedDiff will contain
  // all the interfaces that have changed their 'isAssigned' field
  const assignedDiff = differenceWith(
    newIsAssigned,
    origIsAssigned,
    (origIfc, newIfc) => {
      return isEqual(origIfc, newIfc);
    }
  );

  if (assignedDiff.length > 0) {
    const toAssign = [];
    const toUnAssign = [];
    // Split interfaces into two arrays: one for the interfaces that
    // are about to become assigned, and one for those which will be
    // unassigned. Add the full interface details as well.
    assignedDiff.forEach(ifc => {
      const ifcInfo = newInterfaces.find(ifcEntry => {
        return ifcEntry._id === ifc._id;
      });

      if (ifc.isAssigned) toAssign.push(ifcInfo);
      else toUnAssign.push(ifcInfo);

      // Interfaces that changed their assignment status
      // are not allowed to change. We remove them from
      // the list to avoid change in assignment and modification
      // in the same message.
      pullAllWith(newInterfaces, [ifcInfo], isEqual);
    });
    if (toAssign.length) modifyParams.modify_router.assign = toAssign;
    if (toUnAssign.length) modifyParams.modify_router.unassign = toUnAssign;
  }

  // if it's empty, delete it in order to prevent unnecessary modify-device job
  if (Object.keys(modifyParams.modify_router).length === 0) {
    delete modifyParams.modify_router;
  }

  // Handle changes in interface fields other than 'isAssigned'
  const interfacesDiff = differenceWith(
    newInterfaces,
    origInterfaces,
    (origIfc, newIfc) => {
      return isEqual(origIfc, newIfc);
    }
  );

  // Changes made to unassigned interfaces should be
  // stored in the MGMT, but should not reach the device.
  const assignedInterfacesDiff = interfacesDiff.filter(ifc => {
    return ifc.isAssigned === true;
  });

  // If there are bridge changes, we need to check if we need to send a modify-interface message.
  // For example:
  // Suppose there is already an interface with some IP.
  // Now, the user configures another interface with the same IP address.
  // In this case, we need to send an add-switch job with the new interface,
  // but we need to add the existing interface to this bridge,
  // even if there are no changes in this interface.
  const bridgeChanges = [...assignBridges, ...unassignBridges];
  if (bridgeChanges.length) {
    for (const changedBridge of bridgeChanges) {
      const bridgeAddr = changedBridge;

      // "newInterfaces" at this point contains only interfaces that do not assign now,
      // but already assigned before.
      // look at "pullAllWith(newInterfaces, [ifcInfo], isEqual);" above
      const bridgedInterfaces = newInterfaces.filter(ni => ni.addr === bridgeAddr && ni.isAssigned);
      bridgedInterfaces.forEach(ifc => {
        // if interface doesn't exists in the assignedInterfacesDiff array, we push it
        if (!assignedInterfacesDiff.some(i => i.devId === ifc.devId)) {
          assignedInterfacesDiff.push(ifc);
        };
      });
    }
  }

  // add-lte job should be submitted even if unassigned interface
  // we send this job if configuration or interface metric was changed
  // Create (add|remove)-lte parameters
  const { add: addLte, remove: removeLte } = prepareAddRemoveLte(device[0], data.newDevice);
  if (addLte.length > 0 || removeLte.length > 0) {
    modifyParams.modify_lte = { remove: removeLte, add: addLte };
  }

  if (assignedInterfacesDiff.length > 0) {
    modifyParams.modify_interfaces = {};
    modifyParams.modify_interfaces.interfaces = assignedInterfacesDiff;
  }

  const origDevice = device[0];
  const updDevice = data.newDevice;
  const updFwRules = [];
  const origFwRules = [];
  const updNatRules = [];
  const origNatRules = [];
  for (const rule of updDevice.firewall.rules.toObject()) {
    if (!rule.enabled) {
      continue;
    }
    if (rule.direction === 'lanNat') {
      updNatRules.push(rule);
    } else {
      updFwRules.push(rule);
    }
  }
  for (const rule of origDevice.firewall.rules.toObject()) {
    if (!rule.enabled) {
      continue;
    }
    if (rule.direction === 'lanNat') {
      origNatRules.push(rule);
    } else {
      origFwRules.push(rule);
    }
  }

  const firewallRulesModified =
    origDevice.deviceSpecificRulesEnabled !== updDevice.deviceSpecificRulesEnabled ||
    !(updFwRules.length === origFwRules.length && updFwRules.every((updatedRule, index) =>
      isEqual(
        omit(updatedRule, ['_id', 'name', 'classification']),
        omit(origFwRules[index], ['_id', 'name', 'classification'])
      ) &&
      isEqual(
        omit(updatedRule.classification.source, ['_id']),
        omit(origFwRules[index]?.classification.source, ['_id'])
      ) &&
      isEqual(
        omit(updatedRule.classification.destination, ['_id']),
        omit(origFwRules[index]?.classification.destination, ['_id'])
      )
    ));

  if (firewallRulesModified) {
    modifyParams.modify_firewall = await getDevicesFirewallJobInfo(updDevice.toObject());
  }

  const lanNatRulesModified =
    origDevice.deviceSpecificRulesEnabled !== updDevice.deviceSpecificRulesEnabled ||
    !(updNatRules.length === origNatRules.length && updNatRules.every((updatedRule, index) =>
      isEqual(
        omit(updatedRule.classification?.source, ['_id']),
        omit(origNatRules[index]?.classification?.source, ['_id'])
      ) &&
      isEqual(
        omit(updatedRule.classification?.destination, ['_id']),
        omit(origNatRules[index]?.classification?.destination, ['_id'])
      )
    ));

  if (lanNatRulesModified) {
    modifyParams.modify_lan_nat = getLanNatJobInfo(updDevice);
  }

  // Send QoS policy job only when interfaces specific policy modified
  // as installing a default QoS will set policy on every WAN interface
  const qosAffectingParameters = ({ devId, isAssigned, type, qosPolicy }) => ({
    devId, isAssigned, type, qosPolicyId: qosPolicy._id
  });
  const qosApplied = i => i.isAssigned && i.type === 'WAN' && i.qosPolicy;

  const qosModified = !isEqual(
    data.newDevice.interfaces.filter(qosApplied).map(qosAffectingParameters),
    device[0].interfaces.filter(qosApplied).map(qosAffectingParameters)
  );

  if (qosModified) {
    modifyParams.modify_qos = await getDevicesQOSJobInfo(updDevice.toObject());
  }

  const modified =
      has(modifyParams, 'modify_routes') ||
      has(modifyParams, 'modify_router') ||
      has(modifyParams, 'modify_interfaces') ||
      has(modifyParams, 'modify_ospf') ||
      has(modifyParams, 'modify_advanced_routing_config') ||
      has(modifyParams, 'modify_routing_filters') ||
      has(modifyParams, 'modify_bgp') ||
      has(modifyParams, 'modify_firewall') ||
      has(modifyParams, 'modify_lan_nat') ||
      has(modifyParams, 'modify_qos') ||
      has(modifyParams, 'modify_lte') ||
      has(modifyParams, 'modify_dhcp_config');

  // Queue job only if the device has changed
  // Return empty jobs array if the device did not change
  if (!modified && data.sendAddTunnels.size === 0 && data.sendRemoveTunnels.size === 0) {
    logger.debug('The device was not modified, nothing to apply', {
      params: { newInterfaces: JSON.stringify(newInterfaces), device: device[0]._id }
    });
    return {
      ids: [],
      tasks: {},
      status: 'completed',
      message: ''
    };
  }

  try {
    // First, go over assigned and modified
    // interfaces and make sure they are valid
    const assign = has(modifyParams, 'modify_router.assign')
      ? modifyParams.modify_router.assign
      : [];
    const unassign = has(modifyParams, 'modify_router.unassign')
      ? modifyParams.modify_router.unassign
      : [];
    const modified = has(modifyParams, 'modify_interfaces')
      ? modifyParams.modify_interfaces.interfaces
      : [];
    const interfaces = [...assign, ...modified];
    const { valid, err } = validateModifyDeviceMsg(interfaces);
    if (!valid) throw (new Error(err));
    // Don't allow to modify/assign/unassign
    // interfaces that are assigned with DHCP
    const dhcpValidation = validateDhcpConfig(data.newDevice, [
      ...interfaces,
      ...unassign
    ]);
    if (!dhcpValidation.valid) throw (new Error(dhcpValidation.err));
    await setJobPendingInDB(device[0]._id, orgId, true);

    // Queue device modification job
    const { jobs, sentTasks } = await queueModifyDeviceJob(
      device[0],
      data.newDevice,
      modifyParams,
      user,
      orgId,
      data.sendAddTunnels,
      data.sendRemoveTunnels,
      data.ignoreTasks
    );

    return {
      ids: jobs.flat().map(job => job.id),
      tasks: sentTasks,
      status: 'completed',
      message: ''
    };
  } catch (err) {
    logger.error('Failed to queue modify device job', {
      params: { err: err.message, device: device[0]._id }
    });
    throw (new Error(err.message || 'Internal server error'));
  }
};

/**
 * Called when modify device job completed.
 * In charge of reconstructing the tunnels.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async (jobId, res) => {
  if (!res) {
    logger.warn('Got an invalid job result', { params: { res: res, jobId: jobId } });
    return;
  }
  // Call 'complete' callbacks if needed
  const { firewallPolicy, qosPolicy } = res;
  if (firewallPolicy) {
    firewallPolicyComplete(jobId, firewallPolicy);
  }
  if (qosPolicy) {
    qosPolicyComplete(jobId, qosPolicy);
  }
};

/**
 * Complete handler for sync job
 * @return void
 */
const completeSync = async (jobId, jobsData) => {
  // Currently not implemented. "Modify-device" complete
  // callback reconstructs the tunnels by queuing "add-tunnel"
  // jobs to all devices that might be affected by the change.
  // Since at the moment, the agent does not support adding an
  // already existing tunnel we cannot reconstruct the tunnels
  // as part of the sync complete handler.
};

/**
 * Creates the interfaces, static routes and
 * DHCP sections in the full sync job.
 * Firewall rules skipped here, sync from firewallPolicy will handle them
 * @return Array
 */

const sync = async (deviceId, orgId) => {
  const device = await devices.findOne(
    { _id: deviceId },
    {
      interfaces: 1,
      org: 1,
      staticroutes: 1,
      dhcp: 1,
      ospf: 1,
      bgp: 1,
      routingFilters: 1,
      versions: 1,
      advancedRouting: 1
    }
  )
    .lean()
    // no need to populate pathLabel name here, since we need only the id's
    .populate('interfaces.pathlabels', '_id type')
    .populate('org');

  const {
    interfaces, staticroutes, dhcp, ospf, bgp, advancedRouting, routingFilters, versions, _id
  } = device;

  const majorVersion = getMajorVersion(versions.agent);
  const minorVersion = getMinorVersion(versions.agent);

  // Prepare add-interface message
  const deviceConfRequests = [];

  // do not send it to device version < 6.2
  const isVxlanConfigSupported = majorVersion > 6 || (majorVersion === 6 && minorVersion >= 2);
  if (isVxlanConfigSupported) {
    const vxlanConfigParams = transformVxlanConfig(device.org);
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-vxlan-config',
      params: vxlanConfigParams
    });
  }

  // build bridges
  const bridges = getBridges(interfaces);
  Object.keys(bridges).forEach(item => {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-switch',
      params: {
        addr: item
      }
    });
  });

  // build interfaces
  buildInterfaces(interfaces, ospf, versions.agent).forEach(item => {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-interface',
      params: item
    });
  });

  // lte enable job
  const enabledLte = interfaces.filter(item =>
    item.deviceType === 'lte' && item.configuration.enable);
  if (enabledLte.length) {
    enabledLte.forEach(lte => {
      deviceConfRequests.push({
        entity: 'agent',
        message: 'add-lte',
        params: transformLte(lte)
      });
    });
  }

  // IMPORTANT: routing data should be before static routes!
  let ospfData = transformOSPF(ospf, bgp);
  // remove empty values because they are optional
  ospfData = omitBy(ospfData, val => val === '');
  if (!isEmpty(ospfData)) {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-ospf',
      params: ospfData
    });
  }

  // IMPORTANT: routing data should be before static routes!
  let advancedRoutingData = transformAdvancedRoutingConfig(advancedRouting);
  // remove empty values because they are optional
  advancedRoutingData = omitBy(advancedRoutingData, val => val === '');
  if (!isEmpty(advancedRoutingData)) {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-routing-general',
      params: advancedRoutingData
    });
  }

  // Prepare add-routing-filter message
  const routingFiltersData = transformRoutingFilters(routingFilters, versions.agent);
  routingFiltersData.forEach(entry => {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-routing-filter',
      params: entry
    });
  });

  const isBgpSupported = majorVersion > 5 || (majorVersion === 5 && minorVersion >= 3);
  if (isBgpSupported && bgp?.enable) {
    const bgpData = await transformBGP(device);
    if (!isEmpty(bgpData)) {
      deviceConfRequests.push({
        entity: 'agent',
        message: 'add-routing-bgp',
        params: bgpData
      });
    }
  }

  // Prepare add-route message
  Array.isArray(staticroutes) && staticroutes.forEach(route => {
    // skip pending routes
    if (route.isPending) {
      return;
    }

    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-route',
      params: transformStaticRoute(route)
    });
  });

  const vrrpGroups = await Vrrp.find(
    { org: device.org, 'devices.device': _id }
  ).populate('devices.device', '_id').lean();

  // Prepare add-dhcp-config message
  Array.isArray(dhcp) && dhcp.forEach(entry => {
    const { isPending } = entry;

    // skip pending dhcp
    if (isPending) {
      return;
    }

    const params = transformDHCP(entry, _id, vrrpGroups);

    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-dhcp-config',
      params: params
    });
  });

  return {
    requests: deviceConfRequests,
    completeCbData: {},
    callComplete: false
  };
};

/**
 * Called when modify device job fails
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.error('Modify device job failed', {
    params: { result: res, jobId: jobId }
  });

  // Call 'error' callbacks if needed
  const { firewallPolicy, qosPolicy } = res || {};
  if (firewallPolicy) {
    firewallPolicyError(jobId, firewallPolicy);
  }
  if (qosPolicy) {
    qosPolicyError(jobId, qosPolicy);
  }
};

/**
 * Called when modify device job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion/failure
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
  if (['inactive', 'delayed'].includes(job._state)) {
    logger.info('Modify device job removed', {
      params: { jobId: job.id }
    });
    // Call 'remove' callbacks if needed
    const { firewallPolicy, qosPolicy } = job.data.response.data || {};
    if (firewallPolicy) {
      job.data.response.data = firewallPolicy;
      firewallPolicyRemove(job);
    }
    if (qosPolicy) {
      job.data.response.data = qosPolicy;
      qosPolicyRemove(job);
    }
  }
};

const _isNeedToSkipModifyJob = (messageParams, modifiedIfcsMap, device) => {
  const origIfcs = transformInterfaces(device.interfaces, device.ospf, device.versions.agent);
  return !has(messageParams, 'modify_router') &&
    !has(messageParams, 'modify_routes') &&
    !has(messageParams, 'modify_dhcp_config') &&
    !has(messageParams, 'modify_ospf') &&
    !has(messageParams, 'modify_advanced_routing_config') &&
    !has(messageParams, 'modify_bgp') &&
    !has(messageParams, 'modify_routing_filters') &&
    !has(messageParams, 'modify_lte') &&
    !has(messageParams, 'modify_firewall') &&
    !has(messageParams, 'modify_lan_nat') &&
    !has(messageParams, 'modify_qos') &&
    Object.values(modifiedIfcsMap).every(modifiedIfc => {
      const origIfc = origIfcs.find(o => o._id.toString() === modifiedIfc._id.toString());
      const propsModified = Object.keys(modifiedIfc).filter(prop => {
        switch (prop) {
          case 'pathlabels':
            return !isEqual(
              modifiedIfc[prop].filter(pl => pl.type === 'DIA'),
              origIfc[prop].filter(pl => pl.type === 'DIA')
            );
          default:
            return !isEqual(modifiedIfc[prop], origIfc[prop]);
        }
      });
      // skip modify-device job if only PublicIP or PublicPort are modified
      // or if dhcp==='yes' and only IPv4, IPv6, gateway are modified
      // these parameters are set by device
      const propsToSkip = modifiedIfc.dhcp !== 'yes'
        ? ['PublicIP', 'PublicPort', 'useFixedPublicPort']
        : ['PublicIP', 'PublicPort', 'addr', 'addr6', 'gateway', 'useFixedPublicPort'];
      return differenceWith(propsModified, propsToSkip, isEqual).length === 0;
    });
};

const processModifyJob = async (tasks, device, orgId, user, ignoreTasks = [], jobResponse = {}) => {
  // during the process, can be duplications in tasks so here we clean it
  let finalTasks = uniqWith(tasks, isEqual);

  // remove the ignored tasks
  // "ignoreTasks" is array of tasks that should be removed from the final list.
  // The reason could be that those tasks already sent to the device
  // and no need to send it once again.
  // (see the long comment with examples in Connections.js file).
  for (const ignoreTask of ignoreTasks) {
    const index = finalTasks.findIndex(f => isEqual(ignoreTask, f));
    if (index > -1) {
      finalTasks.splice(index, 1);
    }
  }

  if (finalTasks.length === 0) {
    return { modifyJob: null, finalTasks: null };
  }

  if (finalTasks.length > 1) {
    // convert the tasks to one aggregated request
    finalTasks = [{
      entity: 'agent',
      message: 'aggregated',
      params: { requests: finalTasks }
    }];
  }

  try {
    const modifyJob = await queueJob(
      orgId,
      user.username,
      finalTasks,
      device,
      jobResponse
    );

    return { modifyJob, finalTasks };
  } catch (err) {
    logger.error('Failed to queue device modification message', {
      params: { err: err.message, finalTasks, deviceId: device._id }
    });
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  completeSync: completeSync,
  sync: sync,
  error: error,
  remove: remove,
  processModifyJob: processModifyJob
};
