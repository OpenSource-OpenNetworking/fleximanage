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

const { isIPv4Address } = require('./validators');

/**
 * Builds collection of interfaces to be sent to device
 *
 * @param {*} deviceInterfaces interfaces stored in db
 * @returns array of interfaces
 */
const buildInterfaces = (deviceInterfaces) => {
  const interfaces = [];
  for (const ifc of deviceInterfaces) {
    // Skip unassigned/un-typed interfaces, as they
    // cannot be part of the device configuration
    if (!ifc.isAssigned || ifc.type.toLowerCase() === 'none') continue;

    const {
      pciaddr,
      IPv4,
      IPv6,
      IPv4Mask,
      IPv6Mask,
      PublicIP,
      PublicPort,
      useStun,
      internetMonitoring,
      routing,
      type,
      pathlabels,
      gateway,
      metric,
      dhcp
    } = ifc;
    // Non-DIA interfaces should not be
    // sent to the device
    const labels = pathlabels.filter(
      (label) => label.type === 'DIA'
    );
    // Skip interfaces with invalid IPv4 addresses.
    // Currently we allow empty IPv6 address
    if (dhcp !== 'yes' && !isIPv4Address(IPv4, IPv4Mask)) continue;

    const ifcInfo = {
      pci: pciaddr,
      dhcp: dhcp || 'no',
      addr: `${(IPv4 && IPv4Mask ? `${IPv4}/${IPv4Mask}` : '')}`,
      addr6: `${(IPv6 && IPv6Mask ? `${IPv6}/${IPv6Mask}` : '')}`,
      routing,
      type,
      multilink: { labels: labels.map((label) => label._id.toString()) }
    };
    if (ifc.type === 'WAN') {
      ifcInfo.gateway = gateway;
      ifcInfo.metric = metric;
      ifcInfo.PublicIP = PublicIP;
      ifcInfo.PublicPort = PublicPort;
      ifcInfo.useStun = useStun;
      ifcInfo['internet-monitoring'] = internetMonitoring;
    }
    interfaces.push(ifcInfo);
  }

  return interfaces;
};

module.exports = {
  buildInterfaces
};
