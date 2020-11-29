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

const fetchUtils = require('../utils/fetchUtils');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const notificationsMgr = require('../notifications/notifications')();
const deviceSwVersion = require('../models/deviceSwVersions');
const Accounts = require('../models/accounts');
const { devices } = require('../models/devices');
const { membership } = require('../models/membership');
const { verifyAgentVersion } = require('../versioning');
const configs = require('../configs')();
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);

const dummyVersionObject = {
  versions: {
    device: '0.0.0',
    router: '00.00.00',
    agent: '0.0.0',
    frr: '0.0',
    vpp: '00.00-rc0'
  },
  versionDeadline: new Date(0)
};
/***
 * This class serves as the software update manager, responsible for
 * polling our package repository for new software versions, and take
 * the necessary actions when a new version is released.
 ***/
class SwVersionUpdateManager {
  /**
     * Creates a SwVersionUpdateManager instance
     * @param  {Object} versions the versions of a device and its sub components
     * @param  {Object} deadline the last date to install the new release
     */
  constructor () {
    this.swRepoUri = configs.get('SwRepositoryUrl');
    this.notificationEmailUri = configs.get('SwVersionUpdateUrl');

    this.getLatestSwVersions = this.getLatestSwVersions.bind(this);
    this.notifyUsers = this.notifyUsers.bind(this);
    this.getVersionUpDeadline = this.getVersionUpDeadline.bind(this);
    this.updateSwLatestVersions = this.updateSwLatestVersions.bind(this);
    this.getLatestDevSwVersion = this.getLatestDevSwVersion.bind(this);
  }

  /**
   * A static singleton that creates a SwVersionUpdateManager.
   *
   * @static
   * @return {Promise} an instance of SwVersionUpdateManager class
   */
  static getSwVerUpdateManagerInstance () {
    if (deviceUpdater) return deviceUpdater;
    deviceUpdater = new SwVersionUpdateManager();
    return deviceUpdater;
  }

  /**
     * Notify users be generating user notifications and sending emails
     * regarding the release of a new agent software version.
     * @async
     * @param  {Object} versions the versions of the device and its sub-component
     * @return {void}
     */
  async notifyUsers (versions) {
    // Generate user notifications for the new sw version
    const notifications = [];
    try {
      // Generate notification for each organization.
      // Group all devices not running the latest version
      // by the organizations the belong to.
      const orgDevicesList = await devices.aggregate([
        { $match: { 'versions.device': { $ne: versions.device } } },
        {
          $group: {
            _id: '$org',
            devices: {
              $push: { _id: '$$ROOT._id', machineId: '$$ROOT.machineId' }
            }
          }
        }
      ]);

      orgDevicesList.forEach(orgDevices => {
        orgDevices.devices.forEach(device => {
          notifications.push({
            org: orgDevices._id,
            title: 'Device upgrade',
            time: new Date(),
            device: device._id,
            machineId: device.machineId,
            details: `This device requires upgrade to version ${versions.device}`
          });
        });
      });
      notificationsMgr.sendNotifications(notifications);
    } catch (err) {
      logger.error('Failed to send upgrade notifications', {
        params: { notifications: notifications },
        periodic: { task: this.taskInfo }
      }
      );
    }
    // Send new release emails
    try {
      // eslint-disable-next-line no-template-curly-in-string
      const emailUrl = this.notificationEmailUri.replace('${version}', versions.device);
      let { subject, body } = await fetchUtils.fetchWithRetry(emailUrl, 3);
      body = unescape(body);

      // Fetch all relevant memberships and send the notification email to their users.
      const accounts = await Accounts.find();
      for (const account of accounts) {
        const memberships = await membership.find({
          account: account._id,
          to: 'account',
          role: 'owner'
        },
        'user')
          .populate('user');

        // Send a reminder email to all email addresses that belong to the account
        const emailAddresses = memberships.map(doc => { return doc.user.email; });
        await mailer.sendMailHTML(configs.get('mailerFromAddress'), emailAddresses, subject, body);
        logger.info('Version update email sent', {
          params: { emailAddresses: emailAddresses },
          periodic: { task: this.taskInfo }
        });
      }
    } catch (err) {
      logger.error('Failed to send version notification email to users', {
        params: { err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
     * Updates with the new device version and release deadline.
     * Notifies the users if required.
     * @async
     * @param  {Object} currentVersions the current versions of the device and its sub-component
     * @param  {Object} newVersions     the new versions of the device and its sub-component
     * @return {void}
     */
  async updateSwLatestVersions (currentVersions, newVersions) {
    // Check if the current deadline should be modified.
    // This might happen in the following cases:
    // 1. The last upgrade deadline has already passed.
    // 2. The new version's deadline is earlier than the
    //    current version's deadline.
    let pendingDeadline = currentVersions.versionDeadline;
    const tmpCurrentDeadline = new Date(pendingDeadline);

    if (pendingDeadline.getTime() < Date.now() ||
        newVersions.deadline.getTime() < pendingDeadline.getTime()) {
      pendingDeadline = newVersions.deadline;
    }

    if (tmpCurrentDeadline.getTime() !== pendingDeadline.getTime()) {
      logger.info('Software version deadline updated',
        {
          params: {
            versions: newVersions.versions,
            formerDeadline: tmpCurrentDeadline,
            newDeadline: pendingDeadline
          }
        });
    }

    // Update latest version and deadline in the database
    const { versions } = newVersions;
    try {
      const query = {};
      const set = { $set: { versions: versions, versionDeadline: pendingDeadline } };
      const options = {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        useFindAndModify: false
      };
      await deviceSwVersion.findOneAndUpdate(query, set, options);

      logger.info('Device latest software versions updated in database', {
        params: {
          formerVer: currentVersions.versions,
          latestVer: newVersions.versions,
          deadline: pendingDeadline
        },
        periodic: { task: this.taskInfo }
      }
      );

      // Notify users about the new version release
      this.notifyUsers(versions);
    } catch (err) {
      logger.error('Device software versions update failed',
        {
          params: { versions: versions, err: err.message },
          periodic: { task: this.taskInfo }
        });
    }
  }

  /**
     * Adapts the versions object returned by the device software
     * repository to that format of the object stored in the database.
     * @param  {Object} versions versions of the devices and its sub-components
     * @return {Object}          versions in database object format
     */
  createVersionsObject (versions) {
    const versionObject = { device: versions.device };
    Object.entries(versions.components).forEach(comp => {
      versionObject[comp[0]] = comp[1].version;
    });
    return versionObject;
  }

  /**
     * Polls the device software repository to check whether a new
     * device package version has been released.
     * @async
     * @return {void}
     */
  async pollDevSwRepo () {
    try {
      const body = await fetchUtils.fetchWithRetry(this.swRepoUri, 3);
      const versions = this.createVersionsObject(body);
      const deadline = new Date(body.distributionDueDate);

      const { valid, err } = verifyAgentVersion(versions.device);
      if (!valid) {
        logger.error('Got an invalid device software version',
          { params: { version: versions.device, err: err } });
        return;
      }

      // Compare new versions against the versions in the database
      let versionsDoc = await deviceSwVersion.findOne(
        {},
        'versions versionDeadline'
      );

      // If the database has not been updated yet, use the
      // dummy versions object for the comparison of the
      // device version and deadline
      if (!versionsDoc) {
        versionsDoc = dummyVersionObject;
      }

      const deviceVersion = versionsDoc.versions.device;
      // Update the database only if the device version has changed
      if (deviceVersion !== versions.device) {
        this.updateSwLatestVersions(versionsDoc, { versions, deadline });
      }
    } catch (err) {
      logger.error('Failed to query device software version', {
        params: { err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
     * Get the value of latestVersion
     * @return {Promise} latest software version of a device and its sub-components
     */
  getLatestSwVersions () {
    return deviceSwVersion.findOne({}, 'versions versionDeadline').lean();
  }

  /**
     * Get the value of latestVersion.device
     * @return {Object} latest software version of a device only
     */
  async getLatestDevSwVersion () {
    try {
      const { versions } = await this.getLatestSwVersions();
      return versions.device;
    } catch (err) {
      logger.error('Failed to fetch device latest version', {
        params: { err: err.message }
      });
      return '';
    }
  }

  /**
     * Get version deadline
     * @return {Promise} the date the version upgrade deadline
     */
  getVersionUpDeadline () {
    return deviceSwVersion.findOne({}, 'versionDeadline'.lean());
  }
}

let deviceUpdater = null;
module.exports = {
  getSwVerUpdaterInstance: SwVersionUpdateManager.getSwVerUpdateManagerInstance
};
