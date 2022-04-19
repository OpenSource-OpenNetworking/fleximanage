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

const configs = require('../configs')();
const periodic = require('./periodic')();
const DevSwUpdater = require('../deviceLogic/DevSwVersionUpdateManager');
const upgrade = require('../deviceLogic/applyUpgrade');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));
const { devices } = require('../models/devices');

/***
 * This class periodically checks if there are device scheduled for upgrade,
 * and creates device upgrade jobs for these devices.
 *
 ***/
class DeviceSwUpgrade {
  /**
     * Creates an instance of the DeviceSwUpgrade class
     */
  constructor () {
    this.devSwUpd = null;
    this.start = this.start.bind(this);
    this.periodicDeviceUpgrade = this.periodicDeviceUpgrade.bind(this);

    this.taskInfo = {
      name: 'upgrade_scheduled_devices',
      func: this.periodicDeviceUpgrade,
      handle: null,
      period: 900000
    };
  }

  /**
     * Starts the upgrade_scheduled_devices periodic task
     * @async
     * @return {void}
     */
  start () {
    this.devSwUpd = DevSwUpdater.getSwVerUpdaterInstance();
    // Runs once every 15 minutes
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask(name);
  }

  /**
     * Upgrade devices scheduled for an upgrade. This
     * function queues upgrade jobs to all devices that
     * were scheduled for upgrade in the current time slot.
     * @async
     * @return {void}
     */
  periodicDeviceUpgrade () {
    ha.runIfActive(async () => {
      try {
        const {
          versions,
          versionDeadline
        } = await this.devSwUpd.getLatestSwVersions();
        const version = versions.device;
        const now = Date.now();
        // prevent sending an update task if was sent within the last 24 hours
        const skipBefore = new Date(now);
        skipBefore.setDate(skipBefore.getDate() - 1);
        // If the software version deadline has passed, upgrade all
        // devices that are still not running the latest version.
        // Otherwise, upgrade only devices scheduled to this period.
        // This is done only if there is no pending previous upgrade
        // jobs already in the devices' queue.
        const query = {
          $and: [
            { 'versions.device': { $ne: version } },
            { 'upgradeSchedule.jobQueued': { $ne: true } },
            {
              $or: [
                { 'upgradeSchedule.latestTry': { $exists: false } },
                { 'upgradeSchedule.latestTry': null },
                { 'upgradeSchedule.latestTry': { $lte: skipBefore } }
              ]
            }
          ]
        };
        if (versionDeadline >= now) {
          query.$and.push({ 'upgradeSchedule.time': { $lte: new Date(now) } });
        }

        // Group the the devices that require upgrade
        // under the users that own them
        const organizationDevicesList = await devices.aggregate([
          { $match: query },
          {
            $group: {
              _id: '$org',
              devices: { $push: '$$ROOT' }
            }
          }
        ]);

        for (const orgDevice of organizationDevicesList) {
          const jobResults = await upgrade.queueUpgradeJobs(
            orgDevice.devices,
            'system',
            orgDevice._id,
            version
          );
          jobResults.forEach(job => {
            logger.info('Upgrade device job queued', {
              params: { jobId: job.id, version: version },
              job: job,
              periodic: { task: this.taskInfo }
            });
          });
          // Mark the jobs has been queued to the devices
          const deviceIDs = orgDevice.devices.map(device => { return device._id; });
          const result = await devices.updateMany(
            { _id: { $in: deviceIDs }, org: orgDevice._id },
            {
              $set: {
                'upgradeSchedule.jobQueued': true,
                'upgradeSchedule.latestTry': new Date(now)
              }
            }
          );
          if (result.nModified !== deviceIDs.length) {
            logger.error('Device upgrade pending was not set for all devices', {
              params: {
                devices: deviceIDs,
                expected: deviceIDs.length,
                set: result.nModified
              },
              periodic: { task: this.taskInfo }
            });
          } else {
            logger.info('Device upgrade pending flag set for scheduled devices', {
              params: { devices: deviceIDs },
              periodic: { task: this.taskInfo }
            });
          }
        }
      } catch (err) {
        logger.error('Device periodic task failed', {
          params: { reason: 'Failed to queue upgrade jobs', err: err.message },
          periodic: { task: this.taskInfo }
        });
      }
    });
  }
}

let perUpgDevice = null;
module.exports = function () {
  if (perUpgDevice) return perUpgDevice;
  perUpgDevice = new DeviceSwUpgrade();
  return perUpgDevice;
};
