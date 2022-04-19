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

const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const controllers = require('../controllers');
const Services = require('../services');
const createError = require('http-errors');

const { verifyPermissionEx } = require('../authenticate');

function handleError (err, request, response, next) {
  logger.error(err.error);
  return next(createError(err.code, err.error));
}

/**
 * The purpose of this route is to collect the request variables as defined in the
 * OpenAPI document and pass them to the handling controller as another Express
 * middleware. All parameters are collected in the request.swagger.values key-value object
 *
 * The assumption is that security handlers have already verified and allowed access
 * to this path. If the business-logic of a particular path is dependant on authentication
 * parameters (e.g. scope checking) - it is recommended to define the authentication header
 * as one of the parameters expected in the OpenAPI/Swagger document.
 *
 * Requests made to paths that are not in the OpernAPI scope
 * are passed on to the next middleware handler.
 * @returns {Function}
 */
function openApiRouter (openapiSchemas) {
  return async (request, response, next) => {
    try {
      /**
       * This middleware runs after a previous process have applied an openapi object
       * to the request.
       * If none was applied This is because the path requested is not in the schema.
       * If there's no openapi object, we have nothing to do, and pass on to next middleware.
       */
      if (request.openapi === undefined || request.openapi.schema === undefined
      ) {
        next();
        return;
      }
      // request.swagger.paramValues = {};
      // request.swagger.params.forEach((param) => {
      //   request.swagger.paramValues[param.name] = getValueFromRequest(request, param);
      // });
      const controllerName = request.openapi.schema['x-openapi-router-controller'];
      const serviceName = request.openapi.schema['x-openapi-router-service'];
      if (!controllers[controllerName] || controllers[controllerName] === undefined) {
        const err = {
          code: 400,
          error: `request sent to controller '${controllerName}' which has not been defined`
        };
        handleError(err, request, response, next);
      } else {
        const apiController = new controllers[controllerName](Services[serviceName]);
        const controllerOperation = request.openapi.schema.operationId;

        // this is the place to check on users access level
        if (!verifyPermissionEx(serviceName, request)) {
          const err = { code: 403, error: 'You don\'t have permission to perform this operation' };
          return handleError(err, request, response, next);
        }

        if (!apiController[controllerOperation]) {
          const name = apiController.service.name;
          const err = `Operation ${controllerOperation} not found in controller ${name}`;
          throw new Error(err);
        }

        request.openapi.refs = openapiSchemas;

        await apiController[controllerOperation](request, response, next);
      }
    } catch (error) {
      console.error(error);
      const err = { code: 500, error: error.message };
      handleError(err, request, response, next);
    }
  };
}

module.exports = openApiRouter;
