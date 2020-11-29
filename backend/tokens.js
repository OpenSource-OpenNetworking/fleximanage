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

var jwt = require('jsonwebtoken');
const { preDefinedPermissions, getUserPermissions } = require('./models/membership');
var configs = require('./configs')();
const logger = require('./logging/logging')({ module: module.filename, type: 'req' });

// JWT strategy definition
// Generate token
exports.getToken = async function ({ user }, override = {}, shouldExpire = true) {
  // Get user permissions
  let perms = null;
  try {
    perms = await getUserPermissions(user);
  } catch (err) {
    perms = { ...preDefinedPermissions.none };
    logger.error('Could not get user permissions', {
      params: { user: user, message: err.message }
    });
  }

  return jwt.sign(
    {
      _id: user._id,
      username: user.username,
      org: user.defaultOrg ? user.defaultOrg._id : null,
      orgName: user.defaultOrg ? user.defaultOrg.name : null,
      account: user.defaultAccount ? user.defaultAccount._id : null,
      accountName: user.defaultAccount
        ? user.defaultAccount.name
        : null,
      perms: perms,
      ...override
    },
    configs.get('userTokenSecretKey'),
    shouldExpire ? { expiresIn: configs.get('userTokenExpiration', 'number') } : null
  );
};

exports.getAccessKey = async ({ user }, override = {}, shouldExpire = true) => {
  return jwt.sign(
    {
      _id: user._id,
      type: 'app_access_key',
      account: user.defaultAccount ? user.defaultAccount._id : null,
      ...override
    },
    configs.get('userTokenSecretKey'),
    shouldExpire ? { expiresIn: configs.get('userTokenExpiration', 'number') } : null
  );
};

exports.getRefreshToken = async ({ user }, override = {}) => {
  return jwt.sign({
    _id: user._id,
    username: user.username,
    ...override
  }, configs.get('userTokenSecretKey'), {
    expiresIn: configs.get('userRefreshTokenExpiration', 'number')
  });
};

exports.verifyToken = (token) => {
  return jwt.verify(token, configs.get('userTokenSecretKey'));
};
