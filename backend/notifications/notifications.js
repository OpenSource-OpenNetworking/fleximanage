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
const { membership } = require('../models/membership');
const logger = require('../logging/logging')({ module: module.filename, type: 'notifications' });
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const mongoose = require('mongoose');

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
  async sendNotifications (notifications) {
    try {
      // Get the accounts of the notifications by the organization
      // Since we can have notification with different organization IDs
      // We have to fist create a map that maps an organization to all
      // the notifications that belongs to it, which we'll use later
      // to add the proper account ID to each of the notifications.
      const orgsMap = new Map();
      notifications.forEach(notification => {
        const key = notification.org.toString();
        const notificationList = orgsMap.get(key);
        if (!notificationList) orgsMap.set(key, []);
        orgsMap.get(key).push(notification);
      });

      // Create an array of org ID and account ID pairs
      const orgIDs = Array.from(orgsMap.keys()).map(key => {
        return mongoose.Types.ObjectId(key);
      });
      const accounts = await organizations.aggregate([
        { $match: { _id: { $in: orgIDs } } },
        {
          $group: {
            _id: '$_id',
            accountID: { $push: '$$ROOT.account' }
          }
        }
      ]);

      // Go over all accounts and update all notifications that
      // belong to the organization to which the account belongs.
      accounts.forEach(account => {
        const notificationList = orgsMap.get(account._id.toString());
        notificationList.forEach(notification => { notification.account = account.accountID; });
      });

      await notificationsDb.insertMany(notifications);
      // Log notification for logging systems
      logger.info('New notifications', { params: { notifications: notifications } });
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
    try {
      const accountIDs = await notificationsDb.aggregate([
        { $match: { status: 'unread' } },
        { $group: { _id: '$account', messages: { $push: '$$ROOT' } } },
        {
          $project: {
            messages: { $slice: ['$messages', configs.get('unreadNotificationsMaxSent', 'number')] }
          }
        }
      ]);

      // Notify users only if there are unread notifications
      for (const accountID of accountIDs) {
        const res = await membership.aggregate([
          {
            $match: {
              $and: [
                { account: accountID._id },
                { to: 'account' },
                { role: 'owner' }
              ]
            }
          },
          {
            $lookup: {
              from: 'users',
              localField: 'user',
              foreignField: '_id',
              as: 'users'
            }
          },
          { $unwind: '$users' },
          { $addFields: { email: '$users.email' } },
          {
            $lookup: {
              from: 'accounts',
              localField: 'account',
              foreignField: '_id',
              as: 'accounts'
            }
          },
          { $unwind: '$accounts' },
          { $addFields: { notify: '$accounts.enableNotifications' } }
        ]);

        // Send a reminder email to each email address that belongs to the account
        const emailAddresses = res.reduce(
          (result, { email, notify }) =>
            notify ? result.concat(email) : result,
          []
        );
        if (emailAddresses.length) {
          await mailer.sendMailHTML(
            configs.get('mailerFromAddress'),
            emailAddresses,
            'Pending unread notifications',
            `<h2>${configs.get('companyName')} Notification Reminder</h2>
            <p style="font-size:16px">This email was sent to you since you have pending
             unread notifications. </p>
            <ul>
              ${accountID.messages.map(message => `
              <li>
                <i>${message.time.toISOString().replace(/T/, ' ').replace(/\..+/, '')}</i>
                : ${message.details}
              </li>
              `).join('')}
            </ul>
            <p> All new notifications status set to read.
            <br>To view the notifications, please check the
            <a href="${configs.get('uiServerUrl')}/notifications">Notifications</a>
             page in your flexiMange account.</br>
            </p>
            <p style="font-size:14px;color:gray">Note: Unread notification email alerts
             are sent to Account owners (not Users in Organization level).
              You can disable these emails in the
               <a href="${configs.get('uiServerUrl')}/accounts/update">Account profile</a>
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
      }
      // Set status 'read' to all notifications
      await notificationsDb.updateMany(
        { status: 'unread' },
        { $set: { status: 'read' } }
      );
    } catch (err) {
      logger.warn('Failed to notify users about pending notifications', {
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
