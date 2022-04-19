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
  validateLabelName,
  validateDescription,
  validateLabelColor
} = require('./validators');

/**
 * Path labels Schema
 */

// Define a getter on object ID that
// converts it to a string
Schema.ObjectId.get(v => v ? v.toString() : v);

const pathLabelSchema = new Schema({
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  name: {
    type: String,
    required: true,
    validate: {
      validator: validateLabelName,
      message: 'Path label name format is invalid'
    }
  },
  description: {
    type: String,
    required: false,
    validate: {
      validator: validateDescription,
      message: 'Path label description format is invalid'
    }
  },
  type: {
    type: String,
    enum: ['DIA', 'Tunnel'],
    default: 'DIA',
    required: true
  },
  color: {
    type: String,
    required: true,
    validate: {
      validator: validateLabelColor,
      message: 'Path label color is invalid'
    }
  }
}, {
  timestamps: true
});

pathLabelSchema.index({ org: 1, name: 1 }, { unique: true });
module.exports = mongoConns.getMainDB().model('PathLabels', pathLabelSchema);
