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

/**
 * This module implements a general selector that stores the selection in redis
 */
'use strict';
const util = require('util');
const uuid = require('uuid');
const EventEmitter = require('events').EventEmitter;

const getKey = function (key) {
  return 'selector:' + key;
};

function Selector (redis, key) {
  this.id = uuid.v4();
  this.redis = redis;
  this.key = getKey(key || 'default');
}

util.inherits(Selector, EventEmitter);

/**
  * Try to elect Selector
  */
Selector.prototype.elect = function elect () {
  this.isActive(function (err, isActive) {
    if (err) {
      return this.emit('error', err);
    }
    if (!isActive) {
      // Activate
      this.redis.set(this.key, this.id, function (err, res) {
        if (err) {
          return this.emit('error', err);
        }
        if (res !== null) { // Success
          this.emit('elected');
        }
      }.bind(this));
    };
  }.bind(this));
};

Selector.prototype.isActive = function isActive (done) {
  this.redis.get(this.key, function (err, id) {
    if (err) {
      return done(err);
    }
    done(null, (id === this.id));
  }.bind(this));
};

module.exports = Selector;
