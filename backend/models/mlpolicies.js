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
  validateDescription,
  validateRuleName,
  validateIPv4WithMask,
  validatePortRange
} = require('./validators');

// Define a getter on object ID that
// converts it to a string
Schema.ObjectId.get(v => v ? v.toString() : v);

/**
 * Multi Link Policy Schema
 */
// Rule schema
const multiLinkRuleSchema = new Schema({
  name: {
    type: String,
    required: true,
    validate: {
      validator: validateRuleName,
      message: 'Multi Link rule name format is invalid'
    }
  },
  priority: {
    type: Number,
    min: [0, 'priority should be a number between 0-1000'],
    max: [1000, 'priority should be a number between 0-1000'],
    required: true
  },
  enabled: {
    type: Boolean,
    default: true,
    required: true
  },
  classification: {
    prefix: {
      ip: {
        type: String,
        maxlength: [20, 'ip length must be at most 20'],
        validate: {
          validator: validateIPv4WithMask,
          message: 'IPv4 should be a valid ip address'
        }
      },
      ports: {
        type: String,
        validate: {
          validator: validatePortRange,
          message: 'ports should be a valid ports range'
        }
      },
      protocol: {
        type: String,
        enum: ['', 'udp', 'tcp']
      }
    },
    application: {
      appId: {
        type: String,
        maxlength: [25, 'appId must be at most 25']
      },
      category: {
        type: String,
        maxlength: [20, 'category must be at most 20']
      },
      serviceClass: {
        type: String,
        maxlength: [20, 'service class must be at most 20']
      },
      importance: {
        type: String,
        enum: ['', 'high', 'medium', 'low']
      }
    }
  },
  action: {
    links: [{
      _id: false,
      pathlabels: [{
        type: Schema.Types.ObjectId,
        ref: 'PathLabels'
      }],
      order: {
        type: String,
        enum: ['priority', 'load-balancing', 'link-quality'],
        default: 'priority',
        required: true
      }
    }],
    order: {
      type: String,
      enum: ['priority', 'load-balancing'],
      default: 'priority',
      required: true
    },
    fallback: {
      type: String,
      enum: ['drop', 'by-destination'],
      default: 'drop',
      required: true
    }
  }
}, {
  timestamps: true
});

const multiLinkPolicySchema = new Schema({
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
      message: 'Multi Link policy name format is invalid'
    }
  },
  description: {
    type: String,
    required: false,
    validate: {
      validator: validateDescription,
      message: 'Multi Link policy description format is invalid'
    }
  },
  applyOnWan: {
    type: Boolean,
    default: false,
    required: false
  },
  overrideDefaultRoute: {
    type: Boolean,
    default: true,
    required: false
  },
  version: {
    type: Number,
    min: 0,
    default: 0
  },
  rules: [multiLinkRuleSchema]
}, {
  timestamps: true
});

multiLinkPolicySchema.index({ org: 1, name: 1 }, { unique: true });
module.exports = mongoConns.getMainDB().model('MultiLinkPolicies', multiLinkPolicySchema);
