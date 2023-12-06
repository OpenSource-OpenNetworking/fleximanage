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
const notificationsDb = require('../models/notifications');
const organizations = require('../models/organizations');
const tunnels = require('../models/tunnels');
const devicesModel = require('../models/devices').devices;
const notificationsConf = require('../models/notificationsConf');
const notifications = require('../models/notifications');
const users = require('../models/users');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'notifications' });
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const mongoose = require('mongoose');
const webHooks = require('../utils/webhooks')();
const DELAY_BEFORE_SENDING_CHILD_NOTIFICATION = 120000; // 2 mins

/**
 * Notification events hierarchy class
 */
// Initialize the events hierarchy
const hierarchyMap = {};
const suppressedNotifications = {};

class Event {
  constructor (eventName, parents, hasChildren) {
    this.eventName = eventName;
    this.parents = parents;
    this.hasChildren = hasChildren;

    hierarchyMap[eventName] = this;
  }

  get notificationsMgr () {
    if (!this._notificationsMgr) {
      this._notificationsMgr = new NotificationsManager();
    }
    return this._notificationsMgr;
  }

  getAllParents () {
    const parentNames = new Set();
    for (const parent of this.parents) {
      parentNames.add(parent.eventName);
      for (const grandParentName of parent.getAllParents()) {
        parentNames.add(grandParentName);
      }
    }
    return [...parentNames];
  }

  getTarget (deviceId, interfaceId, tunnelId) {
    // MUST BE IMPLEMENTED IN CHILD CLASSES
  }

  async checkForActiveEvent (notification) {
    // MUST BE IMPLEMENTED IN CHILD CLASSES
  }

  getQuery (deviceId, interfaceId, tunnelId) {
    const query = [];
    const parentNames = this.getAllParents();
    if (parentNames.length === 0) {
      query.push(this.getTarget(deviceId, interfaceId, tunnelId));
    }
    for (const parentName of parentNames) {
      const parent = hierarchyMap[parentName]; // Get the instance of the parent event
      query.push(parent.getTarget(deviceId, interfaceId, tunnelId));
    }
    return query;
  }
}

class DeviceConnectionEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId
    };
  }

  //  Device connection won't be suppressed since it's in the top of the hierarchy
  async checkForActiveEvent (notification) {
  }
}

class RunningRouterEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets } = notification;
    const deviceId = targets.deviceId;
    const routerIsNotRunning = await devices.findOne({ _id: deviceId, status: 'stopped' });
    return Boolean(routerIsNotRunning);
  }
}

class InternetConnectionEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets } = notification;
    const { deviceId, interfaceId } = targets;
    const internetConnectionDown = await devices.findOne({
      _id: deviceId,
      interfaces: { $elemMatch: { _id: interfaceId, internetAccess: 'no' } }
    });
    return Boolean(internetConnectionDown);
  }
}

class MissingInterfaceIPEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets } = notification;
    const { deviceId, interfaceId } = targets;
    const missingInterfaceIp = await devices.findOne({
      _id: deviceId,
      interfaces: { $elemMatch: { _id: interfaceId, IPv4: '' } }
    });
    return Boolean(missingInterfaceIp);
  }
}

class TunnelStateChangeEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.tunnelId': tunnelId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets, org } = notification;
    const tunnelId = targets.tunnelId;
    const tunnelIsDown = await tunnels.findOne({ num: tunnelId, org, status: 'down' });
    return Boolean(tunnelIsDown);
  }
}

class PendingTunnelEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.tunnelId': tunnelId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets, org } = notification;
    const tunnelId = targets.tunnelId;
    const tunnelIsPending = await tunnels.findOne({ num: tunnelId, org, isPending: true });
    return Boolean(tunnelIsPending);
  }
}

class LinkStatusEventClass extends Event {
  getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }

  async checkForActiveEvent (notification) {
    const { targets } = notification;
    const { deviceId, interfaceId } = targets;
    const linkDown = await devices.findOne({
      _id: deviceId,
      interfaces: { $elemMatch: { _id: interfaceId, linkStatus: 'down' } }
    });

    return Boolean(linkDown);
  }
}

const DeviceConnectionEvent = new DeviceConnectionEventClass('Device connection', [], true);
const LinkStatusEvent = new LinkStatusEventClass('Link status', [
  DeviceConnectionEvent], true
);
const RunningRouterEvent = new RunningRouterEventClass(
  'Running router', [LinkStatusEvent], true);
const InterfaceIpChangeEvent = new MissingInterfaceIPEventClass('Missing interface ip', [
  RunningRouterEvent], true
);
const InternetConnectionEvent = new InternetConnectionEventClass('Internet connection', [
  InterfaceIpChangeEvent], true
);
// eslint-disable-next-line no-unused-vars
const PendingTunnelEvent = new PendingTunnelEventClass('Pending tunnel', [
  InterfaceIpChangeEvent], false
);
const TunnelConnectionEvent = new TunnelStateChangeEventClass('Tunnel connection', [
  InternetConnectionEvent], true
);
// eslint-disable-next-line no-unused-vars
const RttEvent = new Event('Link/Tunnel round trip time',
  [TunnelConnectionEvent], false);
// eslint-disable-next-line no-unused-vars
const DropRateEvent = new Event('Link/Tunnel default drop rate',
  [TunnelConnectionEvent], false);

/**
 * Notification Manager class
 */
class NotificationsManager {
  /**
     * Saves notifications in the database
     * @async
     * @param  {Array} notifications an array of notification objects
     * @return {void}
     */

  async getDefaultNotificationsSettings (account) {
    let response;
    if (account) {
      response = await notificationsConf.find({ account: account }, { rules: 1, _id: 0 }).lean();
      if (response.length > 0) {
        const sortedRules = Object.fromEntries(
          Object.entries(response[0].rules).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        );
        return sortedRules;
      }
    // If the account doesn't have a default or the user asked the system default
    // retrieve the system default
    }
    if (!account || response.length === 0) {
      response = await notificationsConf.find({ name: 'Default notifications settings' },
        { rules: 1, _id: 0 }).lean();
      const sortedRules = Object.fromEntries(
        Object.entries(response[0].rules).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      );
      return sortedRules;
    }
  }

  async getUsersEmail (userIds) {
    const usersData = await users.find({ _id: { $in: userIds } });
    return usersData.map(u => u.email);
  }

  async getOrgWithAccount (orgId) {
    const orgDetails = await organizations.aggregate([
      {
        $match: { _id: mongoose.Types.ObjectId(orgId) }
      },
      {
        $lookup: {
          from: 'accounts',
          localField: 'account',
          foreignField: '_id',
          as: 'accountDetails'
        }
      },
      {
        $project: {
          name: 1,
          accountDetails: {
            $arrayElemAt: ['$accountDetails', 0]
          }
        }
      }
    ]);
    return orgDetails;
  }

  async getInfoForEmail (orgId) {
    const uiServerUrl = configs.get('uiServerUrl', 'list');

    // Use the URL object to extract the domain from the URL, excluding the port.
    const urlSchema = new URL(uiServerUrl[0]);
    const urlToDisplay = `${urlSchema.protocol}//${urlSchema.hostname}/notifications`;

    const notificationsPageInfo = uiServerUrl.length > 1 ? '' : `<p><b>Notifications page:</b>
      <a href="${uiServerUrl[0]}/notifications">${urlToDisplay}</a></p>`;
    const orgWithAccount = await this.getOrgWithAccount(orgId);
    const orgInfo = `<p><b>Organization:</b> ${orgWithAccount[0].name}</p>`;
    const accountInfo = `<p><b>Account:</b> ${orgWithAccount[0].accountDetails.name}</p>`;
    return { notificationsPageInfo, orgInfo, accountInfo };
  }

  async sendEmailNotification (title, orgNotificationsConf, severity, alertDetails) {
    try {
      const uiServerUrl = configs.get('uiServerUrl', 'list');
      const userIds = severity === 'warning' ? orgNotificationsConf.signedToWarning
        : orgNotificationsConf.signedToCritical;
      const emailAddresses = await this.getUsersEmail(userIds);
      if (emailAddresses.length === 0) return null;

      const { notificationsPageInfo, orgInfo, accountInfo } = await this.getInfoForEmail(
        orgNotificationsConf.org);

      const notificationLink = uiServerUrl.length > 1 ? ' Notifications '
        : `<a href="${uiServerUrl[0]}/notifications-config">Notifications settings</a>`;

      const emailBody = `
        <h2>${configs.get('companyName')} new notification</h2>
        <p><b>Notification details:</b> ${alertDetails}</p>
        ${notificationsPageInfo}
        ${accountInfo}
        ${orgInfo}
        <p>To make changes to the notification settings in flexiManage,
        please access the ${notificationLink} page in your flexiMange account.</p>
      `;

      await mailer.sendMailHTML(
        configs.get('mailerEnvelopeFromAddress'),
        configs.get('mailerFromAddress'),
        emailAddresses,
        '[flexiWAN Alert] ' + title,
        emailBody
      );

      logger.debug('An immediate notification email has been sent', {
        params: { emailAddresses, notificationDetails: emailBody, org: orgNotificationsConf.org }
      });

      return new Date();
    } catch (err) {
      logger.error('Failed to send an immediate email notification', {
        params: { err: err.message, alertDetails }
      });
    }
  }

  async getQueryForExistingAlert (eventType, targets, resolved, severity, org) {
    const query = {
      eventType,
      resolved,
      org: mongoose.Types.ObjectId(org),
      severity
    };
    // Different devices can trigger an alert for the same tunnel
    // So we want to include only the tunnelId and organization when searching for tunnel alerts
    if (targets.tunnelId) {
      query['targets.tunnelId'] = targets.tunnelId;
    } else {
      for (const targetKey in targets) {
        if (!targets[targetKey]) {
          continue;
        }
        query[`targets.${targetKey}`] = targets[targetKey];
      }
    }

    return query;
  }

  async checkUnresolvedAlertExistence (eventType, targets, org, severity) {
    try {
      const query = await this.getQueryForExistingAlert(eventType, targets, false, severity, org);
      const existingAlert = await notifications.findOne(query);
      return Boolean(existingAlert);
    } catch (err) {
      logger.warn(`Failed to search for notification ${eventType} in database`, {
        params: { notifications: notifications, err: err.message }
      });
      return false;
    }
  }

  /**
 * Checks for active child notifications after a parent notification has been resolved.
 *
 * This function iterates through all suppressed notifications to check if any are associated
 * with the resolved parent notification (identified by its ID). If a child notification no longer
 * has any blocking parents after the resolution of a parent, it triggers the respective event
 * to send the suppressed notification if needed.
 *
 * @param {string} resolvedParentId - The unique identifier of the resolved parent notification.
 */
  async checkForActiveChildrenAfterParentResolution (resolvedParentId) {
    for (const [alertUniqueKey, suppressedNotification] of
      Object.entries(suppressedNotifications)) {
      const { blockingParents, notification } = suppressedNotification;
      if (blockingParents.has(resolvedParentId)) {
        blockingParents.delete(resolvedParentId);
        if (blockingParents.size === 0) {
          const event = hierarchyMap[notification.eventType];
          setTimeout(async () => {
            try {
              const shouldSendChildNotification = await event.checkForActiveEvent(
                notification, alertUniqueKey
              );
              if (shouldSendChildNotification) {
                logger.debug('Found active child event after parent resolution',
                  {
                    params: {
                      resolvedParentNotification: resolvedParentId,
                      suppressedNotification: notification
                    }
                  });
                this.sendNotifications([notification]);
              } else {
                logger.debug(
                  'Did not find active child event. Deleting from suppressed notifications list.',
                  {
                    params: {
                      resolvedParentNotification: resolvedParentId,
                      suppressedNotification: notification
                    }
                  });
                delete suppressedNotifications[alertUniqueKey];
              }
            } catch (error) {
              logger.error('Error sending suppressed notification:', { params: { error } });
            }
          }, DELAY_BEFORE_SENDING_CHILD_NOTIFICATION);
        }
      }
    }
  }

  async resolveAnAlert (eventType, targets, severity, org) {
    try {
      const query = await this.getQueryForExistingAlert(
        eventType, targets, false, severity, org);
      const updatedAlert = await notifications.findOneAndUpdate(
        query,
        { $set: { resolved: true } },
        { new: true }
      );
      logger.debug('Resolved existing notification',
        { params: { idOfResolvedNotification: updatedAlert._id } });
      const event = hierarchyMap[eventType];
      if (event && event.hasChildren) { // If this is a parent, check for active children events
        this.checkForActiveChildrenAfterParentResolution(updatedAlert._id);
      }
    } catch (err) {
      logger.error(`Failed to resolve the notification ${eventType} in database`, {
        params: { notifications: notifications, err: err.message }
      });
    }
  }

  async sendWebHook (title, details, severity, orgNotificationsConf) {
    const webHookMessage = {
      title,
      details,
      severity
    };
    const { webhookURL, sendCriticalAlerts, sendWarningAlerts } =
    orgNotificationsConf.webHookSettings;
    if ((severity === 'warning' && sendWarningAlerts) ||
    (severity === 'critical' && sendCriticalAlerts)) {
      const title = `New ${configs.get('companyName')} notification`;
      if (!await webHooks.sendToWebHook(webhookURL, webHookMessage, '',
        title)) {
        logger.error('Failed to send an immediate webhook notification', {
          params: { message: webHookMessage }
        });
      } else {
        logger.debug('An immediate webhook notification has been sent', {
          params: { message: webHookMessage }
        });
      }
    }
  }

  async sendNotifications (notifications) {
    try {
      const parentsQueryToNotification = new Map();
      const existingAlertSet = new Set();
      const tunnelsDataMap = new Map();

      const orgsMap = new Map();
      const orgNotificationsMap = new Map();
      for (const notification of notifications) {
        logger.debug('Processing notification', { params: { notification } });
        const {
          org, details, eventType, title, severity = null,
          targets, resolved = false, isInfo = false
        } = notification;
        let orgNotificationsConf = orgNotificationsMap.get(org);
        if (!orgNotificationsConf) {
          orgNotificationsConf = await notificationsConf.findOne({ org: org }).lean();
          orgNotificationsMap.set(org, orgNotificationsConf);
        }

        const rules = orgNotificationsMap.get(org).rules;
        const sendResolvedAlert = rules[eventType].resolvedAlert;
        let currentSeverity;
        if (!severity) {
          currentSeverity = rules[eventType].severity;
          notification.severity = currentSeverity;
        }
        let existingUnresolvedAlert = false;
        const alertUniqueKey = eventType + '_' + org + '_' + JSON.stringify(targets) +
          '_' + severity;
        if (existingAlertSet.has(alertUniqueKey)) {
          existingUnresolvedAlert = true;
        } else {
          existingUnresolvedAlert = await this.checkUnresolvedAlertExistence(
            eventType, targets, org, severity || currentSeverity);
          if (existingUnresolvedAlert) {
            existingAlertSet.add(alertUniqueKey);
          }
        }

        // If this is a resolved alert: resolve the existing notification
        if (resolved && !isInfo && existingUnresolvedAlert) {
          await this.resolveAnAlert(eventType, targets, severity || currentSeverity, org);
        }

        // Send an alert only if one of the both is true:
        // 1. This isn't a resolved alert and there is no existing alert
        // 2. This is a resolved alert, there is unresolved alert in the db,
        // and the user has defined to send resolved alerts
        // 3. This is an info alert
        const conditionToSend = ((!resolved && !existingUnresolvedAlert) ||
          (resolved && sendResolvedAlert && existingUnresolvedAlert) ||
          (isInfo));
        logger.debug('Step 1: Initial check for sending alert. Decision: ' +
          (conditionToSend ? 'proceed to step 2' : 'do not send'), {
          params: {
            details: {
              'Notification content': notification,
              'Is there an existing alert?': existingUnresolvedAlert,
              'Is sending resolved alerts defined for this type?': sendResolvedAlert
            }
          }
        });

        // If this is a new notification or a resolved one
        // which we want to notify about it's resolution
        if (conditionToSend) {
          const event = hierarchyMap[eventType];
          // If the event exists in the hierarchy check if there is already a parent event in the db
          // Exclude resolved alerts, as an unresolved alert is guaranteed to exist,
          // having been created once its parent alerts were resolved.
          if (event && !resolved) {
            logger.debug('Step 2: Event exists in hierarchy. Checking for parent notifications.');
            let interfaceId, deviceId;
            if (targets.tunnelId) {
              let tunnel;
              const tunnelKey = org + '_' + targets.tunnelId;
              if (tunnelsDataMap.has(tunnelKey)) {
                tunnel = tunnelsDataMap.get(tunnelKey);
              } else {
                tunnel = await tunnels.findOne({
                  org,
                  num: targets.tunnelId,
                  $or: [
                    { deviceA: targets.deviceId },
                    { deviceB: targets.deviceId }
                  ],
                  isActive: true
                }).lean();
                tunnelsDataMap.set(tunnelKey, tunnel);
              }
              if (tunnel) {
                const interfaces = [tunnel.interfaceA];
                if (!tunnel.peer) {
                  interfaces.push(tunnel.interfaceB);
                }
                interfaceId = {
                  $in: interfaces
                };
                const devices = [tunnel.deviceA, tunnel.deviceB];
                deviceId = {
                  $in: devices
                };
              }
            }
            const eventParents = event.getAllParents();
            if (eventParents.length > 0) {
              const parentsQuery = event.getQuery(deviceId || targets.deviceId, interfaceId ||
                   targets.interfaceId, targets.tunnelId);
              const queryKey = JSON.stringify({ org, parentsQuery });
              let parentNotifications; // We might have more than one parent (foreign events)

              if (parentsQueryToNotification.has(queryKey)) {
                parentNotifications = parentsQueryToNotification.get(queryKey);
              } else {
                parentNotifications = await notificationsDb.find(
                  { resolved: false, org, $or: parentsQuery });
                parentsQueryToNotification.set(queryKey, parentNotifications);
              }

              if (parentNotifications.length > 0) {
                if (!suppressedNotifications[alertUniqueKey]) {
                  suppressedNotifications[alertUniqueKey] = {
                    notification: null,
                    blockingParents: new Set()
                  };
                }

                suppressedNotifications[alertUniqueKey].notification = notification;
                for (const parentNotification of parentNotifications) {
                  suppressedNotifications[alertUniqueKey].blockingParents.add(
                    parentNotification._id);
                }
                logger.debug('Step 3: Parent notifications found. Skipping notification sending.',
                  { params: { notification } });
                continue; // Ignore since there is a parent event
              }

              logger.debug(
                'Step 3: No parent notifications found. Proceeding to send notification.',
                { params: { notification } });

              // Since the RTT and the drop rate remains high for a few mins after the parent alert
              // Has been resolved, we would like to ignore these alerts
              if (['Link/Tunnel round trip time',
                'Link/Tunnel default drop rate'].includes(eventType)) {
                const fiveMinutesAgo = new Date(new Date() - 5 * 60 * 1000);
                const resolvedParentNotification = await notificationsDb.find(
                  { resolved: true, org, updatedAt: { $gte: fiveMinutesAgo }, $or: parentsQuery });
                if (resolvedParentNotification.length > 0) {
                  continue; // Ignore since there is a recently resolved parent event
                }
              }
            }
          } else {
            logger.debug('Step 2: No need to check hierarchy. Proceeding to send notification.');
          }
          if (rules[eventType].immediateEmail) {
            // Check if there is already an event like this for the same device(for device alerts)
            const emailSentForPreviousAlert = !targets.deviceId ? null
              : await notificationsDb.findOne({
                eventType: eventType,
                title: title, // ensures that we will send email for resolved alerts,
                'targets.deviceId': targets.deviceId,
                'targets.tunnelId': null,
                'targets.interfaceId': null,
                // 'targets.policyId': null,
                'emailSent.sendingTime': { $exists: true, $ne: null }
              }).lean();

            let shouldSendEmail = false;
            if (emailSentForPreviousAlert) {
              const emailRateLimitPerDevice = configs.get('emailRateLimitPerDevice');
              const timeSinceLastEmail = new Date() -
                 emailSentForPreviousAlert.emailSent.sendingTime;
              const timeSinceLastEmailInMinutes = Math.ceil(timeSinceLastEmail / (1000 * 60));
              // Send an email if 60 minutes have passed since the last one (for the event+device)
              if (emailRateLimitPerDevice < timeSinceLastEmailInMinutes) {
                shouldSendEmail = true;
              } else {
                // Increment the rate limit count if not sending an email
                await notificationsDb.findOneAndUpdate(
                  {
                    eventType: eventType,
                    'targets.deviceId': targets.deviceId,
                    'targets.tunnelId': null,
                    'targets.interfaceId': null,
                    'emailSent.sendingTime': { $exists: true, $ne: null }
                  },
                  { $inc: { 'emailSent.rateLimitedCount': 1 } }
                );
              }
            } else {
              shouldSendEmail = true;
            }

            // Send the email if necessary
            if (shouldSendEmail) {
              const emailSent = await this.sendEmailNotification(
                title,
                orgNotificationsConf,
                severity || notification.severity,
                details
              );
              if (!notification.emailSent) {
                notification.emailSent = {
                  sendingTime: null,
                  rateLimitedCount: 0
                };
              }
              // Update notification details if an email was sent
              notification.emailSent.sendingTime = emailSent;
            }
          }
          if (rules[eventType].sendWebHook) {
            await this.sendWebHook(title, details,
              severity || notification.severity, orgNotificationsConf);
          }
          const key = notification.org.toString();
          const notificationList = orgsMap.get(key);
          if (!notificationList) orgsMap.set(key, []);
          orgsMap.get(key).push(notification);
        }
      }
      // Get the accounts of the notifications by the organization
      // Since we can have notification with different organization IDs
      // We have to first create a map that maps an organization to all
      // the notifications that belongs to it, which we'll use later
      // to add the proper account ID to each of the notifications.
      // Create an array of org ID and account ID pairs
      const orgIDs = Array.from(orgsMap.keys()).map(key => {
        return mongoose.Types.ObjectId(key);
      });
      const orgsWithAccounts = await organizations.aggregate([
        { $match: { _id: { $in: orgIDs } } },
        {
          $group: {
            _id: '$_id',
            accountID: { $push: '$$ROOT.account' }
          }
        }
      ]);
      const bulkWriteOps = [];

      let notificationList;

      // Go over all accounts and update all notifications that
      // belong to the organization to which the account belongs.
      orgsWithAccounts.forEach(org => {
        notificationList = orgsMap.get(org._id.toString());
        const currentTime = new Date();
        notificationList.forEach(notification => {
          notification.account = org.accountID;
          notification.time = currentTime;
          bulkWriteOps.push({ insertOne: { document: notification } });
        });
      });

      if (bulkWriteOps.length > 0) {
        await notificationsDb.bulkWrite(bulkWriteOps);
        // Log notification for logging systems
        logger.info('New notifications', { params: { notifications: notificationList } });
      }
    } catch (err) {
      logger.error('Failed to store notifications in database', {
        params: { notifications: notifications, err: err.message }
      });
    }
  }

  /**
     * Sends emails to notify users with
     * pending unread notifications.
     * @async
     * @return {void}
     */
  async sendDailySummaryEmail () {
    let orgIDs = [];
    try {
      orgIDs = await notificationsDb.distinct('org', { status: 'unread' });
    } catch (err) {
      logger.warn('Failed to get organization IDs with pending notifications', {
        params: { err: err.message }
      });
    }
    // Notify users only if there are unread notifications
    for (const orgID of orgIDs) {
      try {
        const orgNotificationsConf = await notificationsConf.findOne({ org: orgID }).lean();
        if (!orgNotificationsConf) continue;

        const emailAddresses = await this.getUsersEmail(orgNotificationsConf.signedToDaily);
        if (emailAddresses.length === 0) continue;

        const messages = await notificationsDb.find({ org: orgID, status: 'unread' }
          , 'time targets.deviceId details')
          .sort({ time: -1 })
          .limit(configs.get('unreadNotificationsMaxSent', 'number'))
          .populate('targets.deviceId', 'name -_id', devicesModel)
          .lean();

        // Filter out notifications where the device has been deleted
        const existingDevicesMessages = messages.filter(message => message.targets.deviceId);

        const uiServerUrl = configs.get('uiServerUrl', 'list');
        const { notificationsPageInfo, orgInfo, accountInfo } = await this.getInfoForEmail(
          orgID);

        const emailBody = `
          <h2>${configs.get('companyName')} Notifications Reminder</h2>
          <p style="font-size:16px">This email was sent to you
          since you have pending unread notifications.</p>
          <i><small>
            <ul>
              ${existingDevicesMessages.map(message => `
                <li>
                  ${message.time.toISOString().replace(/T/, ' ').replace(/\..+/, '')}
                  device ${message.targets.deviceId.name}
                  - ${message.details}
                </li>
              `).join('')}
            </ul>
          </small></i>
          ${notificationsPageInfo}
          ${accountInfo}
          ${orgInfo}
          <p style="font-size:16px"> Further to this email,
          all Notifications in your Account have been set to status Read.
          <br>To view the notifications, please check the
          ${uiServerUrl.length > 1
            ? ' Notifications '
            : `<a href="${uiServerUrl[0]}/notifications">Notifications</a>`
          }
           page in your flexiMange account.</br>
          </p>
          <p style="font-size:16px;color:gray">Note: Unread notification email alerts
           are sent only to the subscribed users.
            You can change the subscription in the
            ${uiServerUrl.length > 1
              ? ' email notifications section in the '
              : `<a href="${uiServerUrl[0]}/notifications-config">notification settings </a>`
            }
             page in your flexiManage account.
             More about notifications
             <a href="https://docs.flexiwan.com/troubleshoot/notifications.html">here</a>.</p>
          <p style="font-size:16px">Your friends @ ${configs.get('companyName')}</p>`;

        await mailer.sendMailHTML(
          configs.get('mailerEnvelopeFromAddress'),
          configs.get('mailerFromAddress'),
          emailAddresses,
          'Pending unread notifications',
          emailBody
        );

        logger.info('A daily notifications summary email has been sent', {
          params: { emailAddresses: emailAddresses }
        });
      } catch (err) {
        logger.warn('Failed to notify users about pending notifications', {
          params: { err: err.message, organization: orgID }
        });
      }
    }
    try {
      // Set status 'read' to all notifications
      await notificationsDb.updateMany(
        { status: 'unread' },
        { $set: { status: 'read' } }
      );
    } catch (err) {
      logger.warn('Failed to set status read to all notifications', {
        params: { err: err.message }
      });
    }
  }

  /**
 * Asynchronously resolves notifications associated with deleted tunnels.
 * It updates notifications by setting their 'resolved' field to true.
 *
 * @param {Array} entityIds - The identifiers of the deleted tunnels (tunnel numbers).
 * @param {String} orgId - Organization id.
 * @returns {Promise<void>} - A promise that resolves when the operation is complete.
 *
 * @throws Will throw an error if the database operation fails.
 */
  async resolveNotificationsOfDeletedTunnels (tunnelIds, orgId) {
    const bulkOperations = tunnelIds.map(id => ({
      updateOne: {
        filter: {
          'targets.tunnelId': id,
          org: orgId,
          resolved: false
        },
        update: { $set: { resolved: true } }
      }
    }));

    try {
      const updateResult = await notifications.bulkWrite(bulkOperations);

      if (updateResult.nModified > 0) {
        logger.debug('Resolved notifications of deleted tunnels', {
          params: { count: updateResult.nModified }
        });
      } else {
        logger.debug('No notifications found to resolve');
      }
    } catch (err) {
      logger.error('Failed to resolve notifications in database of deleted tunnels', {
        params: { error: err.message, ids: tunnelIds }
      });
    }
  }
}

let notificationsMgr = null;
module.exports = function () {
  if (notificationsMgr) return notificationsMgr;
  notificationsMgr = new NotificationsManager();
  return notificationsMgr;
};
