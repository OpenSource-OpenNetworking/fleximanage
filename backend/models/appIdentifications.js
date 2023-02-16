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
const Schema = mongoose.Schema;
const mongoConns = require('../mongoConns.js')();
const find = require('lodash/find');
const concat = require('lodash/concat');
const union = require('lodash/union');
const { validateIPv4WithMask, validatePortRange } = require('./validators');

const predefinedServiceClasses = [
  'default',
  'real-time',
  'signaling',
  'telephony',
  'broadcast-video',
  'network-control',
  'oam',
  'high-throughput',
  'multimedia-conferencing',
  'multimedia-streaming',
  'low-latency'
];

/**
 * Rules Database Schema
 */
const rulesSchema = new Schema({
  ip: {
    type: String,
    required: false,
    validate: {
      validator: validateIPv4WithMask,
      message: 'ip should be a valid ipv4 with mask type'
    }
  },
  ports: {
    type: String,
    required: false,
    validate: {
      validator: validatePortRange,
      message: 'ports should be a valid ports range'
    }
  },
  protocol: {
    type: String,
    enum: ['tcp', 'udp', ''],
    required: false
  }
});

// This pre validation hook makes sure that at least ip or port are
// present in the rule.
rulesSchema.pre('validate', function (next) {
  if (!this.ip && !this.ports) {
    this.invalidate('ip|ports', 'Either ip or ports field must not be empty');
  }

  next();
});

/**
 * Modified Imported App Identifications Database Schema
 */
const modifiedImportedSchema = new Schema(
  {
    id: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true,
      minlength: [2, 'App identification name must be at least 2'],
      maxlength: [30, 'App identification name must be at most 30']
    },
    category: {
      type: String,
      required: true,
      minlength: [2, 'Category must be at least 2'],
      maxlength: [30, 'Category must be at most 30']
    },
    serviceClass: {
      type: String,
      required: true,
      minlength: [2, 'Service Class must be at least 2'],
      maxlength: [30, 'Service Class must be at most 30']
    },
    importance: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true
    }
  },
  {
    timestamps: true
  }
);

/**
 * App Identification Database Schema
 */
const appIdentificationSchema = new Schema(
  {
    // Specific id here is neded in order to keep consistency with the imported
    // app identifications list.
    id: {
      type: String,
      required: true,
      minlength: [1, 'Id must be at least 1'],
      maxlength: [24, 'Id must be at most 24']
    },
    name: {
      type: String,
      required: true,
      minlength: [2, 'App identification name must be at least 2'],
      maxlength: [30, 'App identification name must be at most 30']
    },
    category: {
      type: String,
      required: true,
      minlength: [2, 'Category must be at least 2'],
      maxlength: [30, 'Category must be at most 30']
    },
    serviceClass: {
      type: String,
      required: true,
      minlength: [2, 'Service Class must be at least 2'],
      maxlength: [30, 'Service Class must be at most 30']
    },
    importance: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true
    },
    description: {
      type: String,
      maxlength: [128, 'Description must be at most 128']
    },
    rules: [rulesSchema],
    modified: {
      type: Boolean
    }
  },
  {
    timestamps: true
  }
);

/**
 * Metadata Database Schema
 */
const metaSchema = new Schema({
  time: {
    type: Number
  },
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations'
  }
});

/**
 * App Identifications Database Schema
 */
const appIdentificationsSchema = new Schema(
  {
    meta: {
      type: metaSchema,
      required: true
    },
    appIdentifications: [appIdentificationSchema],
    imported: [modifiedImportedSchema]
  },
  {
    timestamps: true
  }
);

const appIdentifications = mongoConns
  .getMainDB()
  .model('appidentifications', appIdentificationsSchema);
const importedAppIdentifications = mongoConns
  .getMainDB()
  .model('importedappidentifications', appIdentificationsSchema);

/**
 * Gets the combined list of custom and imported AppIdentifications as well
 * as the meta data containging times of last updates in both collections.
 * @param {*} offset The number of items to skip before starting to collect the
 * result set (optional)
 * @param {*} limit Integer The numbers of items to return (optional)
 * @param {*} orgList Organization filter
 * @returns
 */
const getAllAppIdentifications = async (offset, limit, orgList) => {
  const projection = {
    updatedAt: 1,
    'appIdentifications.id': 1,
    'appIdentifications.name': 1,
    'appIdentifications.description': 1,
    'appIdentifications.category': 1,
    'appIdentifications.serviceClass': 1,
    'appIdentifications.importance': 1,
    'appIdentifications.rules._id': 1,
    'appIdentifications.rules.protocol': 1,
    'appIdentifications.rules.ports': 1,
    'appIdentifications.rules.ip': 1,
    // not part of the imported, so maybe split projections?
    'imported.id': 1,
    'imported.category': 1,
    'imported.serviceClass': 1,
    'imported.importance': 1
  };
  // it is expected that custom app identifications are stored as single document per
  // organization in the collection
  const customAppIdentsRes = await appIdentifications.findOne(
    { 'meta.org': { $in: orgList } },
    projection
  );
  const customAppIdents = (customAppIdentsRes || {}).appIdentifications || [];

  // it is expected that imported app identifications are stored as single document
  // in the collection
  const importedAppIdentsRes = await importedAppIdentifications.findOne(
    {},
    projection
  );
  // Before merge with modified values taken from custom document,
  // assign each imported app identification with modified = false.
  const importedAppIdents1 =
    (importedAppIdentsRes || {}).appIdentifications.map((item) => {
      item.modified = false;
      return item;
    }) || [];

  const { imported } = customAppIdentsRes || {};
  if (imported) {
    imported.forEach((item) => {
      const oldAppIdent = find(importedAppIdents1, { id: item.id });
      // There could be a situation where there is an imported app identification registered
      // in the custom app identifications database as modified, but there is no longer
      // original object exist in the imported database (e.g. after importing new list).
      // Currently it skips adding it to the imported list.
      if (oldAppIdent) {
        oldAppIdent.modified = true;
        oldAppIdent.category = item.category;
        oldAppIdent.serviceClass = item.serviceClass;
        oldAppIdent.importance = item.importance;
      }
    });
  }

  // Since single document is maintained per organization, skip() and
  // limit() cannot be used here, but instead be implemented with with slice().
  offset = !offset || offset < 0 ? 0 : offset;

  const mergedAppIdens =
    limit && limit >= 0
      ? concat(customAppIdents, importedAppIdents1).slice(
        offset,
        offset + limit
      )
      : concat(customAppIdents, importedAppIdents1).slice(offset);

  return {
    appIdentifications: mergedAppIdens,
    meta: {
      customUpdatedAt:
        customAppIdentsRes === null ? '' : customAppIdentsRes.updatedAt,
      importedUpdatedAt:
        importedAppIdentsRes === null ? '' : importedAppIdentsRes.updatedAt
    }
  };
};

/**
 * Gets the app identification from imported app identifications
 *
 * @param {*} org Organization filter
 * @param {*} id app identification id
 * @returns app identification entry
 */
const getAppIdentificationById = async (org, id) => {
  const projection = {
    updatedAt: 1,
    'appIdentifications.id': 1,
    'appIdentifications.name': 1,
    'appIdentifications.description': 1,
    'appIdentifications.category': 1,
    'appIdentifications.serviceClass': 1,
    'appIdentifications.importance': 1,
    'appIdentifications.rules.id': 1,
    'appIdentifications.rules.protocol': 1,
    'appIdentifications.rules.ports': 1,
    'appIdentifications.rules.ip': 1
  };

  const modifiedImportedProjection = {
    'imported.id': 1,
    'imported.category': 1,
    'imported.serviceClass': 1,
    'imported.importance': 1
  };

  // it is expected that imported AppIdentifications are stored as single document
  // in the collection
  const importedAppIdentsRes = await importedAppIdentifications.findOne(
    {},
    projection
  );
  const importedAppIdents1 =
    (importedAppIdentsRes || {}).appIdentifications || [];
  const importedAppIdentRes = importedAppIdents1.find((item) => item.id === id);
  if (importedAppIdentRes) {
    // Check whether there is a modified version of the imported app identification stored
    // in the custom app identifications document. If there is such, merge the two, so user
    // will see the modified version.
    const modifiedImportedAppIdentsRes = await appIdentifications.findOne(
      { 'meta.org': { $in: org } },
      modifiedImportedProjection
    );
    if (modifiedImportedAppIdentsRes && modifiedImportedAppIdentsRes.imported) {
      const modifiedAppIdentRes = modifiedImportedAppIdentsRes.imported.find(
        (item) => item.id === id
      );
      if (modifiedAppIdentRes) {
        const { category, serviceClass, importance } = modifiedAppIdentRes;
        importedAppIdentRes.category = category;
        importedAppIdentRes.serviceClass = serviceClass;
        importedAppIdentRes.importance = importance;
      }
    }
    return importedAppIdentRes;
  }

  return null;
};

/**
 * Get last update time for AppIdentification list for an organization
 * @param {Array} orgList - org ID to get
 */
const getAppIdentificationUpdateAt = async (orgList) => {
  // Get updated at value
  const projection = {
    updatedAt: 1
  };
  const customAppIdentsRes = await appIdentifications.findOne(
    { 'meta.org': { $in: orgList } },
    projection
  );
  const importedAppIdentsRes = await importedAppIdentifications.findOne(
    {},
    projection
  );

  return {
    customUpdatedAt:
      customAppIdentsRes === null ? '' : customAppIdentsRes.updatedAt,
    importedUpdatedAt:
      importedAppIdentsRes === null ? '' : importedAppIdentsRes.updatedAt
  };
};

/**
 * Gets all existing service classes
 * @param {*} orgList Organization filter
 * @returns {Array} an array of existing service classes
 */
const getExistingServiceClasses = async (orgList) => {
  const importedRes = await importedAppIdentifications.aggregate([
    { $project: { 'appIdentifications.serviceClass': 1 } },
    { $unwind: '$appIdentifications' },
    {
      $group: {
        _id: null,
        serviceClasses: {
          $addToSet: '$appIdentifications.serviceClass'
        }
      }
    }
  ]);
  const customRes = await appIdentifications.aggregate([
    { $match: { 'meta.org': { $in: orgList.map(o => mongoose.Types.ObjectId(o)) } } },
    { $project: { 'appIdentifications.serviceClass': 1 } },
    { $unwind: '$appIdentifications' },
    {
      $group: {
        _id: null,
        serviceClasses: {
          $addToSet: '$appIdentifications.serviceClass'
        }
      }
    }
  ]);
  return union(
    customRes.length ? customRes[0].serviceClasses : [],
    importedRes.length ? importedRes[0].serviceClasses : []
  ).sort();
};

// Default exports
module.exports = {
  getAllAppIdentifications,
  getAppIdentificationUpdateAt,
  getAppIdentificationById,
  getExistingServiceClasses,
  predefinedServiceClasses,
  appIdentifications,
  importedAppIdentifications,
  Rules: mongoConns.getMainDB().model('Rules', rulesSchema)
};
