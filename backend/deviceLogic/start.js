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

// Logic to start/stop a device
const configs = require('../configs')();
const deviceStatus = require('../periodic/deviceStatus')();
const { validateDevice } = require('./validators');
const { getAllOrganizationSubnets } = require('../utils/orgUtils');
const tunnelsModel = require('../models/tunnels');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const mongoose = require('mongoose');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { buildInterfaces } = require('./interfaces');

/**
 * Creates and queues the start-router job.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (devices, user, data) => {
  const { username } = user;
  const { org } = data;
  const opDevices = await Promise.all(devices.map(d => d
    .populate('policies.firewall.policy', '_id name rules')
    .populate('interfaces.pathlabels', '_id name description color type')
    .execPopulate()
  ));

  const errors = [];
  let orgSubnets = [];
  if (configs.get('forbidLanSubnetOverlaps', 'boolean')) {
    orgSubnets = await getAllOrganizationSubnets(mongoose.Types.ObjectId(org));
  }
  const applyPromises = [];
  for (const device of opDevices) {
    const { machineId } = device;
    logger.info('Starting device:', { params: { machineId, user, data } });

    const { valid, err } = validateDevice(device.toObject(), true, orgSubnets);
    if (!valid) {
      logger.warn('Start command validation failed', { params: { device, err } });
      if (!errors.includes(err)) {
        errors.push(err);
      }
      continue;
    }

    // Set the device state to "pending". Device state will
    // be updated again when the device sends periodic message
    deviceStatus.setDeviceState(machineId, 'pending');
    const startParams = {};
    startParams.interfaces = buildInterfaces(
      device.interfaces.toObject(),
      device.ospf.toObject(),
      device.versions.agent
    );

    const tasks = [{ entity: 'agent', message: 'start-router', params: startParams }];
    applyPromises.push(deviceQueues
      .addJob(
        machineId,
        username,
        org,
        // Data
        { title: 'Start device ' + device.hostname, tasks: tasks },
        // Response data
        {
          method: 'start',
          data: {
            device: device._id,
            org: org
          }
        },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      )
    );
  }
  const promisesStatus = await Promise.allSettled(applyPromises);
  const { fulfilled, reasons } = promisesStatus.reduce(({ fulfilled, reasons }, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      logger.info('Start device job queued', {
        params: {
          jobId: job.id,
          machineId: job.type
        }
      });
      fulfilled.push(job.id);
    } else {
      if (!reasons.includes(elem.reason.message)) {
        reasons.push(elem.reason.message);
      }
    };
    return { fulfilled, reasons };
  }, { fulfilled: [], reasons: errors });
  const status = fulfilled.length < opDevices.length
    ? 'partially completed' : 'completed';
  const message = fulfilled.length < opDevices.length
    ? `Warning: ${fulfilled.length} of ${opDevices.length} start device jobs added.` +
      ` Some devices have following errors: ${reasons.join('. ')}`
    : `Start device job${opDevices.length > 1 ? 's' : ''} added successfully`;
  return { ids: fulfilled, status, message };
};

/**
 * Called when start device job completed and
 * marks tunnels for this device as "not connected".
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = (jobId, res) => {
  if (!res || !res.device || !res.org) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
    return;
  }
  // Get all device tunnels and mark them as not connected
  // shouldUpdateTunnel is set for agent v0.X.X where tunnel status
  // is not checked, therefore updating according to the DB status
  if (res.shouldUpdateTunnel) {
    tunnelsModel
      .updateMany(
        // Query
        {
          isActive: true,
          $or: [{ deviceAconf: true }, { deviceBconf: true }],
          // eslint-disable-next-line no-dupe-keys
          $or: [{ deviceA: mongoose.Types.ObjectId(res.device) },
            { deviceB: mongoose.Types.ObjectId(res.device) }],
          org: res.org
        },
        // Update
        { deviceAconf: false, deviceBconf: false },
        // Options
        { upsert: false })
      .then((resp) => {
        logger.debug('Updated tunnels info in db', { params: { jobId: jobId, response: resp } });
        if (resp != null) {
          logger.info('Updated device tunnels status to not-connected', {
            params: { jobId: jobId, device: res.device }
          });
        } else {
          throw new Error('Update tunnel connected status failure');
        }
      }, (err) => {
        logger.error('Start device callback failed', {
          params: { jobId: jobId, err: err.message }
        });
      })
      .catch((err) => {
        logger.error('Start device callback failed', {
          params: { jobId: jobId, err: err.message }
        });
      });
  }
};

module.exports = {
  apply: apply,
  complete: complete
};
