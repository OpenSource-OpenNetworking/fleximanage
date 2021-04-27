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

const validators = require('./validators');
const { validateConfiguration } = require('../deviceLogic/interfaces');
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const mongoConns = require('../mongoConns.js')();

/**
 * Interfaces Database Schema
 */
const interfacesSchema = new Schema({
  // interface name
  name: {
    type: String,
    minlength: [1, 'Name length must be at least 1'],
    maxlength: [50, 'Name length must be at most 50'],
    validate: {
      validator: validators.validateIfcName,
      message: 'name should be a vaild interface name'
    },
    required: [true, 'Interface name must be set']
  },
  // Device bus address
  devId: {
    type: String,
    maxlength: [50, 'devId length must be at most 50'],
    validate: {
      validator: validators.validateDevId,
      message: 'devId should be a vaild devId address'
    },
    default: ''
  },
  // driver name
  driver: {
    type: String,
    maxlength: [30, 'Network driver length must be at most 50'],
    validate: {
      validator: validators.validateDriverName,
      message: 'driver should be a valid driver name'
    },
    required: [true, 'Driver name must be set'],
    default: ''
  },
  // MAC address XX:XX:XX:XX:XX:XX
  MAC: {
    type: String,
    maxlength: [20, 'MAC length must be at most 20'],
    validate: {
      validator: validators.validateMacAddress,
      message: 'MAC should be a valid MAC address'
    }
  },
  // DHCP client for IPv4 : yes|no
  dhcp: {
    type: String,
    uppercase: false,
    validate: {
      validator: validators.validateDHCP,
      message: 'DHCP should be yes or no'
    },
    default: 'no'
  },
  dnsServers: {
    type: [String],
    default: ['8.8.8.8', '8.8.4.4']
  },
  dnsDomains: {
    type: [String]
  },
  // ipv4 address
  IPv4: {
    type: String,
    maxlength: [20, 'IPv4 length must be at most 20'],
    validate: {
      validator: validators.validateIPv4,
      message: 'IPv4 should be a vaild ip address'
    },
    default: ''
  },
  // ipv4 mask
  IPv4Mask: {
    type: String,
    maxlength: [5, 'IPv4 mask length must be at most 5'],
    validate: {
      validator: validators.validateIPv4Mask,
      message: 'IPv4Mask should be a vaild mask'
    }
  },
  // ipv6 address
  IPv6: {
    type: String,
    maxlength: [50, 'IPv6 length must be at most 50'],
    validate: {
      validator: validators.validateIPv6,
      message: 'IPv6 should be a vaild ip address'
    },
    default: ''
  },
  // ipv6 mask
  IPv6Mask: {
    type: String,
    maxlength: [5, 'IPv6 mask length must be at most 5'],
    validate: {
      validator: validators.validateIPv6Mask,
      message: 'IPv6Mask should be a vaild mask'
    }
  },
  // external ip address
  PublicIP: {
    type: String,
    maxlength: [50, 'Public IPv4 length must be at most 50'],
    validate: {
      validator: validators.validateIPaddr,
      message: 'PublicIP should be a valid IPv4 or IPv6 address'
    },
    default: ''
  },
  // external NAT traversal (STUN) port
  PublicPort: {
    type: String,
    maxlength: [5, 'Public Port length must be at most 5'],
    validate: {
      validator: validators.validatePort,
      message: 'Public Port should be a valid Port value'
    },
    default: ''
  },
  // Nat Type
  NatType: {
    type: String,
    maxlength: [30, 'NAT Type length must be at most 30'],
    default: ''
  },
  // use STUN to define public IP address and port
  useStun: {
    type: Boolean,
    default: true
  },
  // use port forwarding to define fixed public port
  useFixedPublicPort: {
    type: Boolean,
    default: false
  },
  // WAN interface default GW
  gateway: {
    type: String,
    maxlength: [50, 'gateway length must be at most 50'],
    validate: {
      validator: validators.validateIPaddr,
      message: 'gateway should be a valid IPv4 or IPv6 address'
    },
    default: ''
  },
  // metric
  metric: {
    type: String,
    default: '0',
    validate: {
      validator: validators.validateMetric,
      message: 'Metric should be a number'
    }
  },
  // MTU
  mtu: {
    type: Number,
    default: 1500,
    validate: {
      validator: validators.validateMtu,
      message: 'MTU should be a number between 500 and 9000'
    }
  },
  // assigned
  isAssigned: {
    type: Boolean,
    default: false
  },
  // routing
  routing: {
    type: String,
    uppercase: true,
    validate: {
      validator: validators.validateRoutingProto,
      message: 'routing should be a valid protocol name'
    },
    default: 'NONE'
  },
  // interface type
  type: {
    type: String,
    uppercase: true,
    validate: {
      validator: validators.validateIfcType,
      message: 'type should be a valid interface type'
    },
    default: 'NONE'
  },
  pathlabels: [{
    type: Schema.Types.ObjectId,
    ref: 'PathLabels'
  }],
  // true if the agent needs to monitor internet access on the WAN interface
  monitorInternet: {
    type: Boolean,
    default: true
  },
  // true if there is an internet access on the WAN interface
  internetAccess: {
    type: String,
    enum: [
      '',
      'yes',
      'no'
    ],
    default: ''
  },
  // device type - wifi, lte
  deviceType: {
    type: String,
    default: 'dpdk'
  },
  configuration: {
    type: Object,
    default: {}
  },
  deviceParams: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true,
  minimize: false,
  discriminatorKey: 'deviceType'
});

interfacesSchema.path('configuration').validate(function (value) {
  if (Object.keys(value).length > 0 && this) {
    if (this.deviceType === 'lte' || this.deviceType === 'wifi') {
      const inter = { ...this._doc };
      const { valid, err } = validateConfiguration(inter, value);
      if (valid === true) {
        return true;
      }

      throw new Error(err);
    }
  }
  return true;
});

/**
 * Static Route Database Schema
 */
const staticroutesSchema = new Schema({
  // destination
  destination: {
    type: String,
    validate: {
      validator: validators.validateIPv4WithMask,
      message: 'Destination should be a valid ipv4 with mask type'
    }
  },
  // gateway
  gateway: {
    type: String,
    validate: {
      validator: validators.validateIPv4,
      message: 'Gateway should be a valid ipv4 address'
    }
  },
  // interface name
  ifname: {
    type: String
  },
  // metric
  metric: {
    type: String,
    default: '',
    validate: {
      validator: validators.validateMetric,
      message: 'Metric should be a number'
    }
  }
}, {
  timestamps: true
});

const MACAssignmentSchema = new Schema({
  host: {
    type: String,
    minlength: [1, 'Host length must be at least 1'],
    maxlength: [253, 'Host length must be at most 253'],
    required: [true, 'Host must be set'],
    validate: {
      validator: validators.validateHostName,
      message: 'Host should contain English characters, digits, hyphens and dots'
    }
  },
  mac: {
    type: String,
    maxlength: [20, 'MAC length must be at most 20'],
    required: [true, 'MAC must be set'],
    validate: {
      validator: validators.validateMacAddress,
      message: 'MAC should be a valid MAC address'
    },
    default: ''
  },
  ipv4: {
    type: String,
    maxlength: [20, 'IPv4 length must be at most 20'],
    required: [true, 'IPv4 must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'IPv4 should be a vaild ip address'
    },
    default: ''
  }
});

const DHCPSchema = new Schema({
  interface: {
    type: String,
    minlength: [1, 'Interface length must be at least 1'],
    maxlength: [50, 'Interface length must be at most 50'],
    required: [true, 'Interface must be set'],
    validate: {
      validator: validators.validateDevId,
      message: 'Interface should be a vaild interface devId'
    }
  },
  rangeStart: {
    type: String,
    required: [true, 'Start range must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'IP start range should be a valid ipv4 address'
    }
  },
  rangeEnd: {
    type: String,
    required: [true, 'End range must be set'],
    validate: {
      validator: validators.validateIPv4,
      message: 'IP end range should be a valid ipv4 address'
    }
  },
  dns: [String],
  macAssign: [MACAssignmentSchema],
  status: {
    type: String,
    default: 'failed'
  }
}, {
  timestamps: true
});

/**
 * Device application install schema
 */
const AppIdentificationSchema = new Schema({
  /**
   * Represent the list of clients that asked for app identification
   * A client is a policy/feature that require to install app identification
   * This is only updated by the server when a client asks to install/uninstall
   */
  clients: [String],
  /**
   * This indicates the last time requested to update.
   * Its purpose is to prevent multiple identical requests
   * Updated when a new job request is sent or when the job removed/failed
   * Possible values:
   *  - null: last request indicated to remove app identification
   *  - <Latest Date>: last request indicated to install app identification
   *  - Date(0): indicates an unknown request value, will cause another update
   */
  lastRequestTime: {
    type: Date,
    default: null
  },
  /**
   * This indicates what is installed on the device, only updated by job complete callback
   * Possible values:
   *  - null: last request indicated to remove app identification
   *  - <Latest Date>: last request indicated to install app identification
   */
  lastUpdateTime: {
    type: Date,
    default: null
  }
}, {
  timestamps: false
});

/**
 * Device Version Database Schema
 */
const deviceVersionsSchema = new Schema({
  // device unique name
  device: {
    type: String,
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
      'Version must be a valid Semver version'
    ]
  },
  // agent version
  agent: {
    type: String,
    required: [true, 'Agent version must be set'],
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
      'Version must be a valid Semver version'
    ],
    default: ''
  },
  // router version
  router: {
    type: String,
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
      'Version must be a valid Semver version'
    ]
  },
  // VPP
  vpp: {
    type: String,
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?(-[a-z0-9]{1,10})?$/i,
      'Version must be a valid VPP version'
    ]
  },
  // FRR
  frr: {
    type: String,
    match: [
      /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
      'Version must be a valid FRR version'
    ]
  }
});

/**
 * Device policy schema
 */
const devicePolicySchema = new Schema({
  _id: false,
  policy: {
    type: Schema.Types.ObjectId,
    ref: 'MultiLinkPolicies',
    default: null
  },
  status: {
    type: String,
    enum: [
      '',
      'installing',
      'installed',
      'uninstalling',
      'job queue failed',
      'job deleted',
      'installation failed',
      'uninstallation failed'
    ],
    default: ''
  },
  requestTime: {
    type: Date,
    default: null
  }
});

/**
 * Version Upgrade Database Schema
 */
const versionUpgradeSchema = new Schema({
  // timestamp
  time: {
    type: Date,
    default: null
  },
  // queued or not
  jobQueued: {
    type: Boolean,
    default: false
  }
});

/**
 * Device sync Database Schema
 */
const deviceSyncSchema = new Schema({
  _id: false,
  state: {
    type: String,
    enum: [
      'synced',
      'syncing',
      'not-synced',
      'unknown'
    ],
    default: 'synced'
  },
  hash: {
    type: String,
    default: ''
  },
  trials: {
    type: Number,
    default: 0
  },
  autoSync: {
    type: String,
    enum: ['on', 'off'],
    default: 'on'
  }
});

/**
 * IKEv2 parameters Database Schema
 */
const IKEv2Schema = new Schema({
  // public certificate
  certificate: {
    type: String,
    default: ''
  },
  // expiration time
  expireTime: {
    type: Date,
    default: null
  },
  // queued or not
  jobQueued: {
    type: Boolean,
    default: false
  }
});

/**
 * Device Database Schema
 */
const deviceSchema = new Schema({
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
  // name
  name: {
    type: String,
    maxlength: [50, 'Name length must be at most 50'],
    validate: {
      validator: validators.validateDeviceName,
      message: 'Device name format is invalid'
    },
    default: ''
  },
  // description
  description: {
    type: String,
    maxlength: [50, 'Description length must be at most 50'],
    validate: {
      validator: validators.validateDescription,
      message: 'Device description format is invalid'
    },
    default: ''
  },
  // site
  site: {
    type: String,
    maxlength: [50, 'Site length must be at most 50'],
    validate: {
      validator: validators.validateDeviceSite,
      message: 'Device site format is invalid'
    },
    default: ''
  },
  // host name
  hostname: {
    type: String,
    minlength: [1, 'Hostname length must be at least 1'],
    maxlength: [253, 'Hostname length must be at most 253'],
    validate: {
      validator: validators.validateHostName,
      message: 'Device hostname should contain English characters, digits, hyphens and dots'
    }
  },
  // default route
  defaultRoute: {
    type: String,
    maxlength: [50, 'defaultRoute length must be at most 50'],
    validate: {
      validator: validators.validateIPv4,
      message: 'defaultRoute should be a vaild ip address'
    },
    default: ''
  },
  // list of IPs
  ipList: {
    type: String,
    maxlength: [200, 'IP list length must be at most 200'],
    validate: {
      validator: validators.validateIpList,
      message: 'ipList should be a list of comma separated IP addresses'
    }
  },
  // unique device id
  machineId: {
    type: String,
    required: [true, 'MachineId is required'],
    maxlength: [50, 'Machine ID length must be at most 50'],
    validate: {
      validator: validators.validateMachineID,
      message: 'machineId should be a valid machine ID'
    },
    unique: true
  },
  serial: {
    type: String,
    maxlength: [250, 'Serial number length must be at most 250'],
    validate: {
      validator: validators.validateSerial,
      message: 'Not a valid serial number'
    },
    default: '0'
  },
  // token
  fromToken: {
    type: String,
    required: [true, 'fromToken is required'],
    minlength: [3, 'Token name length must be at least 3'],
    maxlength: [15, 'Token name length must be at most 15'],
    validate: {
      validator: validators.validateTokenName,
      message: 'Token name format is invalid'
    }
  },
  // token
  deviceToken: {
    type: String,
    maxlength: [1024, 'Device token length must be at most 1024']
    // Device token is not set by the user, therefore does not require a validator
  },
  // is device statis approved
  isApproved: {
    type: Boolean,
    default: false
  },
  // is device connected
  isConnected: {
    type: Boolean,
    default: false
  },
  // versions
  versions: {
    type: deviceVersionsSchema,
    required: [true, 'Device versions must be set']
  },
  // list of static routes configured on device
  staticroutes: [staticroutesSchema],
  // LAN side DHCP
  dhcp: [DHCPSchema],
  // App Identification Schema
  appIdentification: AppIdentificationSchema,
  // schedule for upgrade process
  upgradeSchedule: {
    type: versionUpgradeSchema,
    default: versionUpgradeSchema
  },
  // list of interfaces
  interfaces: [interfacesSchema],
  // labels
  labels: [String],
  policies: {
    multilink: {
      type: devicePolicySchema,
      default: devicePolicySchema
    }
  },
  sync: {
    type: deviceSyncSchema,
    default: deviceSyncSchema
  },
  // IKEv2 parameters
  IKEv2: {
    type: IKEv2Schema,
    default: IKEv2Schema
  }
},
{
  timestamps: true
}
);

// Default exports
module.exports =
{
  devices: mongoConns.getMainDB().model('devices', deviceSchema),
  interfaces: mongoConns.getMainDB().model('interfaces', interfacesSchema),
  versions: mongoConns.getMainDB().model('versions', deviceVersionsSchema),
  staticroutes: mongoConns.getMainDB().model('staticroutes', staticroutesSchema),
  dhcpModel: mongoConns.getMainDB().model('dhcp', DHCPSchema),
  upgradeSchedule: mongoConns.getMainDB().model('upgradeSchedule', versionUpgradeSchema)
};
