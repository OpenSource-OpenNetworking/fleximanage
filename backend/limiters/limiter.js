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

const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class FwLimiter {
  constructor (name, counts, duration, blockDuration) {
    this.name = name;
    this.maxCount = counts;
    this.duration = duration;
    this.blockDuration = blockDuration;

    this.limiter = new RateLimiterMemory({
      points: counts,
      duration: duration,
      blockDuration: blockDuration
    });
  }

  async use (key) {
    const response = { allowed: true, blockedNow: false, releasedNow: false };
    try {
      // try to consume a point. If blocked, an error will be thrown.
      const resConsume = await this.limiter.consume(key);
      // currently, it is not possible to pass a callback that is automatically
      // executed when the key expires.
      // So we call the release function on the next allowed time.
      if (resConsume.consumedPoints === 1) {
        logger.debug('Rate limiter consumed the first time for a key',
          { params: { limiterName: this.name, key, resConsume } }
        );
        response.releasedNow = true;
      }
    } catch (err) {
      // limiter is blocked.
      response.allowed = false;

      // check if blocked now or the key is already blocked
      if (err.consumedPoints === this.maxCount + 1) {
        logger.debug('Rate limiter blocked now for a key',
          { params: { key, err } }
        );
        response.blockedNow = true;
      }

      // check if during the blockage time, the same high rate is continues
      // in order to keep the same convention, we blocked only at the (points + 1).
      // For example, 5 times in 10 minutes. Only at the 6th, 11th, 16th times it will be blocked.
      // that's why we decrement one from the consumed points in the following check
      if ((err.consumedPoints - 1) % this.maxCount === 0) {
        logger.debug('Rate limiter blocked again the key due to continuous high rate',
          { params: { key, err } }
        );
        await this.limiter.block(key, this.blockDuration);
      }
    }

    return response;
  }

  async delete (key) {
    return this.limiter.delete(key);
  }

  async release (key) {
    const isBlocked = await this.isBlocked(key);
    if (!isBlocked) {
      return false;
    }

    const isDeleted = await this.delete(key);
    if (!isDeleted) {
      return false;
    }

    return true;
  }

  async isBlocked (key) {
    const res = await this.limiter.get(key);

    if (res !== null && res.remainingPoints < 0) {
      return true;
    }

    return false;
  }
};

module.exports = FwLimiter;
