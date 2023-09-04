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
const logger = require('../logging/logging')({ module: module.filename, type: 'notifications' });
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const mongoose = require('mongoose');
const webHooks = require('../utils/webhooks')();

/**
 * Notification events hierarchy class
 */
// Initialize the events hierarchy
const hierarchyMap = {};

class Event {
  constructor (eventName, parents) {
    this.eventName = eventName;
    this.parents = parents;

    hierarchyMap[eventName] = this;
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

  async getTarget (deviceId, interfaceId, tunnelId) {
    // MUST BE IMPLEMENTED IN CHILD CLASSES
  }

  async getQuery (deviceId, interfaceId, tunnelId) {
    const query = [];
    const parentNames = this.getAllParents();
    if (parentNames.length === 0) {
      query.push(await this.getTarget(deviceId, interfaceId, tunnelId));
    }
    for (const parentName of parentNames) {
      const parent = hierarchyMap[parentName]; // Get the instance of the parent event
      query.push(await parent.getTarget(deviceId, interfaceId, tunnelId));
    }
    return query;
  }
}

class DeviceConnectionEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId
    };
  }
}

class RunningRouterEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId
    };
  }
}

class InternetConnectionEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }
}

class MissingInterfaceIPEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }
}

class TunnelStateChangeEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.tunnelId': tunnelId
    };
  }
}

class LinkStatusEventClass extends Event {
  async getTarget (deviceId, interfaceId, tunnelId) {
    return {
      eventType: this.eventName,
      'targets.deviceId': deviceId,
      'targets.interfaceId': interfaceId
    };
  }
}

const DeviceConnectionEvent = new DeviceConnectionEventClass('Device connection', []);
const RunningRouterEvent = new RunningRouterEventClass('Running router', [DeviceConnectionEvent]);
const LinkStatusEvent = new LinkStatusEventClass('Link status', [
  RunningRouterEvent
]);
const InternetConnectionEvent = new InternetConnectionEventClass('Internet connection', [
  LinkStatusEvent
]);
const InterfaceIpChangeEvent = new MissingInterfaceIPEventClass('Missing interface ip', [
  LinkStatusEvent
]);
const PendingTunnelEvent = new TunnelStateChangeEventClass('Pending tunnel', [
  LinkStatusEvent
]);
const TunnelConnectionEvent = new TunnelStateChangeEventClass('Tunnel connection', [
  LinkStatusEvent
]);
// eslint-disable-next-line no-unused-vars
const RttEvent = new Event('Link/Tunnel round trip time',
  [InternetConnectionEvent, InterfaceIpChangeEvent, PendingTunnelEvent, TunnelConnectionEvent]);
// eslint-disable-next-line no-unused-vars
const DropRateEvent = new Event('Link/Tunnel default drop rate',
  [InternetConnectionEvent, InterfaceIpChangeEvent, PendingTunnelEvent, TunnelConnectionEvent]);

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

  async sendEmailNotification (title, orgNotificationsConf, severity, emailBody) {
    const userIds = severity === 'warning' ? orgNotificationsConf.signedToWarning
      : orgNotificationsConf.signedToCritical;
    const emailAddresses = await this.getUsersEmail(userIds);
    if (emailAddresses.length > 0) {
      await mailer.sendMailHTML(
        configs.get('mailerEnvelopeFromAddress'),
        configs.get('mailerFromAddress'),
        emailAddresses,
        title,
        (`<p>Please be aware that ${emailBody.toLowerCase()}.</p>
            </p>To make changes to the notification settings in flexiManage, 
            please access the "Account -> Notifications" section</p>`)
      );
      return new Date();
    }
    return null;
  }

  async getQueryForExitingAlert (eventType, targets, resolved, severity, org) {
    const query = {
      eventType: { $regex: eventType, $options: 'i' },
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

  async increaseCount (eventType, targets, org, resolved = false, severity = null) {
    let query;
    try {
      query = await this.getQueryForExitingAlert(eventType, targets, false, severity, org);

      if (resolved) {
        // If resolved is true, only find the document
        const alert = await notifications.findOne(query);
        return alert;
      } else {
        // Else, find the document and increase the count
        const updatedAlert = await notifications.findOneAndUpdate(
          query,
          { $inc: { count: 1 } },
          { new: true }
        );
        return updatedAlert;
      }
    } catch (err) {
      logger.warn(`Failed to increase count of the notification ${eventType} in database`, {
        params: {
          query,
          err: err.message
        }
      });
    }
  }

  async resolveAnAlert (eventType, targets, severity, org) {
    let query;
    try {
      query = await this.getQueryForExitingAlert(
        eventType, targets, false, severity, org);
      const updatedAlert = await notifications.findOneAndUpdate(
        query,
        { $set: { resolved: true } },
        { new: true }
      );
      return updatedAlert;
    } catch (err) {
      logger.warn(`Failed to resolve the notification ${eventType} in database.`, {
        params: {
          query,
          err: err.message
        }
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
      await webHooks.sendToWebHook(webhookURL,
        webHookMessage,
        ''
      );
    }
  }

  async sendNotifications (notifications) {
    try {
      const orgsMap = new Map();
      const orgNotificationsMap = new Map();
      for (const notification of notifications) {
        const {
          org, details, eventType, title, severity = null,
          targets, resolved = false, isAlwaysResolved = false
        } = notification;
        let orgNotificationsConf = orgNotificationsMap.get(org);
        if (!orgNotificationsConf) {
          orgNotificationsConf = await notificationsConf.findOne({ org: org });
          orgNotificationsMap.set(org, orgNotificationsConf);
        }

        const rules = orgNotificationsMap.get(org).rules;
        const sendResolvedAlert = rules[eventType].resolvedAlert;
        let currentSeverity;
        if (!severity) {
          currentSeverity = rules[eventType].severity;
          notification.severity = currentSeverity;
        }
        const existingAlert = await this.increaseCount(
          eventType,
          targets,
          org,
          resolved,
          severity || currentSeverity
        );
        // Send an alert only if one of the both is true:
        // 1. This isn't a resolved alert and there is no existing alert
        // 2. This is a resolved alert, there is unresolved alert in the db,
        // and the user has defined to send resolved alerts
        const conditionToSend = ((!resolved && !existingAlert) ||
        (resolved && sendResolvedAlert && (Boolean(existingAlert))));
        // If this is a new notification or a resolved one
        // which we want to notify about it's resolution
        if (conditionToSend) {
          const event = hierarchyMap[eventType];
          // If the event exists in the hierarchy check if there is already a parent event in the db
          if (event) {
            let interfaceId, deviceId;
            if (targets.tunnelId) {
              const tunnel = await tunnels.findOne({
                org,
                num: targets.tunnelId,
                $or: [
                  { deviceA: targets.deviceId },
                  { deviceB: targets.deviceId }
                ],
                isActive: true
              });
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
            const eventParents = await event.getAllParents();
            if (eventParents.length > 0) {
              const parentsQuery = await event.getQuery(deviceId || targets.deviceId, interfaceId ||
                   targets.interfaceId, targets.tunnelId);
              const parentNotification = await notificationsDb.find(
                { resolved, org, $or: parentsQuery });
              if (parentNotification.length > 0) {
                continue; // Ignore since there is a parent event
              }

              // Since the RTT and the drop rate remains high for a few mins after the parent alert
              // Has been resolved, we would like to ignore these alerts
              if (!resolved && ['Link/Tunnel round trip time',
                'Link/Tunnel default drop rate'].includes(eventType)) {
                const fiveMinutesAgo = new Date(new Date() - 5 * 60 * 1000);
                const resolvedParentNotification = await notificationsDb.find(
                  { resolved: true, org, updatedAt: { $gte: fiveMinutesAgo }, $or: parentsQuery });
                if (resolvedParentNotification.length > 0) {
                  continue; // Ignore since there is a recently resolved parent event
                }
              }
            }
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
              });

            let shouldSendEmail = false;
            if (emailSentForPreviousAlert) {
              const emailRateLimitPerDevice = configs.get('emailRateLimitPerDevice');
              const timeSinceLastEmail = new Date() -
               emailSentForPreviousAlert.emailSent.sendingTime;
              const timeSinceLastEmailInMinutes = Math.ceil(timeSinceLastEmail / (1000 * 60));
              // Send an email for the event and device if 60 minutes have passed since the last one
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
        // Now resolve the existing notification if needed
        // (also if we didn't create a resolved alert)
        if (resolved && !isAlwaysResolved && existingAlert) {
          await this.resolveAnAlert(eventType,
            targets,
            severity || notification.severity,
            org);
        }
      }
      // Get the accounts of the notifications by the organization
      // Since we can have notification with different organization IDs
      // We have to fist create a map that maps an organization to all
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

      // Go over all accounts and update all notifications that
      // belong to the organization to which the account belongs.
      orgsWithAccounts.forEach(org => {
        const notificationList = orgsMap.get(org._id.toString());
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
        logger.info('New notifications', { params: { notifications: notifications } });
      }
    } catch (err) {
      logger.warn('Failed to store notifications in database', {
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
  async notifyUsersByEmail () {
    // Extract email addresses of users with pending unread notifications.
    // This has to be done in two phases, as mongodb does not
    // support the 'lookup' command across different databases:
    // 1. Get the list of account IDs with pending notifications.
    // 2. Go over the list, populate the users and send them emails.
    let orgIDs = [];
    try {
      orgIDs = await notificationsDb.distinct('org', { status: 'unread' });
    } catch (err) {
      logger.warn('Failed to get account IDs with pending notifications', {
        params: { err: err.message }
      });
    }
    // Notify users only if there are unread notifications
    for (const orgID of orgIDs) {
      try {
        const orgNotificationsConf = await notificationsConf.findOne({ org: orgID });
        const emailAddresses = await this.getUsersEmail(orgNotificationsConf.signedToDaily);
        if (emailAddresses.length > 0) {
          const organization = await organizations.findOne({ _id: orgID }, { account: 1, name: 1 });

          const messages = await notificationsDb.find(
            { org: orgID, status: 'unread' },
            'time targets.deviceId details'
          )
            .sort({ time: -1 })
            .limit(configs.get('unreadNotificationsMaxSent', 'number'))
            .populate('targets.deviceId', 'name -_id', devicesModel).lean();

          const uiServerUrl = configs.get('uiServerUrl', 'list');
          await mailer.sendMailHTML(
            configs.get('mailerEnvelopeFromAddress'),
            configs.get('mailerFromAddress'),
            emailAddresses,
            'Pending unread notifications',
            `<h2>${configs.get('companyName')} Notification Reminder</h2>
            <p style="font-size:16px">This email was sent to you since you have pending
             unread notifications in the organization
             "${organization ? organization.name : 'Deleted'} : 
             ${orgID.toString().substring(0, 13)}".</p>
             <i><small>
             <ul>
              ${messages.map(message => `
              <li>
                ${message.time.toISOString().replace(/T/, ' ').replace(/\..+/, '')}
                device ${message.targets.deviceId ? message.targets.deviceId.name : 'Deleted'}
                - ${message.details}
              </li>
              `).join('')}
            </ul>
            </small></i>
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
             are sent to Account owners (not Users in Organization level).
              You can disable these emails in the
              ${uiServerUrl.length > 1
                ? ' Account profile '
                : `<a href="${uiServerUrl[0]}/accounts/update">Account profile</a>`
              }
               page in your flexiManage account. Alerts on new flexiEdge software versions
               or billing information are always sent, regardless of the notifications settings.
               More about notifications
               <a href="https://docs.flexiwan.com/troubleshoot/notifications.html">here</a>.</p>
            <p style="font-size:16px">Your friends @ ${configs.get('companyName')}</p>`
          );

          logger.info('User notifications reminder email sent', {
            params: { emailAddresses: emailAddresses }
          });
        }
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
}

let notificationsMgr = null;
module.exports = function () {
  if (notificationsMgr) return notificationsMgr;
  notificationsMgr = new NotificationsManager();
  return notificationsMgr;
};
