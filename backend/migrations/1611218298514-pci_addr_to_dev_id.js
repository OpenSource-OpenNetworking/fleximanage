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
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });
const { deviceStats } = require('../models/analytics/deviceStats');

async function up () {
  // Change all pci keys to devId for each interface
  try {
    await devices.aggregate([
      {
        $addFields: {
          staticroutes: {
            $map: {
              input: '$staticroutes',
              as: 'static',
              in: {
                _id: '$$static._id',
                metric: '$$static.metric',
                destination: '$$static.destination',
                gateway: '$$static.gateway',
                ifname: { $concat: ['pci:', '$$static.ifname'] },
                updatedAt: '$$static.updatedAt',
                createdAt: '$$static.createdAt'
              }
            }
          },
          dhcp: {
            $map: {
              input: '$dhcp',
              as: 'dhcpEntry',
              in: {
                _id: '$$dhcpEntry._id',
                dns: '$$dhcpEntry.dns',
                status: '$$dhcpEntry.status',
                interface: { $concat: ['pci:', '$$dhcpEntry.interface'] },
                rangeStart: '$$dhcpEntry.rangeStart',
                rangeEnd: '$$dhcpEntry.rangeEnd',
                macAssign: '$$dhcpEntry.macAssign',
                updatedAt: '$$dhcpEntry.updatedAt',
                createdAt: '$$dhcpEntry.createdAt'
              }
            }
          },
          interfaces: {
            $map: {
              input: '$interfaces',
              as: 'inter',
              in: {
                devId: { $concat: ['pci:', '$$inter.pciaddr'] },
                driver: '$$inter.driver',
                dhcp: '$$inter.dhcp',
                IPv4: '$$inter.IPv4',
                IPv6: '$$inter.IPv6',
                PublicIP: '$$inter.PublicIP',
                PublicPort: '$$inter.PublicPort',
                NatType: '$$inter.NatType',
                useStun: '$$inter.useStun',
                gateway: '$$inter.gateway',
                metric: '$$inter.metric',
                isAssigned: '$$inter.isAssigned',
                routing: '$$inter.routing',
                type: '$$inter.type',
                pathlabels: '$$inter.pathlabels',
                monitorInternet: '$$inter.monitorInternet',
                internetAccess: '$$inter.internetAccess',
                _id: '$$inter._id',
                MAC: '$$inter.MAC',
                name: '$$inter.name',
                IPv4Mask: '$$inter.IPv4Mask',
                updatedAt: '$$inter.updatedAt',
                createdAt: '$$inter.createdAt',
                IPv6Mask: '$$inter.IPv6Mask',
                deviceType: 'dpdk'
              }
            }
          }
        }
      },
      { $out: 'devices' }
    ]).allowDiskUse(true);

    await deviceStats.aggregate([
      {
        $addFields: {
          stats: {
            $arrayToObject: {
              $map: {
                input: { $objectToArray: '$stats' },
                as: 'st',
                in: {
                  k: { $concat: ['pci:', '$$st.k'] },
                  v: '$$st.v'
                }
              }
            }
          }
        }
      },
      { $out: 'devicestats' }
    ]).allowDiskUse(true);

    logger.info('Database migration done!', {
      params: { collections: ['devices'], operation: 'up' }
    });
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['devices'], operation: 'up', err: err.message }
    });
  }
}

/**
 * Make any changes that UNDO the up function side effects here (if possible)
 */
async function down () {
  try {
    await devices.aggregate([
      {
        $addFields: {
          staticroutes: {
            $map: {
              input: '$staticroutes',
              as: 'static',
              in: {
                _id: '$$static._id',
                metric: '$$static.metric',
                destination: '$$static.destination',
                gateway: '$$static.gateway',
                ifname: { $arrayElemAt: [{ $split: ['$$static.ifname', 'pci:'] }, 1] },
                updatedAt: '$$static.updatedAt',
                createdAt: '$$static.createdAt'
              }
            }
          },
          dhcp: {
            $map: {
              input: '$dhcp',
              as: 'dhcpEntry',
              in: {
                _id: '$$dhcpEntry._id',
                dns: '$$dhcpEntry.dns',
                status: '$$dhcpEntry.status',
                interface: { $arrayElemAt: [{ $split: ['$$dhcpEntry.interface', 'pci:'] }, 1] },
                rangeStart: '$$dhcpEntry.rangeStart',
                rangeEnd: '$$dhcpEntry.rangeEnd',
                macAssign: '$$dhcpEntry.macAssign',
                updatedAt: '$$dhcpEntry.updatedAt',
                createdAt: '$$dhcpEntry.createdAt'
              }
            }
          },
          interfaces: {
            $map: {
              input: '$interfaces',
              as: 'inter',
              in: {
                pciaddr: { $arrayElemAt: [{ $split: ['$$inter.devId', 'pci:'] }, 1] },
                driver: '$$inter.driver',
                dhcp: '$$inter.dhcp',
                IPv4: '$$inter.IPv4',
                IPv6: '$$inter.IPv6',
                PublicIP: '$$inter.PublicIP',
                PublicPort: '$$inter.PublicPort',
                NatType: '$$inter.NatType',
                useStun: '$$inter.useStun',
                gateway: '$$inter.gateway',
                metric: '$$inter.metric',
                isAssigned: '$$inter.isAssigned',
                routing: '$$inter.routing',
                type: '$$inter.type',
                pathlabels: '$$inter.pathlabels',
                monitorInternet: '$$inter.monitorInternet',
                internetAccess: '$$inter.internetAccess',
                _id: '$$inter._id',
                MAC: '$$inter.MAC',
                name: '$$inter.name',
                IPv4Mask: '$$inter.IPv4Mask',
                updatedAt: '$$inter.updatedAt',
                createdAt: '$$inter.createdAt',
                IPv6Mask: '$$inter.IPv6Mask'
              }
            }
          }
        }
      },
      { $out: 'devices' }
    ]).allowDiskUse(true).option({ bypassDocumentValidation: true });

    await deviceStats.aggregate([
      {
        $addFields: {
          stats: {
            $arrayToObject: {
              $map: {
                input: { $objectToArray: '$stats' },
                as: 'st',
                in: {
                  k: { $arrayElemAt: [{ $split: ['$$st.k', 'pci:'] }, 1] },
                  v: '$$st.v'
                }
              }
            }
          }
        }
      },
      { $out: 'devicestats' }
    ]).allowDiskUse(true);

    logger.info('Database migration done!', {
      params: { collections: ['devices'], operation: 'down' }
    });
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['devices'], operation: 'down', err: err.message }
    });
  }
}

module.exports = { up, down };
