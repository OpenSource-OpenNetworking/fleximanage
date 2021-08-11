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

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const mongoConns = require('../mongoConns.js')();

/**
 * Library Database Schema
 *
 * A schema for the documents that stores all applications we offer
 */
const applicationLibrarySchema = new Schema(
  {
    // application name
    name: {
      type: String,
      required: true,
      unique: true,
      index: true,
      minlength: [2, 'App name must be at least 2'],
      maxlength: [30, 'App name must be at most 30']
    },
    // application description
    description: {
      type: String,
      required: true,
      minlength: [2, 'Description must be at least 2'],
      maxlength: [100, 'Description must be at most 100']
    },
    // latest version
    latestVersion: {
      type: String,
      required: true,
      match: [
        /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
        'installedVersion must be a valid Semver version'
      ]
    },
    // the time of repository update time
    // used to check if the app is not updated
    // the type is number because it's an EPOCH time
    repositoryTime: {
      type: Number
    },
    // who is the creator of this application
    creator: {
      type: String,
      minlength: [2, 'Creator must be at least 2'],
      maxlength: [30, 'Creator must be at most 30']
    },
    // cpu requirements
    cpuRequirements: {
      type: Number
    },
    // ram requirements
    ramRequirements: {
      type: Number
    },
    // the FlexiWAN components used by application
    components: {
      type: [String],
      enum: ['Manage', 'Edge', 'Client']
    },
    // // the FlexiWAN components used by application
    // operatingSystem: {
    //   type: [String],
    //   enum: ['Windows', 'Linux']
    // },
    // application dependencies
    dependencies: {
      type: [String]
    },
    // application permissions
    permissions: {
      // TODO: complete here
    }
  },
  {
    // set collection name to prevent from mongoose to pluralize to 'libraries'
    collection: 'applicationsLibrary',
    timestamps: true
  }
);

// Default exports
module.exports = mongoConns
  .getMainDB()
  .model('applicationsLibrary', applicationLibrarySchema);
