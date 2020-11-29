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

// Logic to apply tunnels between devices
const configs = require('../configs')();
const tunnelsModel = require('../models/tunnels');
const tunnelIDsModel = require('../models/tunnelids');
const mongoose = require('mongoose');
const randomNum = require('../utils/random-key');

const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { routerVersionsCompatible } = require('../versioning');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });

const intersectIfcLabels = (ifcLabelsA, ifcLabelsB) => {
  const intersection = [];
  ifcLabelsA.forEach(label => {
    if (label && ifcLabelsB.has(label)) intersection.push(label);
  });

  return intersection;
};

/**
 * This function is called when adding new tunnels
 * @async
 * @param  {Array}    devices   an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const applyTunnelAdd = async (devices, user, data) => {
  /**
     * Request body holds the list of devices ids to connect tunnel between
     */
  const selectedDevices = data.devices;
  logger.info('Creating tunnels between devices', {
    params: { devices: selectedDevices }
  });

  // Get details for devices to connect
  const opDevices = (devices && selectedDevices)
    ? devices.filter((device) => {
      const inSelected = selectedDevices.hasOwnProperty(device._id);
      if (inSelected) return true;
      else return false;
    }) : [];

  // For each device pair, create tunnels between WAN interfaces
  const devicesLen = opDevices.length;
  // Only allow tunnels for more than two devices
  if (devicesLen >= 2) {
    const dbTasks = [];
    const userName = user.username;
    const org = data.org;

    // reasons of not created tunnels for some devices
    // used to build a response message
    const reasons = {};

    for (let idxA = 0; idxA < devicesLen - 1; idxA++) {
      for (let idxB = idxA + 1; idxB < devicesLen; idxB++) {
        const deviceA = opDevices[idxA];
        const deviceB = opDevices[idxB];

        // Tunnels are supported only between devices of the same router version
        const [verA, verB] = [deviceA.versions.router, deviceB.versions.router];
        if (!routerVersionsCompatible(verA, verB)) {
          logger.warn('Tunnel creation failed', {
            params: { reason: 'Router version mismatch', versions: { verA: verA, verB: verB } }
          });
          throw new Error('Cannot create tunnels between devices with mismatching router versions');
        }

        // Create the list of interfaces for both devices.
        // Add a set of the interface's path labels
        const deviceAIntfs = [];
        deviceA.interfaces.forEach(intf => {
          if (intf.isAssigned === true && intf.type === 'WAN' && intf.gateway) {
            const labelsSet = new Set(intf.pathlabels.map(label => {
              // DIA interfaces cannot be used in tunnels
              return label.type !== 'DIA' ? label._id : null;
            }));
            deviceAIntfs.push({
              labelsSet: labelsSet,
              ...intf.toObject()
            });
          }
        });

        const deviceBIntfs = [];
        deviceB.interfaces.forEach(intf => {
          if (intf.isAssigned === true && intf.type === 'WAN' && intf.gateway) {
            const labelsSet = new Set(intf.pathlabels.map(label => {
              // DIA interfaces cannot be used in tunnels
              return label.type !== 'DIA' ? label._id : null;
            }));
            deviceBIntfs.push({
              labelsSet: labelsSet,
              ...intf.toObject()
            });
          }
        });

        const devicesInfo = {
          deviceA: { hostname: deviceA.hostname, interfaces: deviceAIntfs },
          deviceB: { hostname: deviceB.hostname, interfaces: deviceBIntfs }
        };
        logger.debug('Connecting tunnel between devices', { params: { devicesInfo } });

        // Create a tunnel between each WAN interface on device A to
        // each of the WAN interfaces on device B according to the path
        // labels assigned to the interfaces. If the list of path labels
        // IDs contains the ID 'FFFFFF', create tunnels between all common
        // path labels across all WAN interfaces.
        // TBD: key exchange should be dynamic
        const specifiedLabels = new Set(data.meta.pathLabels);
        const createForAllLabels = specifiedLabels.has('FFFFFF');
        if (deviceAIntfs.length && deviceBIntfs.length) {
          for (let idxA = 0; idxA < deviceAIntfs.length; idxA++) {
            for (let idxB = 0; idxB < deviceBIntfs.length; idxB++) {
              const wanIfcA = deviceAIntfs[idxA];
              const wanIfcB = deviceBIntfs[idxB];
              const ifcALabels = wanIfcA.labelsSet;
              const ifcBLabels = wanIfcB.labelsSet;

              // If no path labels were selected, create a tunnel
              // only if both interfaces aren't assigned with labels
              if (specifiedLabels.size === 0) {
                if (ifcALabels.size === 0 && ifcBLabels.size === 0) {
                  // If a tunnel already exists, skip the configuration
                  const tunnelFound = await getTunnel(org, null, wanIfcA, wanIfcB);
                  if (tunnelFound.length > 0) {
                    logger.debug('Found tunnel', {
                      params: { tunnel: tunnelFound }
                    });
                    reasons.foundTunnels = true;
                  } else {
                    dbTasks.push(generateTunnelPromise(userName, org, null,
                      { ...deviceA.toObject() }, { ...deviceB.toObject() },
                      { ...wanIfcA }, { ...wanIfcB }));
                  }
                } else {
                  reasons.withLabels = true;
                }
              } else {
                // Create a list of path labels that are common to both interfaces.
                const labelsIntersection = intersectIfcLabels(ifcALabels, ifcBLabels);
                if (labelsIntersection.length === 0) {
                  reasons.noSpecifiedLabelsMatched = true;
                }
                for (const label of labelsIntersection) {
                  // Skip tunnel if the label is not included in
                  // the list of labels specified by the user
                  const shouldSkipTunnel =
                    !createForAllLabels &&
                    !specifiedLabels.has(label);
                  if (shouldSkipTunnel) {
                    reasons.noSpecifiedLabelsMatched = true;
                    continue;
                  }
                  // If a tunnel already exists, skip the configuration
                  const tunnelFound = await getTunnel(org, label, wanIfcA, wanIfcB);
                  if (tunnelFound.length > 0) {
                    logger.debug('Found tunnel', {
                      params: { tunnel: tunnelFound }
                    });
                    reasons.foundTunnels = true;
                    continue;
                  }
                  // Use a copy of devices objects as promise runs later
                  dbTasks.push(generateTunnelPromise(userName, org, label,
                    { ...deviceA.toObject() }, { ...deviceB.toObject() },
                    { ...wanIfcA }, { ...wanIfcB }));
                }
              }
            };
          };
        } else {
          logger.info('Failed to connect tunnel between devices', {
            params: {
              deviceA: deviceA.hostname,
              deviceB: deviceB.hostname,
              reason: 'no valid WAN interfaces'
            }
          });
          reasons.noValidWanInterfaces = true;
        }
      }
    }

    // Execute all promises
    logger.debug('Running tunnel promises', { params: { tunnels: dbTasks.length } });

    const promiseStatus = await Promise.allSettled(dbTasks);
    const fulfilled = promiseStatus.reduce((arr, elem) => {
      if (elem.status === 'fulfilled') {
        const job = elem.value;
        arr.push(job);
      }
      return arr;
    }, []);

    const status = fulfilled.length < dbTasks.length
      ? 'partially completed' : 'completed';

    const desired = dbTasks.flat().map(job => job.id);
    const ids = fulfilled.flat().map(job => job.id);
    let message = 'tunnels creation jobs added.';
    if (desired.length === 0) {
      message = 'No ' + message;
    } else if (ids.length < desired.length) {
      message = `${ids.length} of ${desired.length} ${message}`;
    } else {
      message = `${ids.length} ${message}`;
    }
    if (desired.length === 0 || ids.length < desired.length) {
      if (reasons.withLabels) {
        message += ' No Path Labels specified but some devices have interfaces with Path Labels.';
      }
      if (reasons.noSpecifiedLabelsMatched) {
        message += ' Some devices have interfaces without specified Path Labels.';
      }
      if (reasons.noValidWanInterfaces) {
        message += ' Some devices have no valid WAN interfaces.';
      }
      if (reasons.foundTunnels) {
        message += ' Some tunnels exist already.';
      }
    }
    return { ids, status, message };
  } else {
    logger.error('At least 2 devices must be selected to create tunnels', { params: {} });
    throw new Error('At least 2 devices must be selected to create tunnels');
  }
};

/**
 * Complete tunnel add, called for each of the
 * devices that are connected by the tunnel.
 * @param  {number} jobId Kue job ID
 * @param  {Object} res   including the deviceA id, deviceB id, deviceSideConf
 * @return {void}
 */
const completeTunnelAdd = (jobId, res) => {
  logger.info('Tunnel add complete. Updating tunnel connectivity',
    { params: { result: res, jobId: jobId } });
  if (!res || !res.tunnelId || !res.target || !res.username || !res.org) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
    return;
  }

  updateTunnelIsConnected(tunnelsModel, res.org,
    res.tunnelId, res.target, true)(null, (err, res) => {
    if (err) {
      logger.error('Update tunnel connectivity failed', {
        params: { jobId: jobId, reason: err.message }
      });
    }
  }
  );
};

/**
 * Complete handler for sync job
 * @return void
 */
const completeSync = async (jobId, jobsData) => {
  try {
    for (const data of jobsData) {
      await completeTunnelAdd(jobId, data);
    }
  } catch (err) {
    logger.error('Tunnels sync complete callback failed', {
      params: { jobsData, reason: err.message }
    });
  }
};

/**
 * Error tunnel add, called for each of the
 * devices that are connected by the tunnel.
 * @param  {number} jobId Kue job ID
 * @param  {Object} res   including the deviceA id, deviceB id, deviceSideConf
 * @return {void}
 */
const errorTunnelAdd = async (jobId, res) => {
  logger.info('Tunnel add error.',
    { params: { result: res, jobId: jobId } });
  if (!res || !res.deviceA || !res.deviceB || !res.target || !res.username || !res.org) {
    logger.warn('Got an invalid job result', { params: { result: res, jobId: jobId } });
  }
};

/**
 * Returns an active tunnel object promise from DB
 * @param  {string}   org         organization id the user belongs to
 * @param  {string}   pathLabel   path label id
 * @param  {Object}   wanIfcA     device A tunnel interface
 * @param  {Object}   wanIfcB     device B tunnel interface
 */
const getTunnel = (org, pathLabel, wanIfcA, wanIfcB) => {
  return tunnelsModel.find({
    $or: [
      { interfaceA: wanIfcA._id, interfaceB: wanIfcB._id },
      { interfaceB: wanIfcA._id, interfaceA: wanIfcB._id }
    ],
    isActive: true,
    pathlabel: pathLabel,
    org: org
  });
};

/**
 * This function generates one tunnel promise including
 * all configurations for the tunnel into the device
 * @param  {string}   user         user id of the requesting user
 * @param  {string}   org          organization id the user belongs to
 * @param  {Object}   deviceA      device A details
 * @param  {Object}   deviceB      device B details
 * @param  {Object}   deviceAIntf device A tunnel interface
 * @param  {Object}   deviceBIntf device B tunnel interface
 */
const generateTunnelPromise = (user, org, pathLabel, deviceA, deviceB,
  deviceAIntf, deviceBIntf) => {
  logger.debug('Adding tunnel between devices', {
    params: {
      deviceA: deviceA.hostname,
      deviceB: deviceB.hostname,
      interfaces: {
        interfaceA: deviceAIntf.name,
        interfaceB: deviceBIntf.name
      },
      label: pathLabel
    }
  });

  var tPromise = new Promise(function (resolve, reject) {
    // Get a unique tunnel number
    // Search first in deleted tunnels
    tunnelsModel.findOneAndUpdate(
      // Query
      { isActive: false, org: org },
      // Update, make sure other query doesn't find the same number
      { isActive: true },
      // Options
      { upsert: false }
    )
      .then(async (tunnelResp) => {
        logger.debug('Found a tunnel', { params: { tunnel: tunnelResp } });

        if (tunnelResp !== null) { // deleted tunnel found, use it
          const tunnelnum = tunnelResp.num;
          logger.info('Adding tunnel from deleted tunnel', { params: { tunnel: tunnelnum } });

          // Configure tunnel using this num
          const tunnelJobs = await addTunnel(user, org, tunnelnum,
            deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel);

          return resolve(tunnelJobs);
        } else { // No deleted tunnel found, get a new one
          tunnelIDsModel.findOneAndUpdate(
            // Query, allow only 15000 tunnels per organization
            {
              org: org,
              nextAvailID: { $gte: 0, $lt: 15000 }
            },
            // Update
            { $inc: { nextAvailID: 1 } },
            // Options
            { new: true, upsert: true }
          ).then(async (idResp) => {
            const tunnelnum = idResp.nextAvailID;
            logger.info('Adding tunnel with new ID', { params: { tunnel: tunnelnum } });

            // Configure tunnel using this num
            const tunnelJobs = await addTunnel(user, org, tunnelnum,
              deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel);

            return resolve(tunnelJobs);
          }, (err) => {
            // org is a key value in the collection, upsert sometimes creates a new doc
            // (if two upserts done at once)
            // In this case we need to check the error and try again if such occurred
            // See more info in:
            // eslint-disable-next-line max-len
            // https://stackoverflow.com/questions/37295648/mongoose-duplicate-key-error-with-upsert
            if (err.code === 11000) {
              logger.debug('2nd try to find tunnel ID', { params: {} });
              tunnelIDsModel.findOneAndUpdate(
                // Query, allow only 15000 tunnels per organization
                {
                  org: org,
                  nextAvailID: { $gte: 0, $lt: 15000 }
                },
                // Update
                { $inc: { nextAvailID: 1 } },
                // Options
                { new: true, upsert: true }
              ).then(async (idResp) => {
                const tunnelnum = idResp.nextAvailID;
                logger.info('Adding tunnel with new ID', { params: { tunnel: tunnelnum } });
                // Configure tunnel using this num
                const tunnelJobs = await addTunnel(user, org, tunnelnum,
                  deviceA, deviceB, deviceAIntf, deviceBIntf, pathLabel);

                return resolve(tunnelJobs);
              }, (err) => {
                logger.error('Tunnel ID not found (not found twice)', {
                  params: { reason: err.message }
                });
                reject(new Error('Tunnel ID not found'));
              });
            } else {
              // Another error
              logger.error('Tunnel ID not found (other error)', {
                params: { reason: err.message }
              });
              reject(new Error('Tunnel ID not found'));
            }
          })
            .catch((err) => {
              logger.error('Tunnel ID not found (general error)', {
                params: { reason: err.message }
              });
              reject(new Error('Tunnel ID not found'));
            });
        }
      }, (err) => {
        logger.error('Tunnels search error', { params: { reason: err.message } });
        reject(new Error('Tunnels search error'));
      })
      .catch((err) => {
        logger.error('Tunnels search error (general error)', {
          params: { reason: err.message }
        });
        reject(new Error('Tunnel ID not found'));
      });
  });
  return tPromise;
};

/**
 * Queues the tunnel creation/deletion jobs to both
 * of the devices that are connected via the tunnel
 * @param  {boolean} isAdd        a flag indicating creation/deletion
 * @param  {string} title         title of the task
 * @param  {Object} tasksDeviceA  device A tunnel job
 * @param  {Object} tasksDeviceB  device B tunnel job
 * @param  {string} user          user id of the requesting user
 * @param  {string} org           user's organization id
 * @param  {string} devAMachineID device A host id
 * @param  {string} devBMachineID device B host id
 * @param  {string} devAOid       device A database mongodb object id
 * @param  {string} devBOid       device B database mongodb object id
 * @return {void}
 */
const queueTunnel = async (
  isAdd,
  title,
  tasksDeviceA,
  tasksDeviceB,
  user,
  org,
  devAMachineID,
  devBMachineID,
  devAOid,
  devBOid,
  tunnelId,
  pathLabel
) => {
  try {
    const devices = { deviceA: devAOid, deviceB: devBOid };
    const jobA = await deviceQueues.addJob(
      devAMachineID,
      user,
      org,
      // Data
      {
        title: title,
        tasks: tasksDeviceA
      },
      // Response data
      {
        method: isAdd ? 'tunnels' : 'deltunnels',
        data: {
          username: user,
          org: org,
          tunnelId: tunnelId,
          deviceA: devAOid,
          deviceB: devBOid,
          pathlabel: pathLabel,
          target: 'deviceAconf'
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    );

    logger.info(`${isAdd ? 'Add' : 'Del'} tunnel job queued - deviceA`, {
      params: { devices: devices },
      job: jobA
    });

    const jobB = await deviceQueues.addJob(
      devBMachineID,
      user,
      org,
      // Data
      {
        title: title,
        tasks: tasksDeviceB
      },
      // Response data
      {
        method: isAdd ? 'tunnels' : 'deltunnels',
        data: {
          username: user,
          org: org,
          tunnelId: tunnelId,
          deviceA: devAOid,
          deviceB: devBOid,
          pathlabel: pathLabel,
          target: 'deviceBconf'
        }
      },
      // Metadata
      { priority: 'normal', attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    );

    logger.info(`${isAdd ? 'Add' : 'Del'} tunnel job queued - deviceB`, {
      params: { devices: devices },
      job: jobB
    });

    return [jobA, jobB];
  } catch (err) {
    logger.error('Error queuing tunnel', {
      params: { deviceAId: devAMachineID, deviceBId: devBMachineID, message: err.message }
    });
    throw new Error(`Error queuing tunnel for device IDs ${devAMachineID} and ${devBMachineID}`);
  }
};

/**
 * Prepares tunnel add jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {Object} tunnel    tunnel object
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object} deviceBIntf device B tunnel interface
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelAddJob = async (
  tunnel,
  deviceAIntf,
  deviceBIntf,
  pathLabel
) => {
  // Extract tunnel keys from the database
  if (!tunnel) throw new Error('Tunnel not found');
  if (!tunnel.tunnelKeys) throw new Error(`Tunnel ${tunnel.num} has no keys`);

  const tunnelKeys = {
    key1: tunnel.tunnelKeys.key1,
    key2: tunnel.tunnelKeys.key2,
    key3: tunnel.tunnelKeys.key3,
    key4: tunnel.tunnelKeys.key4
  };

  const tasksDeviceA = [];
  const tasksDeviceB = [];
  const paramsIpsecDeviceA = {};
  const paramsIpsecDeviceB = {};
  const {
    paramsDeviceA,
    paramsDeviceB,
    tunnelParams
  } = prepareTunnelParams(tunnel.num, deviceAIntf, deviceBIntf);
  const paramsSaAB = {
    spi: tunnelParams.sa1,
    'crypto-key': tunnelKeys.key1,
    'integr-key': tunnelKeys.key2,
    'crypto-alg': 'aes-cbc-128',
    'integr-alg': 'sha-256-128'
  };
  const paramsSaBA = {
    spi: tunnelParams.sa2,
    'crypto-key': tunnelKeys.key3,
    'integr-key': tunnelKeys.key4,
    'crypto-alg': 'aes-cbc-128',
    'integr-alg': 'sha-256-128'
  };
  paramsIpsecDeviceA['local-sa'] = paramsSaAB;
  paramsIpsecDeviceA['remote-sa'] = paramsSaBA;
  paramsDeviceA.ipsec = paramsIpsecDeviceA;
  paramsDeviceA['loopback-iface'] = {
    addr: tunnelParams.ip1 + '/31',
    mac: tunnelParams.mac1,
    mtu: 1350,
    routing: 'ospf',
    multilink: {
      labels: pathLabel ? [pathLabel] : []
    }
  };

  // const majorAgentVersion = getMajorVersion(devBagentVer);
  // if (majorAgentVersion === 0) {    // version 0.X.X
  // The following looks as a wrong config in vpp 19.01 ipsec-gre interface,
  // spi isn't configured properly for SA
  // This is also the case for version 1.X.X since we revert to ipsec-gre interface
  // Kept the comments to be fixed in later releases
  paramsIpsecDeviceB['local-sa'] = { ...paramsSaAB, spi: tunnelParams.sa2 };
  paramsIpsecDeviceB['remote-sa'] = { ...paramsSaBA, spi: tunnelParams.sa1 };
  // } else if (majorAgentVersion >= 1) {    // version 1.X.X+
  //    paramsIpsecDeviceB['local-sa'] = {...paramsSaBA};
  //    paramsIpsecDeviceB['remote-sa'] = {...paramsSaAB};
  // }

  paramsDeviceB.ipsec = paramsIpsecDeviceB;
  paramsDeviceB['loopback-iface'] = {
    addr: tunnelParams.ip2 + '/31',
    mac: tunnelParams.mac2,
    mtu: 1350,
    routing: 'ospf',
    multilink: {
      labels: pathLabel ? [pathLabel] : []
    }
  };

  // Saving configuration for device A
  tasksDeviceA.push({
    entity: 'agent',
    message: 'add-tunnel',
    params: paramsDeviceA
  });

  // Saving configuration for device B
  tasksDeviceB.push({
    entity: 'agent',
    message: 'add-tunnel',
    params: paramsDeviceB
  });

  return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for creating a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {number}   tunnelnum    id of the tunnel to be added
 * @param  {Object}   deviceA      details of device A
 * @param  {Object}   deviceB      details of device B
 * @param  {Object}   deviceAIntf device A tunnel interface
 * @param  {Object}   deviceBIntf device B tunnel interface
 * @param  {Callback} next         express next() callback
 * @param  {Callback} resolve      promise reject callback
 * @param  {Callback} reject       promise resolve callback
 * @return {void}
 */
const addTunnel = async (
  user,
  org,
  tunnelnum,
  deviceA,
  deviceB,
  deviceAIntf,
  deviceBIntf,
  pathLabel
) => {
  const devicesInfo = {
    deviceA: { hostname: deviceA.hostname, interface: deviceAIntf.name },
    deviceB: { hostname: deviceB.hostname, interface: deviceBIntf.name }
  };

  logger.info('Adding Tunnel between devices', {
    params: { devices: devicesInfo }
  });

  // Generate IPsec Keys and store them in the database
  const { key1, key2, key3, key4 } = generateRandomKeys();

  const tunnel = await tunnelsModel.findOneAndUpdate(
    // Query, use the org and tunnel number
    {
      org: org,
      num: tunnelnum
    },
    // Update
    {
      isActive: true,
      deviceAconf: false,
      deviceBconf: false,
      deviceA: deviceA._id,
      interfaceA: deviceAIntf._id,
      deviceB: deviceB._id,
      interfaceB: deviceBIntf._id,
      pathlabel: pathLabel,
      tunnelKeys: {
        key1,
        key2,
        key3,
        key4
      }
    },
    // Options
    { upsert: true, new: true }
  );

  const [tasksDeviceA, tasksDeviceB] = await prepareTunnelAddJob(
    tunnel,
    deviceAIntf,
    deviceBIntf,
    pathLabel
  );

  const tunnelJobs = await queueTunnel(
    true,
    'Create tunnel between (' +
      deviceA.hostname +
      ',' +
      deviceAIntf.name +
      ') and (' +
      deviceB.hostname +
      ',' +
      deviceBIntf.name +
      ')',
    tasksDeviceA,
    tasksDeviceB,
    user,
    org,
    deviceA.machineId,
    deviceB.machineId,
    deviceA._id,
    deviceB._id,
    tunnelnum,
    pathLabel
  );

  return tunnelJobs;
};

/**
 * Update tunnel device configuration
 * @param  {Object}  tunnelsModel mongoose tunnel schema
 * @param  {string}  org          organization initiated the request
 * @param  {string}  tunnelId     the id of the tunnel to update
 * @param  {string}  target       which parameter to update in the model
 * @param  {boolean} isAdd        update to configuration of true or false
 * @return {void}
 */
const updateTunnelIsConnected = (
  tunnelsModel,
  org,
  tunnelId,
  target,
  isAdd
) => (inp, callback) => {
  const params = {
    org: org,
    target: target,
    isAdd: isAdd
  };
  logger.info('Updating tunnels connectivity', { params: params });
  const update = {};
  update[target] = isAdd;

  tunnelsModel
    .findOneAndUpdate(
      // Query
      { num: tunnelId, org: org },
      // Update
      update,
      // Options
      { upsert: false, new: true }
    )
    .then(
      resp => {
        if (resp != null) {
          callback(null, { ok: 1 });
        } else {
          const err = new Error('Update tunnel connected status failure');
          callback(err, false);
        }
      },
      err => {
        callback(err, false);
      }
    )
    .catch(err => {
      callback(err, false);
    });
};

/**
 * This function is called when deleting a tunnel
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const applyTunnelDel = async (devices, user, data) => {
  const selectedTunnels = data.tunnels;
  const tunnelIds = Object.keys(selectedTunnels);
  logger.info('Delete tunnels ', { params: { tunnels: selectedTunnels } });

  if (devices && tunnelIds.length > 0) {
    const org = data.org;
    const userName = user.username;

    const delPromises = [];
    tunnelIds.forEach(tunnelID => {
      try {
        const delPromise = oneTunnelDel(tunnelID, userName, org);
        delPromises.push(delPromise);
      } catch (err) {
        logger.error('Delete tunnel error', { params: { tunnelID, error: err.message } });
      }
    });

    const promiseStatus = await Promise.allSettled(delPromises);
    const fulfilled = promiseStatus.reduce((arr, elem) => {
      if (elem.status === 'fulfilled') {
        const job = elem.value;
        arr.push(job);
      }
      return arr;
    }, []);
    const status = fulfilled.length < tunnelIds.length
      ? 'partially completed' : 'completed';
    const message = fulfilled.length < tunnelIds.length
      ? `${fulfilled.length} of ${tunnelIds.length} tunnels deletion jobs added` : '';
    return { ids: fulfilled.flat().map(job => job.id), status, message };
  } else {
    logger.error('Delete tunnels failed. No tunnels\' ids provided or no devices found',
      { params: { tunnelIds, devices } });
    throw new Error('Delete tunnels failed. No tunnels\' ids provided or no devices found');
  }
};

/**
 * Deletes a single tunnel.
 * @param  {number}   tunnelID   the id of the tunnel to be deleted
 * @param  {string}   user       the user id of the requesting user
 * @param  {string}   org        the user's organization id
 * @return {array}    jobs created
 */
const oneTunnelDel = async (tunnelID, user, org) => {
  const tunnelResp = await tunnelsModel.findOne({ _id: tunnelID, isActive: true, org: org })
    .populate('deviceA')
    .populate('deviceB');

  logger.debug('Delete tunnels db response', { params: { response: tunnelResp } });

  // Define devices
  const deviceA = tunnelResp.deviceA;
  const deviceB = tunnelResp.deviceB;
  const pathLabel = tunnelResp.pathlabel;

  // Populate interface details
  const deviceAIntf = tunnelResp.deviceA.interfaces
    .filter((ifc) => { return ifc._id.toString() === '' + tunnelResp.interfaceA; })[0];
  const deviceBIntf = tunnelResp.deviceB.interfaces
    .filter((ifc) => { return ifc._id.toString() === '' + tunnelResp.interfaceB; })[0];

  const tunnelnum = tunnelResp.num;

  const tunnelJobs = await delTunnel(user, org, tunnelnum, deviceA, deviceB,
    deviceAIntf, deviceBIntf, pathLabel);

  logger.info('Deleting tunnels from database');
  const resp = await tunnelsModel.findOneAndUpdate(
    // Query
    { _id: mongoose.Types.ObjectId(tunnelID), org: org },
    // Update
    {
      isActive: false,
      deviceAconf: false,
      deviceBconf: false,
      pendingTunnelModification: false,
      tunnelKeys: null
    },
    // Options
    { upsert: false, new: true }
  );

  if (resp === null) throw new Error('Error deleting tunnel');

  return tunnelJobs;
};

/**
 * Called when tunnel delete jobs are finished successfully.
 * @param  {number} jobId the id of the delete tunnel job
 * @param  {Object} res   the result of the delete tunnel job
 * @return {void}
 */
const completeTunnelDel = (jobId, res) => {
  logger.info('Complete tunnel deletion job', { params: { jobId: jobId, result: res } });
};

/**
 * Prepares tunnel delete jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {number} tunnelnum    tunnel id
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object} deviceBIntf device B tunnel interface
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelRemoveJob = (tunnelnum, deviceAIntf, deviceBIntf) => {
  const tasksDeviceA = [];
  const tasksDeviceB = [];
  const {
    paramsDeviceA,
    paramsDeviceB
  } = prepareTunnelParams(tunnelnum, deviceAIntf, deviceBIntf);

  // Saving configuration for device A
  tasksDeviceA.push({ entity: 'agent', message: 'remove-tunnel', params: paramsDeviceA });

  // Saving configuration for device B
  tasksDeviceB.push({ entity: 'agent', message: 'remove-tunnel', params: paramsDeviceB });

  return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for deleting a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {number}   tunnelnum    id of the tunnel to be added
 * @param  {Object}   deviceA      details of device A
 * @param  {Object}   deviceB      details of device B
 * @param  {Object}   deviceAIntf device A tunnel interface
 * @param  {Object}   deviceBIntf device B tunnel interface
 * @return {void}
 */
const delTunnel = async (
  user,
  org,
  tunnelnum,
  deviceA,
  deviceB,
  deviceAIntf,
  deviceBIntf,
  pathLabel
) => {
  const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(
    tunnelnum,
    deviceAIntf,
    deviceBIntf
  );
  try {
    const tunnelJobs = await queueTunnel(
      false,
      'Delete tunnel between (' +
        deviceA.hostname +
        ',' +
        deviceAIntf.name +
        ') and (' +
        deviceB.hostname +
        ',' +
        deviceBIntf.name +
        ')',
      tasksDeviceA,
      tasksDeviceB,
      user,
      org,
      deviceA.machineId,
      deviceB.machineId,
      deviceA._id,
      deviceB._id,
      tunnelnum,
      pathLabel
    );
    logger.debug('Tunnel jobs queued', { params: { jobA: tunnelJobs[0], jobB: tunnelJobs[1] } });
    return tunnelJobs;
  } catch (err) {
    logger.error('Delete tunnel error', { params: { reason: err.message } });
    throw err;
  }
};

/**
 * Creates the tunnels section in the full sync job.
 * @return Array
 */
const sync = async (deviceId, org) => {
  // Get all active tunnels of the devices
  const tunnels = await tunnelsModel.find(
    {
      $and: [
        { org },
        { $or: [{ deviceA: deviceId }, { deviceB: deviceId }] },
        { isActive: true }
      ]
    },
    {
      _id: 0,
      num: 1,
      deviceA: 1,
      deviceB: 1,
      interfaceA: 1,
      interfaceB: 1,
      tunnelKeys: 1,
      pathlabel: 1
    }
  )
    .populate('deviceA', 'interfaces')
    .populate('deviceB', 'interfaces')
    .lean();

  // Create add-tunnel messages
  const tunnelsRequests = [];
  const completeCbData = [];
  let callComplete = false;
  for (const tunnel of tunnels) {
    const {
      num,
      deviceA,
      deviceB,
      interfaceA,
      interfaceB,
      pathlabel
    } = tunnel;

    const ifcA = deviceA.interfaces.find(
      (ifc) => ifc._id.toString() === interfaceA.toString()
    );
    const ifcB = deviceB.interfaces.find(
      (ifc) => ifc._id.toString() === interfaceB.toString()
    );
    const [tasksA, tasksB] = await prepareTunnelAddJob(
      tunnel,
      ifcA,
      ifcB,
      pathlabel
    );
    // Add the tunnel only for the device that is being synced
    const deviceTasks =
      deviceId.toString() === deviceA._id.toString() ? tasksA : tasksB;
    tunnelsRequests.push({
      entity: 'agent',
      message: 'add-tunnel',
      params: deviceTasks[0].params
    });

    // Store the data required by the complete callback
    const target =
      deviceId.toString() === deviceA._id.toString()
        ? 'deviceAconf'
        : 'deviceBconf';
    completeCbData.push({
      org,
      username: 'system',
      tunnelId: num,
      target
    });
    callComplete = true;
  };

  return {
    requests: tunnelsRequests,
    completeCbData,
    callComplete
  };
};

/*
 * Prepares common parameters for add/remove tunnel jobs
 * @param  {number} tunnelnum    tunnel id
 * @param  {Object} deviceAIntf device A tunnel interface
 * @param  {Object} deviceBIntf device B tunnel interface
*/
const prepareTunnelParams = (tunnelnum, deviceAIntf, deviceBIntf) => {
  // Generate from the tunnel num: IP A/B, MAC A/B, SA A/B
  const tunnelParams = generateTunnelParams(tunnelnum);

  const paramsDeviceA = {};
  const paramsDeviceB = {};

  const isLocal = !deviceAIntf.PublicIP || !deviceBIntf.PublicIP ||
      deviceAIntf.PublicIP === deviceBIntf.PublicIP;

  paramsDeviceA.src = deviceAIntf.IPv4;
  paramsDeviceA.pci = deviceAIntf.pciaddr;
  paramsDeviceA.dst = isLocal ? deviceBIntf.IPv4 : deviceBIntf.PublicIP;
  paramsDeviceA.dstPort = (isLocal || !deviceBIntf.PublicPort)
    ? configs.get('tunnelPort') : deviceBIntf.PublicPort;
  paramsDeviceA['tunnel-id'] = tunnelnum;
  paramsDeviceA['loopback-iface'] = {
    addr: tunnelParams.ip1 + '/31',
    mac: tunnelParams.mac1
  };
  paramsDeviceB.src = deviceBIntf.IPv4;
  paramsDeviceB.pci = deviceBIntf.pciaddr;
  paramsDeviceB.dst = isLocal ? deviceAIntf.IPv4 : deviceAIntf.PublicIP;
  paramsDeviceB.dstPort = (isLocal || !deviceAIntf.PublicPort)
    ? configs.get('tunnelPort') : deviceAIntf.PublicPort;
  paramsDeviceB['tunnel-id'] = tunnelnum;
  paramsDeviceB['loopback-iface'] = {
    addr: tunnelParams.ip2 + '/31',
    mac: tunnelParams.mac2
  };

  return { paramsDeviceA, paramsDeviceB, tunnelParams };
};

/**
 * Generates various tunnel parameters that will
 * be used for creating the tunnel.
 * @param  {number} tunnelNum tunnel id
 * @return
 * {{
        ip1: string,
        ip2: string,
        mac1: string,
        mac2: string,
        sa1: number,
        sa2: number
    }}
 */
const generateTunnelParams = (tunnelNum) => {
  const d2h = (d) => (('00' + (+d).toString(16)).substr(-2));

  const h = (tunnelNum % 127 + 1) * 2;
  const l = Math.floor(tunnelNum / 127);
  const ip1 = '10.100.' + (+l).toString(10) + '.' + (+h).toString(10);
  const ip2 = '10.100.' + (+l).toString(10) + '.' + (+(h + 1)).toString(10);
  const mac1 = '02:00:27:fd:' + d2h(l) + ':' + d2h(h);
  const mac2 = '02:00:27:fd:' + d2h(l) + ':' + d2h(h + 1);
  const sa1 = (l * 256 + h);
  const sa2 = (l * 256 + h + 1);

  return {
    ip1: ip1,
    ip2: ip2,
    mac1: mac1,
    mac2: mac2,
    sa1: sa1,
    sa2: sa2
  };
};
/**
 * Generates random keys that will be used for tunnels creation
 * @return {{key1: number, key2: number, key3: number, key4: number}}
 */
const generateRandomKeys = () => {
  return {
    key1: randomNum(32, 16),
    key2: randomNum(32, 16),
    key3: randomNum(32, 16),
    key4: randomNum(32, 16)
  };
};

module.exports = {
  apply: {
    applyTunnelAdd: applyTunnelAdd,
    applyTunnelDel: applyTunnelDel
  },
  complete: {
    completeTunnelAdd: completeTunnelAdd,
    completeTunnelDel: completeTunnelDel
  },
  error: {
    errorTunnelAdd: errorTunnelAdd
  },
  sync: sync,
  completeSync: completeSync,
  prepareTunnelRemoveJob: prepareTunnelRemoveJob,
  prepareTunnelAddJob: prepareTunnelAddJob,
  queueTunnel: queueTunnel,
  oneTunnelDel: oneTunnelDel
};
