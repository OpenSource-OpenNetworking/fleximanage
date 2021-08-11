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

const express = require('express');
const cors = require('./cors');
const notificationsDb = require('../models/notifications');
const { devices } = require('../models/devices');
const { verifyPermission } = require('../authenticate');
const createError = require('http-errors');
const Joi = require('joi');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const notificationsRouter = express.Router();

/**
 * Validates the input arguments in request object
 * @param {object} req Validate HTTP GET request
 * @param {object} res response
 * @param {Function} next callback function
 */
const validateGetRequest = (req, res, next) => {
  const schema = Joi.object().keys({
    op: Joi.string().valid('count'),
    status: Joi.string().valid('read', 'unread')
  });
  const result = schema.validate(req.query);
  if (result.error) {
    return next(createError(400, result.error.details[0].message));
  }
  return next();
};

/**
 * Validates the input arguments in request object
 * @param {object} req Validate HTTP PUT request
 * @param {object} res response
 * @param {Function} next callback function
 */
const validatePutRequest = (req, res, next) => {
  // Validate id for single object route only
  if (req.params.id) {
    if (!/^[0-9a-fA-F]{24}$/i.test(req.params.id)) {
      return next(createError(400, 'Invalid ID format'));
    }
  }

  // Validate request body
  const schema = Joi.object().keys({
    status: Joi.string().valid('read', 'unread').required(),
    ids: Joi.array().items(Joi.string().regex(/^[0-9a-fA-F]{24}$/)).optional()
  });

  // const result = Joi.validate(req.body, schema);
  const result = schema.validate(req.body);
  if (result.error) {
    return next(createError(400, result.error.details[0].message));
  }
  return next();
};

// Retireves the list of notifications
notificationsRouter
  .route('/')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, validateGetRequest, verifyPermission('notifications', 'get'),
    async (req, res, next) => {
      const query = { org: req.user.defaultOrg._id };
      if (req.query.status) query.status = req.query.status;
      try {
        // If operation is 'count', return the amount
        // of notifications for each device
        const notifications = req.query.op === 'count'
          ? await notificationsDb.aggregate([
            { $match: query },
            {
              $group: {
                _id: '$device',
                count: { $sum: 1 }
              }
            }
          ])
          : await notificationsDb.find(
            query,
            'time device title details status machineId'
          ).populate('device', 'name -_id', devices);

        return res.status(200).send(notifications);
      } catch (err) {
        logger.warn('Failed to retrieve notifications', {
          params: {
            org: req.user.defaultOrg._id.toString(),
            err: err.message
          },
          req: req
        });
        return next(createError(500));
      }
    })
  .put(cors.corsWithOptions, validatePutRequest, async (req, res, next) => {
    const query = { org: req.user.defaultOrg._id };
    if (req.body.ids) query._id = { $in: req.body.ids };

    try {
      const res = await notificationsDb.updateMany(
        query,
        { $set: { status: req.body.status } },
        { upsert: false }
      );
      if (req.body.ids && res.n !== req.body.ids.length) {
        return next(
          createError(404, 'Some notification IDs were not found')
        );
      }
    } catch (err) {
      logger.warn('Failed to update notifications', {
        params: {
          org: req.user.defaultOrg._id.toString(),
          err: err.message
        },
        req: req
      });
      return next(createError(500));
    }
    return res.status(200).send({});
  });

notificationsRouter.route('/:id')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .put(cors.corsWithOptions, validatePutRequest, verifyPermission('notifications', 'put'),
    async (req, res, next) => {
      try {
        const res = await notificationsDb.updateOne(
          { org: req.user.defaultOrg._id, _id: req.params.id },
          { $set: { status: req.body.status } },
          { upsert: false }
        );
        if (res.n === 0) return next(createError(404));
      } catch (err) {
        logger.warn('Failed to update notifications', {
          params: {
            org: req.user.defaultOrg._id.toString(),
            err: err.message
          },
          req: req
        });
        return next(createError(500));
      }
      return res.status(200).send({});
    });

// Default exports
module.exports = notificationsRouter;
