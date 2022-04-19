// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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

var configs = require('../configs.js')();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('./cors');
const { verifyPermission } = require('../authenticate');
const resourcesModel = require('../models/resources');
var randomNum = require('../utils/random-key');
const createError = require('http-errors');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const resourcesRouter = express.Router();
resourcesRouter.use(bodyParser.json());

// Error formatter
const formatErr = (err, msg) => {
  // Check for unique error
  if (err.name === 'MongoError' && err.code === 11000) {
    if (err.errmsg.includes('downloadObject')) {
      // Check if object ID is not unique
      return ({ status: 500, error: 'Resource for this object already exist' });
    } else {
      return ({ status: 500, error: 'Error getting file link, please try again' });
    }
  } else {
    return ({ status: 500, error: 'Generate resource link error' });
  }
};

// Get downloadable link
resourcesRouter
  .route('/genlink')
  .options(cors.corsWithOptions, (req, res) => {
    res.sendStatus(200);
  })
  .post(cors.corsWithOptions, verifyPermission('organizations', 'post'), (req, res, next) => {
    const randomKey = randomNum(50);

    // TBD: Check that OID exists and belong to the user
    resourcesModel
      .create({
        username: req.user.username,
        key: randomKey,
        link:
                      configs.get('restServerUrl', 'list')[0] +
                      '/download/' +
                      randomKey +
                      '/' +
                      req.body.fileName,
        downloadObject: req.body.oid,
        type: req.body.type,
        fileName: req.body.fileName,
        fieldName: req.body.fieldName
      })
      .then(
        resp => {
          logger.info('Linked created successfully', { params: { response: resp }, req: req });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          return res.json(resp);
        },
        err => {
          logger.warn('Failed to generate link', { params: { err: err.message }, req: req });
          const fErr = formatErr(err, req.body);
          return next(createError(fErr.status, fErr.error));
        }
      )
      .catch(err => next(err));
  });

// TBD: Delete resource

// Default exports
module.exports = resourcesRouter;
