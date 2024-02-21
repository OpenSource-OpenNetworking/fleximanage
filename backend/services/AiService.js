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

const configs = require('../configs')();
const Service = require('./Service');
const FlexiAi = require('../flexiai');
const aiChatLog = require('../models/analytics/aiChatLog');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class AiService {
  /**
   * Query AI Chat for response
   *
   * returns response for the given session
   **/
  static async aiChatQueryPOST ({ session, query, history, org }, { user }) {
    let response, log;
    try {
      // History must be even length, each message is Human, Assistant
      if (history.length % 2 !== 0) throw new Error('History must have even number of elements');
      // Allow only 3x2 messages in history, check for 6 as each include Human, Assistant
      if (history.length > 6) throw new Error('History too long, must contain up to 3x2 messages');
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Check that account is under its chat quota for this month
      // Get current month
      const date = new Date();
      date.setDate(1);
      date.setHours(0, 0, 0, 0);
      const queryMonthCount = await aiChatLog.aggregate([
        { $match: { account: user.defaultAccount._id, createdAt: { $gte: date } } },
        { $project: { count: { $size: '$transactions' } } },
        { $group: { _id: null, total_count: { $sum: '$count' } } }
      ]).allowDiskUse(true);
      if (queryMonthCount.length > 0 &&
        queryMonthCount[0].total_count > configs.get('chatAccountQuota', 'number')) {
        response = {
          answer: 'You\'ve reached your query quota limit for this month. ' +
          'Please contact flexiWAN support for additional quota',
          sources: [],
          found: true
        };
      } else { // Enough quota
        response = await FlexiAi.chatQuery(session, query, history);
        // const response = { answer: 'test', sources: [], found: true };

        log = await aiChatLog.findOneAndUpdate({
          account: user.defaultAccount._id,
          org: orgList[0],
          session
        }, {
          $push: {
            transactions: {
              query,
              answer: response.answer,
              found: response.found,
              isQuestion: response.isQuestion,
              tool: response.tool,
              sources: response.sources
            }
          }
        }, {
          upsert: true,
          new: true,
          fields: { _id: 1 }
        });
      }
    } catch (e) {
      logger.error('Chat query error', { params: { message: e.message } });
      // On error, return response to print the error in the chat
      response = {
        answer: 'Error getting response, please try again',
        sources: [],
        found: false
      };
    }

    try {
      return Service.successResponse({
        _id: log?._id || '',
        session,
        response
      });
    } catch (e) {
      // On error, return success to print the error in the chat
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
        _id: log?._id || '',
        session,
        useful: useful
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
