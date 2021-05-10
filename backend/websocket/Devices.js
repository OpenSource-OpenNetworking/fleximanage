// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2021  flexiWAN Ltd.

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
const redis = require('redis');
const { promisifyAll } = require('bluebird');
const logger = require('../logging/logging')({ module: module.filename, type: 'websocket' });

// TBD: use memory based devices now, add to Redis in future
class Devices {
  constructor (prefix, redisUrl) {
    this.devices = {};
    this.setDeviceInfo = this.setDeviceInfo.bind(this);
    this.getDeviceInfo = this.getDeviceInfo.bind(this);
    this.disconnectDevice = this.disconnectDevice.bind(this);
    this.removeDeviceInfo = this.removeDeviceInfo.bind(this);
    this.getAllDevices = this.getAllDevices.bind(this);
    this.updateDeviceInfo = this.updateDeviceInfo.bind(this);
    this.setRedisDeviceInfo = this.setRedisDeviceInfo.bind(this);
    this.getRedisDeviceInfo = this.getRedisDeviceInfo.bind(this);
    this.getRedisAllDevices = this.getRedisAllDevices.bind(this);
    this.removeRedisDeviceInfo = this.removeRedisDeviceInfo.bind(this);
    this.redisShutdown = this.redisShutdown.bind(this);

    promisifyAll(redis);
    this.prefix = prefix;
    this.redis = redis.createClient({ url: redisUrl });
    this.redis.on('error', (err) => {
      logger.error('Devices error', { params: { redisUrl: redisUrl, err: err.message } });
    });
  }

  /**
     * Sets the device information in memory for a
     * device with deviceID machine id.
     * @param  {string} deviceID device machine id
     * @param  {Object} info     device info
     * @return {void}
     */
  setDeviceInfo (deviceID, info) {
    this.devices[deviceID] = info;
  }

  /**
     * Get key used for Redis storage of info
     * @param  {string} deviceID device machine id
     * @param  {String} type     i.e. info or stats
     * @return {String} key
     */
  getRedisKey (deviceId, type) {
    return this.prefix + type + ':' + deviceId;
  }

  /**
     * Sets the device information in redis for a
     * device with deviceID machine id.
     * @param  {string} deviceID device machine id
     * @param  {String} field    field name
     * @param  {String} type     i.e. info or stats
     * @param  {String} value    string to store in field
     * @return {void}
     */
  async setRedisDeviceInfo (deviceID, type = 'info', fields) {
    try {
      if (fields.constructor !== Object) throw new Error('fields is not an object');
      // Generate fields to update
      const params = Object.keys(fields).reduce((acc, curr) => {
        acc.push(curr, JSON.stringify(fields[curr]));
        return acc;
      }, []);
      const ret = await this.redis.hsetAsync(this.getRedisKey(deviceID, type), ...params);
      return ret;
    } catch (err) {
      logger.error('Failed to set info in redis', {
        params: { device: deviceID, type: type, fields: fields, err: err.message }
      });
      return -1;
    }
  }

  /**
     * Sets a field by its name in the device info memory object.
     * Use setRedisDeviceInfo for device info redis object.
     * @param  {string} deviceID device machine id
     * @param  {string} key      name of the filed to be set
     * @param  {*}      value    value to be set
     * @return {void}
     */
  updateDeviceInfo (deviceID, key, value) {
    if (this.devices[deviceID]) {
      this.devices[deviceID][key] = value;
    }
  }

  /**
     * Gets a field by its name from the device info.
     * @param  {string} deviceID device machine id
     * @return {Object}          device info object
     */
  getDeviceInfo (deviceID) {
    return this.devices[deviceID];
  }

  /**
     * Gets a field by its name from the device info.
     * @param  {string} deviceID device machine id
     * @param  {String} type     i.e. info or stats
     * @param  {Object} fields to return, {} for all fields
     * @return {Object} device info object
     */
  async getRedisDeviceInfo (deviceID, type = 'info', fields = {}) {
    try {
      if (fields.constructor !== Object) throw new Error('fields is not an object');
      let returnFields = Object.keys(fields);
      if (returnFields.length === 1) { // Exactly one field, get only this field
        const value = await this.redis.hgetAsync(this.getRedisKey(deviceID, type), returnFields[0]);
        const ret = {};
        ret[returnFields[0]] = JSON.parse(value);
        return ret;
      } else { // Multiple values are needed
        const values = await this.redis.hgetallAsync(this.getRedisKey(deviceID, type));
        if (returnFields.length === 0) returnFields = Object.keys(values);
        const ret = returnFields.reduce((acc, curr) => {
          acc[curr] = JSON.parse(values[curr]);
          return acc;
        }, {});
        return ret;
      }
    } catch (err) {
      logger.error('Failed to get info from redis', {
        params: { device: deviceID, type: type, fields: fields, err: err.message }
      });
      return -1;
    }
  }

  /**
     * Deletes device information object for a specific device.
     * @param  {string} deviceID the device machine id
     * @return {void}
     */
  removeDeviceInfo (deviceID) {
    delete this.devices[deviceID];
  }

  /**
     * Deletes device information object for a specific device from redis
     * @param  {string} deviceID the device machine id
     * @param  {String} type     i.e. info or stats
     * @return {void}
     */
  async removeRedisDeviceInfo (deviceID, type = 'info') {
    try {
      const ret = await this.redis.delAsync(this.getRedisKey(deviceID, type));
      return ret;
    } catch (err) {
      logger.error('Failed to del info from redis', {
        params: { device: deviceID, type: type, err: err.message }
      });
    }
  }

  /**
     * Gets all connected devices.
     * @return {Array} an array of all connected devices
     */
  getAllDevices () {
    return Object.keys(this.devices);
  }

  /**
     * Gets all connected devices.
     * @param  {String} type     i.e. info or stats
     * @return {Array} an array of all connected devices
     */
  async getRedisAllDevices (type = 'info') {
    let mappedKeys = [];
    try {
      const keys = await this.redis.keysAsync(this.getRedisKey('*', type));
      mappedKeys = keys.map((key) => key.split(':')[1]);
    } catch (err) {
      logger.error('Failed to get all devices from redis', {
        params: { type: type, err: err.message }
      });
    }
    return mappedKeys;
  }

  /**
     * Closes a device socket.
     * TBD: Need to mark the device as closed and,
     *      next time stats will be checked, it will close the socket
     * @param  {string} deviceID device machine id
     * @return {void}
     */
  disconnectDevice (deviceID) {
    if (deviceID && this.devices[deviceID] && this.devices[deviceID].socket) {
      this.devices[deviceID].socket.close();
    }
  }

  /**
   * Closde Redis connection
   * @return {void}
   */
  redisShutdown () {
    try {
      this.redis.quit(() => {});
    } catch (err) {
      logger.error('Failed to shutdown redis', {
        params: { err: err.message }
      });
      return -1;
    }
  }
}

var devicesHandle = null;
module.exports = function (prefix, redisUrl) {
  if (devicesHandle) return devicesHandle;
  else {
    devicesHandle = new Devices(prefix, redisUrl);
    return devicesHandle;
  }
};
