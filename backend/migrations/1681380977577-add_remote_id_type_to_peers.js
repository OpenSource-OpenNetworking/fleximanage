// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2023  flexiWAN Ltd.

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

const Peers = require('../models/peers');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });

async function up () {
  try {
    await Peers.collection.updateMany(
      { remoteIdType: { $exists: false } },
      [{ $addFields: { remoteIdType: '$idType' } }]
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['peers'], operation: 'up', err: err.message }
    });
    throw err;
  }
}

async function down () {
  try {
    // Do not remove the new field "remoteIdType" on the downgrade, as it is not harm anything.
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['peers'], operation: 'down', err: err.message }
    });
    throw err;
  }
}

module.exports = { up, down };
