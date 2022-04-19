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

// Whitelist of origins allowed to access resources
const whitelist = configs.get('corsWhiteList', 'list');

// CORS handler
var corsOptionsCheck = (req, callback) => {
  var corsOptions = { exposedHeaders: ['Refresh-JWT', 'refresh-token', 'records-total'] };
  if (req.header('Origin') && whitelist.indexOf(req.header('Origin')) !== -1) {
    // In whitelist, allow the request to be accepted
    corsOptions.origin = true;
  } else {
    // Not in whitelist, don't include allow-origin
    corsOptions.origin = false;
  }
  callback(null, corsOptions);
};

// Operations allowed for * origins
exports.cors = cors({ exposedHeaders: ['Refresh-JWT', 'refresh-token', 'records-total'] });

// Operations allowed for whitelist origins
exports.corsWithOptions = cors(corsOptionsCheck);
