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
const {
  appIdentifications,
  importedAppIdentifications,
  getAllAppIdentifications,
  getAppIdentificationById,
  getAppIdentificationUpdateAt
} = require('../models/appIdentifications');
const { devices } = require('../models/devices');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
var mongoose = require('mongoose');
const find = require('lodash/find');
const remove = require('lodash/remove');

class AppIdentificationsService {
  static async appIdentificationsGET ({ limit, org, offset }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const response = await getAllAppIdentifications(offset, limit, orgList);
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async appIdentificationsIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const response = await getAppIdentificationById(orgList, id);
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  };

  static async appIdentificationsCustomIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const appIdentsRes =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });
      const appIdentRes = find(appIdentsRes.appIdentifications, { id: id });
      if (!appIdentRes) {
        return Service.rejectResponse('Requested object was not found', 404);
      }
      return Service.successResponse(appIdentRes);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  };

  /**
   * Updates existing custom app identification.
   *
   * @static
   * @param {*} { id, org, appIdentification }
   * @param {*} { user }
   * @returns
   * @memberof AppIdentificationsService
   */
  static async appIdentificationsCustomIdPUT ({ id, org, appIdentification }, { user }) {
    try {
      // Each app identification entry is stored in the organization document. Whenever
      // update is requested, need to find the organization entry in the custom app
      // identifications collection, then locate and update the entry within the
      // appIdentifications array
      const orgList = await getAccessTokenOrgList(user, org, true);
      const appIdentsRes =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });

      if (!appIdentsRes) {
        return Service.rejectResponse('Requested object was not found', 404);
      }

      const appIdentIndex = appIdentsRes.appIdentifications.findIndex(item => item.id === id);
      if (appIdentIndex !== -1) {
        appIdentsRes.appIdentifications[appIdentIndex] = appIdentification;
      } else {
        appIdentsRes.appIdentifications.push(appIdentification);
      }
      const updateResult =
        await appIdentifications.updateOne({ 'meta.org': { $in: orgList } }, appIdentsRes);
      if (updateResult.nModified !== 1) {
        return Service.rejectResponse(
          'Failed to modify app identification', 500);
      }
      return Service.successResponse(appIdentification, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Adds new custom app identification
   *
   * @static
   * @param {*} { org, appIdentification }
   * @param {*} { user }
   * @returns
   * @memberof AppIdentificationsService
   */
  static async appIdentificationsPOST ({ org, appIdentification }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      let appIdentsRes =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });

      if (!appIdentsRes) {
        // create new organization document and add to collection
        appIdentsRes = {
          meta: {
            org: orgList[0].toString()
          },
          appIdentifications: []
        };
      }

      // Object id will be assigned to both _id and id fields in order to maintain schema
      // consistency across collections of imported  and custom app identifications.
      // Whenever imported collection is being updated from remote uri, it has the
      // id field per each app identification. Mongo will add an _id field as well.
      // So in order to align custom and imported schemas, there are two fields with
      // the same value in the per app identification entry.
      const objectId = mongoose.Types.ObjectId();
      const newAppIdent =
        { ...appIdentification, _id: objectId, id: objectId.toString() };

      appIdentsRes.appIdentifications.push(newAppIdent);
      const options = {
        upsert: true,
        setDefaultsOnInsert: true,
        useFindAndModify: false
      };
      await appIdentifications.findOneAndUpdate(
        { 'meta.org': { $in: orgList } }, appIdentsRes, options);

      const location = `${server}/api/appidentifications/custom/${
          objectId.toString()}`;
      response.setHeader('Location', location);
      return Service.successResponse(newAppIdent, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Reset imported app identification to default settings
   *
   * @static
   * @param {*} { id, org, appIdentification }
   * @param {*} { user }
   * @returns
   * @memberof AppIdentificationsService
   */
  static async appIdentificationsIdResetPUT ({ id, org, appIdentification }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const appIdentsRes =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });

      if (!appIdentsRes) {
        return Service.rejectResponse('Requested object was not found', 404);
      }

      const imported = appIdentsRes.imported ? appIdentsRes.imported : [];
      remove(imported, (item) => item.id === id);

      const updateResult =
        await appIdentifications.updateOne({ 'meta.org': { $in: orgList } }, appIdentsRes);
      if (updateResult.nModified !== 1) {
        return Service.rejectResponse(
          'Failed to modify app identification', 500);
      }

      // payload is empty for reset command, so find the application in the imported
      return await getAppIdentificationById(orgList, id);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Customize imported app identification
   *
   * @static
   * @param {*} { id, org, appIdentImpCustReq }
   * @param {*} { user }
   * @returns
   * @memberof AppIdentificationsService
   */
  static async appIdentificationsIdPUT ({ id, org, appIdentImpCustReq }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const result =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });
      const objectId = mongoose.Types.ObjectId();
      const newAppIdent = { ...appIdentImpCustReq, _id: objectId, id: id };

      // if organization document already exists
      if (result !== null) {
        if (!result.imported) {
          result.imported = [];
        }

        const projection = {
          'appIdentifications.id': 1,
          'appIdentifications.category': 1,
          'appIdentifications.serviceClass': 1,
          'appIdentifications.importance': 1
        };

        const { category, serviceClass, importance } = newAppIdent;

        // if updated AppIdentification has same updated values as original one,
        // remove it from customized imported array, as it is no longer
        // considered modified
        const importedAppIdentsRes =
        await importedAppIdentifications.findOne({}, projection);
        const originalAppIdent =
          find(importedAppIdentsRes.appIdentifications, { id: id });
        if (originalAppIdent) {
          if (
            originalAppIdent.category === category &&
            originalAppIdent.serviceClass === serviceClass &&
            originalAppIdent.importance === importance
          ) {
            await AppIdentificationsService
              .appIdentificationsIdResetPUT(
                { id, org, appIdentImpCustReq },
                { user });
            return Service.successResponse(newAppIdent, 200);
          }
        }

        const oldAppIdentification = find(result.imported, { id: id });
        if (oldAppIdentification) {
          oldAppIdentification.category = category;
          oldAppIdentification.serviceClass = serviceClass;
          oldAppIdentification.importance = importance;
        } else {
          result.imported.push(newAppIdent);
        }
        const updateResult =
          await appIdentifications.updateOne({ 'meta.org': { $in: orgList } }, result);
        if (updateResult.nModified === 1) {
          return Service.successResponse(newAppIdent, 200);
        }
        return Service.rejectResponse(
          'Failed to update app identification', 500);
      }

      // create new organization document and add to collection
      const appIdentificationBody = {
        meta: {
          org: orgList[0].toString()
        },
        appIdentifications: [],
        imported: []
      };
      appIdentificationBody.imported.push(newAppIdent);
      await appIdentifications.create([appIdentificationBody]);
      return Service.successResponse({
        name: appIdentImpCustReq.name
      }, 200);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Deletes App Identification
   *
   * @static
   * @param {*} { id, org } app identification id and organization id
   * @param {*} { user }
   * @returns
   * @memberof AppIdentificationsService
   */
  static async appIdentificationsIdDELETE ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const appIdentsRes =
        await appIdentifications.findOne({ 'meta.org': { $in: orgList } });

      if (!appIdentsRes || !appIdentsRes.appIdentifications.find(item => item.id === id)) {
        return Service.rejectResponse('Requested object was not found', 404);
      }

      appIdentsRes.appIdentifications =
        appIdentsRes.appIdentifications.filter(item => item.id !== id);
      const updateResult =
        await appIdentifications.updateOne({ 'meta.org': { $in: orgList } }, appIdentsRes);
      if (updateResult.nModified !== 1) {
        return Service.rejectResponse(
          'Failed to delete app identification', 500);
      }
      return Service.successResponse({}, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async appIdentificationsInstalledGET ({ org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const response = await getAppIdentificationUpdateAt(orgList);
      const updateAt = (response.importedUpdatedAt >= response.customUpdatedAt)
        ? response.importedUpdatedAt : response.customUpdatedAt;

      const devicesPipeline = [
        {
          $project: {
            _id: { $toString: '$_id' },
            updatedAt: { $toString: { $ifNull: ['$appIdentification.lastUpdateTime', ''] } },
            clients: { $ifNull: ['$appIdentification.clients', []] },
            status: {
              $cond: {
                if: {
                  $and: [{
                    $and: [
                      { $ne: ['$appIdentification.clients', undefined] },
                      { $ne: ['$appIdentification.clients', []] }]
                  },
                  {
                    $or: [
                      { $eq: ['$appIdentification.lastUpdateTime', undefined] },
                      { $eq: ['$appIdentification.lastUpdateTime', null] },
                      { $lt: ['$appIdentification.lastUpdateTime', updateAt] }]
                  }]
                },
                then: 'install',
                else: {
                  $cond: {
                    if: {
                      $and: [{
                        $or: [
                          { $eq: ['$appIdentification.clients', undefined] },
                          { $eq: ['$appIdentification.clients', []] }]
                      },
                      { $ne: ['$appIdentification.lastUpdateTime', null] }]
                    },
                    then: 'uninstall',
                    else: 'ok'
                  }
                }
              }
            }
          }
        }
      ];
      if (offset) devicesPipeline.push({ $skip: offset });
      if (limit) devicesPipeline.push({ $limit: limit });

      const pipeline = [
        {
          $match: {
            org: mongoose.Types.ObjectId(orgList[0]),
            $or: [
              { 'appIdentification.clients': { $exists: true, $ne: [] } },
              { 'appIdentification.lastUpdateTime': { $ne: null } }
            ]
          }
        },
        {
          $facet: {
            count: [{
              $match: {
                $or: [
                  // have clients but not updated to latest
                  {
                    $and: [
                      { 'appIdentification.clients': { $exists: true, $ne: [] } },
                      {
                        $or: [
                          { 'appIdentification.lastUpdateTime': { $exists: false } },
                          { 'appIdentification.lastUpdateTime': null },
                          { 'appIdentification.lastUpdateTime': { $lt: updateAt } }]
                      }]
                  },
                  // have no clients and updated is not null
                  {
                    $and: [
                      {
                        $or: [
                          { 'appIdentification.clients': { $exists: false } },
                          { 'appIdentification.clients': [] }]
                      },
                      { 'appIdentification.lastUpdateTime': { $ne: null } }]
                  }]
              }
            }, { $count: 'numDevices' }],
            devices: devicesPipeline
          }
        }
      ];

      const result = await devices.aggregate(pipeline).allowDiskUse(true);

      return Service.successResponse({
        totalNotUpdated: (
          result && result.length > 0 && result[0].count &&
          result[0].count.length > 0)
          ? result[0].count[0].numDevices
          : 0,
        devices: (result && result[0].devices) ? result[0].devices : 0
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = AppIdentificationsService;
