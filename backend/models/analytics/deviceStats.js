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
const mongoConns = require('../../mongoConns.js')();
const configs = require('../../configs')();

/**
 * Device statistics Database Schema
 */
const deviceStatsSchema = new Schema({
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
  // Epoc time in UTC
  time: {
    type: Number,
    default: 0
  },
  // Free form, not schema based
  stats: Schema.Types.Mixed,
  tunnels: Schema.Types.Mixed,
  health: Schema.Types.Mixed,
  wanMonitoring: Schema.Types.Mixed
}, {
  timestamps: true
});

/**
 * Aggregated Device Statistics Database Schema
 */
const deviceAggregateStatsSchema = new Schema({
  // month
  month: {
    type: Number,
    default: 0,
    required: true
  },
  // statistics mixed schema
  stats: Schema.Types.Mixed
}, {
  timestamps: true
});

// Remove documents created older than configured in analyticsStatsKeepTime
deviceStatsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: configs.get('analyticsStatsKeepTime', 'number') }
);

const deviceStats = mongoConns.getAnalyticsDB().model('deviceStats', deviceStatsSchema);
const deviceAggregateStats = mongoConns
  .getAnalyticsDB()
  .model('deviceAggregatedStats', deviceAggregateStatsSchema);

// Default exports
module.exports = {
  deviceStats,
  deviceAggregateStats
};
