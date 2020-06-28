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

const connections = require('../websocket/Connections')();
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const omit = require('lodash/omit');

/**
 * Handler function for sending a message to the the device
 * @param  {string}   org         organization to which the device belongs
 * @param  {string}   machineID   the ID of the devices
 * @param  {Object}   msg         message sent to the device
 * @param  {Object}   job         the job that triggered the message
 * @param  {number}   curTask     the index of the task in the tasks array
 * @param  {number}   tasksLength the number of tasks in the tasks array
 * @param  {Object}   inp         the output of the previous stage call
 * @param  {Callback} done        a callback used by waterfall for signaling success/error
 * @return {void}
 */
const sendMsg = (org, machineID, msg, job, curTask, tasksLength) => (inp, done) => {
  logger.debug('Starting new task', { params: { message: msg, input: inp }, job: job });
  connections.deviceSendMessage(org, machineID, msg)
    .then((rmsg) => {
      if (rmsg !== null && rmsg.ok === 1) {
        logger.debug('Finished task', { params: { message: msg, reply: rmsg }, job: job });
        job.progress(curTask, tasksLength);
        done(null, rmsg);
      } else {
        const err = new Error(JSON.stringify(rmsg.message));
        done(err, false);
      }
    }, (err) => {
      const logJob = omit(job, ['data.message.tasks']);
      logger.error('Task failed', {
        params: { err: err.message, job: job.id },
        job: logJob
      });
      done(err, false);
    })
    .catch((err) => {
      const logJob = omit(job, ['data.message.tasks']);
      logger.error('Task failed', {
        params: { err: err.message, job: job.id },
        job: logJob
      });
      done(err, false);
    });
};

// Default exports
module.exports = {
  sendMsg: sendMsg
};
