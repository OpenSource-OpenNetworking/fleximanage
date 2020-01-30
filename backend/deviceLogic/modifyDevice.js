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

const configs = require('../configs')();
const deviceQueues = require('../utils/deviceQueue')(configs.get('kuePrefix'),configs.get('redisUrl'));
const {
    prepareTunnelRemoveJob,
    prepareTunnelAddJob,
    queueTunnel
} = require("../deviceLogic/tunnels");
const { validateModifyDeviceMsg } = require('./validators');
const tunnelsModel = require('../models/tunnels');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({module: module.filename, type: 'req'});
const has = require('lodash/has');
const omit = require('lodash/omit');
const differenceWith = require('lodash/differenceWith');
const pullAllWith = require('lodash/pullAllWith');
const isEqual = require('lodash/isEqual');
/**
 * Remove fields that should not be sent to the device from the interfaces array.
 * @param  {Array} interfaces an array of interfaces that will be sent to the device
 * @return {Array}            the same array after removing unnecessary fields
 */
const prepareIfcParams = (interfaces) => {
    return interfaces.map(ifc => {
        return omit(ifc, ["_id", "PublicIP", "isAssigned"]);
    });
};
/**
 * Queues a modify-device job to the device queue.
 * @param  {string}  org                   the organization to which the user belongs
 * @param  {string}  user                  the user that requested the job
 * @param  {Array}   tasks                 the message to be sent to the device
 * @param  {Object}  device                the device to which the job should be queued
 * @param  {Array}   removedTunnelsList=[] tunnels that have been removed as part of the device modification
 * @return {Promise}                       a promise for queuing a job
 */
const queueJob = (org, user, tasks, device, removedTunnelsList = []) => {
    return new Promise(async (resolve, reject) => {
        try {
            const job = await deviceQueues.addJob(
              device.machineId, user, org,
              // Data
              { title: `Modify device ${device.hostname}`, tasks: tasks },
              // Response data
              {
                method: "modify",
                data: { device: device._id, org: org, user: user, origDevice: device, tunnels: removedTunnelsList }
              },
              // Metadata
              { priority: "medium", attempts: 2, removeOnComplete: false },
              // Complete callback
              null,
            );

            logger.info("Modify device job queued", {params: {job: job}});
            resolve(job.id);
        } catch (err) {
            reject(err);
        }
    });
};
/**
 * Performs required tasks before device modification
 * can take place. It removes all tunnels connected to
 * the modified interfaces and then queues the modify device job.
 * @param  {Object}  device        original device object, before the changes
 * @param  {Object}  messageParams device changes that will be sent to the device
 * @param  {string}  user          the user that created the request
 * @param  {string}  org           organization to which the user belongs
 * @return {Promise}               a promise for queuing a modify-device job
 */
const queueModifyDeviceJob = (device, messageParams, user, org) => {
    return new Promise(async(resolve, reject) => {
        const removedTunnels = [];
        const interfacesIdsSet = new Set();
        const modifiedIfcsSet = new Set();
        messageParams.reconnect = false;

        // Changes in the interfaces require reconstruction of all tunnels
        // connected to these interfaces (since the tunnels parameters change).
        // Maintain all interfaces that have changed in a set that will
        // be used later to find all the tunnels that should be reconstructed.
        // We use a set, since multiple changes can be done in a single modify-device
        // message, hence the interface might appear in both modify-router and
        // modify-interfaces objects, and we want to remove the tunnel only once.
        if(has(messageParams, 'modify_router')) {
            const { assign, unassign } = messageParams.modify_router;
            (assign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
            (unassign || []).forEach(ifc => { interfacesIdsSet.add(ifc._id); });
        }
        if(has(messageParams, 'modify_interfaces')) {
            const { interfaces } = messageParams.modify_interfaces;
            interfaces.forEach(ifc => {
                interfacesIdsSet.add(ifc._id);
                modifiedIfcsSet.add(ifc._id);
            });
        }

        try {
            for(const ifc of interfacesIdsSet) {
                // First, remove all active tunnels connected
                // via this interface, on all relevant devices.
                const tunnels = await tunnelsModel
                    .find({
                        'isActive':true,
                        $or: [{ interfaceA: ifc._id }, { interfaceB: ifc._id }]
                    })
                    .populate("deviceA")
                    .populate("deviceB");

                for(const tunnel of tunnels) {
                    let { deviceA, deviceB } = tunnel;

                    // Since the interface changes have already been updated in the database
                    // we have to use the original device for creating the tunnel-remove message.
                    if (deviceA._id.toString() == device._id.toString()) deviceA = device;
                    else deviceB = device;

                    const ifcA = deviceA.interfaces.find(ifc => {
                        return ifc._id == tunnel.interfaceA.toString();
                    });
                    const ifcB = deviceB.interfaces.find(ifc => {
                        return ifc._id == tunnel.interfaceB.toString();
                    });

                    const [tasksDeviceA, tasksDeviceB] = prepareTunnelRemoveJob(tunnel.num, ifcA, ifcB);
                    await queueTunnel(
                        false,
                        `Delete tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
                        tasksDeviceA,
                        tasksDeviceB,
                        user,
                        org,
                        deviceA.machineId,
                        deviceB.machineId,
                        deviceA._id,
                        deviceB._id
                    );
                    // Maintain a list of all removed tunnels for adding them back
                    // after the interface changes are applied on the device.
                    // Add the tunnel to this list only if the interface connected
                    // to this tunnel has changed any property except for 'isAssigned'
                    if(modifiedIfcsSet.has(ifc._id)) removedTunnels.push(tunnel._id);
                }
            }
            // Prepare and queue device modification job
            if(has(messageParams, 'modify_router.assign')) {
                messageParams.modify_router.assign = prepareIfcParams(messageParams.modify_router.assign);
                messageParams.reconnect = true;
            }
            if(has(messageParams, 'modify_router.unassign')) {
                messageParams.modify_router.unassign = prepareIfcParams(messageParams.modify_router.unassign);
                messageParams.reconnect = true;
            }
            if(has(messageParams, 'modify_interfaces')) {
                messageParams.modify_interfaces.interfaces = prepareIfcParams(messageParams.modify_interfaces.interfaces);
                messageParams.reconnect = true;
            }
            const tasks = [{ entity: "agent", message: "modify-device", params: messageParams }];

            const jobId = await queueJob(org, user, tasks, device, removedTunnels);
            resolve(jobId);
        } catch (err) {
            reject(err);
        }
    });
};
/**
 * Reconstructs tunnels that were removed before
 * sending a modify-device message to a device.
 * @param  {Array}   removedTunnels an array of ids of the removed tunnels
 * @param  {string}  org            the organization to which the tunnels belong
 * @param  {string}  user           the user that requested the device change
 * @return {Promise}                a promise for reconstructing tunnels
 */
const reconstructTunnels = (removedTunnels, org, user) => {
    return new Promise(async(resolve, reject) => {
        try {
            const tunnels = await tunnelsModel
                .find({ _id: { $in: removedTunnels }, 'isActive':true })
                .populate("deviceA")
                .populate("deviceB");

            for(const tunnel of tunnels) {
                const { deviceA, deviceB } = tunnel;
                const ifcA = deviceA.interfaces.find(ifc => {
                    return ifc._id == tunnel.interfaceA.toString();
                });
                const ifcB = deviceB.interfaces.find(ifc => {
                    return ifc._id == tunnel.interfaceB.toString();
                });

                const { agent } = deviceB.versions;
                const [tasksDeviceA, tasksDeviceB] = prepareTunnelAddJob(tunnel.num, ifcA, ifcB, agent);
                await queueTunnel(
                    true,
                    `Add tunnel between (${deviceA.hostname}, ${ifcA.name}) and (${deviceB.hostname}, ${ifcB.name})`,
                    tasksDeviceA,
                    tasksDeviceB,
                    user,
                    org,
                    deviceA.machineId,
                    deviceB.machineId,
                    deviceA._id,
                    deviceB._id
                );
            }
            resolve();
        } catch (err) {
            reject(err);
        }
    });
};
/**
 * Sets the job pending flag value. This flag is used to indicate
 * there's a pending modify-device job in the queue to prevent
 * queuing additional modify-device jobs.
 * @param  {string}  deviceID the id of the device
 * @param  {string}  org      the organization the device belongs to
 * @param  {boolean} flag     the value of the flag
 * @return {Promise}          a promise for updating the flab in the database
 */
const setJobPendingInDB = (deviceID, org, flag) => {
    return new Promise(async(resolve, reject) => {
        try {
            await devices.update(
                { _id: deviceID, org: org },
                { $set: { "pendingDevModification.jobPending": flag } },
                { upsert: false }
            );
        } catch (err) {
            return reject(err);
        }
        return resolve();
    });
};
/**
 * Sets the pending job ID in the database
 * @param  {string}  deviceID the id of the device
 * @param  {string}  org      the organization the device belongs to
 * @param  {string}  jobId    the id of the job
 * @return {Promise}          a promise for updating the job ID in the database
 */
const setJobIdInDB = (deviceID, org, jobId) => {
    return new Promise(async(resolve, reject) => {
        try {
            await devices.update(
                { _id: deviceID, org: org },
                { $set: { "pendingDevModification.jobId": jobId } },
                { upsert: false }
            );
        } catch (err) {
            return reject(err);
        }
        return resolve();
    });
};
/**
 * Reverts the device changes in the database. Since
 * modify-device jobs are sent after the changes had
 * already been updated in the database, the changes
 * must be reverted if the job failed to be sent/
 * processed by the device.
 * @param  {Object}  origDevice device object before changes in the database
 * @return {Promise}            a promise for reverting the changes in the database
 */
const rollBackDeviceChanges = (origDevice) => {
    return new Promise(async(resolve, reject) => {
        try {
            const { _id, org } = origDevice;
            const result = await devices.update(
                { _id: _id, org: org },
                { $set: {
                        "defaultRoute": origDevice.defaultRoute,
                        "interfaces": origDevice.interfaces
                    }
                },
                { upsert: false }
            );
            if(result.nModified !== 1) return reject(result);
        } catch (err) {
            return reject(err);
        }
        return resolve();
    });
};

/**
 * Creates a modify-routes object
 * @param  {Object} origDevice device object before changes in the database
 * @param  {Object} newDevice  device object after changes in the database
 * @return {Object}            an object containing an array of routes
 */
const prepareModifyRoutes = (origDevice, newDevice) => {
    // Handle changes in default route
    const routes = [];
    if(origDevice.defaultRoute !== newDevice.defaultRoute) {
        routes.push({
            addr: "default",
            old_route: origDevice.defaultRoute,
            new_route: newDevice.defaultRoute
        })
    }

    // Handle changes in static routes
    // Extract only relevant fields from static routes database entries
    const [newStaticRoutes, origStaticRoutes] = [
        newDevice.staticroutes.map(route => { return ({
            destination: route.destination,
            gateway: route.gateway,
            ifname: route.ifname
        });}),

        origDevice.staticroutes.map(route => { return ({
            destination: route.destination,
            gateway: route.gateway,
            ifname: route.ifname
        });})
    ];

    // Compare new and original static routes arrays.
    // Add all static routes that do not exist in the
    // original routes array and remove all static routes
    // that do not appear in the new routes array
    const [routesToAdd, routesToRemove] = [
        differenceWith(
            newStaticRoutes,
            origStaticRoutes,
            (origRoute, newRoute) => {
                return isEqual(origRoute, newRoute);
            }
        ),
        differenceWith(
            origStaticRoutes,
            newStaticRoutes,
            (origRoute, newRoute) => {
                return isEqual(origRoute, newRoute);
            }
        )
    ]

    routesToRemove.forEach(route => {
        routes.push({
            addr: route.destination,
            old_route: route.gateway,
            new_route: '',
            pci: route.ifname ? route.ifname : undefined
        })
    })
    routesToAdd.forEach(route => {
        routes.push({
            addr: route.destination,
            new_route: route.gateway,
            old_route: '',
            pci: route.ifname ? route.ifname : undefined
        })
    })

    return { routes: routes };
}

/**
 * Creates and queues the modify-device job. It compares
 * the current view of the device in the database with
 * the former view to deduce which fields have change.
 * it then creates an object with the changes and calls
 * queueModifyDeviceJob() to queue the job to the device.
 * @async
 * @param  {Array}    device an array of the devices to be modified
 * @param  {Object}   req    express request object
 * @param  {Object}   res    express response object
 * @param  {Callback} next   express next() callback
 * @param  {Object}   data   data specific to the modify-device apply method
 * @return {Promise}         a promise for applying modify-device request
 */
const apply = async(device, req, res, next, data) => {
    return new Promise(async (resolve, reject) => {
        const user = req.user.username;
        const org = req.user.defaultOrg._id.toString();
        const modifyParams = {};

        // Create the default route modification parameters
        const modify_routes = prepareModifyRoutes(device[0], data.newDevice);
        if (modify_routes.routes.length > 0) modifyParams.modify_routes = modify_routes;

        // Create interfaces modification parameters
        // Compare the array of interfaces, and return
        // an array of the interfaces that have changed
        // First, extract only the relevant interface fields
        const [origInterfaces, origIsAssigned] = [
            device[0].interfaces.map(ifc => { return ({
                _id: ifc._id,
                pci: ifc.pciaddr,
                addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
                addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
                PublicIP: ifc.PublicIP,
                routing: ifc.routing,
                type: ifc.type,
                isAssigned: ifc.isAssigned,
            });}),
            device[0].interfaces.map(ifc => { return ({
                _id: ifc._id,
                pci: ifc.pciaddr,
                isAssigned: ifc.isAssigned,
            });})
        ];

        const [newInterfaces, newIsAssigned] = [
            data.newDevice.interfaces.map(ifc => { return ({
                _id: ifc._id,
                pci: ifc.pciaddr,
                addr: ifc.IPv4 && ifc.IPv4Mask ? `${ifc.IPv4}/${ifc.IPv4Mask}` : '',
                addr6: ifc.IPv6 && ifc.IPv6Mask ? `${ifc.IPv6}/${ifc.IPv6Mask}` : '',
                PublicIP: ifc.PublicIP,
                routing: ifc.routing,
                type: ifc.type,
                isAssigned: ifc.isAssigned,
            });}),

            data.newDevice.interfaces.map(ifc => { return ({
                _id: ifc._id,
                pci: ifc.pciaddr,
                isAssigned: ifc.isAssigned,
            });})
        ];

        // Handle changes in the 'assigned' field. assignedDiff will contain
        // all the interfaces that have changed their 'isAssigned' field
        const assignedDiff = differenceWith(
            newIsAssigned,
            origIsAssigned,
            (origIfc, newIfc) => {
                return isEqual(origIfc, newIfc);
            }
        );

        if(assignedDiff.length > 0) {
            modifyParams.modify_router = {};
            const toAssign = [];
            const toUnAssign = [];
            // Split interfaces into two arrays: one for the interfaces that
            // are about to become assigned, and one for those which will be
            // unassigned. Add the full interface details as well.
            assignedDiff.forEach(ifc => {
                const ifcInfo = newInterfaces.find(interface => {
                    return interface._id === ifc._id;
                });

                if(ifc.isAssigned) toAssign.push(ifcInfo);
                else toUnAssign.push(ifcInfo);

                // Interfaces that changed their assignment status
                // are not allowed to change. We remove them from
                // the list to avoid change in assignment and modification
                // in the same message.
                pullAllWith(newInterfaces, [ifcInfo], isEqual);

            });
            if(toAssign.length) modifyParams.modify_router.assign = toAssign;
            if(toUnAssign.length) modifyParams.modify_router.unassign = toUnAssign;
        }

        // Handle changes in interface fields other than 'isAssigned'
        let interfacesDiff = differenceWith(
            newInterfaces,
            origInterfaces,
            (origIfc, newIfc) => {
                return isEqual(origIfc, newIfc);
            }
        );

        // Changes made to unassigned interfaces should be
        // stored in the MGMT, but should not reach the device.
        interfacesDiff = interfacesDiff.filter(ifc => {
            return ifc.isAssigned === true;
        });
        if(interfacesDiff.length > 0) {
            modifyParams.modify_interfaces = {};
            modifyParams.modify_interfaces.interfaces = interfacesDiff;
        }

        const shouldQueueJob =
            has(modifyParams, "modify_routes") ||
            has(modifyParams, "modify_router") ||
            has(modifyParams, "modify_interfaces");
        let jobId;
        try {
            // Queue job only if the device has changed
            if(shouldQueueJob) {
                // First, go over assigned and modified
                // interfaces and make sure they are valid
                const assign = has(modifyParams, "modify_router.assign") ? modifyParams.modify_router.assign : [];
                const modified = has(modifyParams, "modify_interfaces") ? modifyParams.modify_interfaces.interfaces : [];
                const interfaces = [...assign, ...modified];
                const { valid, err } = validateModifyDeviceMsg(interfaces);
                if (!valid) {
                    // Rollback device changes in database and return error
                    await rollBackDeviceChanges(device[0]);
                    return reject(new Error(err));
                }
                await setJobPendingInDB(device[0]._id, org, true);
                jobId = await queueModifyDeviceJob(device[0], modifyParams, user, org);
                await setJobIdInDB(device[0]._id, org, jobId);
            }
            // Set the 'Location' header in the response header
            res.set('Location', `api/devices/${device[0]._id}/jobs/${jobId}`)
            data.newDevice.pendingDevModification.jobId = jobId;
            return resolve({ jobQueued: shouldQueueJob });
        } catch (err) {
            logger.error("Failed to queue modify device job", {
                params: { err: err.message, device: device[0]._id }
            });
            try {
                await setJobPendingInDB(device[0]._id, org, false);
                await setJobIdInDB(device[0]._id, org, null);
            } catch (err) {
                logger.error("Failed to set job pending flag in db", {
                    params: { err: err.message, device: device[0]._id }
                });
            }
            return reject(new Error('Internal server error'));
        }
    });
};

/**
 * Called when modify device job completed.
 * In charge of reconstructing the tunnels.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {Object} res   job result
 * @return {void}
 */
const complete = async(jobId, res) => {
    if (!res) {
        logger.warn('Got an invalid job result', {params: {res: res, jobId: jobId}});
        return;
    }
    logger.info("Device modification complete", {params: {result: res, jobId: jobId}});
    try {
        await reconstructTunnels(res.tunnels, res.org, res.user);
    } catch (err) {
        logger.error("Tunnel reconstruction failed", {
            params: { jobId: jobId, res: res, err: err.message }
        });
    }
    try {
        await setJobPendingInDB(res.device, res.org, false);
        await setJobIdInDB(res.device, res.org, null);
    } catch (err) {
        logger.error("Failed to set job pending flag in db", {
            params: { err: err.message, jobId: jobId, res: res }
        });
    }
};

/**
 * Called when modify-device job is removed either
 * by user or due to expiration. This method should run
 * only for tasks that were deleted before completion
 * @async
 * @param  {Object} job Kue job
 * @return {void}
 */
const remove = async (job) => {
    // We rollback changes only for pending jobs, as
    // non-pending jobs are covered by the complete callback
    if(['inactive', 'delayed', 'active', 'failed'].includes(job._state)) {
        logger.info('Rolling back device changes for removed task', {params: {job: job}});
        const { org, origDevice } = job.data.response.data;
        try {
            await rollBackDeviceChanges(origDevice);
        } catch (err) {
            logger.error("Device change rollback failed", {
                params: { job: job, err: err.message }
            });
            throw(err);
        }
        try {
            await setJobPendingInDB(origDevice, org, false);
            await setJobIdInDB(origDevice, org, null);
        } catch (err) {
            logger.error("Failed to set job pending flag in db", {
                params: { err: err.message, job: job }
            });
            throw(err);
        }
    }
};

module.exports = {
    apply: apply,
    complete: complete,
    remove: remove,
};
