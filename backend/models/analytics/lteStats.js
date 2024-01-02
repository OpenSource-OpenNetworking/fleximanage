// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2024  flexiWAN Ltd.

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
const mongoConns = require('../../mongoConns.js')();
const configs = require('../../configs.js')();
const validators = require('../validators.js');
const logger = require('../../logging/logging.js')({ module: module.filename, type: 'req' });

/**
 * LTE statistics Database Schema
*/
const schema = {
  // Organization
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // Device Object ID
  device: {
    type: Schema.Types.ObjectId,
    ref: 'devices'
  },
  // Interface Dev ID
  interfaceDevId: {
    type: String,
    maxlength: [50, 'interfaceDevId length must be at most 50'],
    validate: {
      validator: validators.validateDevId,
      message: 'interfaceDevId should be a valid devId address'
    }
  },
  // Epoc time in UTC
  time: {
    type: Number,
    default: 0
  },
  // Free form, not schema based
  stats: Schema.Types.Mixed
};

// This collection includes *multiple documents* for each LTE interface to gather statistics.
// The documents are removed after 2 hours.
const lteStatsSchema = new Schema(schema, {
  timestamps: true
});
// Remove documents created older than configured in analyticsStatsKeepTime
lteStatsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: configs.get('analyticsStatsKeepTime', 'number') }
);

// This collection includes *a single document* for each LTE interface.
// The goal is to always have the latest LTE status in our database.
// The documents won't be removed after two hours.
const lteLastStatsSchema = new Schema(schema, {
  timestamps: true
});
lteLastStatsSchema.index({ org: 1, deviceId: 1, interfaceDevId: 1 });

/*
This middleware takes every document created in the first collection (which has data
that is deleted after two hours) and store it in the second collection (which has
data that persists).
If there is already a document in the second collection for that interface,
it will be replaced by the new document, as only the latest data should be saved.
*/
lteStatsSchema.post('save', (doc, next) => {
  lteLastStats.updateOne(
    {
      org: doc.org,
      device: doc.device,
      interfaceDevId: doc.interfaceDevId
    },
    { $set: { stats: { ...doc.stats, time: doc.time } } },
    { upsert: true }
  ).catch(err => {
    logger.error('Unable to save last LTE status', { params: { message: err.message } });
  }).finally(() => {
    next();
  });
});

const lteStats = mongoConns.getAnalyticsDB()
  .model('lteStats', lteStatsSchema);

const lteLastStats = mongoConns.getAnalyticsDB()
  .model('lteLastStats', lteLastStatsSchema);

// Default exports
module.exports = { lteStats, lteLastStats };
