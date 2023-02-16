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
      type: ifc.type,
      isAssigned: ifc.isAssigned,
      pathlabels: ifc.pathlabels,
      configuration: ifc.configuration,
      deviceType: ifc.deviceType,
      dnsServers: ifc.dnsServers,
      dnsDomains: ifc.dnsDomains,
      useDhcpDnsServers: ifc.useDhcpDnsServers
    };

    if (majorVersion >= 6) {
      ifcObg.bandwidthMbps = ifc.bandwidthMbps;
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
    return ifcObg;
  });
};

/**
 * Transform routing filters params
 * @param  {array} RoutingFilters routingFilters array
 * @return {array}   routingFilters array
 */
const transformRoutingFilters = (routingFilters) => {
  return routingFilters.map(filter => {
    return {
      name: filter.name,
      description: filter.description,
      defaultAction: filter.defaultAction,
      rules: filter.rules.map(r => {
        return {
          network: r.network
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
 * Creates a modify-routing-bgp object
 * @param  {Object} bgp bgp configuration
 * @param  {Object} interfaces  assigned interfaces of device
 * @return {Object}            an object containing an array of routes
 */
const transformBGP = async (device, includeTunnelNeighbors = false) => {
  let { bgp, interfaces, org, _id } = device;
  interfaces = interfaces.filter(i => i.isAssigned);

  const neighbors = bgp.neighbors.map(n => {
    return {
      ip: n.ip,
      remoteAsn: n.remoteASN,
      password: n.password || '',
      inboundFilter: n.inboundFilter || '',
      outboundFilter: n.outboundFilter || '',
      holdInterval: bgp.holdInterval,
      keepaliveInterval: bgp.keepaliveInterval
    };
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
      });
    }
  }

  const networks = [];
  interfaces.filter(i => i.routing.includes('BGP')).forEach(i => {
    networks.push({
      ipv4: `${i.IPv4}/${i.IPv4Mask}`
    });
  });

  return {
    routerId: bgp.routerId,
    localAsn: bgp.localASN,
    neighbors: neighbors,
    redistributeOspf: bgp.redistributeOspf,
    networks: networks
  };
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

module.exports = {
  transformInterfaces,
  transformRoutingFilters,
  transformOSPF,
  transformBGP,
  transformDHCP
};
