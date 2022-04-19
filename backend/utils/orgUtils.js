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

const { devices } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const { generateTunnelParams } = require('./tunnelUtils');
const appsLogic = require('../applicationLogic/applications')();

/**
 * Get all LAN subnets in the organization
 * @param  {string} orgId         the id of the organization
 * @return {[_id: objectId, name: string, subnet: string]} array of LAN subnets with router name
 */
const getAllOrganizationLanSubnets = async orgId => {
  const subnets = await devices.aggregate([
    { $match: { org: orgId } },
    {
      $project: {
        'interfaces.IPv4': 1,
        'interfaces.IPv4Mask': 1,
        'interfaces.type': 1,
        'interfaces.isAssigned': 1,
        name: 1,
        _id: 1
      }
    },
    { $unwind: '$interfaces' },
    {
      $match: {
        'interfaces.type': 'LAN',
        'interfaces.isAssigned': true,
        'interfaces.IPv4': { $ne: '' },
        'interfaces.IPv4Mask': { $ne: '' }
      }
    },
    {
      $project: {
        _id: 1,
        name: 1,
        type: 'interface', // type of subnet
        subnet: {
          $concat: ['$interfaces.IPv4', '/', '$interfaces.IPv4Mask']
        }
      }
    }
  ]);

  return subnets;
};

const getTunnelsSubnets = async org => {
  const tunnels = await tunnelsModel.find({
    isActive: true,
    org: org
  }).lean();

  const subnets = [];

  for (const tunnel of tunnels) {
    const { ip1 } = generateTunnelParams(tunnel.num);
    subnets.push({ _id: tunnel._id, num: tunnel.num, subnet: `${ip1}/31`, type: 'tunnel' });
  }

  return subnets;
};

const getAllOrganizationSubnets = async orgId => {
  const lanSubnets = await getAllOrganizationLanSubnets(orgId);
  const tunnelSubnets = await getTunnelsSubnets(orgId);
  const applicationSubnets = await appsLogic.getApplicationSubnets(orgId);
  return [...lanSubnets, ...tunnelSubnets, ...applicationSubnets];
};

// Default exports
module.exports = {
  getAllOrganizationLanSubnets,
  getAllOrganizationSubnets
};
