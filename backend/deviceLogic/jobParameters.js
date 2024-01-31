// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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

const pick = require('lodash/pick');

const { getMajorVersion, getMinorVersion, isVersionGreaterEquals } = require('../versioning');
const { generateTunnelParams } = require('../utils/tunnelUtils');
const tunnelsModel = require('../models/tunnels');
const configs = require('../configs')();

/**
 * Transforms mongoose array of interfaces into array of objects
 *
 * @param {*} interfaces
 * @param {*} globalOSPF device globalOspf configuration
 * @param {*} deviceVersion
 * @returns array of interfaces
 */
const transformInterfaces = (interfaces, globalOSPF, deviceVersion) => {
  const majorVersion = getMajorVersion(deviceVersion);
  const minorVersion = getMinorVersion(deviceVersion);

  return interfaces.map(ifc => {
    const ifcObg = {
      _id: ifc._id,
      devId: ifc.devId,
      parentDevId: ifc.parentDevId,
      dhcp: ifc.dhcp ? ifc.dhcp : 'no',
      addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
      addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
      PublicIP: ifc.PublicIP,
      PublicPort: ifc.PublicPort,
      useFixedPublicPort: ifc.useFixedPublicPort,
      type: ifc.type,
      isAssigned: ifc.isAssigned,
      pathlabels: ifc.pathlabels?.map(pl => pl.toObject()), // convert from CoreMongooseArray
      configuration: ifc.configuration,
      deviceType: ifc.deviceType
    };

    if (ifc.type === 'WAN') {
      ifcObg.gateway = ifc.gateway;
      ifcObg.metric = ifc.metric;
      ifcObg.useStun = ifc.useStun;
      ifcObg.monitorInternet = ifc.monitorInternet;
      ifcObg.monitorInternetServers = ifc.monitorInternetServers;
      ifcObg.monitorInternetProbeTimeout = ifc.monitorInternetProbeTimeout;
      ifcObg.dnsServers = ifc.dnsServers;
      ifcObg.dnsDomains = ifc.dnsDomains;

      // if useDhcpDnsServers is true, we set empty array to the agent
      if (ifc.dhcp === 'yes' && ifc.useDhcpDnsServers === true) {
        ifcObg.dnsServers = [];
      }

      if (majorVersion >= 6) {
        ifcObg.bandwidthMbps = ifc.bandwidthMbps;
      }
    }

    if (majorVersion > 5 || (majorVersion === 5 && minorVersion >= 3)) {
      ifcObg.routing = ifc.routing.split(/,\s*/); // send as list
    } else {
      ifcObg.routing = ifc.routing.includes('OSPF') ? 'OSPF' : 'NONE';
    }

    // add ospf data if relevant
    if (ifc.routing.includes('OSPF')) {
      ifcObg.ospf = {
        ...ifc.ospf.toObject(),
        helloInterval: globalOSPF.helloInterval,
        deadInterval: globalOSPF.deadInterval
      };
    }

    // do not send MTU for VLANs
    if (!ifc.vlanTag) {
      ifcObg.mtu = ifc.mtu;
    }
    return ifcObg;
  });
};

/**
 * Transform routing filters params
 * @param  {array} RoutingFilters routingFilters array
 * @return {array}   routingFilters array
 */
const transformRoutingFilters = (routingFilters, deviceVersion) => {
  const majorVersion = getMajorVersion(deviceVersion);
  const minorVersion = getMinorVersion(deviceVersion);
  const oldFormat = majorVersion < 6 || (majorVersion === 6 && minorVersion === 1);

  if (oldFormat) {
    return routingFilters.map(filter => {
      // old devices should have old format of job.
      // "action", "nextHop" and "priority" are not supported.
      // In this format, there is "defaultAction" for all rules,
      // except those that exists in "rules". Hence, we put all routes
      // that have the opposite action as the default.
      const defaultRoute = filter.rules.find(r => r.route === '0.0.0.0/0');
      if (!defaultRoute) throw Error('Default route is missing');

      return {
        name: filter.name,
        description: filter.description,
        defaultAction: defaultRoute.action,
        rules: filter.rules.filter(r => r.action !== defaultRoute.action).map(r => {
          return {
            network: r.route
          };
        })
      };
    });
  }

  return routingFilters.map(filter => {
    return {
      name: filter.name,
      description: filter.description,
      rules: filter.rules.map(r => {
        return {
          route: r.route,
          action: r.action,
          nextHop: r.nextHop,
          priority: r.priority,
          custom: transformCustomRouting(r?.custom)
        };
      })
    };
  });
};

/**
 * Creates a modify-ospf object
 * @param  {Object} ospf device OSPF object
 * @param  {Object} bgp  device BGP OSPF object
 * @return {Object}      an object containing the OSPF parameters
 */
const transformOSPF = (ospf, bgp) => {
  // Extract only global fields from ospf
  // The rest fields are per interface and sent to device via add/modify-interface jobs
  // const globalFields = ['routerId', 'redistributeBgp'];
  const ospfParams = {
    routerId: ospf.routerId,
    custom: transformCustomRouting(ospf?.custom)
  };

  // if bgp is disabled, send this field as false to the device.
  if (bgp.enable) {
    ospfParams.redistributeBgp = ospf.redistributeBgp;
  } else {
    ospfParams.redistributeBgp = false;
  }

  return ospfParams;
};

const transformCustomRouting = (custom) => {
  if (!custom) {
    return [];
  }

  const res = [];
  for (const cmd of custom.split('\n')) {
    const noSpaces = cmd.trim();
    if (noSpaces !== '') {
      res.push(noSpaces);
    }
  }

  return res;
};

/**
 * Creates a add|remove-routing-general object
 * @param  {Object} advancedRouting device advancedRouting object
 * @return {Object} an object containing the global FRR parameters
 */
const transformAdvancedRoutingConfig = (advancedRouting) => {
  const custom = transformCustomRouting(advancedRouting?.custom);
  return { ...(custom.length > 0 && { custom }) };
};

/**
 * Creates a add-vxlan-config object
 * @param  {Object} org organization object
 * @return {Object}      an object containing the VXLAN config parameters
 */
const transformVxlanConfig = org => {
  const vxlanConfigParams = {
    port: org.vxlanPort || configs.get('tunnelPort')
  };

  return vxlanConfigParams;
};

/**
 * Creates a modify-routing-bgp object
 * @param  {Object} device device object
 * @return {Object}        an object containing an bgp configuration
 */
const transformBGP = async (device) => {
  let { bgp, interfaces, org, _id, versions } = device;
  interfaces = interfaces.filter(i => i.isAssigned && i.routing.includes('BGP') && i.IPv4);

  const majorVersion = getMajorVersion(versions.agent);
  const minorVersion = getMinorVersion(versions.agent);
  const includeTunnelNeighbors = majorVersion === 5 && minorVersion === 3;
  const sendCommunityAndBestPath = majorVersion > 6 || (majorVersion === 6 && minorVersion >= 2);
  const sendMultiHop = majorVersion > 6 || (majorVersion === 6 && minorVersion >= 3);

  const neighbors = bgp.neighbors.map(n => {
    const neighbor = {
      ip: n.ip,
      remoteAsn: n.remoteASN,
      password: n.password || '',
      inboundFilter: n.inboundFilter || '',
      outboundFilter: n.outboundFilter || '',
      holdInterval: bgp.holdInterval,
      keepaliveInterval: bgp.keepaliveInterval,
      custom: transformCustomRouting(n?.custom)
    };

    if (sendCommunityAndBestPath) {
      neighbor.sendCommunity = n.sendCommunity;
    }

    if (sendMultiHop) {
      neighbor.multiHop = n.multiHop ? n.multiHop : 1; // 1 is the BGP default
    }

    if (sendMultiHop) {
      neighbor.multiHop = n.multiHop ? n.multiHop : 1; // 1 is the BGP default
    }

    return neighbor;
  });

  if (includeTunnelNeighbors) {
    const tunnels = await tunnelsModel.find(
      {
        $and: [
          { org },
          { $or: [{ deviceA: _id }, { deviceB: _id }] },
          { isActive: true },
          { 'advancedOptions.routing': 'bgp' },
          { peer: null }, // don't send peer neighbors
          { isPending: { $ne: true } } // skip pending tunnels
        ]
      }
    )
      .populate('deviceA', 'bgp')
      .populate('deviceB', 'bgp')
      .populate('org', 'tunnelRange')
      .lean();

    for (const tunnel of tunnels) {
      const { num, deviceA, deviceB, org } = tunnel;
      const { ip1, ip2 } = generateTunnelParams(num, org.tunnelRange);
      const isDeviceA = deviceA._id.toString() === _id.toString();

      const remoteIp = isDeviceA ? ip2 : ip1;
      const remoteAsn = isDeviceA ? deviceB.bgp.localASN : deviceA.bgp.localASN;
      const bgpConfig = isDeviceA ? deviceA.bgp : deviceB.bgp;

      neighbors.push({
        ip: remoteIp,
        remoteAsn: remoteAsn,
        password: '',
        inboundFilter: '',
        outboundFilter: '',
        holdInterval: bgpConfig.holdInterval,
        keepaliveInterval: bgpConfig.keepaliveInterval
        // no need to send community here, since it is only for 5.3 version
      });
    }
  }

  const networks = [];
  interfaces.forEach(i => {
    networks.push({
      ipv4: `${i.IPv4}/${i.IPv4Mask}`
    });
  });

  const bgpConfig = {
    routerId: bgp.routerId,
    localAsn: bgp.localASN,
    neighbors: neighbors,
    redistributeOspf: bgp.redistributeOspf,
    networks: networks,
    custom: transformCustomRouting(bgp?.custom)
  };

  if (sendCommunityAndBestPath) {
    bgpConfig.bestPathMultipathRelax = true;
  }

  return bgpConfig;
};

/**
 * Transform add-dhcp params
 * @param  {object} dhcp DHCP config
 * @param  {string} deviceId device ID
 * @param  {[object]} vrrpGroups list of vrrp group
 * @return {object} DHCP config
 */
const transformDHCP = (dhcp, deviceId, vrrpGroups = []) => {
  const { rangeStart, rangeEnd, dns, macAssign } = dhcp;
  const options = dhcp.options ?? [];

  let isRouterOptionConfigured = false;

  const res = {
    interface: dhcp.interface,
    range_start: rangeStart,
    range_end: rangeEnd,
    dns: dns,
    options: options.map(opt => {
      const fields = pick(opt, [
        'option', 'value'
      ]);
      // isc-dhcp requires this option to be a string.
      // in case of first letter is number (value can be IP address)
      // we adding and encoding the double quotes.
      if (fields.option === 'tftp-server-name' && !Number.isNaN(fields.value[0])) {
        fields.value = `\\"${fields.value}\\"`;
      } else if (fields.option === 'domain-name') {
        fields.value = `\\"${fields.value}\\"`;
      }

      if (fields.option === 'routers') {
        isRouterOptionConfigured = true;
      }
      return fields;
    }),
    mac_assign: macAssign.map(mac => {
      return pick(mac, [
        'host', 'mac', 'ipv4', 'useHostNameAsDhcpOption'
      ]);
    })
  };

  if (dhcp?.defaultLeaseTime) {
    res.defaultLeaseTime = dhcp.defaultLeaseTime;
  }

  if (dhcp?.maxLeaseTime) {
    res.maxLeaseTime = dhcp.maxLeaseTime;
  }

  if (!isRouterOptionConfigured) {
    const routers = new Set();
    for (const vrrpGroup of vrrpGroups ?? []) {
      for (const dev of vrrpGroup.devices) {
        if (dev.device._id.toString() !== deviceId.toString()) {
          continue;
        }

        if (dev.interface !== dhcp.interface) {
          continue;
        }

        routers.add(vrrpGroup.virtualIp);
      }
    }

    if (routers.size > 0) {
      res.options.push({ option: 'routers', value: Array.from(routers).join(',') });
    }
  }

  return res;
};

const transformLte = (ifc, agentVersion) => {
  const isSupportsDualSim = isVersionGreaterEquals(agentVersion, '6.4.0');

  const params = {
    metric: ifc.metric,
    dev_id: ifc.devId
  };

  if (isSupportsDualSim) {
    params.primarySlot = ifc.configuration.primarySlot;
    params.automaticSwitchover = ifc.configuration.automaticSwitchover;
    params.tryPrimaryAfter = ifc.configuration.tryPrimaryAfter;
    params.slots = {};
  } else {
    params.enable = ifc.configuration.enable;
  }

  for (const slot in ifc.configuration.slots) {
    if (!ifc.configuration.slots[slot].enable) {
      continue;
    }

    if (isSupportsDualSim) {
      params.slots[slot] = {
        apn: ifc.configuration.slots[slot].apn,
        pin: ifc.configuration.slots[slot].pin,
        auth: ifc.configuration.slots[slot].auth,
        user: ifc.configuration.slots[slot].authUser,
        password: ifc.configuration.slots[slot].authPassword
      };
    } else {
      params.apn = ifc.configuration.slots[slot].apn;
      params.pin = ifc.configuration.slots[slot].pin;
      params.auth = ifc.configuration.slots[slot].auth;
      params.user = ifc.configuration.slots[slot].authUser;
      params.password = ifc.configuration.slots[slot].authPassword;
    }
  }

  return params;
};

const transformVrrp = (device, vrrpGroup) => {
  const params = {
    virtualRouterId: vrrpGroup.virtualRouterId,
    virtualIp: vrrpGroup.virtualIp,
    preemption: vrrpGroup.preemption,
    acceptMode: vrrpGroup.acceptMode
  };

  params.priority = device.priority;

  // use it as objects and not strings of devId only since we
  // may want to add "priority" field in the future.
  params.trackInterfaces = [
    ...(device.trackInterfacesOptional ?? []).map(t => {
      return { devId: t, isMandatory: false };
    }),
    ...(device.trackInterfacesMandatory ?? []).map(t => {
      return { devId: t, isMandatory: true };
    })
  ];
  params.devId = device.interface;

  return params;
};

/**
 * Transform relevant event types from the "rules" field in the notificationsConf collection
 * @param  {object} notificationsSettings the notifications configuration
 * @param  {Set} relevantEventTypes the relevant event types (event names).
 * @return {object} An object of the filtered notifications settings
 */
const transformNotificationsSettings = (notificationsSettings, relevantEventTypes) => {
  const notificationsObject = Object.keys(notificationsSettings).reduce((obj, eventName) => {
    if (relevantEventTypes.has(eventName)) {
      obj[eventName] = notificationsSettings[eventName];
    }
    return obj;
  }, {});
  return notificationsObject;
};

const transformStaticRoute = (route) => {
  const params = {
    addr: route.destination,
    via: route.gateway,
    dev_id: route.ifname || undefined,
    metric: route.metric ? parseInt(route.metric, 10) : undefined,
    redistributeViaOSPF: route.redistributeViaOSPF,
    redistributeViaBGP: route.redistributeViaBGP,
    onLink: route.onLink
  };

  if (route?.conditions?.length > 0) {
    params.condition = {
      addr: route.conditions[0].destination,
      type: route.conditions[0].type,
      via: {}
    };

    const { devId, tunnelId } = route.conditions[0].via;
    if (devId) {
      params.condition.via.dev_id = devId;
    } else if (tunnelId) {
      params.condition.via['tunnel-id'] = tunnelId;
    }
  }

  return params;
};

module.exports = {
  transformInterfaces,
  transformRoutingFilters,
  transformOSPF,
  transformBGP,
  transformDHCP,
  transformVxlanConfig,
  transformLte,
  transformVrrp,
  transformNotificationsSettings,
  transformAdvancedRoutingConfig,
  transformStaticRoute
};
