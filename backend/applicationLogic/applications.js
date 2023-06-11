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

const applicationsModel = require('../models/applications');
const organizationsModel = require('../models/organizations');
const fs = require('fs');
const path = require('path');
const logger = require('../logging/logging')({
  module: module.filename,
  type: 'req'
});
const { validateFirewallRules } = require('../deviceLogic/validators');

const IApplication = require('./applicationsInterface');

class ApplicationLogic extends IApplication {
  constructor () {
    super();
    this.apps = {};
    this.utilFuncs = {};
    this.buildApps();
  }

  registerUtilFunc (key, func) {
    this.utilFuncs[key] = func;

    // register the func with all installed applications
    for (const app in this.apps) {
      this.apps[app].utils[key] = func;
    }
  }

  buildApps () {
    const appDirectory = path.join(__dirname, 'apps');
    const appFiles = fs.readdirSync(appDirectory);

    for (const appFile of appFiles) {
      if (!appFile.endsWith('.js')) {
        continue;
      }
      const identifier = appFile.split('.js')[0];
      const appFullPath = path.join(appDirectory, appFile);
      const appClass = require(appFullPath);
      this.register(identifier, appClass);
    }
  }

  register (identifier, AppClass) {
    this.apps[identifier] = new AppClass();

    // register the funcs with the install application
    for (const utilFunc in this.utilFuncs) {
      this.apps[identifier].utils[utilFunc] = this.utilFuncs[utilFunc];
    }
  }

  remove (identifier, obj) {
    if (identifier in this.apps) {
      delete this.apps[identifier];
    }
  }

  async call (identifier, func, defaultRet, ...params) {
    try {
      if (!(identifier in this.apps)) {
        logger.debug('app identifier didn\'t found', {
          params: { apps: this.apps, identifier }
        });
        return defaultRet;
      }

      if (!this.apps[identifier][func]) {
        logger.debug('func didn\'t found in app class', {
          params: { app: this.apps[identifier], identifier, func }
        });
        return defaultRet;
      }

      return await this.apps[identifier][func](...params);
    } catch (err) {
      logger.error('failed to call application func', {
        params: { identifier, func, defaultRet, ...params }
      });
      throw err;
    }
  }

  /**
   * Save application configurations
   *
   * @param  {string} identifier application identifier
   * @param  {object} application application object
   * @param  {object} updatedConfig updated application configuration
   * @return {object}  new application object with updated config
  */
  async saveConfiguration (identifier, application, updatedConfig) {
    const updatedApp = await applicationsModel.findOneAndUpdate(
      { _id: application._id },
      { $set: { configuration: updatedConfig } },
      { new: true, upsert: false, runValidators: true }
    ).populate('appStoreApp').lean();

    await this.call(identifier, 'updateApplicationBilling', null, updatedApp);
    return updatedApp;
  };

  /**
   * get all application subnets for the given organization
   *
   * @param  {objectid} orgId organization ID
   * @return {[{
   *  _id: objectId,
   *  deviceId: objectId,
   *  type: string,
   *  deviceName: string,
   *  name: string,
   *  subnet: string
   * }]}  list of application subnets
  */
  async getApplicationSubnets (orgId) {
    const apps = await applicationsModel.find({ org: orgId }).populate('appStoreApp').lean();
    const subnets = [];
    for (const app of apps) {
      const appSubnet = await this.getApplicationSubnet(app.appStoreApp.identifier, app);
      const parsed = appSubnet.map(s => {
        return {
          _id: app._id,
          deviceId: s.deviceId,
          type: 'application',
          deviceName: s.deviceName,
          name: app.appStoreApp.name,
          subnet: s.subnet
        };
      });
      subnets.push(...parsed);
    }

    return subnets;
  };

  /**
   * Returns database query of application's "installWith" parameter.
   *
   * This function takes the "installWith" value (see applications.json)
   * and parses it into mongo query. This query will be run on the device.
   *
   * @param  {object} app     application object
   * @param  {object} device  the device object to be configured
   * @param  {string} op      operation type
   * @return void
  */
  async getAppInstallWithAsQuery (app, device, op) {
    const _getVal = val => {
      if (typeof val !== 'string') return val;
      // variable is text within ${}, e.g. ${serverPort}
      // we are taking this text and replace it with the same key in the app configuration object
      const matches = val.match(/\${.+?}/g);
      if (matches) {
        for (const match of matches) {
          const confKey = match.match(/(?<=\${).+?(?=})/);
          val = val.replace(match, app.configuration[confKey]);
        }
      }
      return val;
    };

    const orgAppIds = new Set();
    const orgApps = await applicationsModel.find({ org: device.org }, '_id').lean();
    orgApps.forEach(a => {
      const id = a._id.toString();
      orgAppIds.add(id);
    });

    const query = {};

    const version = app.appStoreApp.versions.find(v => {
      return v.version === app.installedVersion;
    });

    if (!('installWith' in version)) return query;

    if ('firewallRules' in version.installWith) {
      const requestedRules = version.installWith.firewallRules;

      const existingRules = {}; // map of existing application rules based on on referenceNumber
      const updatedFirewallRules = []; // array of all rules except of application related rules

      device.firewall.rules.forEach(r => {
        if (r.system && r.reference && r.reference.toString() === app._id.toString()) {
          existingRules[r.referenceNumber] = r;
        } else if (r.system && r.reference && !orgAppIds.has(r.reference.toString())) {
          // if there is a firewall rule with reference that don't exists for any reason
          // filter it out.
        } else {
          updatedFirewallRules.push(r.toObject()); // reference to application
        }
      });

      // in add operation - add the needed firewall rules
      if (op === 'install' || op === 'config') {
        const lastSysRule = updatedFirewallRules
          .filter(r => r.system)
          .sort((a, b) => b.priority - a.priority).pop();

        let initialPriority = -1;
        if (lastSysRule) {
          initialPriority = lastSysRule.priority - 1;
        }

        for (const rule of requestedRules) {
          const newRule = {
            system: true,
            reference: app._id,
            referenceModel: 'applications',
            referenceNumber: rule.appRuleNum,
            description: _getVal(rule.description),
            priority: initialPriority,
            enabled: true,
            direction: _getVal(rule.direction),
            interfaces: _getVal(rule.interfaces),
            inbound: _getVal(rule.inbound),
            classification: {
              destination: {
                ipProtoPort: {
                  ports: _getVal(rule.destination.ports),
                  protocols: _getVal(rule.destination.protocols)
                }
              }
            }
          };

          // rule exists
          if (existingRules[rule.appRuleNum]) {
            newRule.enabled = existingRules[rule.appRuleNum].enabled;
          }

          updatedFirewallRules.push(newRule);
          initialPriority--;
        }
      }

      query['firewall.rules'] = updatedFirewallRules;
    }

    return query;
  };

  async validateInstalledDevicesWithNewConfig (configurationRequest, app, installedDevices) {
    // simulate the new config on the app
    const newApp = {
      ...app,
      configuration: { ...configurationRequest }
    };

    for (const device of installedDevices) {
      const { valid, err } = await this.validateApplicationFirewallRules(newApp, device, 'config');
      if (!valid) {
        return { valid, err };
      }
    }

    return { valid: true, err: '' };
  }
  /// ////////////////////////////////////////////////////////////////////// ///
  /// From here, we overriding the IApplication method and we adding         ///
  /// an "identifier" params to each function.                               ///
  /// You can find the application descriptions in the IApplication class    ///
  /// ////////////////////////////////////////////////////////////////////// ///

  async validateConfiguration (identifier, configurationRequest, app, account, installedDevices) {
    const defaultRet = { valid: true, err: '' };
    const { valid, err } = await this.call(
      identifier, 'validateConfiguration',
      defaultRet, configurationRequest, app, account);

    if (!valid) {
      return { valid, err };
    }

    return await this.validateInstalledDevicesWithNewConfig(
      configurationRequest, app, installedDevices);
  }

  async selectConfigurationParams (identifier, configuration) {
    return this.call(identifier, 'selectConfigurationParams', configuration, configuration);
  };

  async updateApplicationBilling (identifier, app) {
    return this.call(identifier, 'updateApplicationBilling', null, app);
  };

  /**
   * Pick the allowed fields only from client request.
   *
   * Since the configuration in our database is a mixed object,
   * We give the app developer the option to choose which data he wants to save.
   * If this function is not implemented,
   * all information sent from the user will be stored in the database.
   * @param  {object}  configurationRequest  user configuration request
   * @param  {object}  app application object
   * @return {object}  object with allowed fields only.
   */
  async pickAllowedFieldsOnly (identifier, configurationRequest) {
    const defaultRet = configurationRequest;
    return this.call(identifier, 'pickAllowedFieldsOnly', defaultRet, configurationRequest);
  };

  async needToUpdatedDevices (identifier, oldConfig, newConfig) {
    const defaultRet = true;
    return this.call(identifier, 'needToUpdatedDevices', defaultRet, oldConfig, newConfig);
  };

  async getApplicationStats (identifier, account, org) {
    return this.call(identifier, 'getApplicationStats', true, account, org);
  };

  /**
   * Validate the device specific application configuration request that sent by the user.
   *
   * @param  {object}     app application object
   * @param  {object}     deviceConfiguration  user request for device configuration
   * @param  {[objectId]} deviceList the devices ids list, that application should installed on them
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
   */
  async validateDeviceConfigurationRequest (identifier, app, deviceConfiguration, deviceList) {
    const defaultRet = { valid: true, err: '' };
    return this.call(
      identifier,
      'validateDeviceConfigurationRequest',
      defaultRet,
      app,
      deviceConfiguration,
      deviceList
    );
  }

  /**
   * Validate uninstall request.
   *
   * @param  {object}   app application object
   * @param  {[objectId]} deviceList the devices ids list, that application should installed on them
   * @return {{valid: boolean, err: string}}  test result + error if message is invalid
   */
  async validateUninstallRequest (identifier, app, deviceList) {
    const defaultRet = { valid: true, err: '' };
    return this.call(identifier, 'validateUninstallRequest', defaultRet, app, deviceList);
  };

  async validateApplicationFirewallRules (application, device, op) {
    // get device firewall rules + global firewall rules
    const query = await this.getAppInstallWithAsQuery(application, device, op);
    const deviceSpecific = query && query['firewall.rules'] ? query['firewall.rules'] : [];

    const globalRules = device.policies?.firewall?.policy &&
      device.policies?.firewall?.status.startsWith('install')
      ? device.policies.firewall.policy.rules.toObject()
      : [];

    // validate new rules
    const org = await organizationsModel.findOne({ _id: application.org }).lean();
    const { valid, err } = validateFirewallRules(
      [...deviceSpecific, ...globalRules],
      org
    );
    if (!valid) {
      let prefix = '';
      if (op === 'install') {
        prefix = 'Failed to install application firewall rule: ';
      } else if (op === 'config') {
        prefix = 'Failed to configure application firewall rule: ';
      }

      return { valid, err: prefix + err };
    }

    return { valid: true, err: '' };
  }

  async validateInstallRequest (identifier, application, device) {
    // check that device firewall rules + installed global rules
    // will not be overlapped with the application rules
    const { valid, err } = await this.validateApplicationFirewallRules(
      application, device, 'install');

    if (!valid) {
      return { valid, err };
    }

    const defaultRet = { valid: true, err: '' };
    return this.call(identifier, 'validateInstallRequest', defaultRet, application, device);
  }

  /**
   * Get application configuration for specific device
   *
   * @param  {object} app application object
   * @param  {object} device the device object to be configured
   * @return {object} object of device configurations
   */
  async getDeviceSpecificConfiguration (identifier, app, device, deviceConfiguration, idx) {
    return this.call(
      identifier, 'getDeviceSpecificConfiguration', null, app, device, deviceConfiguration, idx);
  };

  /**
   * Creates the application tasks ta based on application name.
   * @async
   * @param  {object}   device      device to be modified
   * @param  {object}   application application object
   * @param  {string}   op          operation type
   * @return {array}               parameters object
   */
  async getTasks (device, application, op) {
    const params = {
      name: application.appStoreApp.name,
      identifier: application.appStoreApp.identifier
    };

    return this.call(params.identifier, 'getTasks', [], device, application, op, params);
  };

  async getApplicationSubnet (identifier, application) {
    return this.call(identifier, 'getApplicationSubnet', [], application);
  };
}

var applicationLogic = null;
module.exports = function () {
  if (applicationLogic) return applicationLogic;
  else {
    applicationLogic = new ApplicationLogic();
    return applicationLogic;
  };
};
