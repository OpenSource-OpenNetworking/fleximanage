// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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

const net = require('net');
const cidr = require('cidr-tools');
const { generateTunnelParams } = require('../utils/tunnelUtils');
const maxMetric = 2 * 10 ** 9;
/**
 * Checks whether a value is empty
 * @param  {string}  val the value to be checked
 * @return {boolean}     true if the value is empty, false otherwise
 */
const isEmpty = (val) => { return val === null || val === undefined || val === ''; };

/**
 * Checks whether a value is a valid IPv4 network mask
 * @param  {string}  mask the mask to be checked
 * @return {boolean}      true if mask is valid, false otherwise
 */
const validateIPv4Mask = mask => {
  return (
    !isEmpty(mask) &&
        mask.length < 3 &&
        !isNaN(Number(mask)) &&
        (mask >= 0 && mask <= 32)
  );
};

/**
 * Checks whether dhcp server configuration is valid
 * Validate if any dhcp is assigned on a modified interface
 * @param {Object} device - the device to validate
 * @param {List} modifiedInterfaces - list of modified interfaces
 * @return {{valid: boolean, err: string}}  test result + error, if device is invalid
 */
const validateDhcpConfig = (device, modifiedInterfaces) => {
  const assignedDhcps = device.dhcp.map(d => d.interface);
  const modifiedDhcp = modifiedInterfaces.filter(i => {
    // don't validate unassigned modified interface
    if (!assignedDhcps.includes(i.devId)) {
      return false;
    }

    // validate only critical fields
    const orig = device.interfaces.find(intf => intf.devId === i.devId);
    if (i.type !== orig.type ||
      i.dhcp !== orig.dhcp ||
      i.addr !== `${orig.IPv4}/${orig.IPv4Mask}` ||
      i.gateway !== orig.gateway
    ) {
      return true;
    } else {
      return false;
    }
  });
  if (modifiedDhcp.length > 0) {
    // get first interface from device
    const firstIf = device.interfaces.filter(i => i.devId === modifiedDhcp[0].devId);
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
 * Checks whether the device configuration is valid,
 * therefore the device can be started.
 * @param {Object}  device                 the device to check
 * @param {Boolean} isRunning              is the device running
 * @param {[_id: objectId, name: string, subnet: string]} organizationLanSubnets to check overlaps
 * @return {{valid: boolean, err: string}}  test result + error, if device is invalid
 */
const validateDevice = (device, isRunning = false, organizationLanSubnets = []) => {
  // Get all assigned interface. There should be at least
  // two such interfaces - one LAN and the other WAN
  const interfaces = device.interfaces;
  if (!Array.isArray(interfaces) || interfaces.length < 2) {
    return {
      valid: false,
      err: 'There should be at least two interfaces'
    };
  }
  const assignedIfs = interfaces.filter(ifc => { return ifc.isAssigned; });
  const [wanIfcs, lanIfcs] = [
    assignedIfs.filter(ifc => { return ifc.type === 'WAN'; }),
    assignedIfs.filter(ifc => { return ifc.type === 'LAN'; })
  ];

  if (isRunning && (assignedIfs.length < 2 || (wanIfcs.length === 0 || lanIfcs.length === 0))) {
    return {
      valid: false,
      err: 'There should be at least one LAN and one WAN interfaces'
    };
  }

  if (assignedIfs.some(ifc => +ifc.metric >= maxMetric)) {
    return {
      valid: false,
      err: `Metric should be lower than ${maxMetric}`
    };
  }

  for (const ifc of assignedIfs) {
    // Assigned interfaces must be either WAN or LAN
    if (!['WAN', 'LAN'].includes(ifc.type)) {
      return {
        valid: false,
        err: `Invalid interface type for ${ifc.name}: ${ifc.type}`
      };
    }

    if (!isIPv4Address(ifc.IPv4, ifc.IPv4Mask) && ifc.dhcp !== 'yes') {
      return {
        valid: false,
        err: ifc.IPv4 && ifc.IPv4Mask
          ? `Invalid IP address for ${ifc.name}: ${ifc.IPv4}/${ifc.IPv4Mask}`
          : `Interface ${ifc.name} does not have an ${ifc.IPv4Mask === ''
                      ? 'IPv4 mask' : 'IP address'}`
      };
    }

    if (ifc.type === 'LAN') {
      // Path labels are not allowed on LAN interfaces
      if (ifc.pathlabels.length !== 0) {
        return {
          valid: false,
          err: 'Path Labels are not allowed on LAN interfaces'
        };
      }

      // LAN interfaces are not allowed to have a default GW
      if (ifc.gateway !== '') {
        return {
          valid: false,
          err: 'LAN interfaces should not be assigned a default GW'
        };
      }

      // DHCP client is not allowed on LAN interface
      if (ifc.dhcp === 'yes') {
        return {
          valid: false,
          err: 'LAN interfaces should not be set to DHCP'
        };
      }
    }

    if (ifc.type === 'WAN') {
      // OSPF is not allowed on WAN interfaces
      if (ifc.routing === 'OSPF') {
        return {
          valid: false,
          err: 'OSPF should not be configured on WAN interface'
        };
      }
      // WAN interfaces must have default GW assigned to them
      if (ifc.dhcp !== 'yes' && !net.isIPv4(ifc.gateway)) {
        return {
          valid: false,
          err: 'All WAN interfaces should be assigned a default GW'
        };
      }
    }
  }

  // Assigned interfaces must not be on the same subnet
  const assignedNotEmptyIfs = assignedIfs.filter(i => isIPv4Address(i.IPv4, i.IPv4Mask));
  for (const ifc1 of assignedNotEmptyIfs) {
    for (const ifc2 of assignedNotEmptyIfs.filter(i => i.devId !== ifc1.devId)) {
      const ifc1Subnet = `${ifc1.IPv4}/${ifc1.IPv4Mask}`;
      const ifc2Subnet = `${ifc2.IPv4}/${ifc2.IPv4Mask}`;
      if (cidr.overlap(ifc1Subnet, ifc2Subnet)) {
        return {
          valid: false,
          err: 'IP addresses of the assigned interfaces have an overlap'
        };
      }
    }
  }

  // Checks if all assigned WAN interfaces metrics are different
  const metricsArray = wanIfcs.map(i => Number(i.metric));
  const hasDuplicates = metricsArray.length !== new Set(metricsArray).size;
  if (hasDuplicates) {
    return {
      valid: false,
      err: 'Duplicated metrics are not allowed on VPP WAN interfaces'
    };
  }

  if (isRunning && organizationLanSubnets.length > 0) {
    // LAN subnet must not be overlap with other devices in this org
    for (const orgDevice of organizationLanSubnets) {
      for (const currentLanIfc of lanIfcs) {
        const orgSubnet = orgDevice.subnet;
        const currentSubnet = `${currentLanIfc.IPv4}/${currentLanIfc.IPv4Mask}`;

        // Don't check overlapping with same device
        if (orgDevice._id.toString() === device._id.toString()) {
          continue;
        };

        if (cidr.overlap(currentSubnet, orgSubnet)) {
          const msg =
          `The LAN subnet ${currentSubnet} overlaps with a LAN subnet of device ${orgDevice.name}`;

          return {
            valid: false,
            err: msg
          };
        }
      }
    }
  }

  const lteInterface = assignedIfs.find(i => i.deviceType === 'lte');
  if (lteInterface) {
    const isEnabled = lteInterface.configuration && lteInterface.configuration.enable;
    if (!isEnabled) {
      return {
        valid: false,
        err: 'LTE interface is assigned but not enabled. Please enable or unassign it'
      };
    }
  }

  const wifiInterface = assignedIfs.find(i => i.deviceType === 'wifi');
  if (wifiInterface) {
    const band2Enable = wifiInterface.configuration['2.4GHz'] &&
      wifiInterface.configuration['2.4GHz'].enable;
    const band5Enable = wifiInterface.configuration['5GHz'] &&
      wifiInterface.configuration['5GHz'].enable;

    if (band2Enable && band5Enable) {
      return {
        valid: false, err: 'Dual band at the same time is not supported. Please enable one of them'
      };
    } ;

    if (!band2Enable && !band5Enable) {
      return {
        valid: false, err: 'Wifi access point must be enabled'
      };
    } ;

    const key = band2Enable ? '2.4GHz' : '5GHz';
    const ssid = wifiInterface.configuration[key] && wifiInterface.configuration[key].ssid;
    const pass = wifiInterface.configuration[key] && wifiInterface.configuration[key].password;
    if (!ssid) return { valid: false, err: 'SSID is not configured for WIFI interface' };
    if (!pass) return { valid: false, err: 'Password is not configured for WIFI interface' };
  }

  /*
    if (!cidr.overlap(wanSubnet, defaultGwSubnet)) {
        return {
            valid: false,
            err: 'WAN and default route IP addresses are not on the same subnet'
        };
    }
    */
  return { valid: true, err: '' };
};

/**
 * Checks whether a modify-device message body
 * contains valid configurations.
 * @param  {Object} modifyDeviceMsg         modify-device message body
 * @return {{valid: boolean, err: string}}  test result + error if message is invalid
 */
const validateModifyDeviceMsg = (modifyDeviceMsg) => {
  // Support both arrays and single interface
  const msg = Array.isArray(modifyDeviceMsg) ? modifyDeviceMsg : [modifyDeviceMsg];
  for (const ifc of msg) {
    if (ifc.type === 'WAN' && ifc.dhcp === 'yes' && ifc.addr === '') {
      // allow empty IP on WAN with dhcp client
      continue;
    }

    if (ifc.deviceType === 'wifi') {
      // allow empty IP on wifi access point interface
      continue;
    }

    const [ip, mask] = (ifc.addr || '/').split('/');
    if (!isIPv4Address(ip, mask)) {
      return {
        valid: false,
        err: `Bad request: Invalid IP address ${ifc.addr}`
      };
    }
  }
  return { valid: true, err: '' };
};

const isIPv4Address = (ip, mask) => {
  if (!validateIPv4Mask(mask)) {
    return false;
  };
  if (!net.isIPv4(ip)) {
    return false;
  };
  const octets = ip.split('.');
  if (['0', '255'].includes(octets[3])) {
    return false;
  }
  return true;
};

/**
 * Checks whether static route is valid
 * @param {Object} device - the device to validate
 * @param {List} tunnels - list of tunnels nums of the device
 * @param {Object} route - the added/modified route
 * @return {{valid: boolean, err: string}}  test result + error, if device is invalid
 */
const validateStaticRoute = (device, tunnels, route) => {
  const { ifname, gateway } = route;
  const gatewaySubnet = `${gateway}/32`;
  if (ifname) {
    const ifc = device.interfaces.find(i => i.devId === ifname);
    if (ifc === undefined) {
      return {
        valid: false,
        err: `Static route interface not found '${ifname}'`
      };
    };
    if (!ifc.isAssigned) {
      return {
        valid: false,
        err: `Static routes not allowed on unassigned interfaces '${ifname}'`
      };
    }
    if (!cidr.overlap(`${ifc.IPv4}/${ifc.IPv4Mask}`, gatewaySubnet)) {
      return {
        valid: false,
        err: `Interface IP ${ifc.IPv4} and gateway ${gateway} are not on the same subnet`
      };
    }
  } else {
    let valid = device.interfaces.filter(ifc => ifc.IPv4 && ifc.IPv4Mask).some(ifc =>
      cidr.overlap(`${ifc.IPv4}/${ifc.IPv4Mask}`, gatewaySubnet)
    );
    if (!valid) {
      valid = tunnels.some(tunnel => {
        const { ip1 } = generateTunnelParams(tunnel.num);
        return cidr.overlap(`${ip1}/31`, gatewaySubnet);
      });
    }
    if (!valid) {
      return {
        valid: false,
        err: `Static route gateway ${gateway} not overlapped with any interface or tunnel`
      };
    }
  }
  return { valid: true, err: '' };
};

module.exports = {
  isIPv4Address,
  validateDevice,
  validateDhcpConfig,
  validateStaticRoute,
  validateModifyDeviceMsg: validateModifyDeviceMsg
};
