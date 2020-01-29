// flexiWAN SD-WAN software - flexiEdge, flexiManage. For more information go to https://flexiwan.com
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
        minlength: 1,
        maxlength: [50, "Name length must be at most 50"],
        validate: {
            validator: validators.validateIfcName,
            message: "name should be a vaild interface name"
        },
        required: [true, "Interface name must be set"]
    },
    // PCI address
    pciaddr: {
        type: String,
        maxlength: [50, "PCI address length must be at most 50"],
        validate: {
            validator: validators.validatePciAddress,
            message: "pciaddr should be a vaild pci address"
        },
        default: ""
    },
    // driver name
    driver: {
        type: String,
        maxlength: [30, "Network driver length must be at most 50"],
        validate: {
            validator: validators.validateDriverName,
            message: "driver should be a valid driver name"
        },
        required: [true, "Driver name must be set"],
        default: ""
    },
    // MAC address XX:XX:XX:XX:XX:XX
    MAC: {
        type: String,
        maxlength: [20, "MAC length must be at most 20"],
        validate: {
            validator: validators.validateMacAddress,
            message: "MAC should be a valid MAC address"
        },
    },
    // ipv4 address
    IPv4: {
        type: String,
        maxlength: [20, "IPv4 length must be at most 20"],
        validate: {
            validator: validators.validateIPv4,
            message: "IPv4 should be a vaild ip address"
        },
        default: ""
    },
    // ipv4 mask
    IPv4Mask: {
        type: String,
        maxlength: [5, "IPv4 mask length must be at most 5"],
        validate: {
            validator: validators.validateIPv4Mask,
            message: "IPv4Mask should be a vaild mask"
        },
    },
    // ipv6 address
    IPv6: {
        type: String,
        maxlength: [50, "IPv6 length must be at most 50"],
        validate: {
            validator: validators.validateIPv6,
            message: "IPv6 should be a vaild ip address"
        },
        default: ""
    },
    // ipv6 mask
    IPv6Mask: {
        type: String,
        maxlength: [5, "IPv6 mask length must be at most 5"],
        validate: {
            validator: validators.validateIPv6Mask,
            message: "IPv6Mask should be a vaild mask"
        },
    },
    // external ip address
    PublicIP: {
        type: String,
        maxlength: [50, "Public IPv4 length must be at most 50"],
        validate: {
            validator: validators.validateIPaddr,
            message: "PublicIP should be a valid IPv4 or IPv6 address"
        },
        default: ""
    },
    // assigned
    isAssigned: {
        type: Boolean,
        default: false,
    },
    // routing
    routing: {
        type: String,
        uppercase: true,
        validate: {
            validator: validators.validateRoutingProto,
            message: "routing should be a valid protocol name"
        },
        default: "NONE"
    },
    // interface type
    type: {
        type: String,
        uppercase: true,
        validate: {
            validator: validators.validateIfcType,
            message: "type should be a valid interface type"
        },
        default: "NONE"
    }
}, {
    timestamps: true
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
            message: "Destination should be a valid ipv4 with mask type"
        }
    },
    // gateway
    gateway: {
        type: String,
        validate: {
            validator: validators.validateIPv4,
            message: "Gateway should be a valid ipv4 address"
        }
    },
    // interface name
    ifname: {
        type: String
    },
}, {
    timestamps: true
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
            "Version must be a valid Semver version"
        ],
    },
    // agent version
    agent: {
        type: String,
        required: [true, "Agent version must be set"],
        match: [
            /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
            "Version must be a valid Semver version"
        ],
        default: ""
    },
    // router version
    router: {
        type: String,
        match: [
            /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
            "Version must be a valid Semver version"
        ],
    },
    // VPP
    vpp: {
        type: String,
        match: [
            /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?(-[a-z0-9]{1,10})?$/i,
            "Version must be a valid VPP version"
        ],
    },
    // FRR
    frr: {
        type: String,
        match: [
            /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
            "Version must be a valid FRR version"
        ],
    }
});

/**
 * Device pending job schema
 */
const pendingJobSchema = new Schema({
    // Is there a pending job for the device
    jobPending: {
        type: Boolean,
        default: false
    },
    // The ID of the pending job
    jobId: {
        type: String,
        default: null
    },
});

/**
 * Version Upgrade Database Schema
 */
const versionUpgradeSchema = new Schema({
    // timestamp
    time: {
        type: Date,
        default: null,
    },
    // queued or not
    jobQueued: {
        type: Boolean,
        default: false,
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
      maxlength: [50, "Name length must be at most 50"],
        validate: {
            validator: validators.validateDeviceName,
            message: "Device name format is invalid"
        },
      default: ""
    },
    // description
    description: {
        type: String,
        maxlength: [50, "Description length must be at most 50"],
        validate: {
            validator: validators.validateDevDescription,
            message: "Device description format is invalid"
        },
        default: ""
    },
    // site
    site: {
        type: String,
        maxlength: [50, "Site length must be at most 50"],
        validate: {
            validator: validators.validateDeviceSite,
            message: "Device site format is invalid"
        },
        default: ""
    },
    // host name
    hostname: {
        type: String,
        minlength: [1, "Hostname length must be at least 1"],
        maxlength: [253, "Hostname length must be at most 253"],
        validate: {
            validator: validators.validateHostName,
            message: "Device hostname should contain English characters, digits, hyphens and dots"
        },
    },
    // default route
    defaultRoute: {
      type: String,
      maxlength: [50, "defaultRoute length must be at most 50"],
      validate: {
        validator: validators.validateIPv4,
        message: "defaultRoute should be a vaild ip address"
      },
      default: ""
    },
    // list of IPs
    ipList: {
        type: String,
        maxlength: [200, "IP list length must be at most 200"],
        validate: {
            validator: validators.validateIpList,
            message: "ipList should be a list of comma separated IP addresses"
        },
    },
    // unique device id
    machineId: {
        type: String,
        required: [true, "MachineId is required"],
        maxlength: [50, "Machine ID length must be at most 50"],
        validate: {
            validator: validators.validateMachineID,
            message: "machineId should be a valid machine ID"
        },
        unique: true
    },
    // token
    fromToken: {
        type: String,
        required: [true, 'fromToken is required'],
        minlength: [3, "Token name length must be at least 3"],
        maxlength: [15, "Token name length must be at most 15"],
        validate: {
            validator: validators.validateTokenName,
            message: "Token name format is invalid"
        },
    },
    // token
    deviceToken: {
        type: String,
        maxlength: [1024, "Device token length must be at most 1024"],
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
      required: [true, "Device versions must be set"]
    },
    // list of static routes configured on device
    staticroutes: [staticroutesSchema],
    // schedule for upgrade process
    upgradeSchedule: {
        type: versionUpgradeSchema,
        default: versionUpgradeSchema,
    },
    // list of interfaces
    interfaces: [interfacesSchema],
    // labels
    labels: [String],
    // is modification in progress flag
    pendingDevModification: {
        type: pendingJobSchema,
        default: pendingJobSchema
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
    upgradeSchedule: mongoConns.getMainDB().model('upgradeSchedule', versionUpgradeSchema),
};