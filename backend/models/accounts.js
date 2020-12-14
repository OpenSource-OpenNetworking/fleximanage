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
 * Accounts Schema
 *
 * User name and password are handled by passport.js
 */
const Accounts = new Schema({
  // name
  name: {
    type: String,
    required: true,
    match: [
      /^[a-z0-9-_ ]{2,30}$/i,
      'Name should contain English characters, digits, spaces or dash'
    ],
    minlength: [2, 'Name length must be at least 2'],
    maxlength: [30, 'Name length must be at most 30']
  },
  // country
  country: {
    type: String,
    required: true,
    match: [/^[a-z]{1,2}$/i, 'Country should contain 2 English characters'],
    minlength: [2, 'Country length must be exactly 2'],
    maxlength: [2, 'Country length must be exactly 2']
  },
  // company size
  companySize: {
    type: String,
    required: true,
    match: [
      /^[0-9 +-]{1,10}$/i,
      'Company size should contain numbers, dash or plus characters'
    ],
    minlength: [2, 'Company size length must be at least 2'],
    maxlength: [15, 'Company size length must be at most 15']
  },
  // company service type
  serviceType: {
    type: String,
    required: true,
    match: [
      /^[a-z0-9 -]{1,20}$/i,
      'Service type should contain letters digits space or dash characters'
    ],
    minlength: [2, 'Service type length must be at least 2'],
    maxlength: [20, 'Service type length must be at most 20']
  },
  // number of sites planned to be used
  numSites: {
    type: String,
    required: true,
    match: [/^[0-9]{1,10}$/i, 'Num sites should contain a number'],
    minlength: [1, 'Num sites length must be at least 1'],
    maxlength: [10, 'Num sites length must be at most 10']
  },
  // company type
  companyType: {
    type: String,
    required: false,
    default: '',
    match: [
      /^[a-z0-9 \\-]{1,30}$/i,
      'Company type should contain letters digits slash space or dash characters'
    ],
    maxlength: [30, 'Company type length must be at most 30']
  },
  // company description
  companyDesc: {
    type: String,
    required: false,
    default: '',
    match: [
      /^[a-z0-9, $.\\-]{1,30}$/i,
      'Company description cannot contain characters'
    ],
    maxlength: [255, 'Company description length must be at most 255']
  },
  // enable or disable notifications
  enableNotifications: {
    type: Boolean,
    default: false
  },
  // logo file url. Not used
  logoFile: {
    type: String,
    required: false,
    unique: false,
    maxlength: [255, 'logoFile length must be at most 255']
  },
  // list of organizations
  organizations: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'organizations' }
  ],
  // Customer id used for billing
  billingCustomerId: {
    type: String,
    required: false,
    default: null
  },
  // Is subscription valid for account, will set to false when cancled in the billing system
  isSubscriptionValid: {
    type: Boolean,
    default: true
  }
});

// default exports
module.exports = mongoConns.getMainDB().model('accounts', Accounts);
