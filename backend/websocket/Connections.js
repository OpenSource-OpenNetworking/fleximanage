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

const Joi = require('@hapi/joi');
const Devices = require('./Devices');
const modifyDeviceDispatcher = require('../deviceLogic/modifyDevice');
const createError = require('http-errors');
const { devices } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const logger = require('../logging/logging')({ module: module.filename, type: 'websocket' });
const notificationsMgr = require('../notifications/notifications')();
const { verifyAgentVersion, isSemVer, isVppVersion } = require('../versioning');
const flexibilling = require('../flexibilling');
/**
 * Verifies a device subscription.
 * @param  {string} device device machine id
 * @return
 * {{
 *   subscriptionValid: boolean,
 *   subscriptionError: Object
 * }}
 */
const verifySubscription = async (device) => {
  const result = await flexibilling.validateSubscription(device);

  if (result) {
    return { subscriptionValid: result, subscriptionError: null };
  } else {
    logger.warn('Can not validate subscription', { params: { result } });
    return {
      subscriptionValid: false,
      subscriptionError: new Error('Subscription validation failed')
    };
  }
};

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
      if ([socket.CLOSING, socket.CLOSED].includes(socket.readyState)) return;
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

    const { subscriptionValid, subscriptionError } = await verifySubscription(
      device
    );
    if (!subscriptionValid) {
      logger.warn('Subscription verification failed', {
        params: { deviceId: connectionURL.pathname, err: subscriptionError }
      });
      return done(false, 402);
    }

    devices
      .find({
        machineId: device,
        deviceToken: connectionURL.searchParams.get('token')
      })
      .then(
        resp => {
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
              this.devices.setDeviceInfo(device, {
                org: resp[0].org.toString(),
                deviceObj: resp[0]._id,
                machineId: resp[0].machineId,
                ready: false
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
        logger.warn('Device connection failed', {
          params: {
            deviceId: connectionURL.pathname,
            err: err.message,
            status: err.status
          }
        });
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
    socket.isAlive = 3;
    socket.on('pong', function heartbeat () {
      // Pong received, reset retries
      socket.isAlive = 3;
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
    this.sendDeviceInfoMsg(device, info.deviceObj);
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
  async updateTunnelKeys (tunnels) {
    // Update all tunnels with the keys sent by the device
    const tunnelsOps = [];
    for (const tunnel of tunnels) {
      const { id, key1, key2, key3, key4 } = tunnel;
      tunnelsOps.push({
        updateOne:
          {
            filter: { num: id },
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
    if (deviceInfo.message.reconfig && prevDeviceInfo.reconfig !== deviceInfo.message.reconfig) {
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
        const interfaces = origDevice.interfaces.map(i => {
          const updatedConfig = deviceInfo.message.network.interfaces
            .find(u => u.pciaddr === i.pciaddr);
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

          if (updatedConfig.internetAccess !== undefined &&
            i.monitorInternet && updatedConfig.internetAccess !== i.internetAccess) {
            const newInterfaceState = `${updatedConfig.internetAccess ? 'Has' : 'No'} internet`;
            const details = `Interface state changed to "${newInterfaceState}"`;
            logger.info(details, {
              params: {
                machineId,
                updatedConfig
              }
            });
            notificationsMgr.sendNotifications([
              {
                org: origDevice.org,
                title: 'Interface connection change',
                time: new Date(),
                device: origDevice._id,
                machineId,
                details
              }
            ]);
          };

          const updInterface = {
            ...i.toJSON(),
            PublicIP: updatedConfig.public_ip && i.useStun
              ? updatedConfig.public_ip : i.PublicIP,
            PublicPort: updatedConfig.public_port && i.useStun
              ? updatedConfig.public_port : i.PublicPort,
            NatType: updatedConfig.nat_type || i.NatType,
            internetAccess: updatedConfig.internetAccess === undefined ? ''
              : updatedConfig.internetAccess ? 'yes' : 'no'
          };

          if (i.dhcp === 'yes' || !i.isAssigned) {
            updInterface.IPv4 = updatedConfig.IPv4;
            updInterface.IPv4Mask = updatedConfig.IPv4Mask;
            updInterface.IPv6 = updatedConfig.IPv6;
            updInterface.IPv6Mask = updatedConfig.IPv6Mask;
            updInterface.gateway = updatedConfig.gateway;
          };

          return updInterface;
        });

        // Update interfaces in DB
        const updDevice = await devices.findOneAndUpdate(
          { machineId },
          { $set: { interfaces } },
          { new: true, runValidators: true }
        );

        // Update the reconfig hash before applying to prevent infinite loop
        this.devices.updateDeviceInfo(machineId, 'reconfig', deviceInfo.message.reconfig);

        // Apply the new config and rebuild tunnels if need
        logger.info('Applying new configuration from the device', {
          params: {
            reconfig: deviceInfo.message.reconfig,
            machineId
          }
        });
        await modifyDeviceDispatcher.apply(
          [origDevice],
          { username: 'system' },
          { newDevice: updDevice, org: origDevice.org.toString() }
        );
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
   * @return {void}
   */
  async sendDeviceInfoMsg (machineId, deviceId) {
    const validateDevInfoMessage = msg => {
      const devInfoMsgObj = Joi.extend(joi => ({
        base: joi.object().keys({
          device: joi
            .string()
            .regex(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/)
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
              .required()
          }),
          network: joi.object().optional(),
          tunnels: joi.array().optional(),
          reconfig: joi.string().allow('').optional()
        }),
        name: 'versions',
        language: {
          err: 'invalid {{component}} version ({{version}})'
        },
        rules: [
          {
            name: 'format',
            validate (params, value, state, options) {
              for (const [component, info] of Object.entries(
                value.components
              )) {
                const ver = info.version;
                if (!(isSemVer(ver) || isVppVersion(ver))) {
                  return this.createError(
                    'versions.err',
                    { component: component, version: ver },
                    state,
                    options
                  );
                }
              }
              return true;
            }
          }
        ]
      }));
      const devInfoSchema = devInfoMsgObj.versions().format();
      const result = Joi.validate(msg, devInfoSchema);
      if (result.error) {
        return {
          valid: false,
          err: `${result.error.name}: ${result.error.details[0].message}`
        };
      }

      return { valid: true, err: '' };
    };

    try {
      const emptyTunnels = await this.getTunnelsWithEmptyKeys(deviceId);
      const message = { entity: 'agent', message: 'get-device-info', params: {} };
      if (emptyTunnels.length > 0) {
        message.params.tunnels = emptyTunnels;
      }
      const deviceInfo = await this.deviceSendMessage(
        null,
        machineId,
        message,
        '',
        validateDevInfoMessage
      );

      logger.info('Device info message sent', { params: { deviceId: deviceId } });
      if (!deviceInfo.ok) {
        throw new Error(`device reply: ${deviceInfo.message}`);
      }

      const versions = { device: deviceInfo.message.device };
      for (const [component, info] of Object.entries(
        deviceInfo.message.components
      )) {
        versions[component] = info.version;
      }

      const origDevice = await devices.findOneAndUpdate(
        { _id: deviceId },
        { $set: { versions: versions } },
        { new: true, runValidators: true }
      );

      const { tunnels } = deviceInfo.message;
      if (tunnels) {
        await this.updateTunnelKeys(tunnels);
      }

      // Check if config was modified on the device
      this.reconfigCheck(origDevice, deviceInfo);

      logger.info('Device info message response received', {
        params: { deviceId: deviceId, message: deviceInfo }
      });

      this.devices.updateDeviceInfo(machineId, 'ready', true);
      this.callRegisteredCallbacks(this.connectCallbacks, machineId);
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
   * Returns the device info by device ID
   * @param  {string} deviceID device machine id
   * @return {Object}          contains socket, org, deviceObj
   */
  getDeviceInfo (deviceID) {
    return this.devices.getDeviceInfo(deviceID);
  }

  /**
   * If org has value, it verifies that the device belongs to that org.
   * This is in order to make sure a user doesn't send messages to a
   * device that doesn't belong to him If org = null, it ignores the
   * org verification.
   * @param  {string}   org               organization that owns the device
   * @param  {string}   device            device machine id
   * @param  {Object}   msg               message to be sent to the device
   * @param  {Callback} responseValidator a validator for validating the device response
   * @return {Promise}                    A promise the message has been sent
   */
  deviceSendMessage (
    org,
    device,
    msg,
    jobid = '',
    responseValidator = () => {
      return { valid: true, err: '' };
    }
  ) {
    var info = this.devices.getDeviceInfo(device);
    var seq = this.msgSeq++;
    var msgQ = this.msgQueue;
    var p = new Promise(function (resolve, reject) {
      if (info.socket && (org == null || info.org === org)) {
        // Increment seq and update queue with resolve function for this promise,
        // set timeout to 60s to clear when no response received
        var tohandle = setTimeout(() => {
          reject(new Error('Error: Send Timeout'));
          // delete queue for this seq
          delete msgQ[seq];
        }, 180000);
        msgQ[seq] = {
          resolver: resolve,
          rejecter: reject,
          tohandle: tohandle,
          validator: responseValidator
        };
        info.socket.send(JSON.stringify({ seq: seq, msg: msg, jobid: jobid }));
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
