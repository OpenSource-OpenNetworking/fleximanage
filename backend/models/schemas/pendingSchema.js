// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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
const { pendingTypes } = require('../../deviceLogic/events/eventReasons');

const pendingSchema = {
  // indicate if this item was sent to flexiEdge or configured only in manage
  isPending: {
    type: Boolean,
    default: false
  },
  // pending type. We can query all pending with a given type
  pendingType: {
    type: String,
    enum: [...Object.values(pendingTypes), '']
  },
  // reason for pending item configuration
  pendingReason: {
    type: String,
    default: ''
  },
  // pending time. the time when item become pending
  pendingTime: {
    type: Date
  }
};

module.exports = {
  pendingSchema
};
