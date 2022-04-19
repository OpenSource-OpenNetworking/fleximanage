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
const Users = require('../models/users');
const { getToken } = require('../tokens');
const {
  getUserAccounts,
  orgUpdateFromNull
} = require('../utils/membershipUtils');

class AccountsService {
  /**
   * Get all AccessTokens
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async accountsGET ({ offset, limit }, { user }) {
    try {
      const accounts = await getUserAccounts(user, offset, limit);
      return Service.successResponse(accounts);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Retrieve account information
   *
   * id String Numeric ID of the Account to retrieve information
   * returns Account
   **/
  static async accountsIdGET ({ id }, { user }) {
    try {
      if (user.defaultAccount._id.toString() !== id) {
        return Service.rejectResponse(
          'No permission to access this account', 403
        );
      }
      const account = await Accounts.findOne({ _id: id });
      const {
        logoFile,
        organizations,
        companySize,
        serviceType,
        numSites,
        __v,
        ...rest
      } = account.toObject();
      rest._id = rest._id.toString();
      return Service.successResponse(rest);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify account information
   *
   * id String Numeric ID of the Account to modify
   * accountRequest AccountRequest  (optional)
   * returns Account
   **/
  static async accountsIdPUT ({ id, accountRequest }, { user }, response) {
    try {
      if (user.defaultAccount._id.toString() !== id) {
        return Service.rejectResponse(
          'No permission to access this account', 403
        );
      }
      const { name, companyType, companyDesc, country, enableNotifications } = accountRequest;
      const account = await Accounts.findOneAndUpdate(
        { _id: id },
        { $set: { name, companyType, companyDesc, country, enableNotifications } },
        { upsert: false, new: true, runValidators: true });

      // Update token
      const token = await getToken({ user }, { accountName: account.name });
      response.setHeader('Refresh-JWT', token);

      // Return organization
      const {
        logoFile,
        organizations,
        companySize,
        serviceType,
        numSites,
        __v,
        ...rest
      } = account.toObject();
      rest._id = rest._id.toString();
      return Service.successResponse(rest);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Select account
   *
   * selectAccountRequest SelectAccountRequest
   * returns Account
   **/
  static async accountsSelectPOST ({ accountSelectRequest }, req, res) {
    const user = req.user;
    const { account } = accountSelectRequest;

    try {
      if (!user.defaultAccount || !user.defaultAccount._id || !user._id) {
        return Service.rejectResponse('Error in selecting account', 500);
      }

      // If current account not changed, return OK
      if (user.defaultAccount._id.toString() === account) {
        return Service.successResponse({ _id: user.defaultAccount._id.toString() }, 201);
      }

      const accounts = await getUserAccounts(user);
      if (!accounts.find(acc => acc._id === account)) {
        return Service.rejectResponse(
          'No permission to access this account', 403
        );
      }

      // Get organizations for the new account
      const updUser = await Users.findOneAndUpdate(
        // Query, use the email and account
        { _id: user._id },
        // Update account, set default org to null so the system
        // will choose an organization on login if something failed
        { defaultAccount: account, defaultOrg: null },
        // Options
        { upsert: false, new: true }
      ).populate('defaultAccount');

      // Set a default organization for the new account
      user.defaultAccount = updUser.defaultAccount;
      user.defaultOrg = null;

      await orgUpdateFromNull(req, res);
      return Service.successResponse({ _id: updUser.defaultAccount._id.toString() }, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Create new account
   *
   * registerAccountRequest RegisterAccountRequest  (optional)
   * returns Account
   **/
  static async accountsPOST ({ registerAccountRequest }, { user }) {
    try {
      return Service.successResponse('');
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = AccountsService;
