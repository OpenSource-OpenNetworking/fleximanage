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
  prepareTunnelRemoveJob,
  prepareTunnelAddJob,
  queueTunnel
} = require('../deviceLogic/tunnels');
const { validateModifyDeviceMsg, validateDhcpConfig } = require('./validators');
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const {
  complete: firewallPolicyComplete,
  error: firewallPolicyError,
  remove: firewallPolicyRemove,
  getDevicesFirewallJobInfo
} = require('./firewallPolicy');
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

/**
 * Remove fields that should not be sent to the device from the interfaces array.
 * @param  {Array} interfaces an array of interfaces that will be sent to the device
 * @return {Array}            the same array after removing unnecessary fields
 */
const prepareIfcParams = (interfaces, newDevice) => {
  return interfaces.map(ifc => {
    const newIfc = omit(ifc, ['_id', 'isAssigned', 'pathlabels']);

    newIfc.dev_id = newIfc.devId;
    delete newIfc.devId;

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
    newIfc.bridge_addr = ifc.type === 'LAN' && ifc.isAssigned && newDevice.interfaces.some(i => {
      return newIfc.dev_id !== i.devId && i.isAssigned && newIfc.addr === i.IPv4 + '/' + i.IPv4Mask;
    }) ? newIfc.addr : null;

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
    }
    return newIfc;
  });
};

/**
 * Transforms mongoose array of interfaces into array of objects
 *
 * @param {*} interfaces
 * @returns array of interfaces
 */
const transformInterfaces = (interfaces, globalOSPF) => {
  return interfaces.map(ifc => {
    const ifcObg = {
      _id: ifc._id,
      devId: ifc.devId,
      dhcp: ifc.dhcp ? ifc.dhcp : 'no',
      addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
      addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
      PublicIP: ifc.PublicIP,
      PublicPort: ifc.PublicPort,
      useStun: ifc.useStun,
      useFixedPublicPort: ifc.useFixedPublicPort,
      monitorInternet: ifc.monitorInternet,
      gateway: ifc.gateway,
      metric: ifc.metric,
      mtu: ifc.mtu,
      routing: ifc.routing,
      type: ifc.type,
      isAssigned: ifc.isAssigned,
      pathlabels: ifc.pathlabels,
      configuration: ifc.configuration,
      deviceType: ifc.deviceType,
      dnsServers: ifc.dnsServers,
      dnsDomains: ifc.dnsDomains,
      useDhcpDnsServers: ifc.useDhcpDnsServers
    };

    // add ospf data if relevant
    if (ifcObg.routing === 'OSPF') {
      ifcObg.ospf = {
        ...ifc.ospf.toObject(),
        helloInterval: globalOSPF.helloInterval,
        deadInterval: globalOSPF.deadInterval
      };
    }
    return ifcObg;
  });
};

/**
 * Composes aggregated device modification message (agent version >= 2)
 *
 * @param {*} messageParams input device modification params
 * @param {Object}  device the device to which the job should be queued
 * @returns object of the following format:
 * {
 *   message: 'aggregated',
 *   params: { requests: [] }
 * }
 * where 'requests' is an array of individual device modification
 * commands.
 */
const prepareModificationMessage = (messageParams, device, newDevice) => {
  const requests = [];
  const tasks = [];
  // Check against the old configured interfaces.
  // If they are the same, do not initiate modify-device job.
  if (has(messageParams, 'modify_interfaces')) {
    const interfaces = messageParams.modify_interfaces.interfaces || [];
    const lteInterfaces = messageParams.modify_interfaces.lte_enable_disable || [];

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

    if (lteInterfaces.length > 0) {
      requests.push(...lteInterfaces.map(item => {
        return {
          entity: 'agent',
          message: item.configuration.enable ? 'add-lte' : 'remove-lte',
          params: {
            ...item.configuration,
            dev_id: item.devId,
            metric: item.metric
          }
        };
      }));
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

  if (has(messageParams, 'modify_routes')) {
    const routeRequests = messageParams.modify_routes.routes.flatMap(item => {
      let items = [];
      if (item.old_route !== '') {
        items.push({
          entity: 'agent',
          message: 'remove-route',
          params: {
            addr: item.addr,
            via: item.old_route,
            devId: item.devId || undefined,
            metric: item.metric ? parseInt(item.metric, 10) : undefined,
            redistributeViaOSPF: item.redistributeViaOSPF
          }
        });
      }
      if (item.new_route !== '') {
        items.push({
          entity: 'agent',
          message: 'add-route',
          params: {
            addr: item.addr,
            via: item.new_route,
            devId: item.devId || undefined,
            metric: item.metric ? parseInt(item.metric, 10) : undefined,
            redistributeViaOSPF: item.redistributeViaOSPF
          }
        });
      }

      items = items.map((item) => {
        if (item.params && item.params.devId) {
          item.params.dev_id = item.params.devId;
          delete item.params.devId;
        }
        return item;
      });

      return items;
    });

    if (routeRequests) {
      requests.push(...routeRequests);
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

  if (requests.length !== 0) {
    tasks.push(
      {
        entity: 'agent',
        message: 'aggregated',
        params: { requests: requests }
      }
    );
  }

  return tasks;
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
    device.machineId, username, org,
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
 * @param  {Object}  device        original device object, before the changes
 * @param  {Object}  messageParams device changes that will be sent to the device
 * @param  {Object}  user          the user that created the request
 * @param  {string}  org           organization to which the user belongs
 * @return {Job}                   The queued modify-device job
 */
const queueModifyDeviceJob = async (device, newDevice, messageParams, user, org) => {
  const removedTunnels = [];
  const interfacesIdsSet = new Set();
  const modifiedIfcsMap = {};

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
    const interfaces = [
      ...messageParams.modify_interfaces.interfaces,
      ...messageParams.modify_interfaces.lte_enable_disable
    ];
    interfaces.forEach(ifc => {
      interfacesIdsSet.add(ifc._id);
      modifiedIfcsMap[ifc._id] = ifc;
    });
  }

  // Prepare device modification job, if nothing requires modification, return
  const tasks = prepareModificationMessage(messageParams, device, newDevice);

  if (tasks.length === 0 || tasks[0].length === 0) {
    return [];
  }

  let tunnelsJobs = [];
  for (const ifc of interfacesIdsSet) {
    // First, remove all active tunnels connected
    // via this interface, on all relevant devices.
    const tunnels = await tunnelsModel
      .find({
        isActive: true,
        isPending: { $ne: true }, // no need to reconstruct pending tunnels
        $or: [{ interfaceA: ifc._id }, { interfaceB: ifc._id }]
      })
      .populate('deviceA')
      .populate('deviceB')
      .populate('peer');

    for (const tunnel of tunnels) {
      let { deviceA, deviceB, pathlabel, num, peer } = tunnel;
      // IMPORTANT: Since the interface changes have already been updated in the database
      // we have to use the original device for creating the tunnel-remove message.
      if (deviceA._id.toString() === device._id.toString()) {
        deviceA = device;
      } else {
        deviceB = device;
      };

      const ifcA = deviceA.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceA.toString();
      });

      const ifcB = peer ? null : deviceB.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceB.toString();
      });

      // For interface changes such as IP/mask we remove the tunnel
      // and readd it after the change has been applied on the device.
      // In such cases, we don't remove the tunnel from the database,
      // but rather only queue remove/add tunnel jobs to the devices.
      // For interfaces that are unassigned, or which path labels have
      // been removed, we remove the tunnel from both the devices and the MGMT
      const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(
        tunnel, ifcA, ifcB, peer);

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
        (isObject(modifiedIfcA) && modifiedIfcA.dhcp === 'yes' && ifcA.dhcp !== 'yes');
      const waitingDhcpInfoB = peer
        ? false
        : (isObject(modifiedIfcB) && modifiedIfcB.dhcp === 'yes' && ifcB.dhcp !== 'yes');

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
      const ifcAModified = tunnelParametersModified(ifcA, modifiedIfcA);
      const ifcBModified = peer ? false : tunnelParametersModified(ifcB, modifiedIfcB);

      if (!ifcAModified && !ifcBModified) {
        continue;
      }

      // no need to recreate the tunnel with local direct connection
      const isLocal = (ifcA, ifcB) => {
        return !ifcA.PublicIP || !ifcB.PublicIP ||
          ifcA.PublicIP === ifcB.PublicIP;
      };
      const skipLocal = peer
        ? false
        : (isObject(modifiedIfcA) && modifiedIfcA.addr === `${ifcA.IPv4}/${ifcA.IPv4Mask}` &&
          isLocal(modifiedIfcA, ifcB) && isLocal(ifcA, ifcB)) ||
          (isObject(modifiedIfcB) && modifiedIfcB.addr === `${ifcB.IPv4}/${ifcB.IPv4Mask}` &&
          isLocal(modifiedIfcB, ifcA) && isLocal(ifcB, ifcA));

      if (skipLocal) {
        continue;
      }

      await setTunnelsPendingInDB([tunnel._id], org, true);
      let title = '';
      if (peer) {
        // eslint-disable-next-line max-len
        title = `Delete peer tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${peer.name})`;
      } else {
        // eslint-disable-next-line max-len
        title = `Delete tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`;
      }
      const removeTunnelJobs = await queueTunnel(
        false,
        title,
        tasksDeviceA,
        tasksDeviceB,
        user.username,
        org,
        deviceA.machineId,
        peer ? null : deviceB.machineId,
        deviceA._id,
        peer ? null : deviceB._id,
        num,
        pathlabel,
        peer
      );
      tunnelsJobs = tunnelsJobs.concat(removeTunnelJobs);
      removedTunnels.push(tunnel._id);
    }
  }
  // Send modify device job only if required
  const skipModifyJob = !has(messageParams, 'modify_router') &&
    !has(messageParams, 'modify_routes') &&
    !has(messageParams, 'modify_dhcp_config') &&
    !has(messageParams, 'modify_ospf') &&
    !has(messageParams, 'modify_firewall') &&
    Object.values(modifiedIfcsMap).every(modifiedIfc => {
      const origIfc = device.interfaces.find(o => o._id.toString() === modifiedIfc._id.toString());
      const propsModified = Object.keys(modifiedIfc).filter(prop => {
        // There is a case that origIfc.IPv6 is an empty string and origIfc.IPv6Mask is undefined,
        // So the result of the combination of them is "/".
        // If modifiedIfc.addr6 is an empty string, it always different than "/", and
        // we send unnecessary modify-interface job.
        // So if the origIfc.IPv6 is empty, we ignore the IPv6 undefined.
        const origIPv6 = origIfc.IPv6 === '' ? '' : `${origIfc.IPv6}/${origIfc.IPv6Mask}`;
        switch (prop) {
          case 'pathlabels':
            return !isEqual(
              modifiedIfc[prop].filter(pl => pl.type === 'DIA'),
              origIfc[prop].filter(pl => pl.type === 'DIA')
            );
          case 'addr':
            return modifiedIfc.addr !== `${origIfc.IPv4}/${origIfc.IPv4Mask}`;
          case 'addr6':
            return modifiedIfc.addr6 !== origIPv6;
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

  // Additional job response data
  const jobResponse = {};
  if (messageParams.modify_firewall) {
    jobResponse.firewallPolicy = messageParams.modify_firewall.data;
  }

  // Queue device modification job
  const job = !skipModifyJob
    ? await queueJob(org, user.username, tasks, device, jobResponse) : null;

  // Queue tunnel reconstruction jobs
  try {
    const addTunnelJobs = await reconstructTunnels(removedTunnels, user.username);
    tunnelsJobs = tunnelsJobs.concat(addTunnelJobs);
  } catch (err) {
    logger.error('Tunnel reconstruction failed', {
      params: { jobId: job.id, device, err: err.message }
    });
  }

  let jobs = [];
  if (job) jobs.push(job);
  if (tunnelsJobs.length) {
    jobs = jobs.concat(tunnelsJobs);
  }
  return jobs;
};

/**
 * Reconstructs tunnels that were removed before
 * sending a modify-device message to a device.
 * @param  {Array}   removedTunnels an array of ids of the removed tunnels
 * @param  {string}  username       name of the user that requested the device change
 * @param  {boolean} sendRemoveJobs indicate if need to send remove tunnels first
 * @return {Array}                  array of add-tunnel jobs
 */
const reconstructTunnels = async (tunnelsIds, username, sendRemoveJobs = false) => {
  let jobs = [];
  let org = null;
  try {
    const tunnels = await tunnelsModel
      .find({
        _id: { $in: tunnelsIds },
        isActive: true,
        isPending: { $ne: true }
      })
      .populate('deviceA')
      .populate('deviceB')
      .populate('peer');

    for (const tunnel of tunnels) {
      org = tunnel.org;

      let tasksDeviceA = [];
      let tasksDeviceB = [];

      const { deviceA, deviceB, pathlabel, peer, mtu, mssClamp, ospfCost } = tunnel;
      const ifcA = deviceA.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceA.toString();
      });

      const ifcB = peer ? null : deviceB.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceB.toString();
      });

      // IMPORTANT: If the tunnels was removed via modify-device process,
      // the order of jobs is: remove-tunnels, modify-router, add-tunnels.
      // But if tunnels needs to be recreated without a modify device job,
      // we can send remove and add tunnels jobs in one aggregated request.
      if (sendRemoveJobs) {
        await setTunnelsPendingInDB([tunnel._id], org, true);
        const [removeTasksA, removeTasksB] = prepareTunnelRemoveJob(tunnel, ifcA, ifcB, peer);
        tasksDeviceA = tasksDeviceA.concat(removeTasksA);
        tasksDeviceB = tasksDeviceB.concat(removeTasksB);
      }

      const [addTasksA, addTasksB] = await prepareTunnelAddJob(
        tunnel,
        ifcA,
        ifcB,
        pathlabel,
        deviceA,
        deviceB,
        { mtu, mssClamp, ospfCost },
        peer
      );
      tasksDeviceA = tasksDeviceA.concat(addTasksA);
      tasksDeviceB = tasksDeviceB.concat(addTasksB);

      let title = '';
      const actionType = sendRemoveJobs ? 'Reconstruct' : 'Add';
      if (peer) {
        // eslint-disable-next-line max-len
        title = `${actionType} peer tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${peer.name})`;
      } else {
        // eslint-disable-next-line max-len
        title = `${actionType} tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`;
      };

      // if sendRemoveJobs is true, we need to send aggregated request with pair
      // of remove-tunnel and add-tunnel
      [tasksDeviceA, tasksDeviceB] = [tasksDeviceA, tasksDeviceB].map(tasks => {
        if (tasks.length > 1) {
          return [{
            entity: 'agent',
            message: 'aggregated',
            params: { requests: tasks }
          }];
        }
        return tasks;
      });

      const tunnelJobs = await queueTunnel(
        true,
        // eslint-disable-next-line max-len
        title,
        tasksDeviceA,
        tasksDeviceB,
        username,
        tunnel.org,
        deviceA.machineId,
        peer ? null : deviceB.machineId,
        deviceA._id,
        peer ? null : deviceB._id,
        tunnel.num,
        pathlabel,
        peer
      );
      jobs = jobs.concat(tunnelJobs);
    }
  } catch (err) {
    logger.error('Failed to queue Add tunnel jobs', {
      params: { err: err.message, tunnelsIds }
    });
  };
  try {
    await setTunnelsPendingInDB(tunnelsIds, org, false);
  } catch (err) {
    logger.error('Failed to set tunnel pending flag in db', {
      params: { err: err.message, tunnelsIds }
    });
  }
  return jobs;
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
  // Handle changes in default route
  const routes = [];

  // Handle changes in static routes
  // Extract only relevant fields from static routes database entries
  const [newStaticRoutes, origStaticRoutes] = [

    newDevice.staticroutes.filter(r => !r.isPending).map(route => {
      return ({
        destination: route.destination,
        gateway: route.gateway,
        ifname: route.ifname,
        metric: route.metric,
        redistributeViaOSPF: route.redistributeViaOSPF
      });
    }),

    origDevice.staticroutes.filter(r => !r.isPending).map(route => {
      return ({
        destination: route.destination,
        gateway: route.gateway,
        ifname: route.ifname,
        metric: route.metric,
        redistributeViaOSPF: route.redistributeViaOSPF
      });
    })
  ];

  // Compare new and original static routes arrays.
  // Add all static routes that do not exist in the
  // original routes array and remove all static routes
  // that do not appear in the new routes array
  const [routesToAdd, routesToRemove] = [
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

  routesToRemove.forEach(route => {
    routes.push({
      addr: route.destination,
      old_route: route.gateway,
      new_route: '',
      devId: route.ifname || undefined,
      metric: route.metric || undefined,
      redistributeViaOSPF: route.redistributeViaOSPF
    });
  });
  routesToAdd.forEach(route => {
    routes.push({
      addr: route.destination,
      new_route: route.gateway,
      old_route: '',
      devId: route.ifname || undefined,
      metric: route.metric || undefined,
      redistributeViaOSPF: route.redistributeViaOSPF
    });
  });

  return { routes: routes };
};

/**
 * Creates a modify-ospf object
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing an array of routes
 */
const transformOSPF = (ospf) => {
  // Extract only global fields from ospf
  // The rest fields are per interface and sent to device via add/modify-interface jobs
  const globalFields = ['routerId'];
  return pick(ospf, globalFields);
};

/**
 * Creates add/remove-ospf jobs
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing add and remove ospf parameters
 */
const prepareModifyOSPF = (origDevice, newDevice) => {
  const [origOSPF, newOSPF] = [
    transformOSPF(origDevice.ospf),
    transformOSPF(newDevice.ospf)
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
 * Creates a modify-dhcp object
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing an array of routes
 */
const prepareModifyDHCP = (origDevice, newDevice) => {
  // Extract only relevant fields from dhcp database entries
  const [newDHCP, origDHCP] = [
    newDevice.dhcp.filter(d => !d.isPending).map(dhcp => {
      const intf = dhcp.interface;
      return ({
        interface: intf,
        range_start: dhcp.rangeStart,
        range_end: dhcp.rangeEnd,
        dns: dhcp.dns,
        mac_assign: dhcp.macAssign.map(mac => {
          return pick(mac, [
            'host', 'mac', 'ipv4'
          ]);
        })
      });
    }),

    origDevice.dhcp.filter(d => !d.isPending).map(dhcp => {
      const intf = dhcp.interface;
      return ({
        interface: intf,
        range_start: dhcp.rangeStart,
        range_end: dhcp.rangeEnd,
        dns: dhcp.dns,
        mac_assign: dhcp.macAssign.map(mac => {
          return pick(mac, [
            'host', 'mac', 'ipv4'
          ]);
        })
      });
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
  const org = data.org;
  const modifyParams = {};

  device[0] = await device[0]
    .populate('interfaces.pathlabels', '_id name type')
    .populate({
      path: 'applications.app',
      populate: {
        path: 'appStoreApp'
      }
    }).execPopulate();

  data.newDevice = await data.newDevice
    .populate('interfaces.pathlabels', '_id name type')
    .populate('policies.firewall.policy', '_id name rules')
    .execPopulate();

  // Create the default/static routes modification parameters
  const modifyRoutes = prepareModifyRoutes(device[0], data.newDevice);
  if (modifyRoutes.routes.length > 0) modifyParams.modify_routes = modifyRoutes;

  // Create DHCP modification parameters
  const modifyDHCP = prepareModifyDHCP(device[0], data.newDevice);
  if (modifyDHCP.dhcpRemove.length > 0 ||
      modifyDHCP.dhcpAdd.length > 0) {
    modifyParams.modify_dhcp_config = modifyDHCP;
  }

  // Create OSPF modification parameters
  const { remove: removeOSPF, add: addOSPF } = prepareModifyOSPF(device[0], data.newDevice);
  if (removeOSPF || addOSPF) {
    modifyParams.modify_ospf = { remove: removeOSPF, add: addOSPF };
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
  const [origInterfaces, origIsAssigned] = [
    // add global ospf settings to each interface
    transformInterfaces(device[0].interfaces, device[0].ospf),
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        devId: ifc.devId,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  const [newInterfaces, newIsAssigned] = [
    // add global ospf settings to each interface
    transformInterfaces(data.newDevice.interfaces, data.newDevice.ospf),
    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        devId: ifc.devId,
        isAssigned: ifc.isAssigned
      });
    })
  ];
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
  const oldLteInterfaces = device[0].interfaces.filter(item => item.deviceType === 'lte');
  const newLteInterfaces = data.newDevice.interfaces.filter(item => item.deviceType === 'lte');
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

  if (assignedInterfacesDiff.length > 0 || lteInterfacesDiff.length > 0) {
    modifyParams.modify_interfaces = {};
    modifyParams.modify_interfaces.interfaces = assignedInterfacesDiff;
    modifyParams.modify_interfaces.lte_enable_disable = lteInterfacesDiff;
  }

  const origDevice = device[0];
  const updDevice = data.newDevice;
  const updRules = updDevice.firewall.rules.toObject();
  const origRules = origDevice.firewall.rules.toObject();
  const rulesModified =
    origDevice.deviceSpecificRulesEnabled !== updDevice.deviceSpecificRulesEnabled ||
    !(updRules.length === origRules.length && updRules.every((updatedRule, index) =>
      isEqual(
        omit(updatedRule, ['_id', 'name', 'classification']),
        omit(origRules[index], ['_id', 'name', 'classification'])
      ) &&
      isEqual(
        omit(updatedRule.classification.source, ['_id']),
        omit(origRules[index].classification.source, ['_id'])
      ) &&
      isEqual(
        omit(updatedRule.classification.destination, ['_id']),
        omit(origRules[index].classification.destination, ['_id'])
      )
    ));

  if (rulesModified) {
    modifyParams.modify_firewall = await getDevicesFirewallJobInfo(updDevice.toObject());
  }

  const modified =
      has(modifyParams, 'modify_routes') ||
      has(modifyParams, 'modify_router') ||
      has(modifyParams, 'modify_interfaces') ||
      has(modifyParams, 'modify_ospf') ||
      has(modifyParams, 'modify_firewall') ||
      has(modifyParams, 'modify_dhcp_config');

  // Queue job only if the device has changed
  // Return empty jobs array if the device did not change
  if (!modified) {
    logger.debug('The device was not modified, nothing to apply', {
      params: { newInterfaces: JSON.stringify(newInterfaces), device: device[0]._id }
    });
    return {
      ids: [],
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
    await setJobPendingInDB(device[0]._id, org, true);
    // Queue device modification job
    const jobs = await queueModifyDeviceJob(device[0], data.newDevice, modifyParams, user, org);

    return {
      ids: jobs.flat().map(job => job.id),
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
  // Call firewallPolicy complete callback if needed
  if (res.firewallPolicy) {
    firewallPolicyComplete(jobId, res.firewallPolicy);
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
const sync = async (deviceId, org) => {
  const { interfaces, staticroutes, dhcp, ospf } = await devices.findOne(
    { _id: deviceId },
    {
      interfaces: 1,
      staticroutes: 1,
      dhcp: 1,
      ospf: 1,
      versions: 1
    }
  )
    .lean()
    // no need to populate pathLabel name here, since we need only the id's
    .populate('interfaces.pathlabels', '_id type');

  // Prepare add-interface message
  const deviceConfRequests = [];

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
  buildInterfaces(interfaces, ospf).forEach(item => {
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
        params: {
          ...lte.configuration,
          dev_id: lte.devId,
          metric: lte.metric
        }
      });
    });
  }

  // IMPORTANT: routing data should be before static routes!
  let ospfData = transformOSPF(ospf);
  // remove empty values because they are optional
  ospfData = omitBy(ospfData, val => val === '');
  if (!isEmpty(ospfData)) {
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-ospf',
      params: ospfData
    });
  }

  // Prepare add-route message
  Array.isArray(staticroutes) && staticroutes.forEach(route => {
    const { ifname, gateway, destination, metric, isPending } = route;

    // skip pending routes
    if (isPending) {
      return;
    }

    const params = {
      addr: destination,
      via: gateway,
      dev_id: ifname || undefined,
      metric: metric ? parseInt(metric, 10) : undefined,
      redistributeViaOSPF: route.redistributeViaOSPF
    };

    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-route',
      params: params
    });
  });

  // Prepare add-dhcp-config message
  Array.isArray(dhcp) && dhcp.forEach(entry => {
    const { rangeStart, rangeEnd, dns, macAssign, isPending } = entry;

    // skip pending dhcp
    if (isPending) {
      return;
    }

    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-dhcp-config',
      params: {
        interface: entry.interface,
        range_start: rangeStart,
        range_end: rangeEnd,
        dns: dns,
        mac_assign: macAssign
      }
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

  // Call firewallPolicy error callback if needed
  if (res && res.firewallPolicy) {
    firewallPolicyError(jobId, res.firewallPolicy);
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
    // Call firewallPolicy remove callback if needed
    const { firewallPolicy } = job.data.response.data;
    if (firewallPolicy) {
      job.data.response.data = firewallPolicy;
      firewallPolicyRemove(job);
    }
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  completeSync: completeSync,
  sync: sync,
  reconstructTunnels,
  error: error,
  remove: remove
};
