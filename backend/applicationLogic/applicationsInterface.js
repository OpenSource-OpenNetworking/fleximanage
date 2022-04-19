// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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

class IApplication {
  constructor () {
    this.utils = {};
  };

  /**
   * Validate the global application configuration request sent by the user.
   *
   * @param  {object} configurationRequest  user request for global configuration
   * @param  {object} app application object
   * @param  {object} account account object
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
  */
  async validateConfiguration (configurationRequest, app, account) {
    return { valid: true, err: '' };
  }

  /**
   * Filter the confidential fields that should not be exposed to the user.
   *
   * When returning the application object to the UI,
   * there is the option here to return only the public, not the confidential, fields.
   *
   * @param  {object} configuration  user request for global configuration
   * @return {object} filtered configuration object.
  */
  async selectConfigurationParams (configuration) {
    return configuration;
  };

  /**
   * Update billing stuff for application
   *
   * @param  {object} app application object
   * @return void
  */
  async updateApplicationBilling (app) { };

  /**
   * Pick the allowed fields only from client request.
   *
   * Since the configuration in our database is a mixed object,
   * We give the app developer the option to choose which data he wants to save.
   * If this function is not implemented,
   * all information sent from the user will be stored in the database.
   *
   * @param  {object}  configurationRequest  user configuration request
   * @return {object}  object with allowed fields only.
  */
  async pickAllowedFieldsOnly (configurationRequest) {
    return configurationRequest;
  };

  /**
   * Check if need to send configuration request to the devices after a change in app configuration.
   *
   * @param  {object}  oldConfig  user configuration before the change
   * @param  {object}  newConfig  user configuration after the change
   * @return {boolean}  Indicates if need to send jobs or not.
  */
  async needToUpdatedDevices (oldConfig, newConfig) {
    return true;
  };

  /**
   * Get application statistics
   *
   * @param  {object} account account ID
   * @param  {object} org organization ID
   * @return {object} statistics object
  */
  async getApplicationStats (account, org) {
    return {};
  };

  /**
   * Validate the device specific application configuration request that sent by the user.
   *
   * @param  {object}     app application object
   * @param  {object}     deviceConfiguration  user request for device configuration
   * @param  {[objectId]} deviceList the devices ids list, that application should installed on them
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
  */
  async validateDeviceConfigurationRequest (app, deviceConfiguration, deviceList) {
    return { valid: true, err: '' };
  }

  /**
   * Validate uninstall request.
   *
   * @param  {object}   app application object
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
  */
  async validateInstallRequest (application) {
    return { valid: true, err: '' };
  }

  /**
   * Validate uninstall request.
   *
   * @param  {object}   app application object
   * @param  {[objectId]} deviceList the devices ids list, that application should installed on them
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
  */
  async validateUninstallRequest (app, deviceList) {
    return { valid: true, err: '' };
  };

  /**
   * Get application configuration for specific device
   *
   * In case that many devices selected at once, here is the option
   * to calculate configuration for each device based on the "idx" parameter.
   *
   * @param  {object} app application object
   * @param  {object} device the device object to be configured
   * @param  {object} deviceConfiguration application specific configuration for the device
   * @param  {number} idx number of device of the selected deviceList
   * @return {object} object of device specific configurations
  */
  async getDeviceSpecificConfiguration (app, device, deviceConfiguration, idx) {
    return deviceConfiguration;
  };

  /**
   * Creates the application tasks ta based on application name.
   * @async
   * @param  {object}   device      device to be modified
   * @param  {object}   application application object
   * @param  {string}   op          operation type
   * @param  {object}   params      params to include in the job params
   * @return {array}                tasks list
  */
  async getTasks (device, application, op, params) {
    return [];
  };

  /**
   * Get application network subnets
   * @async
   * @param  {object}   application application object
   * @return {[{ deviceId: objectId, deviceName: string, subnet: string }]} tasks list
  */
  async getApplicationSubnet (application) {
    return [];
  };
}

module.exports = IApplication;
