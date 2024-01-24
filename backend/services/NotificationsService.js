/* eslint-disable max-len */
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

const notificationsDb = require('../models/notifications');
const { devices } = require('../models/devices');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const { getUserOrganizations } = require('../utils/membershipUtils');
const mongoose = require('mongoose');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getMatchFilters } = require('../utils/filterUtils');
const notificationsConf = require('../models/notificationsConf');
const { membership } = require('../models/membership');
const Organizations = require('../models/organizations');
const users = require('../models/users');
const { ObjectId } = require('mongodb');
const { apply } = require('../deviceLogic/deviceNotifications');
const keyBy = require('lodash/keyBy');
const notificationsMgr = require('../notifications/notifications')();
const { validateNotificationsSettings, validateNotificationsThresholds, validateEmailNotifications, validateWebhookSettings } = require('../models/validators');
const mongoConns = require('../mongoConns.js')();
const createError = require('http-errors');

class CustomError extends Error {
  constructor ({ message, status, data }) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

class NotificationsService {
  // Helper function to handle device filters
  static async getDevicesFromFilters (orgList, deviceFilters = null) {
    const queryFilters = deviceFilters ? [...deviceFilters] : [];
    const devicesArray = await devices.find({
      $and: [...queryFilters, {
        org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) }
      }]
    }, { name: 1, interfaces: 1 });

    return devicesArray;
  }

  // Helper function to split matchFilters
  static splitMatchFilters (matchFilters) {
    return matchFilters.reduce((res, filter) => {
      for (const key in filter) {
        if (key.startsWith('targets.deviceId')) {
          res[0].push({ [key.replace('targets.deviceId.', '')]: filter[key] });
        } else {
          res[1].push(filter);
        }
      }
      return res;
    }, [[], []]);
  }

  /**
   * Get all Notifications
   *
   * offset Integer The number of items to skip before starting to collect the result set
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async notificationsGET (requestParams, { user }, response) {
    const { org, op, status, offset, limit, sortField, sortOrder, filters } = requestParams;
    let orgList;

    try {
      orgList = await getAccessTokenOrgList(user, org, false);
      const query = { org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) } };

      if (status) {
        query.status = status;
      }

      const pipeline = op !== 'count' ? [
        {
          $match: query
        },
        {
          $project: {
            _id: { $toString: '$_id' },
            time: 1,
            title: 1,
            details: 1,
            targets: 1,
            agentAlertsInfo: 1,
            status: 1,
            severity: 1,
            count: 1,
            emailSent: 1,
            resolved: 1,
            org: 1,
            isInfo: 1,
            lastResolvedStatusChange: 1
          }
        }
      ] : [];
      let devicesArray;
      let deviceFilterWasGiven = false;
      const parsedFilters = filters ? JSON.parse(filters) : null;
      if (parsedFilters && parsedFilters.length > 0) {
        const matchFilters = getMatchFilters(parsedFilters);

        if (matchFilters.length > 0) {
          // if there is a 'device.*' filter we need another query, $lookup will not work
          // because 'devices' and 'notifications' are in different databases
          const [deviceFilters, notificationFilters] = NotificationsService.splitMatchFilters(matchFilters);
          if (deviceFilters.length > 0) {
            deviceFilterWasGiven = true;
            devicesArray = await NotificationsService.getDevicesFromFilters(orgList, deviceFilters);
            notificationFilters.push({
              'targets.deviceId': { $in: devicesArray.map(d => d._id) }
            });
          };
          if (notificationFilters.length > 0) {
            pipeline.push({
              $match: { $and: notificationFilters }
            });
          }
        }
      }
      // If there are no device filters, fetch all devices to make sure we will get only existing devices notifications
      if (!devicesArray) {
        devicesArray = await NotificationsService.getDevicesFromFilters(orgList);
        pipeline[0].$match['targets.deviceId'] = { $in: [...devicesArray.map(d => d._id), null] }; // We allow null, assuming not all notifications include deviceId
      }

      if (sortField) {
        const order = sortOrder.toLowerCase() === 'desc' ? -1 : 1;
        pipeline.push({
          $sort: { [sortField]: order }
        });
      };
      const paginationParams = [{
        $skip: offset > 0 ? +offset : 0
      }];

      if (limit !== undefined) {
        paginationParams.push({ $limit: +limit });
      };
      pipeline.push({
        $facet: {
          records: paginationParams,
          meta: [{ $count: 'total' }]
        }
      });

      // If operation is 'count', return the amount
      // of notifications for each device
      const notifications = (op === 'count')
        ? await notificationsDb.aggregate([{ $match: query },
          {
            $group: {
              _id: '$device',
              count: { $sum: 1 }
            }
          }
        ])
        : await notificationsDb.aggregate(pipeline).allowDiskUse(true);

      let notificationsRelatedDevices = devicesArray;
      if (op !== 'count' && notifications[0].meta.length > 0) {
        response.setHeader('records-total', notifications[0].meta[0].total);
        if (!deviceFilterWasGiven) {
          notificationsRelatedDevices = await NotificationsService.getDevicesFromFilters(
            orgList, [{ _id: { $in: notifications[0].records.map(n => n.targets.deviceId) } }]);
        }
      };

      const devicesByDeviceId = keyBy(notificationsRelatedDevices, '_id');
      const result = (op === 'count')
        ? notifications.map(element => {
          return {
            _id: element._id.toString(),
            count: element.count
          };
        })
        : notifications[0].records.map(element => {
          const device = devicesByDeviceId[element.targets.deviceId];

          let interfaceObj = null;
          const { deviceId, interfaceId } = element.targets;
          if (interfaceId) {
            const ifc = device?.interfaces?.find(ifc => String(ifc._id) === String(interfaceId));
            interfaceObj = {
              _id: interfaceId,
              name: ifc?.name
            };
          }
          const deviceObj = {
            _id: deviceId,
            name: device?.name
          };
          return {
            ...element,
            _id: element._id.toString(),
            time: element.time.toISOString(),
            lastResolvedStatusChange: element.lastResolvedStatusChange?.toISOString(),
            targets: { ...element.targets, deviceId: deviceObj, interfaceId: interfaceObj }
          };
        });

      return Service.successResponse(result);
    } catch (e) {
      logger.warn('Failed to retrieve notifications', {
        params: {
          org: orgList,
          err: e.message
        }
      });
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify notification
   *
   * id String Numeric ID of the notification to modify
   * org String Organization to be filtered by (optional)
   * notificationsIDPutRequest NotificationsIDPutRequest
   * returns Notification
   **/
  static async notificationsIdPUT ({ id, org, ...notificationsIDPutRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const query = { org: { $in: orgList }, _id: id };
      const { status, resolve } = notificationsIDPutRequest;
      const updateFields = {};
      if (status) updateFields.status = status;
      if (resolve) updateFields.resolved = true;
      const res = await notificationsDb.updateOne(
        query,
        { $set: updateFields },
        { upsert: false }
      );
      if (res.n === 0) throw new Error('Failed to update notifications');

      const notifications = await notificationsDb.find(
        query,
        'time device title details status machineId targets'
      ).populate('device', 'name -_id', devices).lean();

      const result = {
        _id: notifications[0]._id.toString(),
        status: notifications[0].status,
        resolved: notifications[0].resolved,
        details: notifications[0].details,
        title: notifications[0].title,
        targets: notifications[0].targets,
        time: notifications[0].time.toISOString()
      };

      return Service.successResponse(result, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify notifications
   *
   * org String Organization to be filtered by (optional)
   * notificationsPutRequest NotificationsPutRequest
   * no response value expected for this operation
   **/
  static async notificationsPUT ({ org, ...notificationsPutRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const query = { org: { $in: orgList } };
      if (notificationsPutRequest.ids) query._id = { $in: notificationsPutRequest.ids };
      const { status, resolve } = notificationsPutRequest;
      const updateFields = {};
      if (status) updateFields.status = status;
      if (resolve) updateFields.resolved = true;
      const res = await notificationsDb.updateMany(
        query,
        { $set: updateFields },
        { upsert: false }
      );
      if (notificationsPutRequest.ids && res.n !== notificationsPutRequest.ids.length) {
        throw new Error('Some notification IDs were not found');
      }
      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete all notifications matching the filters
   *
   * no response value expected for this operation
   **/
  static async notificationsDELETE ({ org, ...notificationsDeleteRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const query = { org: { $in: orgList.map(o => mongoose.Types.ObjectId(o)) } };
      const { filters } = notificationsDeleteRequest;
      if (filters) {
        const matchFilters = getMatchFilters(filters);
        const [deviceFilters, notificationFilters] = NotificationsService.splitMatchFilters(matchFilters);

        if (deviceFilters.length > 0) {
          const deviceIDs = await NotificationsService.getDevicesFromFilters(orgList, deviceFilters);
          if (deviceIDs.length > 0) {
            notificationFilters.push({ 'targets.deviceId': { $in: deviceIDs.map(d => d._id) } });
          }
        }

        if (notificationFilters.length > 0) {
          query.$and = notificationFilters;
        }
      }

      const { deletedCount } = await notificationsDb.deleteMany(query);
      if (deletedCount === 0) {
        return Service.rejectResponse('Not found', 404);
      }
      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
  * Validate notifications conf request params
  * @param org String organization ID
  * @param account String account ID
  * @param group String group name (must be sent with account ID)
  * @param setAsDefault Boolean if this is a set as default request
  **/
  static async validateParams (user, org, account, group, setAsDefault = false) {
    if (setAsDefault) {
      if (!account) {
        throw createError(400, 'Please specify the account id');
      }
    } else {
    // Validate parameters
      if (!org && !account && !group) {
        throw createError(400, 'Missing parameter: org, account or group');
      }
      // The request should contain only the necessary fields. orgId is unique so it should be sent alone
      if (org && (account || group)) {
        throw createError(400, 'Invalid parameter: org should be used alone');
      }
      // Since the group name is not unique, it should always be sent with an account ID
      if (group && !account) {
        throw createError(400, 'Invalid parameter: group should be used with account');
      }
      if (account && org) {
        throw createError(400, 'Invalid parameter: account should be used alone or with group(for modifying the group)');
      }
      if (!user?.defaultAccount?._id || (account && account !== user.defaultAccount._id.toString())) {
        throw createError(403, 'This account does not match the one you are working with');
      }
    }
  }

  /**
   * Fetch the list of organizations the user is allowed to access/modify according to the params
  * @param user Object the user's object
  * @param org String organization ID
  * @param account String account ID
  * @param group String group name (must be sent with account ID)
  * @param get Boolean is this a get request
  * @param allowEmptyOrgList (Boolean): Determines whether an empty organization list is permissible.
  * Utilized in email notification PUT & GET functions to ascertain a user's permission level.
  * When true, checks if the user can modify (initial check). If an empty list is returned, a second check is performed with get = true and allowEmptyOrgList = false.
  * If an empty list is received again, an error is thrown; otherwise, the user is deemed a viewer.
  * returns list of organizations
  **/
  static async fetchOrgList (user, org, account, group, get = false, allowEmptyOrgList = false) {
    // If group is given send it without account, else send org / account (one of them will be undefined,
    // since they can't be used together)
    // The function getAccessTokenOrgList allows only one of: org/account/group
    const orgList = group ? await getAccessTokenOrgList(user, null, false, null, group, !get) : await getAccessTokenOrgList(user, org, false, account, '', !get);

    if (orgList.length === 0 && !allowEmptyOrgList) {
      throw createError(403, `You don't have permission to ${get ? 'access' : 'modify'} the settings`);
    }

    return orgList;
  }

  /**
  * Get notifications settings for a given organization/account/group
  * @param org String organization ID
  * @param account String account ID
  * @param group String group name (must be sent with account ID)
  * user: Object
  * The request should contain one of the 3: org / account / account + group
   **/
  static async notificationsConfGET ({ org, account, group }, { user }) {
    try {
      await NotificationsService.validateParams(user, org, account, group);
      const orgIds = await NotificationsService.fetchOrgList(user, org, account, group, true);
      const response = await notificationsConf.find({ org: { $in: orgIds.map(orgId => new ObjectId(orgId)) } }).lean();
      if (org) {
        const sortedRules = Object.fromEntries(
          Object.entries(response[0].rules).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        );
        return Service.successResponse(sortedRules);
      } else {
        const mergedRules = {};
        response.forEach(org => {
          Object.keys(org.rules).forEach(ruleName => {
            if (!mergedRules[ruleName]) {
              mergedRules[ruleName] = {};
              Object.keys(org.rules[ruleName]).forEach(settingName => {
                mergedRules[ruleName][settingName] = org.rules[ruleName][settingName];
              });
            } else {
              Object.keys(org.rules[ruleName]).forEach(settingName => {
                if (mergedRules[ruleName][settingName] !== org.rules[ruleName][settingName]) {
                  mergedRules[ruleName][settingName] = 'varies';
                }
              });
            }
          });
        });
        const sortedMergedRules = Object.fromEntries(Object.entries(mergedRules).sort(([keyA], [keyB]) => keyA.localeCompare(keyB)));
        return Service.successResponse(sortedMergedRules);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
  * Send the notifications settings of numeric fields to validation
  * If one of the new fields value is "varies" it means we should use the original value
  * in the validation in order to make sure that the other value is valid (bigger/smaller than the other)
  * @param newRulesEventSettings Object of a specific event type settings, sent by the user
  * @param currentRuleEventSettings Object of a specific event type settings, taken from the original organization settings
  **/
  static validateThresholds (newRulesEventSettings, currentRuleEventSettings, eventName) {
    let { warningThreshold, criticalThreshold } = newRulesEventSettings;
    if (warningThreshold === 'varies') {
      warningThreshold = currentRuleEventSettings.warningThreshold;
    }

    if (criticalThreshold === 'varies') {
      criticalThreshold = currentRuleEventSettings.criticalThreshold;
    }

    const validRule = validateNotificationsThresholds({ [eventName]: { warningThreshold, criticalThreshold } });

    if (!validRule.valid) {
      throw new CustomError({
        status: 400,
        message: 'Invalid notification settings',
        data: validRule.errors
      });
    }
  }

  /**
  * Modify the notifications settings of a given organization/account/group
  * @param org String organization ID
  * @param account String account ID
  * @param group String group name (must be sent with account ID)
  * @param rules Object of notifications settings (each one is an object in which the event name is the key and the value
  * is the event settings)
  * user: Object
  **/
  static async notificationsConfPUT ({ org: orgId, account, group, rules: newRules }, { user }) {
    try {
      await NotificationsService.validateParams(user, orgId, account, group);
      const orgIds = await NotificationsService.fetchOrgList(user, orgId, account, group);

      // A map to save the updated notifications for each organization in order to use it in the job
      // Note that the newRules input isn't always applicable as the updated settings since it may contain "varies" in some fields.
      // In this case the original setting for that specific field in the organization settings should be used instead
      const updatedNotificationsByOrg = new Map();

      await mongoConns.mainDBwithTransaction(async (session) => {
        const bulkUpdates = [];

        const allCurrentRules = await notificationsConf.find({ org: { $in: orgIds } }).lean();
        const originalNotificationsByOrg = {};

        allCurrentRules.forEach(orgNotificationsSettings => {
          originalNotificationsByOrg[orgNotificationsSettings.org] = orgNotificationsSettings.rules;
        });

        for (const orgId of orgIds) {
          // Default to new rules in case there's only one orgId.
          let currentRules = newRules;
          if (orgIds.length > 1) {
            currentRules = { ...originalNotificationsByOrg[orgId] };
            for (const event in newRules) {
              Object.entries(newRules[event]).forEach(([field, value]) => {
                if (value && value !== 'varies') {
                  currentRules[event][field] = value;
                }
              });
            }
          }
          // Validate the current notification settings
          const invalidNotifications = validateNotificationsSettings(currentRules);
          if (invalidNotifications) {
            throw new CustomError({
              status: 400,
              message: 'Invalid notifications settings',
              data: { error: invalidNotifications }
            });
          }

          bulkUpdates.push({
            updateOne: {
              filter: { org: orgId },
              update: { $set: { rules: currentRules } }
            }
          });

          updatedNotificationsByOrg.set(orgId, currentRules);
        }

        await notificationsConf.bulkWrite(bulkUpdates, { session: session });
      });

      let devicesShouldReceiveJobs = 0;
      const applyPromises = [];
      let fulfilledJobs = 0;
      for (const [orgId, notificationsSettings] of updatedNotificationsByOrg.entries()) {
        const orgDevices = await devices.find({ org: orgId });
        devicesShouldReceiveJobs += orgDevices.length;
        const data = {
          rules: notificationsSettings,
          org: orgId
        };
        applyPromises.push(apply(orgDevices, user, data));
      }
      const promisesStatus = await Promise.allSettled(applyPromises);
      for (const promiseStatus of promisesStatus) {
        if (promiseStatus.status === 'fulfilled') {
          const { ids } = promiseStatus.value;
          fulfilledJobs += ids.length;
        }
      }
      const status = fulfilledJobs < devicesShouldReceiveJobs.length
        ? 'partially completed' : 'completed';
      const message = fulfilledJobs < devicesShouldReceiveJobs.length
        ? `Warning: ${fulfilledJobs} of ${devicesShouldReceiveJobs.length} Set device's notifications job added.`
        : 'The notifications were updated successfully';
      return Service.successResponse(
        { status, message }, 202
      );
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500,
        e.data
      );
    }
  }

  /**
   * Get account/system default notifications settings
   * @param account  String account ID
   * user Object
   * @return Default notification settings for either the specified account or the system.
   * If the account-specific settings are not found, system default settings will be returned.
   **/
  static async notificationsConfDefaultGET ({ account = null }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, null);
      if (orgList.length === 0) {
        return Service.rejectResponse(
          'You do not have permission for this operation', 403);
      }
      if (account) {
        if (!user?.defaultAccount?._id || account !== user.defaultAccount._id.toString()) {
          throw createError(403, 'This account does not match the one you are working with');
        }
      }
      const defaultSettings = await notificationsMgr.getDefaultNotificationsSettings(account);
      return Service.successResponse(defaultSettings);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify account default notifications settings (set rules as account default)
   * @param account  String account ID
   * user Object
   **/
  static async notificationsConfDefaultPUT ({ account, rules }, { user }) {
    try {
      await NotificationsService.validateParams(user, null, account, null, true);
      const orgList = await getAccessTokenOrgList(user, null, false, account); // make sure the user has access to all the organizations under the account

      if (orgList.length === 0) {
        throw createError(403, "You don't have permission to set default account settings");
      }

      // Verifying user permissions for organizations under the account is insufficient in this case.
      // This operation requires confirmation that the user holds an 'account owner' role
      const accountOwners = await membership.find({
        account,
        to: 'account',
        role: 'owner'
      });
      const accountOwnersIds = Object.values(accountOwners).map(membership => membership.user.toString());
      if (!accountOwnersIds.includes(user._id.toString())) {
        return Service.rejectResponse(
          'Only account owners can set the account default settings', 403);
      }
      const invalidNotifications = validateNotificationsSettings(rules);
      if (invalidNotifications) {
        throw new CustomError({
          status: 400,
          message: 'Invalid notifications settings',
          data: { error: invalidNotifications }
        });
      }
      await notificationsConf.update({ account: account }, { $set: { account: account, rules } }, { upsert: true });

      return Service.successResponse(
        { status: 'completed', message: 'Current settings successfully established as the default for new organizations' }, 202
      );
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get email notifications settings for a given organization/account/group
   * @param org  String organization ID
   * @param account  String account ID
   * @param group  String group name (must be sent with account ID)
   * user Object
   * @return Object: Returns email notification settings for a specific organization, or aggregated email notification settings
   *  for a list of organizations under the account/group.
   * The object contains nested objects with details of each subscribed user (id, signedToCritical, signedToWarning, etc.).
   **/

  static async notificationsConfEmailsGET ({ org, account, group }, { user }) {
    try {
      await NotificationsService.validateParams(user, org, account, group);
      // Fetch orgIds using 'get=false', as we need to first verify put access and then get access to determine if the user is a viewer
      let orgIds;
      orgIds = await NotificationsService.fetchOrgList(user, org, account, group, false, true);
      let isViewer = false;
      if (orgIds.length === 0) {
        orgIds = await NotificationsService.fetchOrgList(user, org, account, group, true); // try again with get = true and don't allow empty org list
        isViewer = true; // if fetchOrgList didn't throw an error the list is not empty and we know the user has "get" access but not "put" - so he is a viewer
      }
      let response = [];
      const uniqueUsers = new Set();

      const processOrganization = async (orgId, isViewer) => {
        const orgData = await Organizations.find({ _id: orgId });
        // Viewers are restricted to access only their own user details.
        // Since these details are already available in the 'user' object, we avoid making a redundant database call
        const members = isViewer ? [{ user: user._id }] : await membership.find({
          $or: [
            { to: 'organization', organization: orgId },
            { to: 'account', account: orgData[0].account },
            { to: 'group', account: orgData[0].account, group: orgData[0].group }
          ]
        });

        const notificationsData = await notificationsConf.find({ org: orgId });
        // A map for storing usersData
        const usersDataMap = new Map();

        for (const member of members) {
          const memberIdStr = member.user.toString();

          if (!uniqueUsers.has(memberIdStr)) {
            uniqueUsers.add(memberIdStr);

            if (!usersDataMap.has(memberIdStr)) {
              const userData = await users.find({ _id: member.user });
              usersDataMap.set(memberIdStr, userData[0]);
            }

            const currentUser = {
              _id: member.user,
              email: usersDataMap.get(memberIdStr).email,
              name: usersDataMap.get(memberIdStr).name,
              lastName: usersDataMap.get(memberIdStr).lastName,
              signedToCritical: notificationsData[0].signedToCritical.includes(member.user),
              signedToWarning: notificationsData[0].signedToWarning.includes(member.user),
              signedToDaily: notificationsData[0].signedToDaily.includes(member.user)
            };

            if (org) response.push(currentUser);
            else response.push({ ...currentUser, count: 1 });
          // An account or a group is given
          } else if (!org) {
            if (!usersDataMap.has(memberIdStr)) {
              const userData = await users.find({ _id: member.user });
              usersDataMap.set(memberIdStr, userData[0]);
            }

            const userIndex = response.findIndex(user => user._id.toString() === memberIdStr);
            const existingUser = response[userIndex];
            existingUser.signedToCritical = notificationsData[0].signedToCritical.includes(member.user) !== existingUser.signedToCritical ? null : existingUser.signedToCritical;
            existingUser.signedToWarning = notificationsData[0].signedToWarning.includes(member.user) !== existingUser.signedToWarning ? null : existingUser.signedToWarning;
            existingUser.signedToDaily = notificationsData[0].signedToDaily.includes(member.user) !== existingUser.signedToDaily ? null : existingUser.signedToDaily;
            existingUser.count++;
          }
        }
      };
      if (org) {
        await processOrganization(org, isViewer);
      } else {
        for (const orgId of orgIds) {
          await processOrganization(orgId, isViewer);
        }
        response = response.filter(user => user.count >= orgIds.length).map(({ count, ...user }) => user);
      }
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify email notifications settings of a given organization/account/group
   * @param org  String organization ID
   * @param account  String account ID
   * @param group  String group name (must be sent with account ID)
   * @param emailsSigning  Object which contains nested objects with the email signing details for each user (id, signToCritical, signToWarning, etc.)
   * user Object
   **/

  static async notificationsConfEmailsPUT ({ org, account, group, emailsSigning }, { user }) {
    try {
      await NotificationsService.validateParams(user, org, account, group);

      const areEmailSigningFieldsMissing = validateEmailNotifications(emailsSigning, !org);
      if (areEmailSigningFieldsMissing) {
        return Service.rejectResponse({
          code: 400,
          message: 'Missing details in email signing object',
          data: areEmailSigningFieldsMissing
        });
      }

      const emailSigningMap = Object.fromEntries(emailsSigning.map(e => [e._id, e]));
      const userIds = Object.keys(emailSigningMap);

      const usersDataList = await users.find({ _id: { $in: userIds } }).lean();
      // If one of the user ids does not exist in the db
      if (userIds.length !== usersDataList.length) {
        return Service.rejectResponse('Not all the user IDs exist in the database');
      }

      const usersDataMap = Object.fromEntries(usersDataList.map(u => [u._id.toString(), u]));

      const operations = [];

      const orgUpdates = {};

      let isViewer = false;
      let orgIds;
      orgIds = await NotificationsService.fetchOrgList(user, org, account, group, false, true);
      if (orgIds.length === 0) {
        orgIds = await NotificationsService.fetchOrgList(user, org, account, group, true); // try again with get=true
        isViewer = true; // if fetchOrgList didn't throw an error the list is not empty and we know the user has "get" access but not "put" - so he is a viewer
      }

      // The user has only viewer permissions
      if (isViewer) {
        if (userIds.length > 1 || userIds[0] !== user._id.toString()) {
          const errorMsg = 'Viewers can only modify their own email notifications settings';
          logger.warn('Error in email subscription', {
            params: {
              err: `user id ${user._id} can only modify his own email notifications in the ${
                org ? `org ${org}` : account ? `account ${account}` : `group ${group}`
              }`
            }
          });
          return Service.rejectResponse(errorMsg, 403);
        }
      }

      // Loop through each user and update their email notification settings for the provided organizations.
      // If any user doesn't have access to a given organization, log an error and reject the request.
      // Update operations are batched and executed at the end of the process.
      for (const userId of userIds) {
        const userEmailSigning = emailSigningMap[userId];
        const userData = usersDataMap[userId];
        const userOrgAccess = await getUserOrganizations(userData, undefined, undefined, user.defaultAccount._id);

        for (const org of orgIds) {
          if (!isViewer && !(org in userOrgAccess)) {
            const errorMsg = org ? 'One of the users does not have permission to access the organization'
              : `All the users must be authorized to each one of the organizations under the ${group ? 'group' : 'account'}`;
            logger.warn('Error in email subscription', { params: { err: `user id ${userData._id} is not authorized for the organization: ${org}` } });
            return Service.rejectResponse(errorMsg, 403);
          }

          if (!orgUpdates[org]) {
            orgUpdates[org] = { $pull: {}, $addToSet: {} };
          }

          ['signedToCritical', 'signedToWarning', 'signedToDaily'].forEach(field => {
            if (userEmailSigning[field] === false) {
              if (!orgUpdates[org].$pull[field]) orgUpdates[org].$pull[field] = [];
              orgUpdates[org].$pull[field].push(mongoose.Types.ObjectId(userEmailSigning._id));
            } else if (userEmailSigning[field]) {
              if (!orgUpdates[org].$addToSet[field]) orgUpdates[org].$addToSet[field] = [];
              orgUpdates[org].$addToSet[field].push(mongoose.Types.ObjectId(userEmailSigning._id));
            }
          });
        }
      }

      for (const org in orgUpdates) {
        // For each organization, loop through the operations (like $pull and $addToSet)
        for (const op in orgUpdates[org]) {
          const updateFields = {};

          const currentUpdates = orgUpdates[org][op];

          // Loop through each field in the current operation (like signedToCritical, signedToWarning, etc.)
          Object.entries(currentUpdates).forEach(([field, userIds]) => {
            // If there are user IDs specified for this field, set the update condition
            // If there's only one ID, use it directly. Otherwise, use the $each modifier to specify multiple IDs
            if (userIds.length) {
              updateFields[field] = op === '$pull' ? { $in: userIds } : (userIds.length === 1 ? userIds[0] : { $each: userIds });
            }
          });

          operations.push({
            updateOne: {
              filter: { org },
              update: { [op]: updateFields },
              upsert: true
            }
          });
        }
      }

      if (operations.length) {
        await notificationsConf.bulkWrite(operations);
      }

      return Service.successResponse('updated successfully', 204);
    } catch (e) {
      return Service.rejectResponse({
        code: e.status || 500,
        message: e.message || 'Internal Server Error'
      });
    }
  }

  /**
   * Get webhook notifications settings for a given organization/account/group
   * @param org  String organization ID
   * @param account  String account ID
   * @param group  String group name (must be sent with account ID)
   * @return Object Returns webhook notification settings for a specific organization, or aggregated email notification settings
   *  for a list of organizations under the account/group.
   **/

  static async notificationsConfWebhookGET ({ org, account, group }, { user }) {
    try {
      await NotificationsService.validateParams(user, org, account, group);
      const orgIds = await NotificationsService.fetchOrgList(user, org, account, group, true);
      const response = await notificationsConf.find({ org: { $in: orgIds.map(orgId => new ObjectId(orgId)) } }, { webHookSettings: 1, _id: 0 }).lean();
      if (org) {
        const webHookSettings = { ...response[0].webHookSettings };
        return Service.successResponse(webHookSettings);
      } else {
        const mergedSettings = {};
        for (let i = 0; i < response.length; i++) {
          Object.keys(response[i].webHookSettings).forEach(setting => {
            if (setting === '_id') {
              return;
            }
            if (!mergedSettings.hasOwnProperty(setting)) {
              mergedSettings[setting] = response[i].webHookSettings[setting];
            } else {
              if (mergedSettings[setting] !== response[i].webHookSettings[setting]) {
                mergedSettings[setting] = null;
              }
            }
          });
        }
        return Service.successResponse(mergedSettings);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify webhook notifications settings of a given organization/account/group
   * @param org  String organization ID
   * @param account  String account ID
   * @param group  String group name (must be sent with account ID)
   * @param webHookSettings  Object
   **/
  static async notificationsConfWebhookPUT ({ org: orgId, account, group, webHookSettings }, { user }) {
    try {
      await NotificationsService.validateParams(user, orgId, account, group);

      const invalidWebHookSettings = validateWebhookSettings(webHookSettings, !orgId);
      if (invalidWebHookSettings) {
        throw new CustomError({
          status: 400,
          message: 'Invalid webhook settings',
          data: invalidWebHookSettings
        });
      }

      const orgIds = await NotificationsService.fetchOrgList(user, orgId, account, group);

      const updateData = { $set: {} };
      Object.entries(webHookSettings).forEach(([field, value]) => {
        if (value !== null) {
          updateData.$set[`webHookSettings.${field}`] = value;
        }
      });

      // Only run the update if there are fields to update
      if (Object.keys(updateData.$set).length > 0) {
        await notificationsConf.updateMany({ org: { $in: orgIds } }, updateData);
      }

      return Service.successResponse('updated successfully', 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500,
        e.data
      );
    }
  }
}

module.exports = NotificationsService;
