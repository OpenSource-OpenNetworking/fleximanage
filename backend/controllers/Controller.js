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

const Logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const configs = require('../configs')();
const { getUiServerUrl } = require('../utils/httpUtils');

class Controller {
  static sendResponse (response, payload) {
    /**
     * The default response-code is 200. We want to allow to change that. in That case,
     * payload will be an object consisting of a code and a payload. If not customized
     * send 200 and the payload as received in this method.
     */
    response.status(payload.code || 200);
    const responsePayload = payload.payload !== undefined ? payload.payload : payload;
    if (responsePayload instanceof Object) {
      response.json(responsePayload);
    } else {
      response.end(responsePayload);
    }
  }

  static sendError (response, error) {
    response.status(error.code || 500);
    if (error.error instanceof Object) {
      response.json(error.error);
    } else {
      response.end(error.error || error.message);
    }
  }

  static collectFiles (request) {
    // 'Checking if files are expected in schema');
    if (request.openapi.schema.requestBody !== undefined) {
      const [contentType] = request.headers['content-type'].split(';');
      if (contentType === 'multipart/form-data') {
        const contentSchema = request.openapi.schema.requestBody.content[contentType].schema;
        Object.entries(contentSchema.properties).forEach(([name, property]) => {
          if (property.type === 'string' && ['binary', 'base64'].indexOf(property.format) > -1) {
            request.body[name] = request.files.find(file => file.fieldname === name);
          }
        });
      } else if (request.openapi.schema.requestBody.content[contentType] !== undefined &&
        request.files !== undefined) {
        [request.body] = request.files;
      }
    }
  }

  static collectRequestParams (request) {
    this.collectFiles(request);
    const requestParams = {};
    if (request.openapi.schema.requestBody !== undefined) {
      // small hack to match arguments
      const lower = (s) => {
        if (typeof s !== 'string') return '';
        return s.charAt(0).toLowerCase() + s.slice(1);
      };

      const [contentType] = request.headers['content-type'].split(';');
      const ref = request.openapi.schema.requestBody.content[contentType].schema.$ref;
      if (ref) {
        const refName = ref.substr(ref.lastIndexOf('/') + 1);
        const refComponent = request.openapi.refs[refName];
        const requestName = lower(refName);
        if (refComponent && refComponent.properties &&
          configs.get('validateOpenAPIRequest', 'boolean')) {
          // continue only with described in schema parameters
          requestParams[requestName] = {};
          for (const param in refComponent.properties) {
            requestParams[requestName][param] = request.body[param];
          }
        } else {
          // if request is not described in schema then skip unknown parameters validation
          requestParams[requestName] = request.body;
        }
      }
    }

    request.openapi.schema.parameters.forEach((param) => {
      if (param.in === 'path') {
        requestParams[param.name] = request.openapi.pathParams[param.name];
      } else if (param.in === 'query') {
        requestParams[param.name] = request.query[param.name];
      }
      // offset and limit must be integer
      if (['offset', 'limit'].includes(param.name) && requestParams[param.name]) {
        requestParams[param.name] = parseInt(requestParams[param.name]);
      }
    });
    return requestParams;
  }

  static async handleRequest (request, response, serviceOperation) {
    try {
      const requestParams = this.collectRequestParams(request);

      // extract the "host" header into the top-level of the object to allow destructs it easily
      request.server = `${request.protocol}://${request.get('host')}`;

      // extract the client hostname from Referer header and check if exists in configs.
      // If yes, use it. If not - use the first one in configs.
      request.restUiUrl = getUiServerUrl(request);

      const serviceResponse = await serviceOperation(requestParams,
        /** need to pass the additional argument here */ request,
        response);

      // need to log request if not successfull
      if (serviceResponse.code >= 400) {
        Logger.error('Error performing operation', {
          params: {
            url: request.url,
            method: request.method,
            body: request.body,
            error: serviceResponse
          }
        });
      }

      Controller.sendResponse(response, serviceResponse);
    } catch (error) {
      Controller.sendError(response, error);
    }
  }
}

module.exports = Controller;
