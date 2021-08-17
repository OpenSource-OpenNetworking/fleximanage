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

const Service = require('./Service');

const Accounts = require('../models/accounts');
const Devices = require('../models/devices');
const Users = require('../models/users');
const Organizations = require('../models/organizations');
const Tunnels = require('../models/tunnels');
const TunnelIds = require('../models/tunnelids');
const Tokens = require('../models/tokens');
const AccessTokens = require('../models/accesstokens');
const MultiLinkPolicies = require('../models/mlpolicies');
const PathLabels = require('../models/pathlabels');
const { membership } = require('../models/membership');
const Connections = require('../websocket/Connections')();
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const Flexibilling = require('../flexibilling');
const { getUserOrganizations, getUserOrgByID, orgUpdateFromNull } =
  require('../utils/membershipUtils');
const mongoConns = require('../mongoConns.js')();
const pick = require('lodash/pick');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getToken } = require('../tokens');

class OrganizationsService {
  /**
   * Select the API fields from mongo organization Object
   * @param {Object} item - mongodb organization object
   */
  static selectOrganizationParams (item) {
    const retOrg = pick(item, [
      'name',
      '_id',
      'account',
      'group',
      'encryptionMethod'
    ]);
    retOrg._id = retOrg._id.toString();
    retOrg.account = retOrg.account.toString();

    return retOrg;
  }

  /**
   * Get all organizations
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async organizationsGET ({ offset, limit }, { user }) {
    try {
      const orgs = await getUserOrganizations(user, offset, limit);
      const result = Object.keys(orgs).map((key) => {
        return OrganizationsService.selectOrganizationParams(orgs[key]);
      });

      const list = result.map(element => {
        return {
          _id: element._id.toString(),
          name: element.name,
          account: element.account ? element.account.toString() : '',
          group: element.group,
          encryptionMethod: element.encryptionMethod
        };
      });

      return Service.successResponse(list);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async organizationsSelectPOST ({ organizationSelectRequest }, { user }, res) {
    try {
      if (!user._id || !user.defaultAccount) {
        return Service.rejectResponse('Error in selecting organization', 500);
      }
      // Check first that user is allowed for this organization
      let org = [];
      try {
        org = await getUserOrgByID(user, organizationSelectRequest.org);
      } catch (err) {
        logger.error('Finding organization for user', { params: { reason: err.message } });
        return Service.rejectResponse('Error selecting organization', 500);
      }
      if (org.length > 0) {
        const updUser = await Users.findOneAndUpdate(
          // Query, use the email and account
          { _id: user._id, defaultAccount: user.defaultAccount._id },
          // Update
          { defaultOrg: organizationSelectRequest.org },
          // Options
          { upsert: false, new: true }
        ).populate('defaultOrg');
        // Success, return OK and refresh JWT with new values
        user.defaultOrg = updUser.defaultOrg;
        const token = await getToken({ user }, {
          org: updUser.defaultOrg._id,
          orgName: updUser.defaultOrg.name
        });
        res.setHeader('Refresh-JWT', token);

        const result = {
          _id: updUser.defaultOrg._id.toString(),
          name: updUser.defaultOrg.name,
          account: updUser.defaultOrg.account ? updUser.defaultOrg.account.toString() : '',
          group: updUser.defaultOrg.group,
          encryptionMethod: updUser.defaultOrg.encryptionMethod
        };
        return Service.successResponse(result, 201);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get organization
   *
   * id String Numeric ID of the Organization to get
   * returns Organization
   **/
  static async organizationsIdGET ({ id }, { user }) {
    try {
      // Find org with the correct ID
      const resultOrg = await getUserOrgByID(user, id);
      if (resultOrg.length !== 1) throw new Error('Unable to find organization');
      return Service.successResponse(OrganizationsService.selectOrganizationParams(resultOrg[0]));
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete organization
   *
   * id String Numeric ID of the Organization to delete
   * no response value expected for this operation
   **/
  static async organizationsIdDELETE ({ id }, { user }, response) {
    let session;

    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();

      // Find and remove organization from account
      // Only allow to delete current default org, this is required to make sure the API permissions
      // are set properly for updating this organization
      const orgList = await getAccessTokenOrgList(user, undefined, false);
      if (!orgList.includes(id)) {
        throw new Error('Please select an organization to delete it');
      }

      const account = await Accounts.findOneAndUpdate(
        { _id: user.defaultAccount },
        { $pull: { organizations: id } },
        { upsert: false, new: true, session }
      );

      if (!account) {
        throw new Error('Cannot delete organization');
      }

      // Since the selected org is deleted, need to select another organization available
      user.defaultOrg = null;
      await orgUpdateFromNull({ user }, response);

      // Remove organization
      await Organizations.findOneAndRemove(
        { _id: id, account: user.defaultAccount },
        { session: session });

      // Remove all memberships that belong to the organization, but keep group even if empty
      await membership.deleteMany({ organization: id }, { session: session });

      // Remove organization inventory (devices, tokens, tunnelIds, tunnels, etc.)
      await Tunnels.deleteMany({ org: id }, { session: session });
      await TunnelIds.deleteMany({ org: id }, { session: session });
      await Tokens.deleteMany({ org: id }, { session: session });
      await AccessTokens.deleteMany({ organization: id }, { session: session });
      await MultiLinkPolicies.deleteMany({ org: id }, { session: session });
      await PathLabels.deleteMany({ org: id }, { session: session });

      // Find all devices for organization
      const orgDevices = await Devices.devices.find({ org: id },
        { machineId: 1, _id: 0 },
        { session: session });

      // Get the account total device count
      const deviceCount = await Devices.devices.countDocuments({ account: user.defaultAccount._id })
        .session(session);

      const deviceOrgCount = await Devices.devices.countDocuments(
        { account: user.defaultAccount._id, org: id }
      ).session(session);

      // Delete all devices
      await Devices.devices.deleteMany({ org: id }, { session: session });
      // Unregister a device (by removing the removed org number)
      await Flexibilling.registerDevice({
        account: user.defaultAccount._id,
        org: id,
        count: deviceCount,
        orgCount: deviceOrgCount,
        increment: -orgDevices.length
      }, session);

      // Disconnect all devices
      orgDevices.forEach((device) => Connections.deviceDisconnect(device.machineId));

      await session.commitTransaction();
      return Service.successResponse(null, 204);
    } catch (e) {
      if (session) session.abortTransaction();
      logger.error('Error deleting organization', { params: { reason: e.message } });

      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify organization
   *
   * id String Numeric ID of the Organization to modify
   * organizationRequest OrganizationRequest  (optional)
   * returns Organization
   **/
  static async organizationsIdPUT ({ id, organizationRequest }, { user }, response) {
    try {
      // Only allow to update current default org, this is required to make sure the API permissions
      // are set properly for updating this organization
      const orgList = await getAccessTokenOrgList(user, undefined, false);
      if (orgList.includes(id)) {
        const { name, group, encryptionMethod } = organizationRequest;
        const resultOrg = await Organizations.findOneAndUpdate(
          { _id: id },
          { $set: { name, group, encryptionMethod } },
          { upsert: false, multi: false, new: true, runValidators: true }
        );
        // Update token
        const token = await getToken({ user }, { orgName: organizationRequest.name });
        response.setHeader('Refresh-JWT', token);
        return Service.successResponse(OrganizationsService.selectOrganizationParams(resultOrg));
      } else {
        throw new Error('Please select an organization to update it');
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Add new organization
   *
   * organizationRequest OrganizationRequest  (optional)
   * returns Organization
   **/
  static async organizationsPOST ({ organizationRequest }, { user }, response) {
    try {
      const session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const orgBody = { ...organizationRequest, account: user.defaultAccount };
      const _org = await Organizations.create([orgBody], { session: session });
      const org = _org[0];
      const updUser = await Users.findOneAndUpdate(
        // Query, use the email
        { _id: user._id },
        // Update
        { defaultOrg: org._id },
        // Options
        { upsert: false, new: true, session: session }
      );

      if (!updUser) throw new Error('Error updating default organization');
      // Add organization to default account
      const updAccount = await Accounts.findOneAndUpdate(
        { _id: updUser.defaultAccount },
        { $addToSet: { organizations: org._id } },
        { upsert: false, new: true, session: session }
      );

      if (!updAccount) throw new Error('Error adding organization to account');
      session.commitTransaction();

      const token = await getToken({ user }, { org: org._id, orgName: org.name });
      response.setHeader('Refresh-JWT', token);

      return Service.successResponse(OrganizationsService.selectOrganizationParams(org), 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = OrganizationsService;
