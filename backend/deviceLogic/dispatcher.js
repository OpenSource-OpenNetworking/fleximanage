// flexiWAN SD-WAN software - flexiEdge, flexiManage. For more information go to https://flexiwan.com
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

// File used to dispatch the apply logic to the right function
const createError = require('http-errors');
const start = require('./start');
const stop = require('./stop');
const modify = require('./modifyDevice');
const tunnels = require('./tunnels');
const staticroutes = require('./staticroutes');
const upgrade = require('./applyUpgrade');
const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(configs.get('kuePrefix'),configs.get('redisUrl'));

const logger = require('../logging/logging')({module: module.filename, type: 'req'});

/**
 * Holds the apply, complete, error and remove callbacks for each device task
 * The apply method is called when applying a device task (called from routes/devices.js/apply)
 * The callback methods are called when a job complete/fails/removed.
 * The callback method are receive the job ID of the relevant job.
 * @type {Object}
 */
const errorNOOP = (jobId, jobData) => {};   // Nothing to do on error
const methods = {
    'start': {
        apply:start.apply,
        complete:start.complete,
        error:errorNOOP
    },
    'stop': {
        apply:stop.apply,
        complete:stop.complete,
        error:errorNOOP
    },
    'modify': {
        apply:modify.apply,
        complete:modify.complete,
        error:errorNOOP,
        remove:modify.remove
    },
    'tunnels': {
        apply:tunnels.apply.applyTunnelAdd,
        complete:tunnels.complete.completeTunnelAdd,
        error: tunnels.error.errorTunnelAdd
    },
    'deltunnels': {
        apply:tunnels.apply.applyTunnelDel,
        complete:tunnels.complete.completeTunnelDel,
        error:errorNOOP
    },
    'staticroutes': {
        apply: staticroutes.apply,
        complete: staticroutes.complete,
        error: staticroutes.error,
        remove: staticroutes.remove
    },
    'upgrade' : {
        apply: upgrade.apply,
        complete: upgrade.complete,
        error: upgrade.error,
        remove: upgrade.remove
    }
};

// Register remove callbacks for relevant methods.
Object.entries(methods).forEach(([method, functions]) => {
    if(functions.hasOwnProperty('remove')) {
        deviceQueues.registerJobRemoveCallback(method, functions.remove);
    }
  });
/**
 * Calls the apply method for to the method
 * specified in the req.body object.
 * @param  {Array}    devices     an array of devices
 * @param  {Object}   req         express request object
 * @param  {Object}   res         express response object
 * @param  {Callback} next        express next() callback
 * @param  {Object}   data=null   additional data per caller's choice
 * @return {void}
 */
const apply = (devices, req, res, next, data=null) => {
    logger.info("Apply method called", {params: {method: req.body.method || null}, req: req});
    const method = methods.hasOwnProperty(req.body.method) ?
        methods[req.body.method].apply : null;
    if (!method) {
        return next(createError(400, "Apply method not found"));
    }
    return method(devices, req, res, next, data);
};

/**
 * Calls the complete callback for the method
 * specified in the req.body object
 * @param  {number} jobId     the id of the completed job
 * @param  {Object} jobResult the results of the completed job
 * @return {void}
 */
const complete = (jobId, jobResult) => {
    logger.info("Dispatcher complete callback called", {params: {jobId: jobId, result: jobResult}});
    const method = methods.hasOwnProperty(jobResult.method) ? methods[jobResult.method].complete : null;
    if (method != null) {
        return method(jobId, jobResult.data);
    } else {
        logger.info('Complete method not found', {params: {jobId: jobId}});
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
    logger.info("Dispatcher error callback called", {params: {jobId: jobId, result: jobResult}});
    const method = methods.hasOwnProperty(jobResult.method) ? methods[jobResult.method].error : null;
    if (method != null) {
        return method(jobId, jobResult.data);
    } else {
        logger.info('error method not found', {params: {jobId: jobId}});
    }
};

module.exports = {
    apply: apply,
    complete: complete,
    error: error
};