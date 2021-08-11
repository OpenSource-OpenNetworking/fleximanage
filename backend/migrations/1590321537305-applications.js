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
const { membership } = require('../models/membership');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });
const { addPerms, removePerms } = require('./utils/updatePerms');

async function up () {
  try {
    await addPerms(membership, 'applications');
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['membership'],
        operation: 'up',
        err: err.message
      }
    });
  }
}

async function down () {
  try {
    await removePerms(membership, 'applications');
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['membership'],
        operation: 'down',
        err: err.message
      }
    });
  }
}

module.exports = { up, down };
