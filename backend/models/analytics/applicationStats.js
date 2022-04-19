// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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
 * Applications statistics Database Schema
 */
const applicationsStatsSchema = new Schema({
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
  // application identifier
  app: {
    type: Schema.Types.String,
    required: true
  },
  // Free form, not schema based
  stats: Schema.Types.Mixed
}, {
  timestamps: true
});

// Remove documents created older than configured in analyticsStatsKeepTime
applicationsStatsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: configs.get('analyticsStatsKeepTime', 'number') }
);

const applicationsStats = mongoConns.getAnalyticsDB()
  .model('applicationStats', applicationsStatsSchema);

// Default exports
module.exports = applicationsStats;
