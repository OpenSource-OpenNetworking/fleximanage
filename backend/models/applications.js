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
 * Applications Database Schema
 *
 * A schema for the documents that stores all installed applications
 */
const applicationSchema = new Schema({
  // reference to application in library
  libraryApp: {
    type: Schema.Types.ObjectId,
    ref: 'applicationsLibrary'
  },
  // reference to organization that installed this application
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations'
  },
  // the installed version of application (can be different from library version)
  installedVersion: {
    type: String,
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
      'installedVersion must be a valid Semver version'
    ],
    required: true
  },
  // the application purchased date
  purchasedDate: {
    type: Date,
    required: true
  },
  // indicates if organization removed this app
  // in this case we still storing the configs but marks this app as removed
  removed: {
    type: Boolean,
    default: false
  },
  // indicates if organization removed this app
  // in this case we still storing the configs but marks this app as removed
  pendingToUpgrade: {
    type: Boolean
  },
  // configuration object. this object is a generic,
  // and can store any configurations for each type of application
  configuration: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true,
  // set minimize to false to allow mongoose to save empty objects.
  // this because we want to save an empty configuration object on initialization
  minimize: false
});

// Default exports
module.exports = mongoConns.getMainDB().model('applications', applicationSchema);
