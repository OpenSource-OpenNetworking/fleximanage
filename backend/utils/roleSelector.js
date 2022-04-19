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

/**
 * This module takes a decision whether this instance of flexiManage is handling
 * traffic of web-sockets. Whenever a new connection is established to the server
 * It set an atomic variable in redis which make the last server that got a connection
 * as active. The role can be kept for TTL time.
 */
const redis = require('redis');
const Selector = require('./redis-selector');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });

class RoleSelector {
  /**
   * Constructor
   * @param {String} redisUrl - redis URL
   * @param {string} key      - unique key per role type
   */
  constructor (redisUrl) {
    // Create a redisClient based on the redis URL
    this.redis = redis.createClient({ url: redisUrl });
    logger.info('RoleSelector init', { params: { redisUrl: redisUrl } });

    // Selectors by key
    this.selectors = {};

    // Bind class functions
    this.initializeSelector = this.initializeSelector.bind(this);
    this.runIfActive = this.runIfActive.bind(this);
    this.shutDown = this.shutDown.bind(this);
  }

  initializeSelector (key) {
    const selector = new Selector(this.redis, key);

    selector.on('error', (err) => {
      logger.error('RoleSelector error', { params: { key: key } });
    });
    selector.on('elected', () => {
      logger.info('RoleSelector elected', { params: { key: key } });
    });

    this.selectors[key] = selector;
  }

  selectorSetActive (key) {
    this.selectors[key].elect();
  }

  runIfActive (key, func) {
    this.selectors[key].isActive((err, isActive) => {
      if (err) {
        logger.error('RoleSelector isActive error', {
          params: { key: key, err: err.message }
        });
      } else {
        if (isActive) {
          func();
        }
      }
    });
  }

  shutDown () {
    this.redis.quit();
  }
}

var RoleSelectorHandler = null;
module.exports = function (redisUrl) {
  if (RoleSelectorHandler) return RoleSelectorHandler;
  else {
    RoleSelectorHandler = new RoleSelector(redisUrl);
    return RoleSelectorHandler;
  }
};
