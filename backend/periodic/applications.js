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

const configs = require('../configs')();
const periodic = require('./periodic')();
const ApplicationsUpdater = require('../deviceLogic/ApplicationsUpdateManager');
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));

/***
 * This class periodically checks if the latest Applications were changed
 * and if so, updates the database with the new version
 ***/
class Applications {
  /**
    * Creates an instance of the Applications class
    */
  constructor () {
    this.applicationsUpdater = null;
    this.start = this.start.bind(this);
    this.periodicCheckApplications = this.periodicCheckApplications.bind(this);

    this.taskInfo = {
      name: 'check_applications',
      func: this.periodicCheckApplications,
      handle: null,
      period: 3600000 // Runs once an hour
    };
  }

  /**
    * Starts the check_applications periodic task.
    * @return {void}
    */
  start () {
    this.applicationsUpdater = ApplicationsUpdater.getApplicationsManagerInstance();

    // Get the applications upon starting up
    this.periodicCheckApplications();

    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask(name);
  }

  /**
    * Polls applications repository to check if
    * a applications file has been released.
    * @return {void}
    */
  periodicCheckApplications () {
    ha.runIfActive(() => {
      this.applicationsUpdater.pollApplications();
    });
  }
}

let applications = null;
module.exports = function () {
  if (applications) return applications;
  applications = new Applications();
  return applications;
};
