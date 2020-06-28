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
  queueTunnel,
  oneTunnelDel
} = require('../deviceLogic/tunnels');
const { validateModifyDeviceMsg } = require('./validators');
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const { isIPv4Address } = require('./validators');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const has = require('lodash/has');
const omit = require('lodash/omit');
const differenceWith = require('lodash/differenceWith');
const pullAllWith = require('lodash/pullAllWith');
const isEqual = require('lodash/isEqual');
const pick = require('lodash/pick');
/**
 * Remove fields that should not be sent to the device from the interfaces array.
 * @param  {Array} interfaces an array of interfaces that will be sent to the device
 * @return {Array}            the same array after removing unnecessary fields
 */
const prepareIfcParams = (interfaces) => {
  return interfaces.map(ifc => {
    const newIfc = omit(ifc, ['_id', 'PublicIP', 'isAssigned', 'pathlabels']);

    // Device should only be aware of DIA labels.
    const labels = [];
    ifc.pathlabels.forEach(label => {
      if (label.type === 'DIA') labels.push(label._id);
    });
    newIfc.multilink = { labels };

    // Don't send interface default GW for LAN interfaces
    if (newIfc.type !== 'WAN') delete newIfc.gateway;

    return newIfc;
  });
};
/**
 * Queues a modify-device job to the device queue.
 * @param  {string}  org                   the organization to which the user belongs
 * @param  {string}  user                  the user that requested the job
 * @param  {Array}   tasks                 the message to be sent to the device
 * @param  {Object}  device                the device to which the job should be queued
 * @param  {Array}   removedTunnelsList=[] tunnels that have been removed as part of
 *                                         the device modification
 * @return {Promise}                       a promise for queuing a job
 */
const queueJob = async (org, user, tasks, device, removedTunnelsList = []) => {
  const job = await deviceQueues.addJob(
    device.machineId, user, org,
    // Data
    { title: `Modify device ${device.hostname}`, tasks: tasks },
    // Response data
    {
      method: 'modify',
      data: {
        device: device._id,
        org: org,
        user: user,
        origDevice: device,
        tunnels: removedTunnelsList
      }
    },
    // Metadata
    { priority: 'medium', attempts: 1, removeOnComplete: false },
    // Complete callback
    null
  );

  logger.info('Modify device job queued', { params: { job: job } });
  return job;
};
/**
 * Performs required tasks before device modification
 * can take place. It removes all tunnels connected to
 * the modified interfaces and then queues the modify device job.
 * @param  {Object}  device        original device object, before the changes
 * @param  {Object}  messageParams device changes that will be sent to the device
 * @param  {string}  user          the user that created the request
 * @param  {string}  org           organization to which the user belongs
 * @return {Job}                   The queued modify-device job
 */
const queueModifyDeviceJob = async (device, messageParams, user, org) => {
  const removedTunnels = [];
  const interfacesIdsSet = new Set();
  const modifiedIfcsMap = {};
  messageParams.reconnect = false;

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
    const { interfaces } = messageParams.modify_interfaces;
    interfaces.forEach(ifc => {
      interfacesIdsSet.add(ifc._id);
      modifiedIfcsMap[ifc._id] = ifc;
    });
  }

  for (const ifc of interfacesIdsSet) {
    // First, remove all active tunnels connected
    // via this interface, on all relevant devices.
    const tunnels = await tunnelsModel
      .find({
        isActive: true,
        $or: [{ interfaceA: ifc._id }, { interfaceB: ifc._id }]
      })
      .populate('deviceA')
      .populate('deviceB');

    for (const tunnel of tunnels) {
      let { deviceA, deviceB, pathlabel, num, _id } = tunnel;

      // Since the interface changes have already been updated in the database
      // we have to use the original device for creating the tunnel-remove message.
      if (deviceA._id.toString() === device._id.toString()) deviceA = device;
      else deviceB = device;

      const ifcA = deviceA.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceA.toString();
      });
      const ifcB = deviceB.interfaces.find(ifc => {
        return ifc._id.toString() === tunnel.interfaceB.toString();
      });

      // For interface changes such as IP/mask we remove the tunnel
      // and readd it after the change has been applied on the device.
      // In such cases, we don't remove the tunnel from the database,
      // but rather only queue remove/add tunnel jobs to the devices.
      // For interfaces that are unassigned, or which path labels have
      // been removed, we remove the tunnel from both the devices and the MGMT
      const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(tunnel.num, ifcA, ifcB);
      const pathlabels = modifiedIfcsMap[ifc._id]
        ? modifiedIfcsMap[ifc._id].pathlabels.map(label => label._id.toString())
        : [];
      const pathLabelRemoved = pathlabel && !pathlabels.includes(pathlabel.toString());

      if (!(ifc._id in modifiedIfcsMap) || pathLabelRemoved) {
        await oneTunnelDel(_id, user, org);
      } else {
        await queueTunnel(
          false,
          // eslint-disable-next-line max-len
          `Delete tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
          tasksDeviceA,
          tasksDeviceB,
          user,
          org,
          deviceA.machineId,
          deviceB.machineId,
          deviceA._id,
          deviceB._id,
          num,
          pathlabel
        );
        removedTunnels.push(tunnel._id);
      }
    }
  }
  // Prepare and queue device modification job
  const modificationMessage = {};
  if (has(messageParams, 'modify_routes')) {
    modificationMessage.modify_routes = messageParams.modify_routes;
  }
  if (has(messageParams, 'modify_router.assign')) {
    modificationMessage.modify_router = {};
    modificationMessage.modify_router.assign = prepareIfcParams(
      messageParams.modify_router.assign
    );
    modificationMessage.reconnect = true;
  }
  if (has(messageParams, 'modify_router.unassign')) {
    if (!modificationMessage.modify_router) {
      modificationMessage.modify_router = {};
    }
    modificationMessage.modify_router.unassign = prepareIfcParams(
      messageParams.modify_router.unassign
    );
    modificationMessage.reconnect = true;
  }
  if (has(messageParams, 'modify_interfaces')) {
    modificationMessage.modify_interfaces = {};
    modificationMessage.modify_interfaces.interfaces = prepareIfcParams(
      messageParams.modify_interfaces.interfaces
    );
    modificationMessage.reconnect = true;
  }

  const tasks = [[]];
  if (Object.keys(modificationMessage).length !== 0) {
    tasks[0].push(
      {
        entity: 'agent',
        message: 'modify-device',
        params: modificationMessage
      }
    );
  }

  if (has(messageParams, 'modify_dhcp_config')) {
    const { dhcpRemove, dhcpAdd } = messageParams.modify_dhcp_config;

    if (dhcpRemove.length !== 0) {
      tasks[0].push({
        entity: 'agent',
        message: 'remove-dhcp-config',
        params: dhcpRemove
      });
    }

    if (dhcpAdd.length !== 0) {
      tasks[0].push({
        entity: 'agent',
        message: 'add-dhcp-config',
        params: dhcpAdd
      });
    }
  }

  const job = await queueJob(org, user, tasks, device, removedTunnels);
  return [job];
};

/**
 * Reconstructs tunnels that were removed before
 * sending a modify-device message to a device.
 * @param  {Array}   removedTunnels an array of ids of the removed tunnels
 * @param  {string}  org            the organization to which the tunnels belong
 * @param  {string}  user           the user that requested the device change
 * @return {Promise}                a promise for reconstructing tunnels
 */
const reconstructTunnels = async (removedTunnels, org, user) => {
  const tunnels = await tunnelsModel
    .find({ _id: { $in: removedTunnels }, isActive: true })
    .populate('deviceA')
    .populate('deviceB');

  for (const tunnel of tunnels) {
    const { deviceA, deviceB, pathlabel } = tunnel;
    const ifcA = deviceA.interfaces.find(ifc => {
      return ifc._id.toString() === tunnel.interfaceA.toString();
    });
    const ifcB = deviceB.interfaces.find(ifc => {
      return ifc._id.toString() === tunnel.interfaceB.toString();
    });

    const { agent } = deviceB.versions;
    const [tasksDeviceA, tasksDeviceB] = await prepareTunnelAddJob(
      tunnel.num,
      ifcA,
      ifcB,
      agent,
      pathlabel
    );
    await queueTunnel(
      true,
      // eslint-disable-next-line max-len
      `Add tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
      tasksDeviceA,
      tasksDeviceB,
      user,
      org,
      deviceA.machineId,
      deviceB.machineId,
      deviceA._id,
      deviceB._id,
      tunnel.num,
      pathlabel
    );
  }
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
  if (origDevice.defaultRoute !== newDevice.defaultRoute) {
    routes.push({
      addr: 'default',
      old_route: origDevice.defaultRoute,
      new_route: newDevice.defaultRoute
    });
  }

  // Handle changes in static routes
  // Extract only relevant fields from static routes database entries
  const [newStaticRoutes, origStaticRoutes] = [
    newDevice.staticroutes.map(route => {
      return ({
        destination: route.destination,
        gateway: route.gateway,
        ifname: route.ifname,
        metric: route.metric
      });
    }),

    origDevice.staticroutes.map(route => {
      return ({
        destination: route.destination,
        gateway: route.gateway,
        ifname: route.ifname,
        metric: route.metric
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
      pci: route.ifname ? route.ifname : undefined,
      metric: route.metric
    });
  });
  routesToAdd.forEach(route => {
    routes.push({
      addr: route.destination,
      new_route: route.gateway,
      old_route: '',
      pci: route.ifname ? route.ifname : undefined,
      metric: route.metric
    });
  });

  return { routes: routes };
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
    newDevice.dhcp.map(dhcp => {
      return ({
        interface: dhcp.interface,
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

    origDevice.dhcp.map(dhcp => {
      return ({
        interface: dhcp.interface,
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
 * Validate if any dhcp is assigned on a modified interface
 * @param {Object} device - original device
 * @param {List} modifiedInterfaces - list of modified interfaces
 */
const validateDhcpConfig = (device, modifiedInterfaces) => {
  const assignedDhcps = device.dhcp.map(d => d.interface);
  const modifiedDhcp = modifiedInterfaces.filter(i => assignedDhcps.includes(i.pci));
  if (modifiedDhcp.length > 0) {
    // get first interface from device
    const firstIf = device.interfaces.filter(i => i.pciaddr === modifiedDhcp[0].pci);
    const result = {
      valid: false,
      err: `DHCP defined on interface ${
        firstIf[0].name
      }, please remove it before modifying this interface`
    };
    return result;
  }
  return { valid: true, err: '' };
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
  const userName = user.username;
  const org = user.defaultOrg._id.toString();
  const modifyParams = {};

  // Create the default/static routes modification parameters
  const modifyRoutes = prepareModifyRoutes(device[0], data.newDevice);
  if (modifyRoutes.routes.length > 0) modifyParams.modify_routes = modifyRoutes;

  // Create DHCP modification parameters
  const modifyDHCP = prepareModifyDHCP(device[0], data.newDevice);
  if (modifyDHCP.dhcpRemove.length > 0 ||
      modifyDHCP.dhcpAdd.length > 0) {
    modifyParams.modify_dhcp_config = modifyDHCP;
  }

  // Create interfaces modification parameters
  // Compare the array of interfaces, and return
  // an array of the interfaces that have changed
  // First, extract only the relevant interface fields
  const [origInterfaces, origIsAssigned] = [
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
        addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
        PublicIP: ifc.PublicIP,
        gateway: ifc.gateway,
        routing: ifc.routing,
        type: ifc.type,
        isAssigned: ifc.isAssigned,
        pathlabels: ifc.pathlabels
      });
    }),
    device[0].interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        isAssigned: ifc.isAssigned
      });
    })
  ];

  const [newInterfaces, newIsAssigned] = [
    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
        addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
        addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
        PublicIP: ifc.PublicIP,
        gateway: ifc.gateway,
        routing: ifc.routing,
        type: ifc.type,
        isAssigned: ifc.isAssigned,
        pathlabels: ifc.pathlabels
      });
    }),

    data.newDevice.interfaces.map(ifc => {
      return ({
        _id: ifc._id,
        pci: ifc.pciaddr,
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
    modifyParams.modify_router = {};
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

  // Handle changes in interface fields other than 'isAssigned'
  let interfacesDiff = differenceWith(
    newInterfaces,
    origInterfaces,
    (origIfc, newIfc) => {
      return isEqual(origIfc, newIfc);
    }
  );

  // Changes made to unassigned interfaces should be
  // stored in the MGMT, but should not reach the device.
  interfacesDiff = interfacesDiff.filter(ifc => {
    return ifc.isAssigned === true;
  });
  if (interfacesDiff.length > 0) {
    modifyParams.modify_interfaces = {};
    modifyParams.modify_interfaces.interfaces = interfacesDiff;
  }

  const shouldQueueJob =
      has(modifyParams, 'modify_routes') ||
      has(modifyParams, 'modify_router') ||
      has(modifyParams, 'modify_interfaces') ||
      has(modifyParams, 'modify_dhcp_config');

  // Return empty jobs array if the device did not change
  if (!shouldQueueJob) {
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
    const dhcpValidation = validateDhcpConfig(device[0], [
      ...interfaces,
      ...unassign
    ]);
    if (!dhcpValidation.valid) throw (new Error(dhcpValidation.err));

    // Queue device modification job
    const jobs = await queueModifyDeviceJob(device[0], modifyParams, userName, org);

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
  logger.info('Device modification complete', { params: { result: res, jobId: jobId } });
  try {
    await reconstructTunnels(res.tunnels, res.org, res.user);
  } catch (err) {
    logger.error('Tunnel reconstruction failed', {
      params: { jobId: jobId, res: res, err: err.message }
    });
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
 * @return Array
 */
const sync = async (deviceId, org) => {
  const { interfaces, staticroutes, dhcp } = await devices.findOne(
    { _id: deviceId },
    {
      interfaces: 1,
      staticroutes: 1,
      dhcp: 1
    }
  )
    .lean()
    .populate('interfaces.pathlabels', '_id type');

  // Prepare add-interface message
  const deviceConfRequests = [];
  for (const ifc of interfaces) {
    // Skip unassigned/un-typed interfaces, as they
    // cannot be part of the device configuration
    if (!ifc.isAssigned || ifc.type.toLowerCase() === 'none') continue;

    const {
      pciaddr,
      IPv4,
      IPv6,
      IPv4Mask,
      IPv6Mask,
      routing,
      type,
      pathlabels,
      gateway
    } = ifc;
    // Non-DIA interfaces should not be
    // sent to the device
    const labels = pathlabels.filter(
      (label) => label.type === 'DIA'
    );
    // Skip interfaces with invalid IPv4 addresses.
    // Currently we allow empty IPv6 address
    if (!isIPv4Address(IPv4, IPv4Mask)) continue;

    const ifcInfo = {
      pci: pciaddr,
      addr: `${IPv4}/${IPv4Mask}`,
      addr6: `${(IPv6 && IPv6Mask ? `${IPv6}/${IPv6Mask}` : '')}`,
      routing,
      type,
      multilink: { labels: labels.map((label) => label._id.toString()) }
    };
    if (ifc.type === 'WAN') ifcInfo.gateway = gateway;

    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-interface',
      params: ifcInfo
    });
  }

  // Prepare add-route message
  staticroutes.forEach(route => {
    const { ifname, gateway, destination, metric } = route;
    deviceConfRequests.push({
      entity: 'agent',
      message: 'add-route',
      params: {
        addr: destination,
        via: gateway,
        pci: ifname,
        metric
      }
    });
  });

  // Prepare add-dhcp-config message
  dhcp.forEach(entry => {
    const { rangeStart, rangeEnd, dns, macAssign } = entry;

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

module.exports = {
  apply: apply,
  complete: complete,
  completeSync: completeSync,
  sync: sync
};
