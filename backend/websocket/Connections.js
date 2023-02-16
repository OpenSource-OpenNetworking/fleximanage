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
const Joi = require('joi');
const Devices = require('./Devices');
const modifyDeviceDispatcher = require('../deviceLogic/modifyDevice');
const DeviceEvents = require('../deviceLogic/events');
const createError = require('http-errors');
const orgModel = require('../models/organizations');
const { devices } = require('../models/devices');
const Accounts = require('../models/accounts');
const tunnelsModel = require('../models/tunnels');
const logger = require('../logging/logging')({ module: module.filename, type: 'websocket' });
const notificationsMgr = require('../notifications/notifications')();
const { verifyAgentVersion, isSemVer, isVppVersion, getMajorVersion } = require('../versioning');
const { getRenewBeforeExpireTime, queueCreateIKEv2Jobs } = require('../deviceLogic/IKEv2');
const { TypedError, ErrorTypes } = require('../utils/errors');
const roleSelector = require('../utils/roleSelector')(configs.get('redisUrl'));
const { reconfigErrorsLimiter } = require('../limiters/reconfigErrors');
const getRandom = require('../utils/random-key');
const { getCpuInfo } = require('../utils/deviceUtils');
const jobService = require('../services/JobsService');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);

class Connections {
  constructor () {
    this.createConnection = this.createConnection.bind(this);
    this.closeConnection = this.closeConnection.bind(this);
    this.verifyDevice = this.verifyDevice.bind(this);
    this.deviceDisconnect = this.deviceDisconnect.bind(this);
    this.deviceSendMessage = this.deviceSendMessage.bind(this);
    this.isConnected = this.isConnected.bind(this);
    this.getAllDevices = this.getAllDevices.bind(this);
    this.registerConnectCallback = this.registerConnectCallback.bind(this);
    this.unregisterConnectCallback = this.unregisterConnectCallback.bind(this);
    this.registerCloseCallback = this.registerCloseCallback.bind(this);
    this.unregisterCloseCallback = this.unregisterCloseCallback.bind(this);
    this.callRegisteredCallbacks = this.callRegisteredCallbacks.bind(this);
    this.sendDeviceInfoMsg = this.sendDeviceInfoMsg.bind(this);
    this.pingCheck = this.pingCheck.bind(this);

    this.devices = new Devices();
    this.msgSeq = 0;
    this.msgQueue = {};
    this.connectCallbacks = {}; // Callback functions to be called on connect
    this.closeCallbacks = {}; // Callback functions to be called on close

    // Ping each client every 30 sec, with two retries
    this.ping_interval = setInterval(this.pingCheck, 20000);
  }

  /**
   * Checks websocket status for all connected devices.
   * The function iterates the connected devices and sends
   * a ping request for each of them.
   * @return {void}
   */
  pingCheck () {
    this.getAllDevices().forEach(deviceID => {
      const { socket } = this.devices.getDeviceInfo(deviceID);
      // Don't try to ping a closing, or already closed socket
      if (!socket) return;
      if ([socket.CLOSING, socket.CLOSED].includes(socket.readyState)) {
        this.closeConnection(deviceID);
        return;
      }
      if (socket.isAlive <= 0) {
        logger.warn('Terminating device due to ping failure', {
          params: { deviceId: deviceID }
        });
        return socket.terminate();
      }
      // Decrement is Alive, if after few retries it reaches zero,
      // ping fails and we terminate connection
      socket.isAlive -= 1;
      socket.ping();
    });
  }

  /**
   * Registers a callback function for a module that
   * will be called when a device connects to the MGMT.
   * @param  {string}   name     the name of the module that registers the callback
   * @param  {Callback} callback the callback to be registered
   * @return {void}
   */
  registerConnectCallback (name, callback) {
    this.connectCallbacks[name] = callback;
  }

  /**
   * Removes a previously registered connect callback function.
   * @param  {string} name the name of the module that registers the callback
   * @return {void}
   */
  unregisterConnectCallback (name) {
    delete this.connectCallbacks[name];
  }

  /**
   * Registers a callback function for a module that
   * will be called when a device disconnects from the MGMT.
   * @param  {string}   name     the name of the module that registers the callback
   * @param  {Callback} callback the callback to be registered
   * @return {void}
   */
  registerCloseCallback (name, callback) {
    this.closeCallbacks[name] = callback;
  }

  /**
   * Removes a previously registered close callback function.
   * @param  {string} name the name of the module that registers the callback
   * @return {void}
   */
  unregisterCloseCallback (name) {
    delete this.closeCallbacks[name];
  }

  /**
   * Calls all registered callback for the provided type of callback
   * @param  {Object} cbObj  the callback object (connect/disconnect callbacks)
   * @param  {string} device the machine id of the device
   * @return {void}
   */
  callRegisteredCallbacks (cbObj, device) {
    Object.keys(cbObj).forEach(name => {
      cbObj[name](device);
    });
  }

  /**
   * Verifies the query parameters section of a url.
   * The main purpose of this method is to protect
   * against HTTP pollution attacks.
   * @param  {Array}   queryParams the array of query parameters of some url
   * @return {boolean} true if the url params are valid, false otherwise
   */
  checkUrlQueryParams (queryParams) {
    // Search for duplicate parameters in the query. If
    // getAll() returns an array with multiple elements,
    // it means the parameter appeared more than once in
    // the query string, which is considered invalid.
    for (const name of queryParams.keys()) {
      if (queryParams.getAll(name).length > 1) return false;
    }
    return true;
  }

  /**
   * Verifies a device before creating the websocket connection.
   * This is a callback method that is called by the websocket
   * as part of the websocket protocol handshake process.
   * @param  {Object}   info information about the websocket connect request
   * @param  {Callback} done a callback used to signal the results to the websocket
   * @return {void}
   */
  async verifyDevice (info, done) {
    const connectionURL = new URL(`${info.req.headers.origin}${info.req.url}`);
    const ip =
      info.req.headers['x-forwarded-for'] || info.req.connection.remoteAddress;
    logger.info('Device connection opened', {
      params: {
        ip: ip,
        deviceId: connectionURL ? connectionURL.pathname : '',
        headers: info.req.headers
      }
    });

    if (
      !connectionURL ||
      !connectionURL.pathname ||
      !connectionURL.pathname.substr(1) ||
      !connectionURL.searchParams ||
      !this.checkUrlQueryParams(connectionURL.searchParams) ||
      !connectionURL.searchParams.get('token')
    ) {
      logger.warn('Device verification failed', {
        params: {
          origin: info.origin,
          deviceId: connectionURL ? connectionURL.pathname : ''
        }
      });
      return done(false, 400);
    }

    // Verify agent version compatibility
    if (!info.req.headers['user-agent']) {
      logger.warn('Received connection request without user-agent field', {
        params: { deviceId: connectionURL.pathname }
      });
      return done(false, 400);
    }

    const agentVersion = info.req.headers['user-agent'].split('/')[1];
    const { valid, err } = verifyAgentVersion(agentVersion);
    if (!valid) {
      logger.warn('Agent version verification failed', {
        params: { deviceId: connectionURL.pathname, err: err }
      });
      return done(false, 400);
    }

    const device = connectionURL.pathname.substr(1);

    devices
      .find({
        machineId: device,
        deviceToken: connectionURL.searchParams.get('token')
      })
      .then(
        async resp => {
          if (resp.length === 1) {
            // exactly one token found
            // Check if device approved
            if (resp[0].isApproved) {
              // If there's already an open connection for the device, close
              // it before opening the new one. Remove all listeners on the
              // 'socket close' event, to prevent calling the registered callbacks.
              // This might happen if the device opens a new connection before the
              // MGMT had the chance to close the current one (for example, when a
              // device changes the IP address of the interface connected to the MGMT).
              const devInfo = this.devices.getDeviceInfo(device);
              if (devInfo && devInfo.ready === true && devInfo.socket) {
                logger.info('Closing device old connection', {
                  params: { device: device }
                });
                devInfo.socket.removeAllListeners('close');
                devInfo.socket.terminate();
              }

              // Validate account subscription
              const checkCancledSubscription = await Accounts.countDocuments(
                { _id: resp[0].account, isSubscriptionValid: false }
              );
              if (checkCancledSubscription > 0) {
                throw createError(402, 'Your subscription is canceled');
              }

              this.devices.setDeviceInfo(device, {
                org: resp[0].org.toString(),
                deviceObj: resp[0]._id,
                machineId: resp[0].machineId,
                version: resp[0].versions.agent,
                ready: false,
                running: devInfo ? devInfo.running : null
              });
              return done(true);
            } else {
              throw createError(403, 'Device found but not approved yet');
            }
          } else if (resp.length === 0) {
            throw createError(404, 'Device not found');
          } else {
            throw createError(500, 'General error');
          }
        },
        err => {
          throw err;
        }
      )
      .catch(err => {
        // Log unapproved devices in debug level only
        if (err.status !== 403) {
          logger.warn('Device connection failed', {
            params: {
              deviceId: connectionURL.pathname,
              err: err.message,
              status: err.status
            }
          });
        } else {
          logger.debug('Device connection failed', {
            params: {
              deviceId: connectionURL.pathname,
              err: err.message,
              status: err.status
            }
          });
        }
        return done(false, err.status);
      });
  }

  /**
   * A callback function called by the websocket
   * module when a new connection is opened.
   * @param  {Object} socket the connection's socket
   * @param  {Object} req    the http GET request sent by the device
   * @return {void}
   */
  createConnection (socket, req) {
    const connectionURL = new URL(`${req.headers.origin}${req.url}`);
    const device = connectionURL.pathname.substr(1);
    const info = this.devices.getDeviceInfo(device);

    // Set the received socket into the device info
    info.socket = socket;
    const msgQ = this.msgQueue;

    // Initialize to alive connection, with 3 retries
    socket.isAlive = 7;
    socket.on('pong', function heartbeat () {
      // Pong received, reset retries
      socket.isAlive = 7;
    });

    socket.on('message', function incoming (message) {
      // Extract the seq from the message
      const jsonmsg = JSON.parse(message);
      const seq = jsonmsg.seq;
      const msg = jsonmsg.msg;

      if (
        seq !== undefined &&
        msgQ[seq] !== undefined &&
        typeof msgQ[seq].resolver === 'function'
      ) {
        // Only validate device's response if the device processed the message
        // successfully, to prevent validation errors due to the mismatch
        // between the message schema and the error returned by the device
        const { valid, err } = msg.ok
          ? msgQ[seq].validator(msg.message)
          : { valid: true, err: '' };

        if (!valid) {
          const validatorName = msgQ[seq].validator.name;
          const content = JSON.stringify(msg.message);
          msgQ[seq].rejecter(
            new Error(
              `message validation failed: ${err}. validator=${validatorName}, msg=${content}`
            )
          );
        } else {
          msgQ[seq].resolver(msg);
        }

        // Remove timeout and Delete message queue entry for this seq
        clearTimeout(msgQ[seq].tohandle);
        delete msgQ[seq];
      }
    });

    socket.on('error', err => {
      logger.error('Websocket error', {
        params: {
          err: err.message
        }
      });
    });
    socket.on('close', () => this.closeConnection(device));

    // Query device for additional required information (such as
    // device version, network information, tunnel keys, etc.)
    // Only after getting the device's response and updating
    // the information, the device can be considered ready.
    this.sendDeviceInfoMsg(device, info.deviceObj, info.org, true);
  }

  /**
   * Gets the tunnel numbers of all tunnels that don't have
   * the information about the tunnels keys in the database.
   * @async
   * @param  {string} deviceId The mongodb id of the device
   * @return {Array}           An array of tunnels numbers of the tunnels
   *                           that require keys information from the device
   */
  async getTunnelsWithEmptyKeys (deviceId) {
    // Retrieve all device's tunnels that
    // don't have tunnel parameters
    const result = await tunnelsModel.find({
      $and: [
        { $or: [{ deviceA: deviceId }, { deviceB: deviceId }] },
        { isActive: true },
        { encryptionMethod: 'psk' },
        {
          $or: [
            { tunnelKeys: { $exists: false } },
            { tunnelKeys: null }
          ]
        }
      ]
    });
    return result.map(tunnel => tunnel.num);
  }

  /**
   * Updates the keys for each of the tunnels sent by
   * the device in the management database
   * @async
   * @param  {Array} tunnels An array of tunnels information
   * @return {void}
   */
  async updateTunnelKeys (org, tunnels) {
    // Update all tunnels with the keys sent by the device
    const tunnelsOps = [];
    for (const tunnel of tunnels) {
      const { id, key1, key2, key3, key4 } = tunnel;
      tunnelsOps.push({
        updateOne:
          {
            filter: { org, num: id },
            update: { $set: { tunnelKeys: { key1, key2, key3, key4 } } },
            upsert: false
          }
      });
    }
    return tunnelsModel.bulkWrite(tunnelsOps);
  }

  /**
   * Checks if reconfig hash is changed on the device.
   * and applies new parameters if need
   * @async
   * @param  {Object} origDevice instance of the device from db
   * @param  {Object} deviceInfo data received on get-device-info message
   * @return {void}
   */
  async reconfigCheck (origDevice, deviceInfo) {
    const machineId = origDevice.machineId;
    const prevDeviceInfo = this.devices.getDeviceInfo(machineId);
    // Check if reconfig was changed
    if ((prevDeviceInfo === undefined) || (deviceInfo.message.reconfig &&
      prevDeviceInfo.reconfig !== deviceInfo.message.reconfig)) {
      const needReconfig = origDevice.interfaces && deviceInfo.message.network.interfaces &&
        deviceInfo.message.network.interfaces.length > 0;

      if (needReconfig) {
        // Currently we allow only one change at a time to the device,
        // to prevent inconsistencies between the device and the MGMT database.
        // Therefore, we block the request if there's a pending change in the queue.
        // The reconfig hash is not updated so it will try to process again in 10 sec
        if (origDevice.pendingDevModification) {
          throw new Error('Failed to apply new config, only one device change is allowed');
        }

        const incomingInterfaces = deviceInfo.message.network.interfaces;

        const interfaces = origDevice.interfaces.map(i => {
          const updatedConfig = incomingInterfaces.find(u => u.devId === i.devId);
          if (!updatedConfig) {
            logger.warn('Missing interface configuration in the get-device-info message', {
              params: {
                reconfig: deviceInfo.message.reconfig,
                machineId: machineId,
                interface: i.toJSON()
              }
            });
            return i;
          }

          // send a notification if the link changed to down
          if (updatedConfig.link === 'down' && i.linkStatus !== 'down') {
            const { org, deviceObj } = prevDeviceInfo;
            notificationsMgr.sendNotifications([
              {
                org: org,
                title: 'Link status changed',
                time: new Date(),
                device: deviceObj,
                machineId: machineId,
                details: `Link ${i.name} ${i.IPv4} is DOWN`
              }
            ]);
          }
          const updInterface = {
            ...i.toJSON(),
            PublicIP: updatedConfig.public_ip && i.useStun
              ? updatedConfig.public_ip : i.PublicIP,
            PublicPort: updatedConfig.public_port && i.useStun
              ? updatedConfig.public_port : i.PublicPort,
            NatType: updatedConfig.nat_type || i.NatType,
            internetAccess: updatedConfig.internetAccess === undefined ? ''
              : updatedConfig.link !== 'down' && updatedConfig.internetAccess ? 'yes' : 'no',
            linkStatus: updatedConfig.link,
            hasIpOnDevice: updatedConfig.IPv4 !== ''
          };

          // allow to modify the interface type dpdk/pppoe for unassigned interfaces
          if (!i.isAssigned && ['dpdk', 'pppoe'].includes(updatedConfig.deviceType)) {
            if (i.deviceType !== 'lte') { // don't allow to change LTE device type dynamically
              updInterface.deviceType = updatedConfig.deviceType;
            }
            updInterface.dhcp = updatedConfig.dhcp;
            if (updatedConfig.deviceType === 'pppoe') {
              updInterface.type = 'WAN';
              updInterface.routing = 'NONE';
            }
          }

          if (!i.isAssigned || i.deviceType === 'pppoe') {
            // if LTE unassigned and disabled, don't override metric. keep the auto metric
            if (i.deviceType !== 'lte' || i?.configuration?.enable) {
              updInterface.metric = updatedConfig.metric;
            }
            if (updatedConfig.mtu) {
              updInterface.mtu = updatedConfig.mtu;
            }
          };

          if (i.dhcp === 'yes' || !i.isAssigned || i.deviceType === 'pppoe') {
            updInterface.IPv4 = updatedConfig.IPv4;
            updInterface.IPv4Mask = updatedConfig.IPv4Mask;
            updInterface.IPv6 = updatedConfig.IPv6;
            updInterface.IPv6Mask = updatedConfig.IPv6Mask;
            updInterface.gateway = updatedConfig.gateway;
          };

          if (!i.isAssigned && updInterface.deviceType === 'dpdk') {
            // changing the type of an unassigned interface based on the gateway
            // Non dpdk interfaces are pppoe (WAN) or lte (WAN) or wifi (LAN),
            // these shouldn't be modified from the value set on registration
            updInterface.type = updInterface.gateway ? 'WAN' : 'LAN';
          }

          return updInterface;
        });

        const deviceId = origDevice._id.toString();

        try {
          // Update interfaces in DB
          await devices.findOneAndUpdate(
            { machineId },
            { $set: { interfaces } },
            { runValidators: true }
          );

          // We create a new instance of events class
          // to know changedDevice and changedTunnels
          let events = new DeviceEvents();

          const plainJsDevice = origDevice.toObject({ minimize: false });

          // add current device to changed devices in order to run modify process for it
          await events.addChangedDevice(origDevice._id, origDevice);

          await events.checkIfToTriggerEvent(plainJsDevice, interfaces);

          // Update the reconfig hash before applying to prevent infinite loop
          this.devices.updateDeviceInfo(machineId, 'reconfig', deviceInfo.message.reconfig);
          this.devices.updateDeviceInfo(machineId, 'version', deviceInfo.message.device);

          // Apply the new config and rebuild tunnels if need
          logger.info('Applying new configuration from the device', {
            params: {
              reconfig: deviceInfo.message.reconfig,
              machineId
            }
          });

          let addTunnelIds = Object.assign({},
            ...Array.from(events.activeTunnels, v => ({ [v]: '' })));
          let removeTunnelIds = Object.assign({},
            ...Array.from(events.pendingTunnels, v => ({ [v]: '' })));

          // modify jobs
          const modifyDevices = await events.prepareModifyDispatcherParameters();
          const completedTasks = {};

          for (const modified in modifyDevices) {
            const { tasks } = await modifyDeviceDispatcher.apply(
              [modifyDevices[modified].orig],
              { username: 'system' },
              {
                org: modifyDevices[modified].orig.org.toString(),
                newDevice: modifyDevices[modified].updated,
                sendAddTunnels: addTunnelIds,
                sendRemoveTunnels: removeTunnelIds,
                ignoreTasks: completedTasks[modifyDevices[modified].orig._id] ?? []
              }
            );

            // In case of tunnel between two devices (a and b) and static routes
            // in both devices via the tunnel.
            //
            // Once one of the interfaces loses his IP,
            // the events logic set the tunnel and all the routes (in both devices) to pending state
            // and we need to send jobs to both devices to remove the pending configurations.
            //
            // On the first iteration of this "modifyDevices" loop,
            // the modifyDevice detects that it needs to send remove tunnels and routes jobs
            // for both devices.
            //
            // So once we come to the second iteration of the loop,
            // we need to prevent job duplications and don't send remove tunnel and routes again.
            //
            // Hance, on every iteration, we save the sent jobs in a map object
            //  { deviceId: sentTasksArray }
            // And we pass the devices' sent jobs as a parameter. Then,
            // the modifyDevice logic knows to ignore those tasks.
            for (const deviceId in tasks) {
              if (!(deviceId in completedTasks)) {
                completedTasks[deviceId] = [];
              }
              completedTasks[deviceId].push(...tasks[deviceId]);
            }

            // send tunnel jobs only on the first iteration to prevent job duplications
            addTunnelIds = {};
            removeTunnelIds = {};
          }

          // remove the variable from the memory.
          events = null;
        } catch (err) {
          // if there are many errors in a row, we block the get-device-info loop
          const { allowed, blockedNow } = await reconfigErrorsLimiter.use(deviceId);
          if (!allowed && blockedNow) {
            logger.error('Reconfig errors rate-limit exceeded', { params: { deviceId } });

            await notificationsMgr.sendNotifications([{
              org: origDevice.org,
              title: 'Unsuccessful self-healing operations',
              time: new Date(),
              device: deviceId,
              machineId: machineId,
              details: 'Unsuccessful updating device data. Please contact flexiWAN support'
            }]);
          }

          logger.error('Failed to apply new configuration from device', {
            params: { device: machineId, err: err.message }
          });
        }
      }
    }
  }

  /**
   * Sends a get-info message to the device. The device
   * should reply with information regarding the software
   * versions of the different components running on it.
   * @async
   * @param  {string} machineId the device machine id
   * @param  {string} deviceId the device mongodb id
   * @param  {string} org the device organization id
   * @param  {boolean} isNewConnection flag to specify whether target device is a new connection
   * @return {void}
   */
  async sendDeviceInfoMsg (machineId, deviceId, org, isNewConnection = false) {
    const validateDevInfoMessage = msg => {
      const devInfoSchema = Joi.object().keys({
        device: Joi
          .string()
          .pattern(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/)
          .required(),
        components: Joi.object({
          agent: Joi.object()
            .keys({ version: Joi.string().required() })
            .required(),
          router: Joi.object()
            .keys({ version: Joi.string().required() })
            .required(),
          vpp: Joi.object()
            .keys({ version: Joi.string().required() })
            .required(),
          frr: Joi.object()
            .keys({ version: Joi.string().required() })
            .required(),
          edgeui: Joi.object()
            .keys({ version: Joi.string().required() })
            .optional()
        }),
        stats: Joi.object().optional(),
        network: Joi.object().optional(),
        tunnels: Joi.array().optional(),
        jobs: Joi.array().optional(),
        reconfig: Joi.string().allow('').optional(),
        ikev2: Joi.object({
          certificateExpiration: Joi.string().allow('').optional(),
          error: Joi.string().allow('').optional()
        }).allow({}).optional(),
        cpuInfo: Joi.object().optional()
      }).custom((obj, helpers) => {
        for (const [component, info] of Object.entries(
          obj.components
        )) {
          const ver = info.version;
          if (!(isSemVer(ver) || isVppVersion(ver))) {
            return helpers.message(`invalid ${component} version ${ver}`);
          }
        }
        return obj;
      });

      const result = devInfoSchema.validate(msg);
      if (result.error) {
        return { valid: false, err: result.error.details[0].message };
      }

      return { valid: true, err: '' };
    };

    try {
      const emptyTunnels = await this.getTunnelsWithEmptyKeys(deviceId);
      const message = { entity: 'agent', message: 'get-device-info', params: { tunnels: [] } };
      if (emptyTunnels.length > 0) {
        message.params.tunnels = emptyTunnels;
      }

      // Get the last 16 failed jobs from the jobs database. The number 16 is because devices
      // keep only the last 16 run jobs in their jobs database, so no point of
      // requesting more than that from the jobs database as well.
      const failedJobs = [];
      await deviceQueues.iterateJobsByOrg(org,
        'failed', (job) => {
          const { _id, error } = jobService.selectJobsParams(job);
          if (error?.errors?.[0]?.error === 'Send Timeout') {
            failedJobs.push(_id);
          }
          return true;
        }, 0, -1, 'desc', 0, 16, [{ key: 'type', op: '==', val: machineId }]
      );
      message.params.jobs = failedJobs;

      const deviceInfo = await this.deviceSendMessage(
        null,
        machineId,
        message,
        undefined,
        '',
        validateDevInfoMessage
      );

      logger.debug('Device info message sent', { params: { deviceId: deviceId } });
      if (!deviceInfo.ok) {
        throw new Error(`device reply: ${deviceInfo.message}`);
      }

      const versions = { device: deviceInfo.message.device };
      for (const [component, info] of Object.entries(
        deviceInfo.message.components
      )) {
        versions[component] = info.version;
      }

      const origDevice = await devices.findOne(
        { _id: deviceId }
      ).populate('interfaces.pathlabels', '_id name type');

      if (!origDevice) {
        logger.warn('Device not found in DB', {
          params: { device: machineId }
        });
        this.deviceDisconnect(machineId);
        return;
      }

      // when receiving cpuInfo from device, we need to keep the configured value
      const cpuInfo = getCpuInfo({
        ...deviceInfo.message.cpuInfo,
        configuredVppCores: origDevice.cpuInfo.configuredVppCores
      });
      origDevice.cpuInfo = cpuInfo;
      origDevice.versions = versions;
      await origDevice.save();

      const { expireTime, jobQueued } = origDevice.IKEv2;

      const { encryptionMethod } = await orgModel.findOne({ _id: origDevice.org });
      const { ikev2 } = deviceInfo.message;
      let needNewIKEv2Certificate = false;
      if (encryptionMethod === 'ikev2' && getMajorVersion(deviceInfo.message.device) >= 4) {
        if (!ikev2) {
          needNewIKEv2Certificate = true;
        } else if (ikev2.error) {
          logger.warn('IKEv2 certificate error on device', {
            params: { deviceId, err: ikev2.error }
          });
          needNewIKEv2Certificate = true;
        } else {
          const dbExpireTime = expireTime ? expireTime.getTime() : 0;
          const devExpireTime = (new Date(ikev2.certificateExpiration)).getTime();
          // check if expiration is different on agent and management
          // or certificate is about to expire
          if (devExpireTime !== dbExpireTime || dbExpireTime < getRenewBeforeExpireTime()) {
            needNewIKEv2Certificate = true;
          } else {
            this.devices.updateDeviceInfo(machineId, 'certificateExpiration', dbExpireTime);
          }
        }
      }

      if (needNewIKEv2Certificate && !jobQueued) {
        queueCreateIKEv2Jobs(
          [origDevice],
          'system',
          origDevice.org
        ).then(jobResults => {
          logger.info('Create a new IKEv2 certificate device job queued', {
            params: { job: jobResults[0] }
          });
        });
      }

      const { tunnels } = deviceInfo.message;
      if (Array.isArray(tunnels) && tunnels.length > 0) {
        await this.updateTunnelKeys(origDevice.org, tunnels);
      }

      const { jobs } = deviceInfo.message;
      if (jobs && Array.isArray(jobs)) {
        jobs.forEach(job => {
          deviceQueues.getJobById(job.job_id).then(jobToUpdate => {
            if (!jobToUpdate) {
              // This might happen, for example, when the job was deleted
              // in the interval between send device info request from the
              // management and the actual response from device.
              return;
            }
            logger.info('Updating job result received from device', {
              params: { deviceId: deviceId, job_id: job.job_id, state: job.state }
            });
            if (job.state === 'complete') {
              jobToUpdate.complete();
              jobToUpdate.error('');
              jobToUpdate.data.metadata.jobUpdated = true;
              jobToUpdate.save();
            }
            if (job?.errors?.length > 0) {
              jobToUpdate.error(JSON.stringify({ errors: job.errors }));
              jobToUpdate.data.metadata.jobUpdated = true;
              jobToUpdate.save();
            }
          });
        });
      }

      // Check if config was modified on the device
      this.reconfigCheck(origDevice, deviceInfo);

      logger.info('Device info message response received', {
        params: { deviceId: deviceId, message: deviceInfo }
      });

      if (isNewConnection) {
        // This part should only be done on a new connection
        this.devices.updateDeviceInfo(machineId, 'ready', true);
        this.callRegisteredCallbacks(this.connectCallbacks, machineId);
        // Set websocket traffic handler role for this instance
        roleSelector.selectorSetActive('websocketHandler');
      }
    } catch (err) {
      logger.error('Failed to receive info from device', {
        params: { device: machineId, err: err.message }
      });
      this.deviceDisconnect(machineId);
    }
  }

  /**
   * Checks whether a device is currently connected to the MGMT.
   * @param  {string} device device machine id
   * @return {boolean}       true if the device is connected, false otherwise
   */
  isConnected (device) {
    const deviceInfo = this.devices.getDeviceInfo(device);
    if (deviceInfo && deviceInfo.ready) return true;
    return false;
  }

  /**
   * Websocket close event callback, called when a connection is closed.
   * @param  {string} device device machine id
   * @return {void}
   */
  closeConnection (device) {
    // Device has no information, probably not connected, just return
    const deviceInfo = this.devices.getDeviceInfo(device);
    if (!deviceInfo) return;
    const { org, deviceObj, machineId } = deviceInfo;
    notificationsMgr.sendNotifications([
      {
        org: org,
        title: 'Device connection change',
        time: new Date(),
        device: deviceObj,
        machineId: machineId,
        details: 'Device disconnected from management'
      }
    ]);
    this.devices.removeDeviceInfo(device);
    this.callRegisteredCallbacks(this.closeCallbacks, device);
    logger.info('Device connection closed', { params: { deviceId: device } });
  }

  /**
   * Closes a device's websocket socket.
   * @param  {string} device device machine id
   * @return {void}
   */
  deviceDisconnect (device) {
    this.devices.disconnectDevice(device);
  }

  /**
   * Returns an array of all device IDs, for all organizations
   * @return {Array} an array of all device IDs across all organizations.
   */
  getAllDevices () {
    return this.devices.getAllDevices();
  }

  /**
   * Gets all organizations ids with updated connection status
   * @return {Array} array of org ids
   */
  getConnectionStatusOrgs () {
    return this.devices.getConnectionStatusOrgs();
  }

  /**
   * Gets all devices with updated connection status
   * @param  {string} org the org id
   * @return {Object} an object of devices ids of the org grouped by status
   * or undefined if no updated statuses
   */
  getConnectionStatusByOrg (org) {
    return this.devices.getConnectionStatusByOrg(org);
  }

  /**
   * Deletes devices connection status for the org.
   * @param  {string} org the org id
   * @return {void}
   */
  clearConnectionStatusByOrg (org) {
    return this.devices.clearConnectionStatusByOrg(org);
  }

  /**
   * Returns the device info by device ID
   * @param  {string} deviceID device machine id
   * @return {Object}          contains socket, org, deviceObj
   */
  getDeviceInfo (deviceID) {
    return this.devices.getDeviceInfo(deviceID);
  }

  /**
   * Set device state by device ID
   * @param  {string} deviceID device machine id
   * @return void
   */
  setDeviceState (deviceID, state) {
    this.devices.updateDeviceInfo(deviceID, 'running', state);
  }

  /**
   * If org has value, it verifies that the device belongs to that org.
   * This is in order to make sure a user doesn't send messages to a
   * device that doesn't belong to him If org = null, it ignores the
   * org verification.
   * @param  {string}   org               organization that owns the device
   * @param  {string}   device            device machine id
   * @param  {object}   msg               message to be sent to the device
   * @param  {number}   timeout           The number of seconds to wait for an answer
   * @param  {string}   jobid             sends the job ID to the agent, if job is created
   * @param  {function} responseValidator a validator for validating the device response
   * @return {Promise}                    A promise the message has been sent
   */
  deviceSendMessage (
    org,
    device,
    msg,
    timeout = configs.get('jobTimeout', 'number'),
    jobid = '',
    responseValidator = () => {
      return { valid: true, err: '' };
    }
  ) {
    const info = this.devices.getDeviceInfo(device);
    const seq = this.msgSeq++;

    const key = `${seq}:${getRandom(8)}`;

    const msgQ = this.msgQueue;
    const p = new Promise(function (resolve, reject) {
      if (info.socket && (org == null || info.org === org)) {
        // Increment seq and update queue with resolve function for this promise,
        // set timeout to clear when no response received
        const tohandle = setTimeout(() => {
          reject(new TypedError(ErrorTypes.TIMEOUT, 'Send Timeout'));
          // delete queue for this seq
          delete msgQ[key];
        }, timeout);
        msgQ[key] = {
          resolver: resolve,
          rejecter: reject,
          tohandle: tohandle,
          validator: responseValidator
        };
        info.socket.send(JSON.stringify({ seq: key, msg: msg, jobid: jobid }));
      } else reject(new Error('Send General Error'));
    });
    return p;
  }
}

var connections = null;
module.exports = function () {
  if (connections) return connections;
  else {
    connections = new Connections();
    return connections;
  }
};
