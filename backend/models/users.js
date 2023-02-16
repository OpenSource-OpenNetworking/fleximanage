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

const validators = require('./validators');
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var passportLocalMongoose = require('passport-local-mongoose');
const mongoConns = require('../mongoConns.js')();

/**
 * Email tokens, used for checking email responses
 */
const emailTokens = new Schema({
  // link for verification
  verify: {
    type: String,
    maxlength: 50,
    required: false,
    default: ''
  },
  // invitation link
  invite: {
    type: String,
    maxlength: 50,
    required: false,
    default: ''
  },
  // reset password link
  resetPassword: {
    type: String,
    maxlength: 50,
    required: false,
    default: ''
  }
});

/**
 * user schema
 */
const User = new Schema({
  // is user is an admin
  admin: {
    type: Boolean,
    default: false
  },
  // user first name
  name: {
    type: String,
    required: true,
    validate: {
      validator: validators.validateUserName,
      message: 'should be a valid first name (English chars, digits, space or -.)'
    }
  },
  // last name
  lastName: {
    type: String,
    required: true,
    validate: {
      validator: validators.validateUserName,
      message: 'should be a valid last name (English chars, digits, space or -.)'
    }
  },
  // email address
  email: {
    type: String,
    required: true,
    unique: true,
    maxlength: [255, 'Email length must be at most 255'],
    validate: {
      validator: validators.validateEmail,
      message: 'should be a valid email address'
    }
  },
  // account user email used for login
  username: {
    type: String,
    required: true,
    unique: true,
    validate: {
      validator: validators.validateEmail,
      message: 'should be a valid user name as email'
    }
  },
  // job title provided during registration
  jobTitle: {
    type: String,
    required: true,
    match: [/^[a-z0-9 -]{2,30}$/i, 'should contain letters digits space or dash characters'],
    minlength: [2, 'Job title length must be at least 2'],
    maxlength: [30, 'Job title length must be at most 30']
  },
  // phone number provided during registration
  phoneNumber: {
    type: String,
    validate: {
      validator: (number) => { return number === '' || validators.validateIsPhoneNumber(number); },
      message: 'should be a valid phone number'
    },
    maxlength: [20, 'Phone number length must be at most 20']
  },
  // user state
  state: {
    type: String,
    required: true,
    default: 'unverified'
  },
  // tokens
  emailTokens: emailTokens,
  // Default user account
  defaultAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'accounts'
  },
  // Default user organization
  defaultOrg: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'organizations'
  },
  // MFA configuration
  mfa: {
    // Array of all secrets that user received.
    // We reset this field to empty after first verification.
    unverifiedSecrets: {
      type: [String],
      default: []
    },
    // Once first verification done, we save the secret that will be used for next logins
    secret: {
      type: String,
      default: null
    },
    // Indicates if MFA is enabled and verified.
    enabled: {
      type: Boolean,
      default: false
    },
    // Array of codes that user can use to login to the system without the 2fa.
    recoveryCodes: {
      type: []
    }
  }
});

// use for maximum attempts protection
const maxInterval = 30000; // 5 minutes
const options = {
  limitAttempts: true,
  maxInterval: maxInterval,
  errorMessages: {
    // eslint-disable-next-line max-len
    AttemptTooSoonError: `Too many login attempts. try again in ${Math.floor(maxInterval / 6000)} minutes`
  }
};

// enable mangoose plugin for local authenticaiton
User.plugin(passportLocalMongoose, options);

// Default exports
module.exports = mongoConns.getMainDB().model('users', User);
