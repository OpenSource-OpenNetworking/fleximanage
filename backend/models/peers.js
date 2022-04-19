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
const validators = require('./validators');

const dhGroupValues = [
  'none',
  'modp-768',
  'modp-1024',
  'modp-1536',
  'modp-2048',
  'modp-3072',
  'modp-4096',
  'modp-6144',
  'modp-8192',
  'ecp-256',
  'ecp-384',
  'ecp-521',
  'modp-1024-160',
  'modp-2048-224',
  'modp-2048-256',
  'ecp-192'
];

const cryptoAlgsValues = [
  'des-iv64',
  'des',
  '3des',
  'rc5',
  'idea',
  'cast',
  'blowfish',
  '3idea',
  'des-iv32',
  'null',
  'aes-cbc',
  'aes-ctr',
  'aes-gcm-16'
];

const integAlgsValues = [
  'none',
  'md5-96',
  'sha1-96',
  'des-mac',
  'kpdk-md5',
  'aes-xcbc-96',
  'md5-128',
  'sha1-160',
  'cmac-96',
  'aes-128-gmac',
  'aes-192-gmac',
  'aes-256-gmac',
  'hmac-sha2-256-128',
  'hmac-sha2-384-192',
  'hmac-sha2-512-256'
];

const protocolsValues = [
  'any',
  'icmp',
  'tcp',
  'udp'
];

const keySizesValues = ['128', '256'];

/**
 * Peers Database Schema
 */
const peerSchema = new Schema({
  org: {
    type: Schema.Types.ObjectId,
    ref: 'organizations',
    required: true
  },
  // Name of the peer configuration - for UI purpose only
  name: {
    type: String,
    required: [true, 'Name must be set']
  },
  idType: {
    type: String,
    enum: ['fqdn', 'ip4-addr'],
    required: [true, 'ID Type must be set']
  },
  localId: {
    type: String,
    required: [true, 'Local ID must be set'],
    validate: {
      validator: validators.validateStringNoSpaces,
      message: 'Local ID cannot include spaces'
    }
  },
  remoteId: {
    type: String,
    required: [true, 'Remote ID must be set'],
    validate: {
      validator: validators.validateStringNoSpaces,
      message: 'Remote ID cannot include spaces'
    }
  },
  psk: {
    type: String,
    required: [true, 'PSK must be set'],
    validate: {
      validator: validators.validateStringNoSpaces,
      message: 'PSK cannot include spaces'
    }
  },
  remoteIP: {
    type: String,
    required: [true, 'Remote IP must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'Remote IP should be a valid ipv4 address'
    }
  },

  // monitoring
  urls: {
    type: [{
      type: String,
      validate: {
        validator: validators.validateFQDN,
        message: 'URL should be a valid FQDN'
      }
    }],
    default: []
  },
  ips: {
    type: [{
      type: String,
      validate: {
        validator: validators.validateIPv4,
        message: 'IP should be a valid ip address'
      }
    }],
    default: []
  },

  // IKE parameters
  ikeDhGroup: {
    type: String,
    enum: dhGroupValues,
    required: [true, 'ikeDhGroup must be set']
  },
  ikeCryptoAlg: {
    type: String,
    enum: cryptoAlgsValues,
    required: [true, 'ikeCryptoAlg must be set']
  },
  ikeKeySize: {
    type: String,
    enum: keySizesValues,
    required: [true, 'ikeKeySize must be set']
  },
  ikeIntegAlg: {
    type: String,
    enum: integAlgsValues,
    required: [true, 'ikeIntegAlg must be set']
  },

  // ESP parameters
  espDhGroup: {
    type: String,
    enum: dhGroupValues,
    required: [true, 'espDhGroup must be set']
  },
  espCryptoAlg: {
    type: String,
    enum: cryptoAlgsValues,
    required: [true, 'espCryptoAlg must be set']
  },
  espKeySize: {
    type: String,
    enum: keySizesValues,
    required: [true, 'espKeySize must be set']
  },
  espIntegAlg: {
    type: String,
    enum: integAlgsValues,
    required: [true, 'espIntegAlg must be set']
  },
  sessionLifeTime: {
    type: String,
    required: [true, 'sessionLifeTime must be set'],
    validate: {
      validator: validators.validateIsInteger,
      message: 'sessionLifeTime should be an integer'
    }
  },

  // local traffic selected
  localIpRangeStart: {
    type: String,
    maxlength: [20, 'localIpRangeStart length must be at most 20'],
    required: [true, 'localIpRangeStart must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'localIpRangeStart should be a valid ip address'
    }
  },
  localIpRangeEnd: {
    type: String,
    maxlength: [20, 'localIpRangeStart length must be at most 20'],
    required: [true, 'localIpRangeStart must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'localIpRangeStart should be a valid ip address'
    }
  },
  localPortRangeStart: {
    type: String,
    maxlength: [5, 'localPortRangeStart length must be at most 5'],
    required: [true, 'localPortRangeStart must be set'],
    validate: {
      validator: validators.validatePort,
      message: 'localPortRangeStart should be a valid Port value'
    }
  },
  localPortRangeEnd: {
    type: String,
    maxlength: [5, 'localPortRangeStart length must be at most 5'],
    required: [true, 'localPortRangeEnd must be set'],
    validate: {
      validator: validators.validatePort,
      message: 'localPortRangeEnd should be a valid Port value'
    }
  },
  localProtocol: {
    type: String,
    enum: protocolsValues,
    required: [true, 'localProtocol must be set']
  },

  // remote traffic selected
  remoteIpRangeStart: {
    type: String,
    maxlength: [20, 'remoteIpRangeStart length must be at most 20'],
    required: [true, 'remoteIpRangeStart must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'remoteIpRangeStart should be a valid ip address'
    }
  },
  remoteIpRangeEnd: {
    type: String,
    maxlength: [20, 'remoteIpRangeEnd length must be at most 20'],
    required: [true, 'remoteIpRangeEnd must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'remoteIpRangeEnd should be a valid ip address'
    }
  },
  remotePortRangeStart: {
    type: String,
    maxlength: [5, 'remotePortRangeStart length must be at most 5'],
    required: [true, 'remotePortRangeStart must be set'],
    validate: {
      validator: validators.validatePort,
      message: 'remotePortRangeStart should be a valid Port value'
    }
  },
  remotePortRangeEnd: {
    type: String,
    maxlength: [5, 'remotePortRangeEnd length must be at most 5'],
    required: [true, 'remotePortRangeEnd must be set'],
    validate: {
      validator: validators.validatePort,
      message: 'remotePortRangeEnd should be a valid Port value'
    }
  },
  remoteProtocol: {
    type: String,
    enum: protocolsValues,
    required: [true, 'remoteProtocol must be set']
  }
}, {
  timestamps: true
});

// Peer name per org must be unique
peerSchema.index({ name: 1, org: 1 }, { unique: true });

// Default exports
module.exports = mongoConns.getMainDB().model('peers', peerSchema);
