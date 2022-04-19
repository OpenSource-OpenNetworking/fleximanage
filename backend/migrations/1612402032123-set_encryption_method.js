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

const orgModel = require('../models/organizations');
const tunnelsModel = require('../models/tunnels');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });

async function up () {
  try {
    // Add encryptionMethod field, set as 'psk' to all existing organizations
    await orgModel.updateMany(
      { encryptionMethod: { $exists: false } },
      { $set: { encryptionMethod: 'psk' } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['organizations'], operation: 'up', err: err.message }
    });
  }
  try {
    // Add encryptionMethod field, set as 'psk' to all existing tunnels
    await tunnelsModel.updateMany(
      { encryptionMethod: { $exists: false } },
      { $set: { encryptionMethod: 'psk' } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['tunnels'], operation: 'up', err: err.message }
    });
  }
}

async function down () {
  try {
    // Unset encryptionMethod field
    await orgModel.updateMany(
      { encryptionMethod: { $exists: true } },
      { $unset: { encryptionMethod: '' } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['organizations'], operation: 'down', err: err.message }
    });
  }
  try {
    // Unset encryptionMethod field
    await tunnelsModel.updateMany(
      { encryptionMethod: { $exists: true } },
      { $unset: { encryptionMethod: '' } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['tunnels'], operation: 'down', err: err.message }
    });
  }
}

module.exports = { up, down };
