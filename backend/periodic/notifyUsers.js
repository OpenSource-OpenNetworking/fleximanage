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
const notificationsMgr = require('../notifications/notifications')();
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));

/***
 * This class runs once a day and notifies users about pending notifications
 *
 ***/
class NotifyUsers {
  /**
     * Creates an instance of the NotifyUsers class
     */
  constructor () {
    this.start = this.start.bind(this);
    this.periodicNotifyUsers = this.periodicNotifyUsers.bind(this);

    // Task information
    this.taskInfo = {
      name: 'notify_users',
      func: this.periodicNotifyUsers,
      handle: null,
      // Period for sending unread notifications
      period: configs.get('unreadNotificationPeriod', 'number')
    };
  }

  /**
     * Starts the notify_users periodic task
     * @return {void}
     */
  start () {
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask(name);
  }

  /**
     * Go over all users and send emails to those
     * with pending unread user notifications.
     * @return {void}
     */
  periodicNotifyUsers () {
    ha.runIfActive(() => {
      // Send a reminder email for users with
      // pending unread notifications
      notificationsMgr.notifyUsersByEmail();
    });
  }
}

var notifyUsers = null;
module.exports = function () {
  if (notifyUsers) return notifyUsers;
  notifyUsers = new NotifyUsers();
  return notifyUsers;
};
