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

/**
 * AI Chat Log Schema
 */
const aiChatLogSchema = new Schema({
  // Account
  account: {
    type: Schema.Types.ObjectId,
    ref: 'accounts',
    required: true
  },
  // Organization
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // Session
  session: {
    type: Schema.Types.String,
    required: true
  },
  transactions: {
    type: [{
    // Query
      query: {
        type: Schema.Types.String,
        required: true
      },
      // Answer
      answer: {
        type: Schema.Types.String,
        required: true
      },
      // If answer found
      found: {
        type: Boolean,
        default: true
      },
      isQuestion: {
        type: Boolean,
        default: true
      },
      tool: {
        type: Schema.Types.String,
        default: ''
      },
      // List of recommended sources
      sources: [String]
    }],
    default: []
  },
  // Is useful response
  useful: {
    type: Schema.Types.Boolean,
    required: false,
    default: null
  }
},
{
  timestamps: { createdAt: true, updatedAt: false }
});

// Indexes
aiChatLogSchema.index({ session: 1 });
aiChatLogSchema.index({ createdAt: 1, account: 1 });

const aiChatLog = mongoConns.getAnalyticsDB()
  .model('aiChatLog', aiChatLogSchema);

// Default exports
module.exports = aiChatLog;
