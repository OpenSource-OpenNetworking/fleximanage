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
const createError = require('http-errors');
const connections = require('../websocket/Connections')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const proxyRouter = express.Router();
proxyRouter.use(bodyParser.json());

const extractParametersAndValidate = (req) => {
  const machineId = req.params.machineId;
  const q = req.params.url + ((Object.keys(req.query).length !== 0)
    ? ('?' + new URLSearchParams(req.query).toString()) : '');
  if (!q) {
    throw new Error('Query URL must be included');
  }
  const server =
  `${req.protocol}://${req.header('host')}${req.baseUrl}/${req.params.machineId}`;
  if (!server) {
    throw new Error('Cannot determine target server');
  }
  if (!connections.isConnected(machineId)) {
    throw new Error('Device not connected');
  }
  return { machineId, q, server };
};

/**
 * This route is allowed for proxy access to a device
 */
proxyRouter
  .route('/:machineId/:url')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, async (req, res, next) => {
    try {
      const { machineId, q, server } = extractParametersAndValidate(req);
      const request = {
        entity: 'agent',
        message: 'proxy',
        params: {
          url: q,
          server: server,
          type: 'GET',
          headers: [],
          body: null
        }
      };

      const result = await connections.deviceSendMessage(
        null,
        machineId,
        request,
        100000 // 100 sec
      );

      if (result.ok) {
        // const headersDict = result.message.headers.reduce((acc, h) => {
        //   if (h.length === 2) {
        //     acc[h[0]] = h[1];
        //   }
        //   return acc;
        // }, {});
        // res.setHeader('Content-Type', headersDict['Content-Type'] || 'plain/text');
        // res.setHeader('Content-Length', headersDict['Content-Length'] || 100);
        result.message.headers.forEach((h) => res.setHeader(h[0], h[1]));
        res.statusCode = result.message.status;
        return res.send(Buffer.from(result.message.response, 'base64'));
      } else {
        throw new Error('Failed to get device response');
      }
    } catch (err) {
      logger.error('Error processing GET request to proxy', { params: { error: err.message } });
      return next(createError(500, 'Error processing GET request to proxy'));
    }
  })
  .post(cors.corsWithOptions, async (req, res, next) => {
    try {
      const { machineId, q, server } = extractParametersAndValidate(req);
      const request = {
        entity: 'agent',
        message: 'proxy',
        params: {
          url: q,
          server: server,
          type: 'POST',
          headers: [],
          body: req.body
        }
      };

      const result = await connections.deviceSendMessage(
        null,
        machineId,
        request,
        100000 // 100 sec
      );

      if (result.ok) {
        result.message.headers.forEach((h) => res.setHeader(h[0], h[1]));
        res.statusCode = result.message.status;
        return res.send(Buffer.from(result.message.response, 'base64'));
      } else {
        throw new Error('Failed to get device response');
      }
    } catch (err) {
      logger.error('Error processing GET request to proxy', { params: { error: err.message } });
      return next(createError(500, 'Error processing GET request to proxy'));
    }
  });

// Default exports
module.exports = proxyRouter;
