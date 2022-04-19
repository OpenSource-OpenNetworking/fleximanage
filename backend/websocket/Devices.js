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

// TBD: use memory based devices now, add to Redis in future
class Devices {
  constructor () {
    this.devices = {};
    this.setDeviceInfo = this.setDeviceInfo.bind(this);
    this.getDeviceInfo = this.getDeviceInfo.bind(this);
    this.disconnectDevice = this.disconnectDevice.bind(this);
    this.removeDeviceInfo = this.removeDeviceInfo.bind(this);
    this.getAllDevices = this.getAllDevices.bind(this);
    this.updateDeviceInfo = this.updateDeviceInfo.bind(this);

    // Connection status by will be added on every connection changed
    // periodically stored into the db and cleared in memory after that
    this.connectionStatusByOrg = {};
    this.setConnectionStatusByOrg = this.setConnectionStatusByOrg.bind(this);
    this.getConnectionStatusByOrg = this.getConnectionStatusByOrg.bind(this);
    this.clearConnectionStatusByOrg = this.clearConnectionStatusByOrg.bind(this);
  }

  /**
     * Sets the device information for a
     * device with deviceID machine id.
     * @param  {string} deviceID device machine id
     * @param  {Object} info     device info
     * @return {void}
     */
  setDeviceInfo (deviceID, info) {
    this.devices[deviceID] = info;
    this.setConnectionStatusByOrg(deviceID, false);
  }

  /**
     * Sets a field by its name in the device info object.
     * @param  {string} deviceID device machine id
     * @param  {string} key      name of the filed to be set
     * @param  {*}      value    value to be set
     * @return {void}
     */
  updateDeviceInfo (deviceID, key, value) {
    if (this.devices[deviceID]) {
      if (key === 'ready') {
        this.setConnectionStatusByOrg(deviceID, value);
      }
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
     * Deletes device information object for a specific device.
     * @param  {string} deviceID the device machine id
     * @return {void}
     */
  removeDeviceInfo (deviceID) {
    if (this.devices[deviceID]) {
      this.setConnectionStatusByOrg(deviceID, false);
      delete this.devices[deviceID];
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
     * Closes a device socket.
     * @param  {string} deviceID device machine id
     * @return {void}
     */
  disconnectDevice (deviceID) {
    if (deviceID && this.devices[deviceID] && this.devices[deviceID].socket) {
      this.devices[deviceID].socket.close();
      this.devices[deviceID].ready = false;
      this.setConnectionStatusByOrg(deviceID, false);
    }
  }

  /**
   * Sets the devices connection status information in memory by org
   * @param  {string} deviceID device machine id
   * @param  {bool}   status   connection status
   * @return {void}
   */
  setConnectionStatusByOrg (deviceID, status) {
    if (this.devices[deviceID]) {
      const { org, deviceObj } = this.devices[deviceID];
      if (org && deviceObj && status !== undefined) {
        if (!this.connectionStatusByOrg.hasOwnProperty(org)) {
          this.connectionStatusByOrg[org] = {};
        }
        this.connectionStatusByOrg[org][deviceObj] = status;
      }
    }
  }

  /**
   * Gets all organizations ids with updated connection status
   * @return {Array} array of org ids
   */
  getConnectionStatusOrgs () {
    return Object.keys(this.connectionStatusByOrg);
  }

  /**
   * Gets all devices with updated connection status
   * @return {Object} an object of devices ids of the org grouped by status
   * or undefined if no updated statuses
   */
  getConnectionStatusByOrg (org) {
    return this.connectionStatusByOrg[org];
  }

  /**
   * Deletes devices connection status for the org.
   * @param  {string} org the org id
   * @return {void}
   */
  clearConnectionStatusByOrg (org) {
    if (org && this.connectionStatusByOrg.hasOwnProperty(org)) {
      delete this.connectionStatusByOrg[org];
    }
  }
}

module.exports = Devices;
