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
const applicationsLibrary = require('../models/applicationsLibrary');
const { devices } = require('../models/devices');
const applications = require('../models/applications');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const dispatcher = require('../deviceLogic/dispatcher');
const ObjectId = require('mongoose').Types.ObjectId;
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const {
  getInitialConfigObject,
  validateConfiguration,
  pickAllowedFieldsOnly,
  saveConfiguration,
  needToUpdatedDevices
} = require('../applicationLogic/applications');

class ApplicationsService {
  /**
   * get all applications in our applications library
   *
   * @static
   * @param {*} { user }
   * @returns {Object} object with applications array
   * @memberof ApplicationsService
   */
  static async applicationsLibraryGET ({ user }) {
    try {
      const appsList = await applicationsLibrary.find().lean();

      const mapped = appsList.map(app => {
        return { ...app, _id: app._id.toString() };
      });

      return Service.successResponse(mapped);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * get purchased application by id
   *
   * @static
   * @param {*} { org, id } org id and application id
   * @param {*} { user }
   * @returns {Object} object with applications array
   * @memberof ApplicationsService
   */
  static async applicationGET ({ org, id }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const installedApp = await applications
        .findOne({ org: { $in: orgList }, removed: false, _id: id })
        .populate('libraryApp').populate('org');

      return Service.successResponse({ application: installedApp });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * get all purchased applications
   *
   * @static
   * @param {*} { org }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async applicationsGET ({ org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const installed = await applications.aggregate([
        { $match: { org: { $in: orgList.map(o => ObjectId(o)) }, removed: false } },
        {
          $lookup: {
            from: 'devices',
            let: { id: '$_id' },
            pipeline: [
              { $unwind: '$applications' },
              { $match: { $expr: { $eq: ['$applications.applicationInfo', '$$id'] } } },
              { $project: { 'applications.status': 1 } },
              { $group: { _id: '$applications.status', count: { $sum: 1 } } }
            ],
            as: 'statuses'
          }
        },
        {
          $project: {
            _id: 1,
            libraryApp: 1,
            org: 1,
            installedVersion: 1,
            pendingToUpgrade: 1,
            statuses: 1
          }
        }
      ]).allowDiskUse(true);

      await applications.populate(installed, { path: 'libraryApp' });
      await applications.populate(installed, { path: 'org' });

      const response = installed.map(app => {
        const statusesTotal = {
          installed: 0,
          pending: 0,
          failed: 0,
          deleted: 0
        };
        app.statuses.forEach(appStatus => {
          if (appStatus._id === 'installed') {
            statusesTotal.installed += appStatus.count;
          } else if (['installing', 'uninstalling'].includes(appStatus._id)) {
            statusesTotal.pending += appStatus.count;
          } else if (appStatus._id.includes('fail')) {
            statusesTotal.failed += appStatus.count;
          } else if (appStatus._id.includes('deleted')) {
            statusesTotal.deleted += appStatus.count;
          }
        });
        const { ...rest } = app;
        return {
          ...rest,
          statuses: statusesTotal
        };
      });

      return Service.successResponse({ applications: response });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * purchase new application
   *
   * @static
   * @param {*} { org, id }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async applicationPOST ({ org, id }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      // check if application._id is an application in library
      const libraryApp = await applicationsLibrary.findOne({ _id: id });
      if (!libraryApp) {
        return Service.rejectResponse('Application id is not known', 500);
      }

      // check if app already installed
      let appExists = await applications.findOne({
        org: { $in: orgList }, libraryApp: id
      });

      if (appExists && !appExists.removed) {
        return Service.rejectResponse('This Application is already purchased', 500);
      }

      // don't create new app if this app installed in the past but removed
      if (appExists && appExists.removed) {
        appExists.removed = false;
        appExists.purchasedDate = Date.now();
        appExists.save();

        appExists = await appExists.populate('libraryApp').populate('org').execPopulate();

        return Service.successResponse(appExists);
      }

      // create app
      let installedApp = await applications.create({
        libraryApp: libraryApp._id,
        org: orgList[0],
        installedVersion: libraryApp.latestVersion,
        purchasedDate: Date.now(),
        configuration: getInitialConfigObject(libraryApp)
      });

      // return populated document
      installedApp = await installedApp.populate('libraryApp').populate('org').execPopulate();

      return Service.successResponse(installedApp);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * uninstall application
   *
   * @static
   * @param {*} { org, id }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async applicationDELETE ({ org, id }, { user }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      await applications.updateOne(
        { _id: id, org: { $in: orgList }, removed: false },
        { $set: { removed: true } },
        { upsert: false }
      );

      // send jobs to device that installed or installing this app
      const opDevices = await devices.find({
        org: { $in: orgList },
        'applications.applicationInfo': id,
        $or: [
          { 'applications.status': 'installed' },
          { 'applications.status': 'installing' }
        ]
      });

      if (opDevices.length) {
        await dispatcher.apply(opDevices, 'application',
          user, { org: orgList[0], meta: { op: 'uninstall', id: id } });
      }

      return Service.successResponse({ data: 'ok' });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * update application
   *
   * @static
   * @param {*} { org, id }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async applicationsConfigurationPUT ({ id, configurationRequest, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id) || Object.keys(configurationRequest).length === 0) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications
        .findOne({ org: { $in: orgList }, removed: false, _id: id })
        .populate('libraryApp').populate('org').lean();

      if (!app) return Service.rejectResponse('Invalid application id', 500);

      // this configuration object is dynamically.
      // we need to pick only allowed fields for given application
      configurationRequest = pickAllowedFieldsOnly(configurationRequest, app);

      const { valid, err } = await validateConfiguration(configurationRequest, app, orgList);

      if (!valid) {
        logger.warn('Application update failed',
          {
            params: { config: configurationRequest, err: err }
          });
        return Service.rejectResponse(err, 500);
      }

      // update old configuration object with new one
      const combinedConfig = { ...app.configuration, ...configurationRequest };

      const isNeedToUpdatedDevices = needToUpdatedDevices(app, app.configuration, combinedConfig);

      const updated = await saveConfiguration(app, combinedConfig);

      // Update devices if needed
      if (isNeedToUpdatedDevices) {
        const opDevices = await devices.find({
          org: { $in: orgList },
          'applications.applicationInfo': id,
          'applications.status': { $in: ['installed', 'installing', 'configuration failed'] }
        });

        if (opDevices.length) {
          await dispatcher.apply(opDevices, 'application',
            user, { org: orgList[0], meta: { op: 'config', id: id } });
        }
      }

      return Service.successResponse({ application: updated });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * upgrade application
   *
   * @static
   * @param {*} { org, id }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async applicationsUpgradePOST ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications.findOne({ _id: id }).populate('libraryApp').lean();

      const currentVersion = app.installedVersion;
      const newVersion = app.libraryApp.latestVersion;

      if (currentVersion === newVersion) {
        return Service.rejectResponse(
          'This application is already updated with latest version',
          500
        );
      }

      // send jobs to device
      const opDevices = await devices.find({
        org: { $in: orgList },
        'applications.applicationInfo': id
      });

      await dispatcher.apply(opDevices, 'application',
        user, { org: orgList[0], meta: { op: 'upgrade', id: id, newVersion: newVersion } });

      return Service.successResponse({ data: 'ok' });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = ApplicationsService;
