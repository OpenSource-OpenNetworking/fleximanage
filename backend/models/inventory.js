// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

/**
 * Inventory Database Schema
 */
const inventory = new Schema({
  state: {
    type: String,
    enum: ['active', 'deletePending', 'deleteApproved', 'deleteRejected'],
    required: true
  },
  requesterId: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  requesterComments: {
    type: String,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [120, 'Id must be at most 120'],
    required: false
  },
  approverId: {
    type: String,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [24, 'Id must be at most 24'],
    required: false
  },
  approverComments: {
    type: String,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [120, 'Id must be at most 120'],
    required: false
  }
});

// Default exports
module.exports = {
  inventory
};
