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
 * This module takes a decision whether this instance of flexiManage is active
 * or standby. It relies on redis semaphore used by redis-leader
 */
const redis = require('redis');
const { getRedisAuthUrl } = require('../utils/httpUtils');
const Leader = require('./redis-leader');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });

class HighAvailability {
  /**
   * Constructor
   * @param {String} redisUrl - redis URL
   */
  constructor (redisUrl) {
    // Create a redisClient based on the redis URL
    const { redisAuth, redisUrlNoAuth } = getRedisAuthUrl(redisUrl);
    this.redis = redis.createClient({ url: redisUrlNoAuth });
    if (redisAuth) this.redis.auth(redisAuth);
    // Create a leader
    const options = {
      key: 'haleaderselect',
      ttl: 2000,
      wait: 1000
    };
    this.leader = new Leader(this.redis, options);
    logger.info('HighAvailability init', { params: { redisUrl: redisUrl, options: options } });

    this.leader.on('error', (err) => {
      logger.error('HighAvailability error', { params: { redisUrl: redisUrl, err: err.message } });
    });
    this.leader.on('elected', () => {
      logger.info('HighAvailability elected', { params: { redisUrl: redisUrl } });
    });
    this.leader.on('revoked', () => {
      logger.info('HighAvailability revoked', { params: { redisUrl: redisUrl } });
    });

    // Try to elect this as active
    this.leader.elect();

    // Bind class functions
    this.runIfActive = this.runIfActive.bind(this);
  }

  runIfActive (func) {
    this.leader.isLeader((err, isLeader) => {
      if (err) {
        logger.error('HighAvailability isLeader error', {
          params: { err: err.message }
        });
      } else {
        if (isLeader) {
          func();
        }
      }
    });
  }
}

var highAvailabilityHandler = null;
module.exports = function (redisUrl) {
  if (highAvailabilityHandler) return highAvailabilityHandler;
  else {
    highAvailabilityHandler = new HighAvailability(redisUrl);
    return highAvailabilityHandler;
  }
};
