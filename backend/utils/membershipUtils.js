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

const organizations = require('../models/organizations');
const User = require('../models/users');
const Accounts = require('../models/accounts');
const { membership } = require('../models/membership');
const { getToken } = require('../tokens');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

/**
 * Get all organizations available for a user
 * @param {Object} user - user DB object
 * @param {Integer} offset The number of items to skip (optional)
 * @param {Integer} limit The numbers of items to return (optional)
 */
const getUserOrganizations = async (user, offset = 0, limit = 0) => {
  if (!user.defaultAccount || !user.defaultAccount._id || !user._id) return [];

  /* Organizations permitted are:
       - If user has account permissions, get all account organizations
       - If user has group permissions, get all accounts for this group
       - Get all organizations permitted for user
    */

  try {
    const resultSet = {};

    // If user has account permissions, get all account organizations
    const account = await membership.findOne({
      user: user._id,
      account: user.defaultAccount._id,
      to: 'account'
    });
    if (account) {
      await user.defaultAccount.populate('organizations').execPopulate();
      user.defaultAccount.organizations.forEach((org) => { resultSet[org._id] = org; });
      return resultSet;
    }

    // If user has group permissions, get all accounts for this group
    const groups = await membership.distinct('group', {
      user: user._id,
      account: user.defaultAccount._id,
      to: 'group'
    });
    const groupOrgs = await organizations.find({
      account: user.defaultAccount._id,
      group: { $in: groups }
    }).skip(offset).limit(limit);
    groupOrgs.forEach((entry) => { resultSet[entry._id] = entry; });

    // Add all organizations permitted for user
    const orgs = await membership.find({
      user: user._id,
      account: user.defaultAccount._id,
      to: 'organization'
    })
      .populate('organization');
    orgs.forEach((org) => { resultSet[org.organization._id] = org.organization; });
    return resultSet;
  } catch (err) {
    logger.error('Error getting user organizations', { params: { reason: err.message } });
  }

  return [];
};

/**
 * Get user organization by organization id
 * @param {Object} user  - request user
 * @param {String} orgId
 */
const getUserOrgByID = async (user, orgId) => {
  try {
    // Find org with the correct ID
    const orgs = await getUserOrganizations(user);
    const resultOrg = (orgs[orgId]) ? [orgs[orgId]] : [];
    return resultOrg;
  } catch (err) {
    logger.error('Error getting organization', { params: { reason: err.message } });
    throw new Error('Error getting organization');
  }
};

/**
 * Get Account Organization List when Access Token is used
 * If no Access Token is used, return the default organization
 * Otherwise, if no orgID is specified, return a list of all account organizations
 * If orgId is specified, return this orgID if exist in the account organizations
 *
 * @param {Object} user - request user
 * @param {String} orgId
 * @param {Boolean} orgIdRequired - whether org must be specified for the operation
 * @returns {List} List of organizations (as strings)
 */
const getAccessTokenOrgList = async (user, orgId, orgIdRequired = false) => {
  // No access token, return default orgId, if no orgId found, otherwise throw an error
  if (!user.accessToken) {
    if (!orgId) return [user.defaultOrg._id.toString()];
    else throw new Error('Organization query parameter is only available in Access Key');
  }
  // Access token where org is required for the operation, must be specified
  if (orgIdRequired && !orgId) {
    throw new Error('Organization query parameter must be specified for this operation');
  }
  const account = await Accounts.findOne({ _id: user.jwtAccount });
  const organizations = account.organizations.map(o => o._id.toString());
  // If Access token with orgId specified
  if (orgId) {
    // Return orgId if included in the account, otherwise throw an error
    if (organizations.includes(orgId)) return [orgId];
    else throw new Error('Organization not found');
  }
  // Access token without orgId, use all account organizations
  return organizations;
};

/**
 * Get all accounts available for a user
 * @param {Object} user - user object with user _id
 * @param {Integer} offset The number of items to skip (optional)
 * @param {Integer} limit The numbers of items to return (optional)
 */
const getUserAccounts = async (user, offset = 0, limit = 0) => {
  if (!user._id) return [];

  const resultSet = {};
  try {
    // Add all accounts user has access to
    const accounts = await membership.find({
      user: user._id
    })
      .skip(offset)
      .limit(limit)
      .populate('account');
    accounts.forEach((entry) => { resultSet[entry.account._id] = entry.account.name; });
    const result = Object.keys(resultSet).map(key => {
      return { _id: key, name: resultSet[key] };
    });
    return result;
  } catch (err) {
    logger.error('Error getting user accounts', { params: { reason: err.message } });
  }
  return [];
};

/**
 * Update default organization when it's null and refresh token
 * If defaultOrg is null, will to find a new organization and update the req with it
 * @param {*} req - req with updated user account info
 * @param {*} res - res with updated token if necessary
 */
const orgUpdateFromNull = async ({ user }, res) => {
  if (user.defaultOrg == null) {
    let org0 = null;

    try {
      const orgs = await getUserOrganizations(user);
      org0 = orgs[Object.keys(orgs)[0]];
      if (org0) {
        await User.updateOne({ _id: user._id }, { defaultOrg: org0._id });
        user.defaultOrg = org0;
      }
      // Refresh JWT with new values
      const token = await getToken({ user }, {
        account: user.defaultAccount._id,
        accountName: user.defaultAccount.name,
        org: org0 ? org0._id : null,
        orgName: org0 ? org0.name : null
      });
      res.setHeader('Refresh-JWT', token);
    } catch (err) {
      logger.error('Could not update organization',
        { params: { userId: user._id, message: err.message } });
      return false;
    }
  }
  return true;
};

// /**
//  * Update default organization when it's null and refresh token
//  * If defaultOrg is null, will to find a new organization and update the req with it
//  * @param {*} req - req with updated user account info
//  * @param {*} res - res with updated token if necessary
//  */
// const orgUpdateFromNull = async (req, res) => {
//   if (req.user.defaultOrg == null) {
//     let org0 = null;
//     try {
//       const orgs = await getUserOrganizations(req.user);
//       org0 = orgs[Object.keys(orgs)[0]];
//       if (org0) {
//         await User.updateOne({ _id: req.user._id }, { defaultOrg: org0._id });
//         req.user.defaultOrg = org0;
//       }
//       // Refresh JWT with new values
//       const token = await getToken(req, {
//         account: req.user.defaultAccount._id,
//         accountName: req.user.defaultAccount.name,
//         org: org0 ? org0._id : null,
//         orgName: org0 ? org0.name : null
//       });
//       res.setHeader('Refresh-JWT', token);
//     } catch (err) {
//       logger.error('Could not update organization',
//         { params: { userId: req.user._id, message: err.message }, req: req });
//       return false;
//     }
//   }
//   return true;
// };

// Default exports
module.exports = {
  getUserOrganizations: getUserOrganizations,
  getUserOrgByID: getUserOrgByID,
  getAccessTokenOrgList: getAccessTokenOrgList,
  getUserAccounts: getUserAccounts,
  orgUpdateFromNull: orgUpdateFromNull
};
