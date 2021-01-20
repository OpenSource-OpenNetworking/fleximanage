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

const tunnelsModel = require('../models/tunnels');
const devicesModel = require('../models/devices').devices;
const randomNum = require('../utils/random-key');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });

/**
 * Generates 4 random keys
 * @return {{key1: number, key2: number, key3: number, key4: number}}
 */
const generateRandomKeys = () => {
  return {
    key1: randomNum(32, 16),
    key2: randomNum(32, 16),
    key3: randomNum(32, 16),
    key4: randomNum(32, 16)
  };
};

async function up () {
  try {
    const tunnelsOps = [];
    const devicesToSync = [];
    const tunnels = await tunnelsModel.find({ tunnelKeys: null, isActive: true });
    for (const tunnel of tunnels) {
      const { key1, key2, key3, key4 } = generateRandomKeys();
      tunnelsOps.push({
        updateOne:
          {
            filter: { _id: tunnel._id },
            update: { $set: { tunnelKeys: { key1, key2, key3, key4 } } },
            upsert: false
          }
      });
      // need to sync both sides
      if (!devicesToSync.includes(tunnel.deviceA)) {
        devicesToSync.push(tunnel.deviceA);
      }
      if (!devicesToSync.includes(tunnel.deviceB)) {
        devicesToSync.push(tunnel.deviceB);
      }
    }
    await tunnelsModel.bulkWrite(tunnelsOps);

    // need to sync all devices in order to update tunnelKeys on devices
    await devicesModel.updateMany(
      { _id: { $in: devicesToSync } },
      {
        $set: {
          'sync.state': 'syncing',
          'sync.autoSync': 'on',
          'sync.trials': 0
        }
      },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['tunnels', 'devices'], operation: 'up', err: err.message }
    });
  }
}

async function down () {
  // no need to do anything here
}

module.exports = { up, down };
