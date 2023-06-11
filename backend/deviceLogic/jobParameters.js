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

const { getMajorVersion, getMinorVersion } = require('../versioning');
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
      pathlabels: ifc.pathlabels,
      configuration: ifc.configuration,
      deviceType: ifc.deviceType
    };

    if (ifc.type === 'WAN') {
      ifcObg.gateway = ifc.gateway;
      ifcObg.metric = ifc.metric;
      ifcObg.useStun = ifc.useStun;
      ifcObg.monitorInternet = ifc.monitorInternet;
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
          priority: r.priority
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
    routerId: ospf.routerId
  };

  // if bgp is disabled, send this field as false to the device.
  if (bgp.enable) {
    ospfParams.redistributeBgp = ospf.redistributeBgp;
  } else {
    ospfParams.redistributeBgp = false;
  }

  return ospfParams;
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
  interfaces = interfaces.filter(i => i.isAssigned);

  const majorVersion = getMajorVersion(versions.agent);
  const minorVersion = getMinorVersion(versions.agent);
  const includeTunnelNeighbors = majorVersion === 5 && minorVersion === 3;
  const sendCommunityAndBestPath = majorVersion > 6 || (majorVersion === 6 && minorVersion >= 2);

  const neighbors = bgp.neighbors.map(n => {
    const neighbor = {
      ip: n.ip,
      remoteAsn: n.remoteASN,
      password: n.password || '',
      inboundFilter: n.inboundFilter || '',
      outboundFilter: n.outboundFilter || '',
      holdInterval: bgp.holdInterval,
      keepaliveInterval: bgp.keepaliveInterval
    };

    if (sendCommunityAndBestPath) {
      neighbor.sendCommunity = n.sendCommunity;
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
      .lean();

    for (const tunnel of tunnels) {
      const { num, deviceA, deviceB } = tunnel;
      const { ip1, ip2 } = generateTunnelParams(num);
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
  interfaces.filter(i => i.routing.includes('BGP')).forEach(i => {
    networks.push({
      ipv4: `${i.IPv4}/${i.IPv4Mask}`
    });
  });

  const bgpConfig = {
    routerId: bgp.routerId,
    localAsn: bgp.localASN,
    neighbors: neighbors,
    redistributeOspf: bgp.redistributeOspf,
    networks: networks
  };

  if (sendCommunityAndBestPath) {
    bgpConfig.bestPathMultipathRelax = true;
  }

  return bgpConfig;
};

/**
 * Transform add-dhcp params
 * @param  {object} dhcp DHCP config
 * @return {object} DHCP config
 */
const transformDHCP = dhcp => {
  const { rangeStart, rangeEnd, dns, macAssign } = dhcp;
  return {
    interface: dhcp.interface,
    range_start: rangeStart,
    range_end: rangeEnd,
    dns: dns,
    mac_assign: macAssign.map(mac => {
      return pick(mac, [
        'host', 'mac', 'ipv4'
      ]);
    })
  };
};

const transformLte = lteInterface => {
  return {
    ...lteInterface.configuration,
    dev_id: lteInterface.devId,
    metric: lteInterface.metric
  };
};

module.exports = {
  transformInterfaces,
  transformRoutingFilters,
  transformOSPF,
  transformBGP,
  transformDHCP,
  transformVxlanConfig,
  transformLte
};
