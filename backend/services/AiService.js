// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2024  flexiWAN Ltd.

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
const FlexiAi = require('../flexiai');
const aiChatLog = require('../models/analytics/aiChatLog');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');

class AiService {
  /**
   * Query AI Chat for response
   *
   * returns response for the given session
   **/
  static async aiChatQueryPOST ({ session, query, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const response = await FlexiAi.chatQuery(session, query);
      // const response = { answer: 'test', sources: [] };

      const log = await aiChatLog.create({
        org: orgList[0],
        session,
        query,
        answer: response.answer,
        sources: response.sources
      });

      return Service.successResponse({
        _id: log.id,
        session,
        response
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * AI Chat Update User Input
   *
   * returns response after change
   **/
  static async aiChatQueryPUT ({ session, org, _id, useful }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const log = await aiChatLog.findOneAndUpdate({
        org: orgList[0],
        session,
        _id
      }, { $set: { useful: useful } },
      { useFindAndModify: false, upsert: false, new: true });

      return Service.successResponse({
        _id: log.id,
        session,
        useful: log.useful
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = AiService;
