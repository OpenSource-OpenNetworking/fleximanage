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
 * Action Database Schema
 */
const action = new Schema({
  type: {
    type: String,
    enum: ['Delete'],
    required: true
  },
  org: {
    type: String,
    required: true
  },
  state: {
    type: String,
    enum: ['active', 'deletePending', 'deleteApproved', 'deleteRejected'],
    required: true
  },
  inventoryId: {
    type: String,
    required: true
  },
  inventoryType: {
    type: String,
    enum: ['Device', 'Organization'],
    required: true
  },
  inventoryName: {
    type: String,
    required: true
  },
  requesterId: {
    type: String,
    required: true,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [24, 'Id must be at most 24']
  },
  requesterComments: {
    type: String,
    required: false,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [120, 'Id must be at most 120']
  },
  approverId: {
    type: String,
    required: true,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [24, 'Id must be at most 24']
  },
  approverComments: {
    type: String,
    required: false,
    minlength: [1, 'Id must be at least 1'],
    maxlength: [120, 'Id must be at most 120']
  }
});

// Default exports
module.exports = {
  action
};
