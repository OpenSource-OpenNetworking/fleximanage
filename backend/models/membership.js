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

const configs = require('../configs')();
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const mongoConns = require('../mongoConns.js')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

// Permissions bit masks
const permissionMasks = {
  get: 0x1,
  post: 0x2,
  put: 0x4,
  del: 0x8
};
const permissionShifts = {
  get: 0,
  post: 1,
  put: 2,
  del: 3
};

// Each value is 1 or 0 based if API is allowed or not respectively
const setPermission = (get, post, put, del) => {
  return ((get << permissionShifts.get) & permissionMasks.get) +
        ((post << permissionShifts.post) & permissionMasks.post) +
        ((put << permissionShifts.put) & permissionMasks.put) +
        ((del << permissionShifts.del) & permissionMasks.del);
};

const managerDelPermission = () => configs.get('allowManagerToDel', 'boolean') ? 1 : 0;

// Permissions
// Each number is a bitmask of permissions for Del (MSB), Put, Post, Get (LSB)
const Permissions = new Schema({
  jobs: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  billing: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  accounts: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  organizations: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  devices: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  tokens: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  appidentifications:
    { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  members: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  tunnels: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  peers: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  accesstokens: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  notifications: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  pathlabels: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  mlpolicies: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  applications: { type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high'] },
  firewallpolicies: {
    type: Number, min: [0, 'Permission too low'], max: [15, 'Permission too high']
  }
});

// Predefined permissions
const preDefinedPermissions = {
  none: {
    jobs: setPermission(0, 0, 0, 0),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(0, 0, 0, 0),
    organizations: setPermission(0, 0, 0, 0),
    devices: setPermission(0, 0, 0, 0),
    tokens: setPermission(0, 0, 0, 0),
    appidentifications: setPermission(0, 0, 0, 0),
    members: setPermission(0, 0, 0, 0),
    tunnels: setPermission(0, 0, 0, 0),
    peers: setPermission(0, 0, 0, 0),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(0, 0, 0, 0),
    pathlabels: setPermission(0, 0, 0, 0),
    mlpolicies: setPermission(0, 0, 0, 0),
    applications: setPermission(0, 0, 0, 0),
    firewallpolicies: setPermission(0, 0, 0, 0)
  },
  account_owner: {
    jobs: setPermission(1, 1, 1, 1),
    billing: setPermission(1, 1, 0, 0),
    accounts: setPermission(1, 1, 1, 0),
    organizations: setPermission(1, 1, 1, 1),
    devices: setPermission(1, 1, 1, 1),
    tokens: setPermission(1, 1, 1, 1),
    appidentifications: setPermission(1, 1, 1, 1),
    members: setPermission(1, 1, 1, 1),
    tunnels: setPermission(1, 1, 1, 1),
    peers: setPermission(1, 1, 1, 1),
    accesstokens: setPermission(1, 1, 1, 1),
    notifications: setPermission(1, 1, 1, 1),
    pathlabels: setPermission(1, 1, 1, 1),
    mlpolicies: setPermission(1, 1, 1, 1),
    applications: setPermission(1, 1, 1, 1),
    firewallpolicies: setPermission(1, 1, 1, 1)
  },
  account_manager: {
    jobs: setPermission(1, 1, 1, 1),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(1, 0, 0, 0),
    organizations: setPermission(1, 1, 1, managerDelPermission()),
    devices: setPermission(1, 1, 1, managerDelPermission()),
    tokens: setPermission(1, 1, 1, managerDelPermission()),
    appidentifications: setPermission(1, 1, 1, managerDelPermission()),
    members: setPermission(1, 1, 1, managerDelPermission()),
    tunnels: setPermission(1, 1, 1, managerDelPermission()),
    peers: setPermission(1, 1, 1, managerDelPermission()),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 1, 1, 1),
    pathlabels: setPermission(1, 1, 1, 1),
    mlpolicies: setPermission(1, 1, 1, 1),
    applications: setPermission(1, 1, 1, 1),
    firewallpolicies: setPermission(1, 1, 1, managerDelPermission())
  },
  account_viewer: {
    jobs: setPermission(1, 0, 0, 0),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(1, 0, 0, 0),
    organizations: setPermission(1, 0, 0, 0),
    devices: setPermission(1, 0, 0, 0),
    tokens: setPermission(1, 0, 0, 0),
    appidentifications: setPermission(1, 0, 0, 0),
    members: setPermission(1, 0, 0, 0),
    tunnels: setPermission(1, 0, 0, 0),
    peers: setPermission(1, 0, 0, 0),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 0, 0, 0),
    pathlabels: setPermission(1, 0, 0, 0),
    mlpolicies: setPermission(1, 0, 0, 0),
    applications: setPermission(1, 0, 0, 0),
    firewallpolicies: setPermission(1, 0, 0, 0)
  },
  group_manager: {
    jobs: setPermission(1, 1, 1, 1),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(0, 0, 0, 0),
    organizations: setPermission(1, 0, 1, 0),
    devices: setPermission(1, 1, 1, managerDelPermission()),
    tokens: setPermission(1, 1, 1, managerDelPermission()),
    appidentifications: setPermission(1, 1, 1, managerDelPermission()),
    members: setPermission(1, 1, 1, managerDelPermission()),
    tunnels: setPermission(1, 1, 1, managerDelPermission()),
    peers: setPermission(1, 1, 1, managerDelPermission()),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 1, 1, 1),
    pathlabels: setPermission(1, 1, 1, 1),
    mlpolicies: setPermission(1, 1, 1, 1),
    applications: setPermission(1, 1, 1, 1),
    firewallpolicies: setPermission(1, 1, 1, managerDelPermission())
  },
  group_viewer: {
    jobs: setPermission(1, 0, 0, 0),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(0, 0, 0, 0),
    organizations: setPermission(1, 0, 0, 0),
    devices: setPermission(1, 0, 0, 0),
    tokens: setPermission(1, 0, 0, 0),
    appidentifications: setPermission(1, 0, 0, 0),
    members: setPermission(1, 0, 0, 0),
    tunnels: setPermission(1, 0, 0, 0),
    peers: setPermission(1, 0, 0, 0),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 0, 0, 0),
    pathlabels: setPermission(1, 0, 0, 0),
    mlpolicies: setPermission(1, 0, 0, 0),
    applications: setPermission(1, 0, 0, 0),
    firewallpolicies: setPermission(1, 0, 0, 0)
  },
  organization_manager: {
    jobs: setPermission(1, 1, 1, 1),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(0, 0, 0, 0),
    organizations: setPermission(1, 0, 1, 0),
    devices: setPermission(1, 1, 1, managerDelPermission()),
    tokens: setPermission(1, 1, 1, managerDelPermission()),
    appidentifications: setPermission(1, 1, 1, managerDelPermission()),
    members: setPermission(1, 1, 1, managerDelPermission()),
    tunnels: setPermission(1, 1, 1, managerDelPermission()),
    peers: setPermission(1, 1, 1, managerDelPermission()),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 1, 1, 1),
    pathlabels: setPermission(1, 1, 1, managerDelPermission()),
    mlpolicies: setPermission(1, 1, 1, managerDelPermission()),
    applications: setPermission(1, 1, 1, 1),
    firewallpolicies: setPermission(1, 1, 1, managerDelPermission())
  },
  organization_viewer: {
    jobs: setPermission(1, 0, 0, 0),
    billing: setPermission(0, 0, 0, 0),
    accounts: setPermission(0, 0, 0, 0),
    organizations: setPermission(1, 0, 0, 0),
    devices: setPermission(1, 0, 0, 0),
    tokens: setPermission(1, 0, 0, 0),
    appidentifications: setPermission(1, 0, 0, 0),
    members: setPermission(1, 0, 0, 0),
    tunnels: setPermission(1, 0, 0, 0),
    peers: setPermission(1, 0, 0, 0),
    accesstokens: setPermission(0, 0, 0, 0),
    notifications: setPermission(1, 0, 0, 0),
    pathlabels: setPermission(1, 0, 0, 0),
    mlpolicies: setPermission(1, 0, 0, 0),
    applications: setPermission(1, 0, 0, 0),
    firewallpolicies: setPermission(1, 0, 0, 0)
  }
};

/**
 * Membership Database Schema
 */
const Membership = new Schema({
  // user Id
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users'
  },
  // account Id
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'accounts'
  },
  // group name
  group: {
    type: String,
    required: false,
    unique: false,
    maxlength: [50, 'Group length must be at most 50']
  },
  // organization Id
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'organizations'
  },
  // applied to
  to: {
    type: String,
    enum: ['account', 'organization', 'group'],
    required: true
  },
  // default roles are 'owner', 'manager', 'viewer'
  role: {
    type: String,
    required: false,
    unique: false,
    maxlength: [10, 'role length must be at most 10']
  },
  // permissions
  perms: Permissions
});

const membership = mongoConns.getMainDB().model('membership', Membership);

/**
 * Return the best permissions for this user for the default account and organization
 * @param {Object} user user model populated with default account and organization
 */
const getUserPermissions = (user) => {
  const p = new Promise((resolve, reject) => {
    const perms = { ...preDefinedPermissions.none };

    if (!user || !user.defaultAccount || !user.defaultAccount._id) { return resolve(perms); }

    // Get all relevant memberships
    const options = {
      account: user.defaultAccount._id,
      user: user._id,
      $or: [
        { to: 'account' },
        ...(user.defaultOrg && user.defaultOrg.group
          ? [{ to: 'group', group: user.defaultOrg.group }]
          : []),
        ...(user.defaultOrg && user.defaultOrg._id
          ? [{ to: 'organization', organization: user.defaultOrg._id }]
          : [])
      ]
    };

    membership.find(options)
      .then((mems) => {
        if (mems && mems.length > 0) {
          mems.forEach((mem) => {
            // Loop on all permission types
            Object.entries(mem.perms.toObject()).forEach(([type, value]) => {
              if (type !== '_id' && value > perms[type]) perms[type] = value;
            });
          });
        }
        return resolve(perms);
      })
      .catch((err) => {
        logger.error('Unable to get user permissions', { params: { message: err.message } });
        return reject(new Error('Unable to get user permissions'));
      });
  });
  return p;
};

// Default exports
module.exports = {
  membership: membership,
  permissionMasks: permissionMasks,
  permissionShifts: permissionShifts,
  permissionsSchema: Permissions,
  setPermission: setPermission,
  preDefinedPermissions: preDefinedPermissions,
  getUserPermissions: getUserPermissions
};
