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

const { devices } = require('../models/devices');
const logger = require('../logging/logging')({
  module: module.filename,
  type: 'migration'
});

const defaultValues = {
  hwCores: 2,
  grubCores: 2,
  vppCores: 1,
  configuredVppCores: 1,
  powerSaving: false
};

async function up () {
  try {
    // Add the "cpuInfo" default values
    await devices.updateMany(
      { cpuInfo: { $exists: false } },
      { $set: { cpuInfo: defaultValues } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['devices'],
        operation: 'up',
        err: err.message
      }
    });
    throw new Error(err.message);
  }
}

async function down () {
  try {
    // Remove the "cpuInfo" default values
    await devices.updateMany(
      { cpuInfo: { $exists: true } },
      { $unset: { cpuInfo: '' } },
      { upsert: false }
    );
  } catch (err) {
    logger.error('Database migration failed', {
      params: {
        collections: ['devices'],
        operation: 'down',
        err: err.message
      }
    });
    throw new Error(err.message);
  }
}

module.exports = { up, down };
