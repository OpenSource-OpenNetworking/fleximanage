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

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('./cors');
const auth = require('../authenticate');
const connections = require('../websocket/Connections')();
const Devices = require('../websocket/Devices')();
const deviceStatus = require('../periodic/deviceStatus')();
const usersModel = require('../models/users');
const tunnelsModel = require('../models/tunnels');
const { devices: devicesModel } = require('../models/devices');
const { deviceAggregateStats } = require('../models/analytics/deviceStats');

const adminRouter = express.Router();
adminRouter.use(bodyParser.json());

/**
 * This route is allowed only if the organization is marked as admin
 * Return internal information
 */
adminRouter
  .route('/')
// When options message received, reply origin based on whitelist
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, auth.verifyAdmin, async (req, res, next) => {
    // Get users info
    let registeredUsers = 'No info';
    try {
      registeredUsers = await usersModel
        .aggregate([{ $project: { username: 1 } }, { $count: 'num_registered_users' }])
        .allowDiskUse(true);
    } catch (e) {
      registeredUsers = 'Error getting registered users info, error=' + e.message;
    }

    // Get Installed Devices
    let installedDevices = 'No info';
    try {
      installedDevices = await devicesModel
        .aggregate([{ $project: { org: 1 } },
          { $group: { _id: { org: '$org' }, num_devices: { $sum: 1 } } },
          { $project: { _id: 0, org: '$_id.org', num_devices: '$num_devices' } }])
        .allowDiskUse(true);
    } catch (e) {
      installedDevices = 'Error getting installed devices info, error=' + e.message;
    }

    // Get Installed Tunnels
    let installedTunnels = 'No info';
    try {
      installedTunnels = await tunnelsModel
        .aggregate([
          {
            $project: {
              org: 1,
              active: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] }
            }
          },
          {
            $group: {
              _id: { org: '$org' },
              created: { $sum: 1 },
              active: { $sum: '$active' }
            }
          },
          {
            $project: {
              _id: 0,
              org: '$_id.org',
              created: '$created',
              active: '$active'
            }
          }
        ])
        .allowDiskUse(true);
    } catch (e) {
      installedTunnels = 'Error getting installed tunnels info, error=' + e.message;
    }

    // Get Monthly Stats
    let monthlyStats = 'No info';
    try {
      monthlyStats = await deviceAggregateStats
        .aggregate([{ $project: { month: 1, orgs: { $objectToArray: '$stats.orgs' } } },
          { $unwind: '$orgs' },
          { $project: { month: 1, org: '$org.k', devices: { $objectToArray: '$orgs.v.devices' } } },
          { $unwind: '$devices' },
          { $project: { month: 1, org: 1, device: '$devices.k', bytes: '$devices.v.bytes' } },
          {
            $group: {
              _id: { month: '$month' },
              active_orgs: { $addToSet: '$org' },
              active_devices: { $addToSet: '$device' },
              total_bytes: { $sum: '$bytes' }
            }
          },
          {
            $project: {
              _id: 0,
              month: '$_id.month',
              activeOrgs: { $size: '$active_orgs' },
              activeDevices: { $size: '$active_devices' },
              totalBytes: '$total_bytes'
            }
          },
          { $sort: { month: -1 } }])
        .allowDiskUse(true);
      monthlyStats.forEach((result) => {
        result.month = (new Date(result.month)).toLocaleDateString();
        result.totalBytes = result.totalBytes.valueOf();
      });
    } catch (e) {
      monthlyStats = 'Error getting installed tunnels info, error=' + e.message;
    }

    // Return  static info from:
    const result = {
      ...registeredUsers[0],
      installedDevices: installedDevices,
      installedTunnels: installedTunnels,
      monthlyStats: monthlyStats,
      connectedOrgs: {}
    };

    // 1. Open websocket connections and connection info
    const devices = connections.getAllDevices();
    result.numConnectedDevices = devices.length;
    devices.forEach((device) => {
      const { org } = Devices.getRedisDeviceInfo(device, 'info', { org: 1 });
      if (result.connectedOrgs[org] === undefined) {
        result.connectedOrgs[org] = [];
      }
      result.connectedOrgs[org].push({
        machineID: device,
        status: ((deviceStatus.getDeviceStatus(device))
          ? deviceStatus.getDeviceStatus(device).state : 'unknown')
        // ip:(deviceInfo.socket._sender._socket._peername.address || 'unknown'),
        // port:(deviceInfo.socket._sender._socket._peername.port || 'unknown')
      });
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.json(result);
  });

// Default exports
module.exports = adminRouter;
