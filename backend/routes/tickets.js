// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('./cors');
const auth = require('../authenticate');
const zendesk = require('node-zendesk');
const createError = require('http-errors');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const ticketsRouter = express.Router();
ticketsRouter.use(bodyParser.json());

/**
 * This route is allowed only if the organization is marked as admin
 * Return internal information
 */
ticketsRouter
  .route('/')
  // When options message received, reply origin based on whitelist
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, auth.verifyAdmin, async (req, res, next) => {
    try {
      if (!zendeskClient || !accountId) {
        return next(createError(500, 'Ticketing System Not Provisioned'));
      }
      const tickets = await zendeskClient.tickets.listByOrganization(accountId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.json(tickets);
    } catch (err) {
      logger.error('Error getting zendesk data', { params: { error: err.message } });
      return res.status(500).send('Failed to get tickets data');
    }
  });

ticketsRouter
  .route('/:ticketId/comments')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, auth.verifyAdmin, async (req, res, next) => {
    try {
      if (!zendeskClient || !accountId) {
        return next(createError(500, 'Ticketing System Not Provisioned'));
      }
      const ticket = await zendeskClient.tickets.show(req.params.ticketId);
      if (ticket.organization_id?.toString() !== accountId) {
        return next(createError(403, 'You are not allowed to view this ticket'));
      }
      const comments = await zendeskClient.tickets.getComments(req.params.ticketId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.json(comments);
    } catch (err) {
      logger.error('Error getting zendesk ticket comments', { params: { error: err.message } });
      return next(createError(500, 'Failed to get tickets data'));
    }
  });

// Default exports
let zendeskClient = null;
let accountId = '';
module.exports = function (username, token, url, account) {
  if (zendeskClient) return ticketsRouter;
  else {
    if (username && token && url && account) {
      zendeskClient = zendesk.createClient({
        username,
        token,
        remoteUri: url
      });
      accountId = account;
    }
    return ticketsRouter;
  }
};
