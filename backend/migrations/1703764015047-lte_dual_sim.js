// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2024  flexiWAN Ltd.

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

const { devices: devicesModel } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });
const cloneDeep = require('lodash/cloneDeep');
/**
 * Make any changes you need to make to the database here
 */
async function up () {
  try {
    const devices = await devicesModel.find(
      {},
      { interfaces: 1, _id: 1 }
    );

    const devicesOps = [];

    for (const device of devices) {
      for (const ifc of device.interfaces) {
        ifc.monitorInternetServers = ['8.8.8.8', '1.1.1.1'];
        ifc.monitorInternetProbeTimeout = 1000;

        // rest changes below are for LTE interfaces
        if (ifc.deviceType !== 'lte') {
          continue;
        }

        // continue if LTE interface is not configured yet
        if (Object.keys(ifc.configuration).length === 0) {
          continue;
        }

        // continue if LTE config is already use the new format
        if ('primarySlot' in ifc.configuration) {
          continue;
        }

        // store deep copy of current configuration object
        const current = cloneDeep(ifc.configuration);

        // build the new format of configuration object
        ifc.configuration = {
          enable: true,
          primarySlot: '1',
          automaticSwitchover: false,
          tryPrimaryAfter: '',
          slots: {
            1: {
              enable: true,
              apn: current.apn,
              pin: current.pin,
              auth: current.auth,
              authUser: current.user,
              authPassword: current.password
            },
            2: {
              enable: false,
              apn: '',
              pin: '',
              auth: '',
              authUser: '',
              authPassword: ''
            }
          }
        };
      }

      devicesOps.push({
        updateOne: {
          filter: { _id: device._id },
          update: { $set: { interfaces: device.interfaces } },
          upsert: false
        }
      });
    }

    let res = null;
    if (devicesOps.length > 0) {
      res = await devicesModel.bulkWrite(devicesOps);
    }

    logger.info('Device dual sim database migration succeeded', {
      params: { collections: ['devices'], operation: 'up', res }
    });
  } catch (err) {
    logger.error('Device dual sim database migration failed', {
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
    const devices = await devicesModel.find(
      {},
      { interfaces: 1, _id: 1 }
    );

    const devicesOps = [];

    for (const device of devices) {
      for (const ifc of device.interfaces) {
        delete ifc.monitorInternetServers;
        delete ifc.monitorInternetProbeTimeout;

        // ignore non-lte interface
        if (ifc.deviceType !== 'lte') {
          continue;
        }

        // continue if LTE interface is not configured yet
        if (Object.keys(ifc.configuration).length === 0) {
          continue;
        }

        // continue if LTE config is already use the old format
        if (!('primarySlot' in ifc.configuration)) {
          continue;
        }

        // store deep copy of current configuration object
        const current = cloneDeep(ifc.configuration);

        // build the new format of configuration object
        ifc.configuration = {
          enable: true,
          apn: current.slots[current.primarySlot].apn,
          pin: current.slots[current.primarySlot].pin,
          auth: current.slots[current.primarySlot].auth,
          user: current.slots[current.primarySlot].authUser,
          password: current.slots[current.primarySlot].authPassword
        };
      }

      devicesOps.push({
        updateOne: {
          filter: { _id: device._id },
          update: { $set: { interfaces: device.interfaces } },
          upsert: false
        }
      });
    }

    let res = null;
    if (devicesOps.length > 0) {
      res = await devicesModel.bulkWrite(devicesOps);
    }

    logger.info('Device dual sim database migration succeeded', {
      params: { collections: ['devices'], operation: 'down', res }
    });
  } catch (err) {
    logger.error('Device dual sim database migration failed', {
      params: { collections: ['devices'], operation: 'down', err: err.message }
    });
    throw new Error(err.message);
  }
}

module.exports = { up, down };
