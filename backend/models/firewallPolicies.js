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
const mongoConns = require('../mongoConns.js')();
const Schema = mongoose.Schema;
const {
  validatePolicyName,
  validateDescription
} = require('./validators');
const { firewallRuleSchema } = require('./firewallRule');

// Define a getter on object ID that
// converts it to a string
Schema.ObjectId.get(v => v ? v.toString() : v);

/**
 * Firewall Policy Schema
 */

const firewallPolicySchema = new Schema({
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  name: {
    type: String,
    required: true,
    validate: {
      validator: validatePolicyName,
      message: 'Firewall policy name format is invalid'
    }
  },
  description: {
    type: String,
    required: false,
    validate: {
      validator: validateDescription,
      message: 'Firewall policy description format is invalid'
    }
  },
  isDefault: {
    type: Boolean,
    default: false,
    required: false
  },
  version: {
    type: Number,
    min: 0,
    default: 0
  },
  rules: [firewallRuleSchema]
}, {
  timestamps: true
});

firewallPolicySchema.index({ org: 1, name: 1 }, { unique: true });
module.exports = mongoConns.getMainDB().model('FirewallPolicies', firewallPolicySchema);
