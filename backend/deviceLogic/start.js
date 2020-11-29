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
const { getAllOrganizationLanSubnets, getDefaultGateway } = require('../utils/deviceUtils');
const tunnelsModel = require('../models/tunnels');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const mongoose = require('mongoose');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const { getMajorVersion } = require('../versioning');
const { buildInterfaces } = require('./interfaces');

/**
 * Creates and queues the start-router job.
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (device, user, data) => {
  logger.info('Starting device:', {
    params: { machineId: device[0].machineId, user: user, data: data }
  });

  let organizationLanSubnets = [];
  if (configs.get('forbidLanSubnetOverlaps', 'boolean')) {
    organizationLanSubnets = await getAllOrganizationLanSubnets(device[0].org);
  }

  const deviceValidator = validateDevice(device[0], true, organizationLanSubnets);

  if (!deviceValidator.valid) {
    logger.warn('Start command validation failed',
      {
        params: { device: device[0], err: deviceValidator.err }
      });
    throw new Error(deviceValidator.err);
  }

  deviceStatus.setDeviceStatsField(device[0].machineId, 'state', 'pending');
  const majorAgentVersion = getMajorVersion(device[0].versions.agent);
  const startParams = {};
  let ifnum = 0;
  const defaultGateway = getDefaultGateway(device[0]);

  if (majorAgentVersion === 0) { // version 0.X.X
    for (let idx = 0; idx < device[0].interfaces.length; idx++) {
      const intf = device[0].interfaces[idx];
      const ifParams = {};
      if (intf.isAssigned === true) {
        ifnum++;
        ifParams.pci = intf.pciaddr;
        ifParams.dhcp = intf.dhcp && intf.type === 'WAN' ? intf.dhcp : 'no';
        ifParams.addr = intf.IPv4 ? `${intf.IPv4}/${intf.IPv4Mask}` : '';
        if (intf.routing === 'OSPF') ifParams.routing = 'ospf';
        startParams['iface' + (ifnum)] = ifParams;
      }
    }
    startParams['default-route'] = defaultGateway || '';
  } else if (majorAgentVersion >= 1) { // version 1.X.X+
    const deviceInterfaces = buildInterfaces(device[0].interfaces);
    // Send route for backward compatibility (agent version < 1.2.15)
    const routes = [];
    if (defaultGateway && majorAgentVersion < 2) {
      routes.push({
        addr: 'default',
        via: defaultGateway
      });
    }

    startParams.interfaces = deviceInterfaces;
    if (routes.length > 0) {
      startParams.routes = routes;
    }
  }

  if (majorAgentVersion < 2) {
    // Start router command might change IP address of the
    // interface connected to the MGMT. Tell the agent to
    // reconnect to the MGMT after processing this command.
    startParams.reconnect = true;
  }

  const tasks = [];
  const userName = user.username;
  const org = data.org;
  const { machineId } = device[0];

  tasks.push({ entity: 'agent', message: 'start-router', params: startParams });

  try {
    const job = await deviceQueues
      .addJob(
        machineId,
        userName,
        org,
        // Data
        { title: 'Start device ' + device[0].hostname, tasks: tasks },
        // Response data
        {
          method: 'start',
          data: {
            device: device[0]._id,
            org: org,
            shouldUpdateTunnel: majorAgentVersion === 0
          }
        },
        // Metadata
        { priority: 'medium', attempts: 1, removeOnComplete: false },
        // Complete callback
        null
      );

    logger.info('Start device job queued', { job: job });
    return { ids: [job.id], status: 'completed', message: '' };
  } catch (err) {
    logger.error('Start device job failed', { params: { machineId, error: err.message } });
    throw (new Error(err.message || 'Internal server error'));
  }
};

/**
 * Called when start device job completed and
 * marks tunnels for this device as "not connected".
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   device object ID and organization
 * @return {void}
 */
const complete = (jobId, res) => {
  logger.info('Start Machine complete', { params: { result: res, jobId: jobId } });
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
