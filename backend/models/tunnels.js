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
const { pendingSchema } = require('./schemas/pendingSchema');

// Tunnels params schema
const tunnelKeysSchema = new Schema({
  _id: false,
  key1: {
    type: String,
    default: '',
    required: true
  },
  key2: {
    type: String,
    default: '',
    required: true
  },
  key3: {
    type: String,
    default: '',
    required: true
  },
  key4: {
    type: String,
    default: '',
    required: true
  }
});

// Tunnel advanced options schema
const tunnelAdvancedOptionsSchema = new Schema({
  _id: false,
  // MTU of the tunnel
  mtu: {
    type: String,
    default: ''
  },
  // TCP MSS Clamping
  mssClamp: {
    type: String,
    enum: ['', 'yes', 'no'],
    default: ''
  },
  // OSPF cost
  ospfCost: {
    type: String,
    default: ''
  },
  routing: {
    type: String,
    enum: ['ospf', 'bgp'],
    default: 'ospf'
  }
});

/**
 * Tunnels Database Schema
 */
const tunnelSchema = new Schema({
  // Organization
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // Unique tunnel number. This number is used to generate the tunnel parameters
  num: {
    type: Number,
    default: 0
  },
  // Indicate if the tunnel is used or deleted
  isActive: {
    type: Boolean,
    default: false
  },
  encryptionMethod: {
    type: String,
    enum: ['none', 'psk', 'ikev2'],
    default: 'psk'
  },
  // device A participate in the tunnel
  deviceA: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'devices'
  },
  interfaceA: {
    type: mongoose.Schema.Types.ObjectId
  },
  // device B participate in the tunnel
  deviceB: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'devices'
  },
  interfaceB: {
    type: mongoose.Schema.Types.ObjectId
  },
  // Indicate if the tunnel is configured for deviceA
  deviceAconf: {
    type: Boolean,
    default: false
  },
  // Indicate if the tunnel is configured for deviceB
  deviceBconf: {
    type: Boolean,
    default: false
  },
  // Tunnel keys
  tunnelKeys: {
    type: tunnelKeysSchema,
    default: null
  },

  // The path label assigned to the tunnel
  pathlabel: {
    type: Schema.Types.ObjectId,
    ref: 'PathLabels'
  },
  // is modification in progress flag
  pendingTunnelModification: {
    type: Boolean,
    default: false
  },
  // Tunnel status
  status: {
    type: String,
    enum: ['', 'up', 'down'],
    default: ''
  },
  // The peer configuration for the tunnel
  peer: {
    type: Schema.Types.ObjectId,
    ref: 'peers',
    default: null
  },
  // Tunnel advanced options
  advancedOptions: {
    type: tunnelAdvancedOptionsSchema,
    default: null
  },
  ...pendingSchema
}, {
  timestamps: true
});

// tunnel number per org must be unique
tunnelSchema.index({ num: 1, org: 1 }, { unique: true });

// Default exports
module.exports = mongoConns.getMainDB().model('tunnels', tunnelSchema);
