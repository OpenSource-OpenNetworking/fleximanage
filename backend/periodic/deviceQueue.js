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

const configs = require('../configs')();
const periodic = require('./periodic')();
const ha = require('../utils/highAvailability')(configs.get('redisUrl'));
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);

/***
 * This class runs periodic tasks related to jobs
 * Run once a day for deleting older than 7 days jobs
 * and remove old waiting jobs > 5min
 *
 ***/
class DeviceQueues {
  /**
    * Creates a DeviceQueues instance
    */
  constructor () {
    this.start = this.start.bind(this);
    this.periodicCheckJobs = this.periodicCheckJobs.bind(this);

    // Task info
    this.taskInfo = {
      checkJobsPeriod: 86400000,
      // timeout + 10sec
      oldWaitingJobsTimeout: configs.get('jobTimeout', 'number') + 10000
    };
  }

  /**
     * Starts the check_deviceJobs periodic task
     * @return {void}
     */
  start () {
    const { checkJobsPeriod } = this.taskInfo;
    // Run on start and once a day
    periodic.registerTask('check_deviceJobs', this.periodicCheckJobs, checkJobsPeriod);
    periodic.startTask('check_deviceJobs');
    // Call check on start
    this.periodicCheckJobs(true);
  }

  /**
     * Removes completed/failed/inactive jobs that
     * are more than a week old
     * @param  {Boolean} isStart - signal if called on start (true) or periodic (false)
     * @return {void}
     */
  periodicCheckJobs (isStart = false) {
    ha.runIfActive(() => {
      // Delete days old jobs
      const { checkJobsPeriod, oldWaitingJobsTimeout } = this.taskInfo;
      // On start remove any active job, since it lost all data, it will never be resolved
      deviceQueues.failedJobs('active', (isStart) ? 0 : oldWaitingJobsTimeout);
      deviceQueues.removeJobs('complete', checkJobsPeriod);
      deviceQueues.removeJobs('failed', checkJobsPeriod);
      deviceQueues.removeJobs('inactive', checkJobsPeriod);
    });
  }
}

var checkjobs = null;
module.exports = function () {
  if (checkjobs) return checkjobs;
  else {
    checkjobs = new DeviceQueues();
    return checkjobs;
  }
};
