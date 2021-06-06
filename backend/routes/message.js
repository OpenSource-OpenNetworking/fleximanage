// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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
// const createError = require('http-errors');
const bodyParser = require('body-parser');
const logger = require('../logging/logging')({ module: module.filename, type: 'message' });

const messageVersion = '1.0.0';

const messageRouter = express.Router();
messageRouter.use(bodyParser.json());

messageRouter.route('/version')
  .get((req, res, next) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.json({ version: messageVersion });
  });

messageRouter.route('/send-device-message')
  .post((req, res, next) => {
    logger.info('Send device message called', { params: { body: req.body }, req: req });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.json({ ok: 1 });
  });

// Default exports
module.exports = messageRouter;
