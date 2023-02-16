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

const { Schema, Types } = require('mongoose');
const {
  validateIPv4WithMask,
  validateIPv4,
  validatePort,
  validatePortRange
} = require('./validators');

// Source classification schema
const sourceClassificationSchema = new Schema({
  ipPort: {
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
    }
  },
  trafficId: {
    type: String,
    maxlength: [25, 'trafficId must be at most 25']
  }
});

// Destination classification schema
const destinationClassificationSchema = new Schema({
  ipProtoPort: {
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
    protocols: {
      type: [String],
      default: undefined,
      required: false,
      enum: ['tcp', 'udp', 'icmp']
    },
    interface: {
      type: String,
      maxlength: [25, 'interface must be at most 25']
    }
  },
  trafficId: {
    type: String,
    maxlength: [25, 'trafficId must be at most 25']
  },
  trafficTags: {
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
});

// Rule schema
const firewallRuleSchema = new Schema({
  description: {
    type: String,
    required: false,
    maxlength: [100, 'Rule description length must be at most 100']
  },
  direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    default: 'inbound',
    required: true
  },
  inbound: {
    type: String,
    enum: ['edgeAccess', 'portForward', 'nat1to1'],
    default: 'edgeAccess',
    required: true
  },
  internalIP: {
    type: String,
    validate: {
      validator: validateIPv4,
      message: 'Internal IP should be a valid ip address'
    },
    required: false
  },
  internalPortStart: {
    type: String,
    validate: {
      validator: validatePort,
      message: 'Port format is invalid'
    },
    required: false
  },
  priority: {
    type: Number,
    min: [-1000, 'priority should be a number between -1000 - 1000'],
    max: [1000, 'priority should be a number between 0 - 1000'],
    required: true
  },
  enabled: {
    type: Boolean,
    default: true,
    required: true
  },
  classification: {
    source: {
      type: sourceClassificationSchema,
      default: sourceClassificationSchema
    },
    destination: {
      type: destinationClassificationSchema,
      default: destinationClassificationSchema
    }
  },
  action: {
    type: String,
    enum: ['allow', 'deny'],
    default: 'allow',
    required: true
  },
  interfaces: [{
    type: String
  }],
  // indicates if rule created by the system and cannot be modified by a user
  system: {
    type: Boolean,
    required: true,
    default: false
  },
  // In the case of a system rule, save some reference that associates
  // it with another component in the system (an app for example)
  reference: {
    type: Types.ObjectId,
    required: false,
    refPath: 'referenceModel'
  },
  referenceModel: {
    type: String,
    required: false,
    enum: ['applications']
  },
  referenceNumber: {
    type: Number,
    required: false
  }
});

module.exports = { firewallRuleSchema };
