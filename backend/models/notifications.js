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

const targetsSchema = new Schema({
  deviceId: {
    type: Schema.Types.ObjectId,
    ref: 'devices',
    required: false
  },
  tunnelId: {
    type: String,
    required: false
  },
  interfaceId: {
    type: Schema.Types.ObjectId,
    ref: 'devices',
    required: false
  }
  // policyId: {
  //   type: Schema.Types.ObjectId,
  //   required: false
  // }
});

const alertInfoSchema = new Schema({
  value: {
    type: Number
  },
  threshold: {
    type: Number
  },
  unit: {
    type: String,
    enum: ['%', 'ms', 'C°']
  },
  type: {
    type: String,
    enum: ['tunnel', 'device']
  }
});

/**
 * Notifications Database Schema
 */
const notificationsSchema = new Schema({
  // organization
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // account
  account: {
    type: Schema.Types.ObjectId,
    ref: 'accounts',
    required: true
  },
  // title
  title: {
    type: String,
    required: true
  },
  // timestamp
  time: {
    type: Date,
    required: true
  },
  // additional details, description
  details: {
    type: String,
    required: true
  },
  // notification status
  status: {
    type: String,
    required: true,
    default: 'unread'
  },
  count: {
    type: Number,
    required: false,
    default: 1
  },
  eventType: {
    type: String,
    required: false,
    enum: ['Device connection',
      'Running router',
      'Link/Tunnel round trip time',
      'Link/Tunnel default drop rate',
      'Device memory usage',
      'Hard drive usage',
      'Temperature',
      'Software update',
      'Internet connection',
      'Link status',
      'Missing interface ip',
      'Pending tunnel',
      'Tunnel connection',
      'Failed self-healing',
      'Static route state'
    ]
  },
  resolved:
  {
    type: Boolean,
    default: false
  },
  targets: {
    type: targetsSchema,
    required: true
  },
  severity: {
    type: String,
    required: true,
    enum: ['warning', 'critical', null],
    default: null
  },
  agentAlertsInfo: {
    type: alertInfoSchema,
    default: {}
  },
  emailSent: {
    sendingTime: {
      type: Date,
      default: null
    },
    rateLimitedCount: {
      type: Number,
      default: 0
    }
  },
  isInfo: {
    type: Boolean,
    default: false
  },
  lastResolvedStatusChange: {
    type: Date,
    default: new Date()
  }
}, {
  timestamps: true
});

// Remove read notifications created more than a week ago
notificationsSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 604800,
    partialFilterExpression: { status: 'read' }
  }
);
notificationsSchema.index({ org: 1 });
notificationsSchema.index({ account: 1 });
notificationsSchema.index({ status: 1 });
notificationsSchema.index({ eventType: 1, org: 1 }); // helps in heavy queries of notifications
notificationsSchema.index({ org: 1, resolved: 1 }); // helps in heavy queries of notifications
notificationsSchema.index({ org: 1, resolved: 1, eventType: 1 });
notificationsSchema.index({ org: 1, eventType: 1, targets: 1 });
notificationsSchema.index({ org: 1, eventType: 1, 'targets.tunnelId': 1 });

// Default exports
module.exports = mongoConns.getAnalyticsDB().model('notifications', notificationsSchema);
