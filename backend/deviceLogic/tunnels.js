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

// Logic to apply tunnels between devices
const configs = require('../configs')();
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const tunnelsModel = require('../models/tunnels');
const tunnelIDsModel = require('../models/tunnelids');
const mongoose = require('mongoose');
const createError = require('http-errors');
const randomNum = require('../utils/random-key');

const deviceQueues = require('../utils/deviceQueue')(configs.get('kuePrefix'),configs.get('redisUrl'));
const { routerVersionsCompatible, getMajorVersion } = require('../versioning');
const logger = require('../logging/logging')({module: module.filename, type: 'req'});

/**
 * This function is called when adding new tunnels
 * @param  {Array}    devices the array of device objects
 * @param  {Object}   req     express request object
 * @param  {Object}   res     express response object
 * @param  {Callback} next    express next() callback
 * @return {void}
 */
const applyTunnelAdd = (devices, req, res, next) => {
    /**
     * Request body holds the list of devices ids to connect tunnel between
     */
    const selected_devices = req.body.devices;
    logger.info("Creating tunnels between devices", {params: {devices: selected_devices}, req: req});

    // Get details for devices to connect
    const op_devices = (devices && selected_devices) ?
        devices.filter((device) => {
            const in_selected = selected_devices.hasOwnProperty(device._id);
            if (in_selected) return true;
            else return false;
        }) : [];

    // For each device pair, create tunnels between WAN interfaces
    const devices_len = op_devices.length;
    // Only allow tunnels for more than two devices
    if (devices_len >= 2) {

        const dbTasks = [];
        const user = req.user.username;
        const org = req.user.defaultOrg._id.toString();

        for (idxA=0;idxA<devices_len-1;idxA++) {
            for (idxB=idxA+1;idxB<devices_len;idxB++) {
                deviceA = op_devices[idxA];
                deviceB = op_devices[idxB];

                // Tunnels are supported only between devices of the same router version
                const [verA, verB] = [deviceA.versions.router, deviceB.versions.router];
                if(!routerVersionsCompatible(verA, verB)) {
                    logger.warn('Tunnel creation failed', {
                        params: {reason: "Router version mismatch", versions: {verA: verA, verB: verB}},
                        req: req});
                    return next(
                      createError(
                        400,
                        "Cannot create tunnels between devices with mismatching router versions"
                      )
                    );
                }

                // Find device A WAN interface
                var deviceA_intf = null;
                deviceA.interfaces.forEach((intf) => {
                    if (intf.isAssigned === true && intf.type == "WAN") {
                        deviceA_intf = intf;
                    }
                });

                // Find device B WAN interface
                var deviceB_intf = null;
                deviceB.interfaces.forEach((intf) => {
                    if (intf.isAssigned === true && intf.type == "WAN") {
                        deviceB_intf = intf;
                    }
                });

                const devicesInfo = {
                    deviceA:{ hostname: deviceA.hostname, interface: deviceA_intf.name },
                    deviceB:{ hostname: deviceB.hostname, interface: deviceB_intf.name }
                };
                logger.debug("Connecting tunnel between devices", {params: {devicesInfo}, req: req});

                // Create a tunnel from device A to device B WAN interface
                // TBD: add tunnels through multiple WAN interfaces
                // TBD: key exchange should be dynamic
                if (deviceA_intf && deviceB_intf) {

                    logger.info("Connecting tunnel between (" + deviceA.hostname + "," + deviceA_intf.name +
                        ") and (" + deviceB.hostname + "," + deviceB_intf.name + ")");

                    // Check if tunnel exist, if already exist skip the configuration
                    // Use a copy of devices objects as promise runs later
                    dbTasks.push(getTunnelPromise(user, org,
                        {...deviceA.toObject()}, {...deviceB.toObject()},
                        {...deviceA_intf.toObject()}, {...deviceB_intf.toObject()},
                        next));
                } else {
                    logger.info("Failed to connect tunnel between " + deviceA.hostname + " and " + deviceB.hostname +
                        " - no valid WAN interfaces");
                }
            }
        }

        // Execute all promises
        logger.debug("Running tunnel promises", {params: {tunnels: dbTasks.length}, req: req});
        Promise.all(dbTasks)
        .then((values) => {
            // Run all device configuration operations
            logger.debug("Operation completed", {params: {values: values}, req: req});
            res.status(200).send({ 'ok': 1 });
        }, (err) => {
            logger.error("Error in configuring some devices", {params: {reason: err.message}});
            return next(createError(500, "Error for some of the tunnels, you may try again to configure the same tunnels"));
        })
        .catch((err) => {
            logger.error("Error (general) in configuring some devices", {params: {reason: err.message}});
            return next(createError(500, "Error (general) for some of the tunnels, you may try again to configure the same tunnels"));
        });
    } else {
        logger.error("At least 2 devices must be selected to create tunnels", {params: {}});
        return next(createError(400, "At least 2 devices must be selected to create tunnels"));
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
    logger.info("Tunnel add complete. Updating tunnel connectivity",
                {params: {result: res, jobId: jobId}});
    if (!res || !res.deviceA || !res.deviceB || !res.target || !res.username || !res.org) {
        logger.warn('Got an invalid job result', {params: {result: res, jobId: jobId}});
        return;
    }

    updateTunnelIsConnected(tunnelsModel, res.org,
        res.deviceA, res.deviceB, res.target, true)(null, (err, res) => {
            if (err) logger.error('Update tunnel connectivity failed', {
                                  params: {jobId: jobId, reason: err.message}});
        }
    );
};

/**
 * Error tunnel add, called for each of the
 * devices that are connected by the tunnel.
 * @param  {number} jobId Kue job ID
 * @param  {Object} res   including the deviceA id, deviceB id, deviceSideConf
 * @return {void}
 */
const errorTunnelAdd = (jobId, res) => {
    logger.info("Tunnel add error. rollback tunnel",
                {params: {result: res, jobId: jobId}});
    if (!res || !res.deviceA || !res.deviceB || !res.target || !res.username || !res.org) {
        logger.warn('Got an invalid job result', {params: {result: res, jobId: jobId}});
        return;
    }

    tunnelsModel.findOne({deviceA:res.deviceA, deviceB:res.deviceB, org:res.org, isActive:true})
    .then((tunnel) => {
        if (tunnel != null) {
            oneTunnelDel(tunnel._id, res.username, res.org,
                (msg)=>{logger.info("One tunnel del", {params: {message: msg}})},
                ()=>{logger.info("Tunnel deleted", {params: {org:res.org, tunnelId:tunnel._id, tunnelNum:tunnel.num}})});
        } else {
            logger.error("errorTunnelAdd no tunnel found",
            {params: {deviceA:res.deviceA, deviceB:res.deviceB, org:res.org, isActive:true}});
        }
    }, (err) => {
        logger.error("errorTunnelAdd error",
        {params: {deviceA:res.deviceA, deviceB:res.deviceB, org:res.org, isActive:true, message:err.message}});
    })
    .catch((err) => {
        logger.error("errorTunnelAdd error",
        {params: {deviceA:res.deviceA, deviceB:res.deviceB, org:res.org, isActive:true, message:err.message}});
    });
};

/**
 * This function generates one tunnel promise including all configurations for the tunnel into the device
 * @param  {string}   user         user id of the requesting user
 * @param  {string}   org          organization id the user belongs to
 * @param  {Object}   deviceA      device A details
 * @param  {Object}   deviceB      device B details
 * @param  {Object}   deviceA_intf device A tunnel interface
 * @param  {Object}   deviceB_intf device B tunnel interface
 * @param  {callback} next         express next() callback
 */
const getTunnelPromise = (user, org, deviceA, deviceB,
    deviceA_intf, deviceB_intf, next) => {
    logger.debug("getTunnelPromise between", {params:
        {deviceA:{hostname: deviceA.hostname},
        deviceB:{hostname: deviceB.hostname}}});


    var tPromise = new Promise(function(resolve, reject) {
      tunnelsModel.find({ $or: [
        {'deviceA':deviceA._id, 'deviceB':deviceB._id},
        {'deviceB':deviceA._id, 'deviceA':deviceB._id}
        ],
        'isActive':true, org:org
      })


        .then((tunnelFound) => {
            logger.debug("Found tunnels", {params: {tunnels: tunnelFound}});

            if (tunnelFound.length == 0) {  // Tunnel does not exist, need to create it
                // Get a unique tunnel number
                // Search first in deleted tunnels
                tunnelsModel.findOneAndUpdate(
                    // Query
                    {isActive:false, org:org},
                    // Update, make sure other query doesn't find the same number
                    { isActive: true },
                    // Options
                    { upsert: false }
                    )
                .then((tunnelResp) => {
                    logger.debug("Found a tunnel", {params: {tunnel: tunnelResp}});

                    if (tunnelResp !== null) { // deleted tunnel found, use it
                        const tunnelnum = tunnelResp.num;
                        logger.info("Adding tunnel from deleted tunnel", {params: {tunnel: tunnelnum}});

                        // Configure tunnel using this num
                        addTunnel(user, org, tunnelnum,
                            deviceA, deviceB, deviceA_intf, deviceB_intf,
                            next, resolve, reject);

                    } else { // No deleted tunnel found, get a new one
                        tunnelIDsModel.findOneAndUpdate(
                            // Query, allow only 15000 tunnels per organization
                            { org: org,
                              nextAvailID: { $gte: 0, $lt: 15000 } },
                            // Update
                            { $inc: {nextAvailID: 1 }},
                            // Options
                            { new: true, upsert: true}
                        ).then((idResp) => {
                            const tunnelnum = idResp.nextAvailID;
                            logger.info("Adding tunnel with new ID", {params: {tunnel: tunnelnum}});

                            // Configure tunnel using this num
                            addTunnel(user, org, tunnelnum,
                                deviceA, deviceB, deviceA_intf, deviceB_intf,
                                next, resolve, reject);

                        }, (err) => {
                            // org is a key value in the collection, upsert sometimes creates a new doc (if two upserts done at once)
                            // In this case we need to check the error and try again if such occurred
                            // See more info in: https://stackoverflow.com/questions/37295648/mongoose-duplicate-key-error-with-upsert
                            if (err.code === 11000) {
                                logger.debug("2nd try to find tunnel ID", {params: {}});
                                tunnelIDsModel.findOneAndUpdate(
                                    // Query, allow only 15000 tunnels per organization
                                    { org: org,
                                      nextAvailID: { $gte: 0, $lt: 15000 } },
                                    // Update
                                    { $inc: {nextAvailID: 1 }},
                                    // Options
                                    { new: true, upsert: true}
                                ).then((idResp) => {
                                    const tunnelnum = idResp.nextAvailID;
                                    logger.info("Adding tunnel with new ID", {params: {tunnel: tunnelnum}});
                                    // Configure tunnel using this num
                                    addTunnel(user, org, tunnelnum,
                                        deviceA, deviceB, deviceA_intf, deviceB_intf,
                                        next, resolve, reject);
                                }, (err) => {
                                    logger.error("Tunnel ID not found (not found twice)", {params: {reason: err.message}});
                                    reject (new Error("Tunnel ID not found"));
                                });
                            } else {
                                // Another error
                                logger.error("Tunnel ID not found (other error)", {params: {reason: err.message}});
                                reject (new Error("Tunnel ID not found"));
                            }
                        })
                        .catch((err) => {
                            logger.error("Tunnel ID not found (general error)", {params: {reason: err.message}});
                            reject (new Error("Tunnel ID not found"));
                        });
                    }
                }, (err) => {
                    logger.error("Tunnels search error", {params: {reason: err.message}});
                    reject (new Error("Tunnels search error"));
                })
                .catch((err) => {
                    logger.error("Tunnels search error (general error)", {params: {reason: err.message}});
                    reject (new Error("Tunnel ID not found"));
                });
            } else {
                logger.info("Tunnel found, will be checked via periodic task");
                resolve({'ok':1, 'message':'Tunnel found'});
            }
        }, (err) => {
            logger.error("Tunnels find error", {params: {reason: err.message}});
            reject (new Error("Tunnels find error"));
        })
        .catch((err) => {
            logger.error("Tunnels find error (general error)", {params: {reason: err.message}});
            reject (new Error("Tunnel find error"));
        });
    });
    return tPromise;
};
/**
 * Prepares tunnel add jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {number} tunnelnum    tunnel id
 * @param  {Object} deviceA_intf device A tunnel interface
 * @param  {Object} deviceB_intf device B tunnel interface
 * @param  {string} devBagentVer device B version
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelAddJob = (tunnelnum, deviceA_intf, deviceB_intf, devBagentVer) => {
    // Generate from the tunnel ID: IP A/B, MAC A/B, SA A/B, 4 IPsec Keys
    const tunnelParams = generateTunnelParams(tunnelnum);
    const tunnelKeys = generateRandomKeys();

    const tasksDeviceA = [];
    const tasksDeviceB = [];
    const paramsDeviceA = {};
    const paramsDeviceB = {};
    const paramsIpsecDeviceA = {};
    const paramsIpsecDeviceB = {};

    const paramsSaAB = {
        "spi": tunnelParams.sa1,
        "crypto-key": tunnelKeys.key1,
        "integr-key": tunnelKeys.key2,
        "crypto-alg": "aes-cbc-128",
        "integr-alg": "sha-256-128"
    };
    const paramsSaBA = {
        "spi": tunnelParams.sa2,
        "crypto-key": tunnelKeys.key3,
        "integr-key": tunnelKeys.key4,
        "crypto-alg": "aes-cbc-128",
        "integr-alg": "sha-256-128"
    };

    paramsDeviceA['src'] = deviceA_intf.IPv4;
    paramsDeviceA['dst'] = ((deviceB_intf.PublicIP === "")? deviceB_intf.IPv4 : deviceB_intf.PublicIP);
    paramsDeviceA['tunnel-id'] = tunnelnum;
    paramsIpsecDeviceA['local-sa'] = paramsSaAB;
    paramsIpsecDeviceA['remote-sa'] = paramsSaBA;
    paramsDeviceA['ipsec'] = paramsIpsecDeviceA;
    paramsDeviceA['loopback-iface'] = {
        "addr": tunnelParams.ip1 + "/31",
        "mac": tunnelParams.mac1,
        "mtu": 1360,
        "routing": "ospf"
    };

    paramsDeviceB['src'] = deviceB_intf.IPv4;
    paramsDeviceB['dst'] = ((deviceA_intf.PublicIP === "")? deviceA_intf.IPv4 : deviceA_intf.PublicIP);
    paramsDeviceB['tunnel-id'] = tunnelnum;

    //const majorAgentVersion = getMajorVersion(devBagentVer);
    //if (majorAgentVersion === 0) {    // version 0.X.X
        // The following looks as a wrong config in vpp 19.01 ipsec-gre interface, spi isn't configured properly for SA
        // This is also the case for version 1.X.X since we revert to ipsec-gre interface
        // Kept the comments to be fixed in later releases
        paramsIpsecDeviceB['local-sa'] = {...paramsSaAB, "spi": tunnelParams.sa2};
        paramsIpsecDeviceB['remote-sa'] = {...paramsSaBA, "spi": tunnelParams.sa1};
    //} else if (majorAgentVersion >= 1) {    // version 1.X.X+
    //    paramsIpsecDeviceB['local-sa'] = {...paramsSaBA};
    //    paramsIpsecDeviceB['remote-sa'] = {...paramsSaAB};
    //}

    paramsDeviceB['ipsec'] = paramsIpsecDeviceB;
    paramsDeviceB['loopback-iface'] = {
        "addr": tunnelParams.ip2 + "/31",
        "mac": tunnelParams.mac2,
        "mtu": 1360,
        "routing": "ospf"
    };

    // Saving configuration for device A
    tasksDeviceA.push({"entity":"agent","message":"add-tunnel","params":paramsDeviceA});

    // Saving configuration for device B
    tasksDeviceB.push({"entity":"agent","message":"add-tunnel","params":paramsDeviceB});

    return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for creating a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {number}   tunnelnum    id of the tunnel to be added
 * @param  {Object}   deviceA      details of device A
 * @param  {Object}   deviceB      details of device B
 * @param  {Object}   deviceA_intf device A tunnel interface
 * @param  {Object}   deviceB_intf device B tunnel interface
 * @param  {Callback} next         express next() callback
 * @param  {Callback} resolve      promise reject callback
 * @param  {Callback} reject       promise resolve callback
 * @return {void}
 */
const addTunnel = (user, org, tunnelnum, deviceA, deviceB,
    deviceA_intf, deviceB_intf, next, resolve, reject) => {

    const devicesInfo = {
        deviceA:{ hostname: deviceA.hostname, interface: deviceA_intf.name },
        deviceB:{ hostname: deviceB.hostname, interface: deviceB_intf.name }
    };

    logger.info("Adding Tunnel between devices", {params: {devices: devicesInfo}});

    tunnelsModel.findOneAndUpdate(
        // Query, use the org and tunnel number
        { org: org,
          num: tunnelnum },
        // Update
        { isActive: true,
          deviceAconf: false,
          deviceBconf: false,
          deviceA: deviceA._id,
          interfaceA: deviceA_intf._id,
          deviceB: deviceB._id,
          interfaceB: deviceB_intf._id },
        // Options
        { upsert: true }
    ).then(async (tResp) => {
        const { agent } = deviceB.versions;
        const [tasksDeviceA, tasksDeviceB] = prepareTunnelAddJob(tunnelnum, deviceA_intf, deviceB_intf, agent);
        try {
            await queueTunnel(true, "Create tunnel between (" + deviceA.hostname + "," + deviceA_intf.name +
                ") and (" + deviceB.hostname + "," + deviceB_intf.name + ")",
                tasksDeviceA, tasksDeviceB, user, org, deviceA.machineId, deviceB.machineId,
                deviceA._id, deviceB._id);
            resolve();
        } catch(err) {
            reject(err);
        }
    }, (err) => {
        logger.error("Unable to store tunnel", {params: {reason: err.message}});
        reject(new Error("Unable to store tunnel"));
    })
    .catch((err) => {
        logger.error("Unable to store tunnel (general error)", {params: {reason: err.message}});
        reject(new Error("Unable to store tunnel"));
    });
};

const queueTunnelJob = async (method, title, devTasks, devMachineId, devAObjId, devBObjId, target, user, org) => {
    return deviceQueues.addJob(
        devMachineId, user, org,
      // Data
      { title: title, tasks: devTasks },
      // Response data
      {
        method: method,
        data: {
          username: user,
          org: org,
          deviceA: devAObjId,
          deviceB: devBObjId,
          target: target
        }
      },
      // Metadata
      { priority: "normal", attempts: 1, removeOnComplete: false },
      // Complete callback
      null
    );
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
 * @param  {string} devAmachineID device A host id
 * @param  {string} devBmachineID device B host id
 * @param  {string} devAOid       device A database mongodb object id
 * @param  {string} devBOid       device B database mongodb object id
 * @return {void}
 */
const queueTunnel = async (isAdd, title, tasksDeviceA, tasksDeviceB, user, org, devAmachineID, devBmachineID,
    devAOid, devBOid) => {

    return new Promise((resolve, reject) => {
        method = isAdd ? 'tunnels' : 'deltunnels';
        const devices = { deviceA: devAOid, deviceB:devBOid };
        queueTunnelJob(
            method,
            title,
            tasksDeviceA,
            devAmachineID,
            devAOid,
            devBOid,
            'deviceAconf',
            user,
            org
        )
          .then(job => {
            logger.info(`${isAdd ? "Add" : "Del"} tunnel job queued`, {
              params: { devices: devices },
              job: job
            });
            resolve(job.id);
          })
          .catch(err => {
            logger.error("Error queuing tunnel device A", {
              params: { deviceID: devAmachineID, reason: err.message }
            });
            reject({
              error: "Error queuing tunnel for device ID=" + devAmachineID
            });
          });

        queueTunnelJob(
            method,
            title,
            tasksDeviceB,
            devBmachineID,
            devAOid,
            devBOid,
            'deviceBconf',
            user,
            org
        )
        .then((job) => {
            logger.info(`${(isAdd) ? 'Add' : 'Del'} tunnel job queued`, {params: {devices: devices}, job: job});
            resolve(job.id);
        })
        .catch((err) => {
            logger.error("Error queuing tunnel device B", {params: {deviceID: devAmachineID, reason: err.message}});
            reject({"error": "Error queuing tunnel for device ID=" +
                devBmachineID});
        });
    });
};

/**
 * Update tunnel device configuration
 * @param  {Object}  tunnelsModel mongoose tunnel schema
 * @param  {string}  org          organization initiated the request
 * @param  {string}  devAOid      device A mongodb object id
 * @param  {string}  devBOid      device B mongodb object id
 * @param  {string}  target       which parameter to update in the model
 * @param  {boolean} isAdd        update to configuration of true or false
 * @return {void}
 */
const updateTunnelIsConnected = (tunnelsModel, org, devAOid, devBOid, target, isAdd) => (inp, callback) => {
    const params = {
        org: org,
        target: target,
        isAdd: isAdd,
        devices: {
            deviceA: devAOid,
            deviceB: devBOid
        }
    };
    logger.info('Updating tunnels connectivity', {params: params});
    const update = {};
    update[target] = isAdd;

    tunnelsModel
    .findOneAndUpdate(
        // Query
        {deviceA:devAOid, deviceB:devBOid, org:org},
        // Update
        update,
        // Options
        { upsert: false, new: true })
    .then((resp) => {
        if (resp != null) {
            callback(null, {'ok':1});
        } else {
            const err = new Error("Update tunnel connected status failure");
            callback(err, false);
        }
    }, (err) => {
        callback(err, false);
    })
    .catch((err) => {
        callback(err, false);
    });
};

/**
 * This function is called when deleting a tunnel
 * @param  {Array}    devices the array of device objects
 * @param  {Object}   req     express request object
 * @param  {Object}   res     express response object
 * @param  {Callback} next    express next() callback
 * @return {void}
 */
const applyTunnelDel = (devices, req, res, next) => {
    const selected_tunnels = req.body.tunnels;
    const tunnelIds = Object.keys(selected_tunnels);
    logger.info("Delete tunnels ", {params: {tunnels: selected_tunnels}});

    // For now assume one tunnel deletion at a time
    // Check that only one tunnel selected
    if (devices && tunnelIds.length == 1) {
        // Get tunnel data
        const tunnelID = tunnelIds[0];
        const org = req.user.defaultOrg._id.toString();
        const user = req.user.username;

        oneTunnelDel(tunnelID, user, org, next, ()=>{
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            return res.json({'ok':1});
        });
    } else {
        logger.error("Attempt to delete more than one tunnel or no devices found", {params: {}});
        return next(createError(400, "Attempt to delete more than one tunnel or no devices found"));
    }
};
/**
 * Deletes a single tunnel.
 * @param  {number}   tunnelID   the id of the tunnel to be deleted
 * @param  {string}   user       the user id of the requesting user
 * @param  {string}   org        the user's organization id
 * @param  {Callback} next       express next() callback
 * @param  {Callback} successCB  a callback that will be called if operation succeeds
 * @return {void}
 */
const oneTunnelDel = (tunnelID, user, org, next, successCB) => {

    tunnelsModel.findOne({_id:tunnelID, isActive:true, org:org})
    .populate('deviceA')
    .populate('deviceB')
    .then((tunnelResp) => {
        logger.debug("Delete tunnels db response", {params: {response: tunnelResp}});

        // Define devices
        const deviceA = tunnelResp.deviceA;
        const deviceB = tunnelResp.deviceB;

        // Populate interface details
        const deviceA_intf = tunnelResp.deviceA.interfaces
            .filter((interface)=>{return interface._id == ""+tunnelResp.interfaceA})[0];
        const deviceB_intf = tunnelResp.deviceB.interfaces
            .filter((interface)=>{return interface._id == ""+tunnelResp.interfaceB})[0];

        const tunnelnum = tunnelResp.num;

        delTunnel(user, org, tunnelnum, deviceA, deviceB, deviceA_intf, deviceB_intf, next);

        logger.info("Deleting tunnels from database");
        tunnelsModel
        .findOneAndUpdate(
            // Query
            {_id:mongoose.Types.ObjectId(tunnelID), org:org},
            // Update
            { isActive: false, deviceAconf: false, deviceBconf: false },
            // Options
            { upsert: false, new: true })
        .then((resp) => {
            if (resp != null) {
                return successCB();
            } else {
            return next(createError(500, "Error deleting tunnel"));
            }
        }, (err) => {
            next(err);
        })
        .catch((err) => {
            next(err);
        });
    }, (err) => {
        logger.error("No tunnel found", {params: {reason: err.message}});
        return next(createError(404, "No tunnel found"));
    })
    .catch((err) => {
        logger.error("Must have at least 2 devices to delete tunnels", {params: {reason: err.message}});
        return next(createError(400, "Must have at least 2 devices to delete tunnels"));
    });

};
/**
 * Called when tunnel delete jobs are finished successfully.
 * @param  {number} jobId the id of the delete tunnel job
 * @param  {Object} res   the result of the delete tunnel job
 * @return {void}
 */
const completeTunnelDel = (jobId, res) => {
    logger.info("Complete tunnel deletion job", {params: {jobId: jobId, result: res}});
};

/**
 * Prepares tunnel delete jobs by creating an array that contains
 * the jobs that should be queued for each of the devices connected
 * by the tunnel.
 * @param  {number} tunnelnum    tunnel id
 * @param  {Object} deviceA_intf device A tunnel interface
 * @param  {Object} deviceB_intf device B tunnel interface
 * @param  {string} devBagentVer device B version
 * @return {[{entity: string, message: string, params: Object}]} an array of tunnel-add jobs
 */
const prepareTunnelRemoveJob = (tunnelnum, deviceA_intf, deviceB_intf) => {
    // Generate from the tunnel num: IP A/B, MAC A/B, SA A/B
    const tunnelParams = generateTunnelParams(tunnelnum);

    const tasksDeviceA = [];
    const tasksDeviceB = [];
    const paramsDeviceA = {};
    const paramsDeviceB = {};

    paramsDeviceA['src'] = deviceA_intf.IPv4;
    paramsDeviceA['dst'] = ((deviceB_intf.PublicIP === "")? deviceB_intf.IPv4 : deviceB_intf.PublicIP);
    paramsDeviceA['tunnel-id'] = tunnelnum;
    paramsDeviceA['loopback-iface'] = {
        "addr": tunnelParams.ip1 + "/31",
        "mac": tunnelParams.mac1
    }

    paramsDeviceB['src'] = deviceB_intf.IPv4;
    paramsDeviceB['dst'] = ((deviceA_intf.PublicIP === "")? deviceA_intf.IPv4 : deviceA_intf.PublicIP);
    paramsDeviceB['tunnel-id'] = tunnelnum;
    paramsDeviceB['loopback-iface'] = {
        "addr": tunnelParams.ip2 + "/31",
        "mac": tunnelParams.mac2
    }

    // Saving configuration for device A
    tasksDeviceA.push({"entity":"agent","message":"remove-tunnel","params":paramsDeviceA});

    // Saving configuration for device B
    tasksDeviceB.push({"entity":"agent","message":"remove-tunnel","params":paramsDeviceB});

    return [tasksDeviceA, tasksDeviceB];
};

/**
 * Calls the necessary APIs for deleting a single tunnel
 * @param  {string}   user         user id of requesting user
 * @param  {string}   org          id of the organization of the user
 * @param  {number}   tunnelnum    id of the tunnel to be added
 * @param  {Object}   deviceA      details of device A
 * @param  {Object}   deviceB      details of device B
 * @param  {Object}   deviceA_intf device A tunnel interface
 * @param  {Object}   deviceB_intf device B tunnel interface
 * @param  {Callback} next         express next() callback
 * @return {void}
 */
const delTunnel = async (user, org, tunnelnum, deviceA, deviceB, deviceA_intf, deviceB_intf, next) => {
    const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(tunnelnum, deviceA_intf, deviceB_intf);
    try {
        await queueTunnel(false, "Delete tunnel between (" + deviceA.hostname + "," + deviceA_intf.name +
            ") and (" + deviceB.hostname + "," + deviceB_intf.name + ")",
            tasksDeviceA, tasksDeviceB, user, org, deviceA.machineId, deviceB.machineId,
            deviceA._id, deviceB._id);
    } catch(err) {
        logger.error("Delete tunnel error", {params: {reason: err.message}});
        return next(createError(500, err.message));
    }
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

    const d2h = (d) => (("00"+(+d).toString(16)).substr(-2));

    const h = (tunnelNum % 127 + 1) *2;
    const l = Math.floor(tunnelNum / 127);
    const ip1 = "10.100." + (+l).toString(10) + "." + (+h).toString(10);
    const ip2 = "10.100." + (+l).toString(10) + "." + (+(h+1)).toString(10);
    mac1 = "02:00:27:fd:" + d2h(l) + ":" + d2h(h);
    mac2 = "02:00:27:fd:" + d2h(l) + ":" + d2h(h+1);
    sa1 = (l*256 + h);
    sa2 = (l*256 + h + 1);

    return {
        'ip1':ip1,
        'ip2':ip2,
        'mac1':mac1,
        'mac2':mac2,
        'sa1':sa1,
        'sa2':sa2
    };
};
/**
 * Generates random keys that will be used for tunnels creation
 * @return {{key1: number, key2: number, key3: number, key4: number}}
 */
const generateRandomKeys = () => {
    return {
        'key1':randomNum(32, 16),
        'key2':randomNum(32, 16),
        'key3':randomNum(32, 16),
        'key4':randomNum(32, 16)
    };
};


module.exports = {
    apply: {
        applyTunnelAdd:applyTunnelAdd,
        applyTunnelDel:applyTunnelDel
    },
    complete: {
        completeTunnelAdd:completeTunnelAdd,
        completeTunnelDel:completeTunnelDel
    },
    error: {
        errorTunnelAdd:errorTunnelAdd
    },
    prepareTunnelRemoveJob: prepareTunnelRemoveJob,
    prepareTunnelAddJob: prepareTunnelAddJob,
    queueTunnel: queueTunnel,
    queueTunnelJob: queueTunnelJob
};