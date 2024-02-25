// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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

const periodic = require('./periodic')();
const deviceStatus = require('./deviceStatus')();
const connections = require('../websocket/Connections')();
const mongoose = require('mongoose');
const tunnels = require('../models/tunnels');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const configs = require('../configs')();
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));

/***
 * This class periodically updates devices/tunnels statuses from memory to db
 ***/
class StatusesInDb {
  /**
  * Creates an instance of the class
  */
  constructor () {
    this.start = this.start.bind(this);
    this.runTask = this.runTask.bind(this);
    this.updateTunnelsStatuses = this.updateTunnelsStatuses.bind(this);
    this.updateDevicesStatuses = this.updateDevicesStatuses.bind(this);

    // Task information
    this.taskInfo = {
      name: 'statuses_in_db',
      func: this.runTask,
      handle: null,
      period: 60000
    };
  }

  /**
  * Starts the periodic task.
  * @return {void}
  */
  async start () {
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    await this.fetchStatusesFromDB();
    periodic.startTask(name);
  }

  /**
  * Fetch statuses from DB and update them in memory
  * when a new server is started it should be populated
  * with current state of devices/tunnels
  * @async
  * @return {void}
  */
  async fetchStatusesFromDB () {
    try {
      const connectedDevices = await devices.find(
        { isConnected: true },
        { org: 1, machineId: 1, isConnected: 1, status: 1, versions: 1 }
      );
      for (const device of connectedDevices) {
        const { org, _id, machineId, versions, status } = device;
        const info = {
          org: org,
          deviceObj: _id,
          machineId: machineId,
          version: versions.agent,
          ready: true,
          running: status === 'running',
          status: status
        };
        connections.devices.setDeviceInfo(machineId, info, false);
      }
    } catch (err) {
      logger.warn('Failed to statuses statuses from database', {
        params: { message: err.message }
      });
    }
  }

  /**
  * Clears all statuses in DB after service is started
  * @async
  * @return {void}
  */
  async clearStatuses () {
    try {
      await devices.updateMany(
        { },
        { $set: { isConnected: false, status: '' } }
      );
      await tunnels.updateMany(
        { },
        { $set: { status: '' } }
      );
    } catch (err) {
      logger.warn('Failed to clear statuses in database', {
        params: { message: err.message }
      });
    }
  }

  /**
  * Called periodically to update statuses from memory to DB
  * @return {void}
  */
  runTask () {
    ha.runIfActive(() => {
      this.updateDevicesStatuses();
      this.updateTunnelsStatuses();
    });
  }

  /**
  * Stores modified statuses from memory to DB
  * Runs full sync of statuses if need
  * @async
  * @param  {array|null} orgs organizations ids array
  * @return {void}
  */
  async updateDevicesStatuses (orgs = null) {
    const updateDiffs = [];
    const connectionStatusOrgs = orgs || connections.getConnectionStatusOrgs();
    for (const org of connectionStatusOrgs) {
      const connectionStatuses = connections.getConnectionStatusByOrg(org);
      if (connectionStatuses && Object.keys(connectionStatuses).length > 0) {
        const devicesByStatus = {};
        for (const deviceId in connectionStatuses) {
          const status = connectionStatuses[deviceId].toString();
          if (!devicesByStatus[status]) devicesByStatus[status] = [];
          devicesByStatus[status].push(mongoose.Types.ObjectId(deviceId));
        }
        for (const status in devicesByStatus) {
          updateDiffs.push({
            updateMany: {
              filter: { _id: { $in: devicesByStatus[status] } },
              update: { $set: { isConnected: (status === 'true') } }
            }
          });
        }
      }
    }
    const devicesStatusOrgs = orgs || deviceStatus.getDevicesStatusOrgs();
    for (const org of devicesStatusOrgs) {
      const devicesStatuses = deviceStatus.getDevicesStatusByOrg(org);
      if (devicesStatuses && Object.keys(devicesStatuses).length > 0) {
        const devicesByState = {};
        for (const deviceId in devicesStatuses) {
          const status = devicesStatuses[deviceId];
          if (!devicesByState[status]) devicesByState[status] = [];
          devicesByState[status].push(mongoose.Types.ObjectId(deviceId));
        }
        for (const state in devicesByState) {
          updateDiffs.push({
            updateMany: {
              filter: { _id: { $in: devicesByState[state] } },
              update: { $set: { status: state === 'pending' ? '' : state } }
            }
          });
        }
      }
    }
    if (updateDiffs.length > 0) {
      // Clear diff in memory before the db update
      connectionStatusOrgs.map(org => connections.clearConnectionStatusByOrg(org));
      devicesStatusOrgs.map(org => deviceStatus.clearDevicesStatusByOrg(org));
      // Update states and connection statuses diffs in the db
      try {
        await devices.collection.bulkWrite(updateDiffs);
      } catch (err) {
        logger.warn('Failed to update statuses in database', {
          params: { message: err.message }
        });
      }
    }

    // Check if need db/memory sync
    const connectedDevices = connections.getAllDevices().reduce((res, machineId) => {
      const { ready, deviceObj } = connections.getDeviceInfo(machineId) || {};
      if (ready) res.push(mongoose.Types.ObjectId(deviceObj));
      return res;
    }, []);
    // Check if need db/memory sync
    const connectedInDbCount = await devices.countDocuments({
      isConnected: true
    });
    if (connectedDevices.length !== connectedInDbCount) {
      logger.info('Different counts of connected devices in memory and DB, syncing statuses', {
        params: { dbCount: connectedInDbCount, memCount: connectedDevices.length }
      });
      const updateFull = [];
      updateFull.push({
        updateMany: {
          filter: { $and: [{ _id: { $in: connectedDevices } }, { isConnected: false }] },
          update: { $set: { isConnected: true, status: '' } }
        }
      });
      updateFull.push({
        updateMany: {
          filter: {
            $and: [
              {
                $or: [
                  { isConnected: true },
                  { status: { $ne: '' } }
                ]
              },
              { _id: { $not: { $in: connectedDevices } } }
            ]
          },
          update: { $set: { isConnected: false, status: '' } }
        }
      });
      // Full sync of connection statuses in db
      try {
        await devices.collection.bulkWrite(updateFull);
      } catch (err) {
        logger.warn('Failed to update statuses in database', {
          params: { message: err.message }
        });
      }
    }
  }

  /**
  * Stores modified tunnels statuses from memory to DB
  * @async
  * @param  {array|null} orgs organizations ids array
  * @return {void}
  */
  async updateTunnelsStatuses (orgs = null) {
    for (const org of orgs || deviceStatus.getTunnelsStatusOrgs()) {
      const tunnelsStatuses = deviceStatus.getTunnelsStatusByOrg(org);
      if (tunnelsStatuses && Object.keys(tunnelsStatuses).length > 0) {
        const tunnelsByStatus = {};
        for (const tunnelNum in tunnelsStatuses) {
          const sides = Object.entries(tunnelsStatuses[tunnelNum]);
          let status = sides.length > 0 && sides.every(s => s[1] === 'up') ? 'up' : 'down';
          if (status === 'up') {
            // check if still connected
            if (sides.some(s => !connections.isConnected(s[0]))) {
              status = 'down';
            }
          }
          if (!tunnelsByStatus[status]) tunnelsByStatus[status] = [];
          tunnelsByStatus[status].push(+tunnelNum);
        }
        const updateOps = [];
        for (const status in tunnelsByStatus) {
          updateOps.push({
            updateMany: {
              filter: {
                org: mongoose.Types.ObjectId(org),
                num: { $in: tunnelsByStatus[status] }
              },
              update: { $set: { status: status } }
            }
          });
        }
        // Update in db
        if (updateOps.length) {
          try {
            // Clear in memory before updating the db
            deviceStatus.clearTunnelsStatusByOrg(org);
            await tunnels.collection.bulkWrite(updateOps);
          } catch (err) {
            logger.warn('Failed to update tunnels status in database', {
              params: { message: err.message }
            });
          }
        }
      }
    }
  }
}

var statuses = null;
module.exports = function () {
  if (statuses) return statuses;
  else {
    statuses = new StatusesInDb();
    return statuses;
  }
};
