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

const notificationsModel = require('../models/notifications');
const devicesModel = require('../models/devices').devices;
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });
const keyBy = require('lodash/keyBy');

async function up () {
  try {
    await notificationsModel.aggregate([
      {
        $addFields: {
          count: { $ifNull: ['$count', 1] },
          resolved: { $ifNull: ['$resolved', true] },
          targets: {
            $ifNull: [
              '$targets',
              {
                deviceId: '$device',
                tunnelId: null,
                interfaceId: null
              }
            ]
          },
          severity: { $ifNull: ['$severity', 'warning'] },
          agentAlertsInfo: { $ifNull: ['$agentAlertsInfo', {}] },
          emailSent: {
            $ifNull: [
              '$emailSent',
              {
                sendingTime: null,
                rateLimitedCount: 0
              }
            ]
          },
          isInfo: false,
          lastResolvedStatusChange: { $ifNull: ['$lastResolvedStatusChange', '$updatedAt'] }
        }
      },
      {
        $unset: ['device', 'machineId']
      },
      {
        $out: 'notifications'
      }
    ]).allowDiskUse(true);

    logger.info('Database migration successful', {
      params: { collections: ['notifications'], operation: 'up' }
    });
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['notifications'], operation: 'up', err: err.message }
    });
    throw new Error(err.message);
  }
}

async function down () {
  try {
    const devices = await devicesModel.find();
    const devicesMapById = keyBy(devices, '_id');

    const notifications = await notificationsModel.find();

    for (const notification of notifications) {
      if (!notification.targets || !notification.targets.deviceId) {
        continue;
      }

      const device = devicesMapById[notification.targets.deviceId];
      const machineId = device.machineId;

      await notificationsModel.collection.updateOne(
        { _id: notification._id },
        {
          $set: {
            device: notification.targets.deviceId,
            machineId: machineId
          },
          $unset: {
            count: '',
            resolved: '',
            targets: '',
            severity: '',
            agentAlertsInfo: '',
            emailSent: '',
            isInfo: ''
          }
        }
      );
    }

    logger.info('Database migration successful', {
      params: { collections: ['notifications'], operation: 'down' }
    });
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['notifications'], operation: 'down', err: err.message }
    });
    throw new Error(err.message);
  }
}

module.exports = { up, down };
