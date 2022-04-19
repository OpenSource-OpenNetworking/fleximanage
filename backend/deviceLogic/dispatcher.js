// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2020  flexiWAN Ltd.

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

// File used to dispatch the apply logic to the right function
const start = require('./start');
const stop = require('./stop');
const reset = require('./reset');
const modify = require('./modifyDevice');
const tunnels = require('./tunnels');
const staticroutes = require('./staticroutes');
const upgrade = require('./applyUpgrade');
const mlpolicy = require('./mlpolicy');
const application = require('./application');
const firewallPolicy = require('./firewallPolicy');
const dhcp = require('./dhcp');
const appIdentification = require('./appIdentification');
const sync = require('./sync');
const IKEv2 = require('./IKEv2');
const replace = require('./replace');
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);

const logger = require('../logging/logging')({ module: module.filename, type: 'job' });

/**
 * Holds the apply, complete, error and remove callbacks for each device task
 * The apply method is called when applying a device task (called from routes/devices.js/apply)
 * The callback methods are called when a job complete/fails/removed.
 * The callback method are receive the job ID of the relevant job.
 * @type {Object}
 */
const errorNOOP = (jobId, jobData) => {}; // Nothing to do on error
const methods = {
  start: {
    apply: start.apply,
    complete: start.complete,
    error: errorNOOP
  },
  stop: {
    apply: stop.apply,
    complete: stop.complete,
    error: errorNOOP
  },
  reset: {
    apply: reset.apply,
    complete: reset.complete,
    error: reset.error
  },
  modify: {
    apply: modify.apply,
    complete: modify.complete,
    error: modify.error,
    remove: modify.remove
  },
  tunnels: {
    apply: tunnels.apply.applyTunnelAdd,
    complete: tunnels.complete.completeTunnelAdd,
    error: tunnels.error.errorTunnelAdd
  },
  deltunnels: {
    apply: tunnels.apply.applyTunnelDel,
    complete: tunnels.complete.completeTunnelDel,
    error: errorNOOP
  },
  staticroutes: {
    apply: staticroutes.apply,
    complete: staticroutes.complete,
    error: staticroutes.error,
    remove: staticroutes.remove
  },
  dhcp: {
    apply: dhcp.apply,
    complete: dhcp.complete,
    error: dhcp.error,
    remove: dhcp.remove
  },
  upgrade: {
    apply: upgrade.apply,
    complete: upgrade.complete,
    error: upgrade.error,
    remove: upgrade.remove
  },
  mlpolicy: {
    apply: mlpolicy.apply,
    complete: mlpolicy.complete,
    error: mlpolicy.error,
    remove: mlpolicy.remove
  },
  application: {
    apply: application.apply,
    complete: application.complete,
    error: application.error,
    remove: application.remove
  },
  firewallPolicy: {
    apply: firewallPolicy.apply,
    complete: firewallPolicy.complete,
    error: firewallPolicy.error,
    remove: firewallPolicy.remove
  },
  appIdentification: {
    apply: appIdentification.apply,
    complete: appIdentification.complete,
    error: appIdentification.error,
    remove: appIdentification.remove
  },
  sync: {
    apply: sync.apply,
    complete: sync.complete,
    error: sync.error,
    remove: errorNOOP
  },
  ikev2: {
    apply: IKEv2.apply,
    complete: IKEv2.complete,
    error: IKEv2.error,
    remove: IKEv2.remove
  },
  replace: {
    apply: replace.apply,
    complete: errorNOOP,
    error: errorNOOP
  }
};

// Register remove/error callbacks for relevant methods.
Object.entries(methods).forEach(([method, functions]) => {
  if (functions.hasOwnProperty('remove')) {
    deviceQueues.registerJobRemoveCallback(method, functions.remove);
  }
  if (functions.hasOwnProperty('error')) {
    deviceQueues.registerJobErrorCallback(method, functions.error);
  }
});

/**
 * Calls the apply method for to the method
 *
 * @param  {Array}    devices     an array of devices
 * @param  {String}   method      apply method to execute
 * @param  {Object}   user        User data
 * @param  {Object}   data=null   additional data per caller's choice
 * @return {void}
 */
const apply = async (devices, method, user, data = null) => {
  logger.info('Apply method called', {
    params: { method: method || null, user: user, data: data }
  });
  const methodFunc = methods.hasOwnProperty(method)
    ? methods[method].apply : null;
  if (!methodFunc) {
    throw new Error('Apply method not found');
  }
  const job = await methodFunc(devices, user, data);
  return job;
};

/**
 * Calls the complete callback for the method
 * specified in the req.body object
 * @param  {number} jobId     the id of the completed job
 * @param  {Object} jobResult the results of the completed job
 * @return {void}
 */
const complete = (jobId, jobResult) => {
  logger.debug('Dispatcher complete callback', {
    params: { jobId: jobId, result: jobResult }
  });
  const method = methods.hasOwnProperty(jobResult.method)
    ? methods[jobResult.method].complete
    : null;
  if (method != null) {
    return method(jobId, jobResult.data);
  } else {
    logger.info('Complete method not found', { params: { jobId: jobId } });
  }
};

/**
 * Calls the error callback for the method
 * specified in the req.body object
 * @param  {number} jobId     the id of the failed job
 * @param  {Object} jobResult the results of the failed job
 * @return {void}
 */
const error = (jobId, jobResult) => {
  logger.info('Dispatcher error callback called', { params: { jobId: jobId, result: jobResult } });
  const method = methods.hasOwnProperty(jobResult.method) ? methods[jobResult.method].error : null;
  if (method != null) {
    return method(jobId, jobResult.data);
  } else {
    logger.info('error method not found', { params: { jobId: jobId } });
  }
};

module.exports = {
  apply: apply,
  complete: complete,
  error: error
};
