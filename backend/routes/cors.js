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
const cors = require('cors');
// TODO: const createError = require('http-errors');

// Whitelist of origins allowed to access resources
const whitelist = configs.get('corsWhiteList', 'list');
// TODO: const originIsRequired = configs.get('originHttpHeaderRequired', 'boolean');

// CORS handler
var corsOptionsCheck = (req, callback) => {
  var corsOptions = { exposedHeaders: ['Refresh-JWT', 'refresh-token', 'records-total'] };
  const origin = req.header('Origin');
  // Cross-Origin Resource Sharing (CORS) is a security feature in web browsers
  // that limits cross-origin HTTP requests.
  // Note that the "Origin" HTTP request header is not mandatory for all requests,
  // which means that non-browser clients can send requests without it.
  // Additionally, it is possible for a browser to not send the header.
  // Additionally, some browser extensions may bypass CORS restrictions.
  // To address these issues, a new config called "originHttpHeaderRequired" has been introduced.
  // When set to true, the server will throw an error if the "Origin" header is not present,
  // preventing the request from proceeding.
  //
  if (origin && whitelist.indexOf(origin) !== -1) {
    // In whitelist, allow the origin to be accepted
    corsOptions.origin = true;
    corsOptions.maxAge = 60; // prevent the preflight request for 1 minute.
  } else {
    // Not in whitelist, don't include allow-origin
    corsOptions.origin = false;
  }
  callback(null, corsOptions);
};

exports.cors = cors(corsOptionsCheck);
