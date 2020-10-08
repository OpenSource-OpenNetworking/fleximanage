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

const fetchUtils = require('../utils/fetchUtils');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const configs = require('../configs')();
const { importedAppIdentifications } = require('../models/appIdentifications');

/***
 * This class serves as the app identification rules update manager, responsible for
 * polling the repository for app identification rules file and replacement of the
 * file in the database when remote update time has changed.
 ***/
class AppRulesUpdateManager {
  /**
    * Creates a AppRulesUpdateManager instance
    */
  constructor () {
    this.appRulesUri = configs.get('appRulesUrl');
  }

  /**
    * A static singleton that creates an AppRulesUpdateManager.
    *
    * @static
    * @return an instance of an AppRulesUpdateManager class
    */
  static getAppRulesManagerInstance () {
    if (appRulesUpdater) return appRulesUpdater;
    appRulesUpdater = new AppRulesUpdateManager();
    return appRulesUpdater;
  }

  /**
    * Polls the app rules file.
    * @async
    * @return {void}
    */
  async pollAppRules () {
    logger.info('Begin fetching global app identification rules', {
      params: { appRulesUri: this.appRulesUri }
    });
    try {
      const body = await fetchUtils.fetchWithRetry(this.appRulesUri, 3);
      logger.debug('Imported app identifications response received', {
        params: { time: body.meta.time, rulesCount: body.applications.length }
      });

      // check stored time against received one. If same, do not update
      const importedAppIdentificationsResult =
        await importedAppIdentifications.findOne();
      if (importedAppIdentificationsResult) {
        const { meta } = importedAppIdentificationsResult;
        if (meta.time === body.meta.time) {
          return;
        }
      }

      const set = { $set: { meta: body.meta, appIdentifications: body.applications } };
      const options = {
        upsert: true,
        setDefaultsOnInsert: true,
        useFindAndModify: false
      };
      await importedAppIdentifications.findOneAndUpdate({}, set, options);
      logger.info('Imported app identifications database updated', {
        params: { time: body.meta.time, rulesCount: body.applications.length }
      });
    } catch (err) {
      logger.error('Failed to query app rules', {
        params: { err: err.message }
      });
    }
  }
}

let appRulesUpdater = null;
module.exports = {
  getAppRulesUpdaterInstance: AppRulesUpdateManager.getAppRulesManagerInstance
};
