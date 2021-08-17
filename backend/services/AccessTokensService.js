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

const { getAccessKey } = require('../tokens');
const AccessTokens = require('../models/accesstokens');
const { getUserPermissions } = require('../models/membership');

class AccessTokensService {
  /**
   * Get all AccessTokens
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async accesstokensGET ({ org, offset, limit }, { user }) {
    try {
      const response = await AccessTokens.find({ account: user.defaultAccount._id })
        .skip(offset)
        .limit(limit)
        .populate('organization');

      const result = response.map(record => {
        return {
          _id: record.id,
          name: record.name,
          token: record.token,
          isValid: record.isValid
        };
      });
      return Service.successResponse(result);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete access token
   *
   * id String Numeric ID of the Access token to delete
   * no response value expected for this operation
   **/
  static async accesstokensIdDELETE ({ id }, { user }) {
    try {
      const { deletedCount } = await AccessTokens.deleteOne({
        _id: id,
        account: user.defaultAccount._id
      });

      if (deletedCount === 0) {
        return Service.rejectResponse('Access token not found', 404);
      }

      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Create new access token
   *
   * accessTokenRequest AccessTokenRequest  (optional)
   * returns AccessToken
   **/
  static async accesstokensPOST ({ accessTokenRequest }, { user }) {
    try {
      const accessToken = new AccessTokens({
        account: user.defaultAccount._id,
        organization: null,
        name: accessTokenRequest.name,
        token: '', // should be empty for now
        isValid: true
      });

      const token = await getAccessKey({ user }, {
        id: accessToken._id.toString(),
        org: null
      }, false);
      accessToken.token = token;

      const perms = await getUserPermissions(user);
      accessToken.permissions = perms;

      await accessToken.save();

      return Service.successResponse({
        _id: accessToken.id,
        name: accessToken.name,
        token: accessToken.token
      }, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = AccessTokensService;
