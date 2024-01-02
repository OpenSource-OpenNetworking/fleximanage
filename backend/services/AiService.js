/* eslint-disable no-multi-str */
/* eslint-disable no-template-curly-in-string */
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
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class AiService {
  /**
   * Query AI Chat for response
   *
   * returns response for the given session
   **/
  static async aiChatQueryPOST ({ session, query }, { user }) {
    try {
      // const orgList = await getAccessTokenOrgList(user, org, false);

      const response = `This is a server response to your query: ${query}`;

      return Service.successResponse({ session, response });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = AiService;
