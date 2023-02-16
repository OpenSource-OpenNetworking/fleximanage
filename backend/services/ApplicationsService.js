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

const mongoose = require('mongoose');
const Service = require('./Service');
const appStore = require('../models/applicationStore');
const { devices } = require('../models/devices');
const applications = require('../models/applications');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const dispatcher = require('../deviceLogic/dispatcher');
const ObjectId = require('mongoose').Types.ObjectId;
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getMatchFilters } = require('../utils/filterUtils');

const appsLogic = require('../applicationLogic/applications')();
const deviceStatus = require('../periodic/deviceStatus')();

class ApplicationsService {
  /**
   * Select the API fields from application Object
   * @param {Object} item - jobs object
   */
  static selectApplicationStoreParams (item) {
    item._id = item._id.toString();
    return item;
  }

  /**
   * Select the API fields from application Object
   * @param {Object} item - jobs object
   */
  static async selectApplicationParams (item) {
    item._id = item._id.toString();

    if (item.org) {
      if (mongoose.Types.ObjectId.isValid(item.org)) {
        item.org = item.org.toString();
      } else {
        item.org._id = item.org._id.toString();
      }
    }

    if (item.appStoreApp) {
      if (mongoose.Types.ObjectId.isValid(item.appStoreApp)) {
        item.org = item.appStoreApp.toString();
      } else {
        item.appStoreApp._id = item.appStoreApp._id.toString();
      }
      item.appStoreApp.versions = item.appStoreApp.versions.filter(v => {
        return v.version === item.installedVersion;
      });
    }

    item.configuration = await appsLogic.selectConfigurationParams(
      item.appStoreApp.identifier, item.configuration);

    return item;
  }

  /**
   * get all applications in our applications store
   *
   * @static
   * @param {*} { user }
   * @returns {Object} object with applications array
   * @memberof ApplicationsService
   */
  static async appstoreGET ({ filters }, { user }) {
    try {
      let appsList = [];
      const pipeline = [];

      if (filters) {
        const parsedFilters = JSON.parse(filters);
        const matchFilters = getMatchFilters(parsedFilters);
        if (matchFilters.length > 0) {
          pipeline.push({
            $match: { $and: matchFilters }
          });
        }
      }

      if (pipeline.length > 0) {
        appsList = await appStore.aggregate(pipeline).allowDiskUse(true);
      } else {
        appsList = await appStore.find().lean();
      }

      const mapped = appsList.map(app => {
        return ApplicationsService.selectApplicationStoreParams(app);
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
  static async appstorePurchasedIdGET ({ org, id }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications
        .findOne({ org: { $in: orgList }, _id: id })
        .populate('appStoreApp').lean();

      const parsed = await ApplicationsService.selectApplicationParams(app);
      return Service.successResponse(parsed);
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
  static async appstorePurchasedGET (requestParams, { user }) {
    try {
      let orgList = await getAccessTokenOrgList(user, requestParams.org, true);
      orgList = orgList.map(o => mongoose.Types.ObjectId(o));

      const pipeline = [
        { $match: { org: { $in: orgList } } },
        {
          $lookup: {
            from: 'applicationStore',
            localField: 'appStoreApp',
            foreignField: '_id',
            as: 'appStoreApp'
          }
        },
        {
          $unwind: '$appStoreApp'
        }
      ];

      if (requestParams.responseType === 'summary') {
        pipeline.push({
          $project: {
            _id: 1,
            appStoreApp: 1,
            org: 1,
            installedVersion: 1,
            pendingToUpgrade: 1,
            configuration: 1
          }
        });
      } else {
        pipeline.push({
          $lookup: {
            from: 'devices',
            let: { id: '$_id' },
            pipeline: [
              { $match: { org: { $in: orgList } } },
              { $unwind: '$applications' },
              { $match: { $expr: { $eq: ['$applications.app', '$$id'] } } },
              { $project: { 'applications.status': 1 } },
              { $group: { _id: '$applications.status', count: { $sum: 1 } } }
            ],
            as: 'statuses'
          }
        });

        pipeline.push({
          $project: {
            _id: 1,
            appStoreApp: 1,
            org: 1,
            installedVersion: 1,
            pendingToUpgrade: 1,
            statuses: 1,
            configuration: 1
          }
        });
      }

      if (requestParams.filters) {
        const parsedFilters = JSON.parse(requestParams.filters);
        const matchFilters = getMatchFilters(parsedFilters);
        if (matchFilters.length > 0) {
          pipeline.push({
            $match: { $and: matchFilters }
          });
        }
      }

      const installed = await applications.aggregate(pipeline).allowDiskUse(true);

      // await applications.populate(installed, { path: 'appStoreApp' });

      const response = installed.map(app => {
        const { ...rest } = app;
        const response = {
          ...rest,
          _id: app._id.toString(),
          org: app.org.toString()
        };

        if (requestParams.responseType === 'summary') {
          return response;
        }

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

        response.statuses = statusesTotal;
        return response;
      });

      const parsed = await Promise.all(response.map(r =>
        ApplicationsService.selectApplicationParams(r)));
      return Service.successResponse(parsed);
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
  static async appstorePurchaseIdPOST ({ org, id }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      // check if application._id is an application in the appstore
      const appStoreApp = await appStore.findOne({ _id: id });
      if (!appStoreApp) {
        return Service.rejectResponse('Application id is not known', 500);
      }

      // check if app already purchased
      const alreadyPurchased = await applications.findOne({
        org: { $in: orgList }, appStoreApp: appStoreApp._id
      });

      if (alreadyPurchased) {
        return Service.rejectResponse('This Application is already purchased', 500);
      }

      // create app
      let installedApp = await applications.create({
        appStoreApp: appStoreApp._id,
        org: orgList[0],
        installedVersion: appStoreApp.versions[appStoreApp.versions.length - 1].version,
        purchasedDate: Date.now(),
        configuration: {}
      });

      installedApp = await applications.findOne({ _id: installedApp._id })
        .populate('appStoreApp').lean();

      const parsed = await ApplicationsService.selectApplicationParams(installedApp);
      return Service.successResponse(parsed);
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
  static async appstorePurchasedIdDELETE ({ org, id }, { user }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications
        .findOne({ org: { $in: orgList }, _id: id })
        .populate('appStoreApp').lean();

      if (!app) {
        return Service.rejectResponse('Invalid application id', 500);
      }

      // send jobs to device that installed or installing this app
      const opDevices = await devices.find({
        org: { $in: orgList },
        'applications.app': id
      });

      for (const device of opDevices) {
        const installedApp = device.applications.find(a => a.app.toString() === id);

        // send remove-jobs for needed devices
        if (installedApp.status === 'installed' || installedApp.status === 'installing') {
          await dispatcher.apply(
            [device], 'application', user, { org: orgList[0], meta: { op: 'uninstall', id: id } }
          );
        }

        // remove all application stuff from the device
        const installWithQuery = await appsLogic.getAppInstallWithAsQuery(app, device, 'uninstall');
        await devices.updateOne(
          { _id: device._id },
          {
            $set: { ...installWithQuery },
            $pull: { applications: { app: app._id } }
          },
          { upsert: false }
        );
      }

      await applications.deleteOne(
        { _id: id, org: { $in: orgList } }
      );
      const identifier = app.appStoreApp.identifier;
      await appsLogic.updateApplicationBilling(identifier, app);

      return Service.successResponse(null, 204);
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
  static async appstorePurchasedIdPUT (request, { user }) {
    try {
      const { id, purchasedApplicationConfigurationRequest, org } = request;
      let configurationRequest = purchasedApplicationConfigurationRequest;

      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id) || Object.keys(configurationRequest).length === 0) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications
        .findOne({ org: { $in: orgList }, _id: id })
        .populate('appStoreApp').lean();

      if (!app) {
        return Service.rejectResponse('Invalid application id', 500);
      }

      const identifier = app.appStoreApp.identifier;
      // this configuration object is dynamically.
      // we need to pick only allowed fields for given application
      configurationRequest = await appsLogic.pickAllowedFieldsOnly(
        identifier, configurationRequest, app);

      const installedDevices = await devices.find({
        org: { $in: orgList },
        'applications.app': id,
        'applications.status': { $in: ['installed', 'installing', 'configuration failed'] }
      }).populate('policies.firewall.policy', '_id name rules');

      const { valid, err } = await appsLogic.validateConfiguration(
        identifier, configurationRequest, app, user.defaultAccount, installedDevices
      );

      if (!valid) {
        logger.warn('Application update failed',
          {
            params: { config: configurationRequest, err: err }
          });
        return Service.rejectResponse(err, 500);
      }

      // update old configuration object with new one
      const combinedConfig = { ...app.configuration, ...configurationRequest };

      const isNeedToUpdatedDevices = await appsLogic.needToUpdatedDevices(
        identifier, app.configuration, combinedConfig);

      const updated = await appsLogic.saveConfiguration(identifier, app, combinedConfig);

      // Update devices if needed
      if (isNeedToUpdatedDevices && installedDevices.length > 0) {
        await dispatcher.apply(installedDevices, 'application',
          user, { org: orgList[0], meta: { op: 'config', id: id } });
      }

      const parsed = await ApplicationsService.selectApplicationParams(updated);
      return Service.successResponse(parsed);
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
  static async appstorePurchasedIdUpgradePost ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications.findOne({ _id: id }).populate('appStoreApp').lean();

      if (!app) {
        return Service.rejectResponse('Invalid application id', 500);
      }

      const currentVersion = app.installedVersion;
      const newVersion = app.appStoreApp.latestVersion;

      if (currentVersion === newVersion) {
        return Service.rejectResponse(
          'This application is already updated with latest version',
          500
        );
      }

      // send jobs to device
      const opDevices = await devices.find({
        org: { $in: orgList },
        'applications.app': id
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

  /**
   * Get application status
   *
   * @static
   * @param {*} { org, id }
   * @param {*} { user }
   * @returns
   * @memberof ApplicationsService
   */
  static async appstorePurchasedIdStatusGet ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // check if user didn't pass request body or if app id is invalid
      if (!ObjectId.isValid(id)) {
        return Service.rejectResponse('Invalid request', 500);
      }

      const app = await applications.findOne({ _id: id })
        .populate('appStoreApp').populate('org').lean();

      if (!app) {
        return Service.rejectResponse('Invalid application id', 500);
      }

      const identifier = app.appStoreApp.identifier;

      const devicesList = await devices.aggregate([
        { $match: { org: { $in: orgList.map(o => ObjectId(o)) } } },
        { $unwind: '$applications' },
        { $match: { 'applications.app': ObjectId(id) } },
        {
          $project: {
            name: 1,
            applications: 1,
            isConnected: 1,
            deviceStatus: '$status',
            machineId: 1
          }
        }
      ]).allowDiskUse(true);

      const appStatus = await appsLogic.getApplicationStats(
        identifier, app.org.account, app.org._id);

      for (const device of devicesList) {
        device.monitoring = {};
        if (!device.isConnected) {
          continue;
        }

        const devStatus = deviceStatus.getDeviceStatus(device.machineId);
        if (!devStatus) {
          continue;
        }

        if (!('applicationStatus' in devStatus)) {
          continue;
        }

        device.monitoring = devStatus.applicationStatus[identifier];
      }

      return Service.successResponse({
        devices: devicesList,
        ...appStatus
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = ApplicationsService;
