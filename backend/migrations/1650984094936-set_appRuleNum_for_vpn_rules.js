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

const logger = require('../logging/logging')({
  module: module.filename,
  type: 'migration'
});
const { devices } = require('../models/devices');

/// NOTE!!!! /////////////////////////////
/// this should migrate only vpn rules at this stage
/// //////////////////////////////////////
async function up () {
  try {
    // Add the "referenceNumber" with 1 value for all system rules.
    await devices.updateMany(
      { 'firewall.rules.system': true },
      { $set: { 'firewall.rules.$[rule].referenceNumber': 1 } },
      {
        arrayFilters: [
          {
            'rule.system': true,
            'rule.description': 'Allow VPN inbound traffic',
            'rule.referenceNumber': { $exists: false }
          }
        ],
        upsert: false
      }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['devices'],
        operation: 'up',
        err: err.message
      }
    });
    throw err;
  }
}

/**
 * Make any changes that UNDO the up function side effects here (if possible)
 */
async function down () {
  try {
    // Remove the referenceNumber from all system rules
    await devices.updateMany(
      { 'firewall.rules.system': true },
      { $unset: { 'firewall.rules.$[rule].referenceNumber': '' } },
      {
        arrayFilters: [
          {
            'rule.system': true,
            'rule.description': 'Allow VPN inbound traffic',
            'rule.referenceNumber': { $exists: true, $eq: 1 }
          }
        ],
        upsert: false
      }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['devices'],
        operation: 'down',
        err: err.message
      }
    });

    throw err;
  }
}

module.exports = { up, down };
