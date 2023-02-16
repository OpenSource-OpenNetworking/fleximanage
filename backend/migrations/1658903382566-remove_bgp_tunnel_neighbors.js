
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
const { generateTunnelParams } = require('../utils/tunnelUtils');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });
/**
 * Make any changes you need to make to the database here
 */
async function up () {
  try {
    const res = await devices.collection.updateMany(
      { 'bgp.neighbors': { $exists: true, $not: { $size: 0 } } },
      [
        {
          $addFields: {
            'bgp.neighbors': {
              $filter: {
                input: '$bgp.neighbors',
                as: 'neighbor',
                cond: {
                  $not: {
                    $regexMatch: {
                      input: '$$neighbor.ip',
                      regex: /^10\.100/
                    }
                  }
                }
              }
            }
          }
        }
      ],
      { multi: true }
    );
    logger.info('Device bgp.neighbors database migration succeeded', {
      params: { collections: ['devices'], operation: 'up', res }
    });
  } catch (err) {
    logger.error('Device bgp.neighbors database migration failed', {
      params: { collections: ['devices'], operation: 'up', err: err.message }
    });
    throw new Error(err.message);
  }
}

/**
 * Make any changes that UNDO the up function side effects here (if possible)
 */
async function down () {
  try {
    const bgpTunnels = await tunnelsModel.find({
      isActive: true,
      peer: null,
      'advancedOptions.routing': 'bgp'
    })
      .populate('deviceA', '_id bgp')
      .populate('deviceB', '_id bgp')
      .lean();

    for (const bgpTunnel of bgpTunnels) {
      const { num, deviceA, deviceB } = bgpTunnel;
      const { ip1, ip2 } = generateTunnelParams(num);

      const aAsn = deviceA.bgp.localASN;
      const bAsn = deviceB.bgp.localASN;

      // const remoteAsn = isDeviceA ? deviceB.bgp.localASN : deviceA.bgp.localASN;
      await devices.updateOne(
        { _id: deviceA._id },
        { $push: { 'bgp.neighbors': { ip: ip2, remoteASN: bAsn } } }
      );

      await devices.updateOne(
        { _id: deviceB._id },
        { $push: { 'bgp.neighbors': { ip: ip1, remoteASN: aAsn } } }
      );
    }

    logger.info('Device bgp.neighbors database migration succeeded', {
      params: { collections: ['devices'], operation: 'up' }
    });
  } catch (err) {
    logger.error('Device bgp.neighbors database migration failed', {
      params: { collections: ['devices'], operation: 'down', err: err.message }
    });
    throw new Error(err.message);
  }
}

module.exports = { up, down };
