// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

const Service = require('./Service');
const Tunnels = require('../models/tunnels');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const deviceStatus = require('../periodic/deviceStatus')();
const statusesInDb = require('../periodic/statusesInDb')();
const { getTunnelsPipeline } = require('../utils/tunnelUtils');
const { getUserOrganizations } = require('../utils/membershipUtils');
const notificationsConf = require('../models/notificationsConf');
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { getMajorVersion, getMinorVersion } = require('../versioning');
const { validateNotificationsSettings } = require('../models/validators');
const mongoConns = require('../mongoConns.js')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class CustomError extends Error {
  constructor ({ message, status, data }) {
    super(message);
    this.status = status;
    this.data = data;
  }
}
class TunnelsService {
  /**
   * Extends mongo results with tunnel status info
   *
   * @param {mongo Tunnel Object} item
   */
  static selectTunnelParams (retTunnel) {
    const tunnelId = retTunnel.num;
    // Add tunnel status
    retTunnel.tunnelStatusA =
      deviceStatus.getTunnelStatus(retTunnel.deviceA.machineId, tunnelId) || {};

    // Add tunnel status
    retTunnel.tunnelStatusB = retTunnel.peer
      ? {}
      : deviceStatus.getTunnelStatus(retTunnel.deviceB.machineId, tunnelId) || {};

    // if no filter or ordering by status then db can be not updated,
    // we get the status directly from memory
    const { peer, tunnelStatusA, tunnelStatusB, isPending } = retTunnel;
    if (!tunnelStatusA.status || (!tunnelStatusB.status && !peer)) {
      // one of devices is disconnected
      retTunnel.tunnelStatus = 'N/A';
    } else if (isPending) {
      retTunnel.tunnelStatus = 'Pending';
    } else if ((tunnelStatusA.status === 'up') && (peer || tunnelStatusB.status === 'up')) {
      retTunnel.tunnelStatus = 'Connected';
    } else {
      retTunnel.tunnelStatus = 'Not Connected';
    };

    retTunnel._id = retTunnel._id.toString();

    return retTunnel;
  }

  static getOnlyTunnelsEvents (notifications) {
    const notificationsDict = {};
    for (const [notificationName, notificationSettings] of Object.entries(notifications)) {
      const { type, warningThreshold, criticalThreshold } = notificationSettings;
      if (type === 'tunnel') {
        notificationsDict[notificationName] = {
          warningThreshold: warningThreshold,
          criticalThreshold: criticalThreshold
        };
      }
    }
    return notificationsDict;
  }

  /**
   * Retrieve device tunnels information
   *
   * @param {Integer} offset The number of items to skip before collecting the result (optional)
   * @param {Integer} limit The numbers of items to return (optional)
   * @param {String} sortField The field by which the data will be ordered (optional)
   * @param {String} sortOrder Sorting order [asc|desc] (optional)
   * @param {Array} filters Array of filter strings in format 'key|operation|value' (optional)
   **/
  static async tunnelsGET (requestParams, { user }, response) {
    const { org, offset, limit, sortField, sortOrder, filters } = requestParams;
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const updateStatusInDb = (filters && filters.includes('tunnelStatus')) ||
        sortField === 'tunnelStatus';
      if (updateStatusInDb) {
        // need to update changed statuses from memory to DB
        await statusesInDb.updateDevicesStatuses(orgList);
        await statusesInDb.updateTunnelsStatuses(orgList);
      }
      const detailed = requestParams?.response !== 'summary';
      const {
        matchPipeline,
        dataPipeline,
        filterPipeline
      } = getTunnelsPipeline(orgList, filters, detailed);

      const sortByLookupFields = new Set([
        'deviceA.name',
        'interfaceADetails.name',
        'deviceB.name',
        'interfaceBDetails.name',
        'pathlabel',
        'tunnelStatus'
      ]);
      let isSortByLookupFields = false;
      const sortPipeline = [];
      if (sortField) {
        const order = sortOrder.toLowerCase() === 'desc' ? -1 : 1;
        isSortByLookupFields = sortByLookupFields.has(sortField);
        sortPipeline.push({
          $sort: { [sortField]: order }
        });
      };

      const paginationPipeline = [];
      if (offset !== undefined) {
        paginationPipeline.push({ $skip: offset > 0 ? +offset : 0 });
      };
      if (limit !== undefined) {
        paginationPipeline.push({ $limit: +limit });
      };

      let dbRecords;
      if (paginationPipeline.length > 0) {
        let pipeline = [];
        if (filterPipeline.length === 0 && !isSortByLookupFields) {
          // If there are no filters and no sort by fields that require $lookup,
          // we can do the $limit here and only then do the heavy $lookup pipeline
          // on small amount of docs,
          // since we need it only for those docs that are shown in the UI
          pipeline = [
            ...matchPipeline,
            ...sortPipeline,
            {
              $facet: {
                records: [
                  ...paginationPipeline,
                  ...dataPipeline
                ],
                meta: [{ $count: 'total' }]
              }
            }
          ];
        } else {
          pipeline = [
            ...matchPipeline,
            ...dataPipeline,
            ...filterPipeline,
            ...sortPipeline,
            {
              $facet: {
                records: paginationPipeline,
                meta: [{ $count: 'total' }]
              }
            }
          ];
        }
        const paginated = await Tunnels.aggregate(pipeline).allowDiskUse(true);
        if (paginated[0].meta.length > 0) {
          response.setHeader('records-total', paginated[0].meta[0].total);
        };
        dbRecords = paginated[0].records;
      } else {
        dbRecords = await Tunnels.aggregate([
          ...matchPipeline,
          ...dataPipeline,
          ...filterPipeline,
          ...sortPipeline
        ]).allowDiskUse(true);
        response.setHeader('records-total', dbRecords.length);
      }
      const tunnelsMap = dbRecords.map((d) => {
        const tunnelStatusInDb = d.tunnelStatus;
        const retTunnel = TunnelsService.selectTunnelParams(d);
        // get the status from db if it was updated
        if (updateStatusInDb) {
          if (retTunnel.tunnelStatus !== tunnelStatusInDb) {
            // mark the tunnel status is changed, it will be updated in DB on the next call
            const status = retTunnel.tunnelStatus === 'Connected' ? 'up' : 'down';
            deviceStatus.setTunnelsStatusByOrg(orgList[0], d.num, d.deviceA.machineId, status);
            retTunnel.tunnelStatus = tunnelStatusInDb;
          }
        }
        return retTunnel;
      });

      return Service.successResponse(tunnelsMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    };
  }

  /**
   * Set tunnel specific notifications configuration
   *
   * @param {Array} tunnelsIdList - List of tunnel ids (Strings)
   * @param {Array} notifications - list of notifications (objects) to update
   **/

  static async tunnelsNotificationsPUT ({ org: orgId, tunnelsIdList, notifications }, { user }) {
    try {
      if (!orgId || !tunnelsIdList || !notifications || tunnelsIdList.length === 0) {
        return Service.rejectResponse(
          'Missing parameter: org, tunnels list or notifications settings',
          400
        );
      }

      const userOrgList = await getUserOrganizations(user);
      if (!Object.values(userOrgList).find((o) => o.id === orgId)) {
        return Service.rejectResponse(
          'You do not have permission to access this organization',
          403
        );
      }

      const tunnels = await Tunnels.find({ _id: { $in: tunnelsIdList }, org: orgId })
        .populate('deviceA', '_id name machineId versions')
        .populate('deviceB', '_id name machineId versions')
        .lean();

      if (tunnels.length !== tunnelsIdList.length) {
        return Service.rejectResponse(
          'Please check again your tunnels id list',
          500
        );
      }

      const orgNotifications = await notificationsConf.find(
        { org: orgId },
        { rules: 1, _id: 0 }
      );
      const jobsToSend = [];
      const errors = [];
      await mongoConns.mainDBwithTransaction(async (session) => {
        for (const tunnel of tunnels) {
          try {
            let currentSettingsDict;
            const orgRules = orgNotifications[0].rules;
            if (tunnel.notificationsSettings) {
              currentSettingsDict = tunnel.notificationsSettings;
            } else {
              currentSettingsDict = TunnelsService.getOnlyTunnelsEvents(orgRules);
            }

            const notificationsDict = {};
            for (const [event, { warningThreshold, criticalThreshold }]
              of Object.entries(notifications)) {
              let eventCriticalThreshold = currentSettingsDict[event].criticalThreshold;
              if (criticalThreshold !== 'varies') {
                eventCriticalThreshold = criticalThreshold;
                notificationsDict[event] = notificationsDict[event] || {};
                notificationsDict[event].criticalThreshold = eventCriticalThreshold;
              }

              let eventWarningThreshold = currentSettingsDict[event].warningThreshold;
              if (warningThreshold !== 'varies') {
                eventWarningThreshold = warningThreshold;
                notificationsDict[event] = notificationsDict[event] || {};
                notificationsDict[event].warningThreshold = eventWarningThreshold;
              }
              notificationsDict[event].thresholdUnit = orgRules[event].thresholdUnit;
            }

            const invalidNotifications = validateNotificationsSettings(notificationsDict, true);
            if (invalidNotifications) {
              throw new CustomError({
                status: 400,
                message: 'Invalid notification settings',
                data: { error: invalidNotifications }
              });
            }

            await Tunnels.updateOne(
              { _id: tunnel._id, org: orgId },
              {
                $set: {
                  notificationsSettings: notificationsDict
                }
              }
            ).session(session);

            const isPeer = tunnel.peer;
            const majorVersionA = getMajorVersion(tunnel.deviceA.versions.agent);
            const majorVersionB = !isPeer ? getMajorVersion(tunnel.deviceB.versions.agent) : 0;
            const minorVersionA = getMinorVersion(tunnel.deviceA.versions.agent);
            const minorVersionB = !isPeer ? getMinorVersion(tunnel.deviceB.versions.agent) : 0;

            const isDeviceAVersionSupported =
                    (majorVersionA > 6 || (majorVersionA === 6 && minorVersionA >= 3));
            const isDeviceBVersionSupported =
                    (majorVersionB > 6 || (majorVersionB === 6 && minorVersionB >= 3));

            if (isDeviceAVersionSupported) {
              jobsToSend.push({
                machineId: tunnel.deviceA.machineId.toString(),
                userName: user.username,
                orgId,
                deviceName: tunnel.deviceA.name,
                notifications: notificationsDict,
                tunnelNum: tunnel.num,
                deviceId: tunnel.deviceA._id
              });
            }

            if (!tunnel.peer && isDeviceBVersionSupported) {
              jobsToSend.push({
                machineId: tunnel.deviceB.machineId.toString(),
                userName: user.username,
                orgId,
                deviceName: tunnel.deviceB.name,
                notifications: notificationsDict,
                tunnelNum: tunnel.num,
                deviceId: tunnel.deviceB._id
              });
            }
          } catch (error) {
            errors.push({
              tunnelId: tunnel._id,
              status: 'error',
              message: error.message || 'Unknown error',
              data: error.data || {}
            });
          }
        }
      });
      if (errors.length > 0) {
        return Service.rejectResponse(
          'Invalid notification settings',
          400,
          errors
        );
      }
      const jobPromises = jobsToSend.map(jobToSend => {
        return deviceQueues.addJob(
          jobToSend.machineId,
          jobToSend.userName,
          jobToSend.orgId,
          {
            title: `Modify tunnel notifications settings on device ${jobToSend.deviceName}`,
            tasks: [{
              entity: 'agent',
              message: 'modify-tunnel',
              params: {
                notificationsSettings: jobToSend.notifications,
                'tunnel-id': jobToSend.tunnelNum
              }
            }]
          },
          {
            method: 'notifications',
            data: {
              device: jobToSend.deviceId,
              org: jobToSend.orgId,
              action: 'update-tunnel-notifications'
            }
          },
          { priority: 'normal', attempts: 1, removeOnComplete: false },
          null
        );
      });
      const promiseStatus = await Promise.allSettled(jobPromises);

      const fulfilled = promiseStatus.reduce((arr, elem) => {
        if (elem.status === 'fulfilled') {
          const job = elem.value;
          arr.push(job);
        } else {
          logger.error('Modify tunnel notifications Job Queue Error', {
            params: { message: elem.reason.message }
          });
        }
        return arr;
      }, []);
      const status = fulfilled.length < jobsToSend.length
        ? 'partially completed' : 'completed';
      const message = fulfilled.length < jobsToSend.length
        ? `${fulfilled.length} of ${jobsToSend.length} tunnel notifications jobs added`
        : 'The notifications were updated successfully';
      return Service.successResponse(
        { status, message },
        202
      );
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = TunnelsService;
