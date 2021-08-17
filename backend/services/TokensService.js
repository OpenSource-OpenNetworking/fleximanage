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

const jwt = require('jsonwebtoken');
const configs = require('../configs.js')();
const Tokens = require('../models/tokens');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');

class TokensService {
  /**
   * Get all Tokens
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async tokensGET ({ org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const result = await Tokens.find({ org: { $in: orgList } });

      const tokens = result.map(item => {
        return {
          _id: item.id,
          org: item.org.toString(),
          name: item.name,
          token: item.token,
          createdAt: item.createdAt.toISOString()
        };
      });

      return Service.successResponse(tokens);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete token
   *
   * id String Numeric ID of the Token to delete
   * no response value expected for this operation
   **/
  static async tokensIdDELETE ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const { deletedCount } = await Tokens.deleteOne({
        _id: id,
        org: { $in: orgList }
      });

      if (deletedCount === 0) {
        return Service.rejectResponse('Token not found', 404);
      }

      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async tokensIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const result = await Tokens.findOne({ _id: id, org: { $in: orgList } });

      if (!result) {
        return Service.rejectResponse('Token not found', 404);
      }

      const token = {
        _id: result.id,
        org: result.org.toString(),
        name: result.name,
        token: result.token,
        createdAt: result.createdAt.toISOString()
      };
      return Service.successResponse(token);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify a token
   *
   * id String Numeric ID of the Token to modify
   * tokenRequest TokenRequest  (optional)
   * returns Token
   **/
  static async tokensIdPUT ({ id, org, tokenRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const result = await Tokens.findOneAndUpdate(
        { _id: id, org: { $in: orgList } },
        { $set: tokenRequest },
        { useFindAndModify: false, upsert: false, runValidators: true, new: true });

      if (!result) {
        return Service.rejectResponse('Token not found', 404);
      }

      const token = {
        _id: result.id,
        org: result.org.toString(),
        name: result.name,
        token: result.token,
        createdAt: result.createdAt.toISOString()
      };

      return Service.successResponse(token, 201);
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
   * tokenRequest TokenRequest  (optional)
   * returns Token
   **/
  static async tokensPOST ({ org, tokenRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const servers = configs.get('restServerUrl', 'list');
      let server = tokenRequest.server;

      // If no server specified by user, use the first one in the list
      // If specified by user, check if it exists in the configs list
      if (!server || server === '') {
        server = servers[0];
      } else {
        const known = servers.find(ser => ser === server);
        if (!known) {
          throw new Error('Token error: Server is not allowed');
        }
      }

      const tokenData = {
        org: orgList[0].toString(),
        account: user.defaultAccount._id,
        server: server
      };
      // Update token with repo if needed
      const repoUrl = configs.get('SwRepositoryUrl');
      const strippedUrl = repoUrl.split('/');
      if (strippedUrl.length < 6) {
        throw new Error('Token error: wrong configuration of repository url');
      }
      const repoServer = strippedUrl.slice(0, 3).join('/');
      let repoName = strippedUrl[3];
      if (repoName === 'info') repoName = 'flexiWAN'; // no repo specified, use default as flexiWAN
      const typeSplit = strippedUrl[strippedUrl.length - 1].split('-');
      let repoType = 'main';
      if (typeSplit.length === 2) repoType = typeSplit[1];

      if (repoName !== 'flexiWAN') { // Only set non default repo
        tokenData.repo = `${repoServer}|${repoName}|${repoType}`;
      }
      const body = jwt.sign(tokenData, configs.get('deviceTokenSecretKey'));

      const token = await Tokens.create({
        name: tokenRequest.name,
        org: orgList[0].toString(),
        token: body
      });

      return Service.successResponse({
        _id: token.id,
        org: token.org.toString(),
        name: token.name,
        token: token.token,
        createdAt: token.createdAt.toISOString()
      }, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = TokensService;
