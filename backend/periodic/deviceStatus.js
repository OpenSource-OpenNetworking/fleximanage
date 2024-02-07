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

const periodic = require('./periodic')();
const connections = require('../websocket/Connections')();
const { deviceStats, deviceAggregateStats } = require('../models/analytics/deviceStats');
const notifications = require('../models/notifications');
const notificationsConf = require('../models/notificationsConf');
const applicationStats = require('../models/analytics/applicationStats');
const Joi = require('joi');
const logger = require('../logging/logging')({ module: module.filename, type: 'periodic' });
const notificationsMgr = require('../notifications/notifications')();
const configs = require('../configs')();
const { getRenewBeforeExpireTime } = require('../deviceLogic/IKEv2');
const orgModel = require('../models/organizations');
const { reconfigErrorsLimiter } = require('../limiters/reconfigErrors');
const { parseLteStatus, mapWifiNames } = require('../utils/deviceUtils');
const tunnels = require('../models/tunnels');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const { createClient } = require('redis');
const { getRedisAuthUrl } = require('../utils/httpUtils');

/***
 * This class gets periodic status from all connected devices
 ***/
class DeviceStatus {
  /**
    * Creates an instance of the DeviceStatus class
    */
  constructor () {
    // Holds the status per deviceID
    this.status = {};
    this.usersDeviceAggregatedStats = {};
    this.statsFieldsMap = new Map([
      ['rx_bytes', 'rx_bps'],
      ['rx_pkts', 'rx_pps'],
      ['tx_bytes', 'tx_bps'],
      ['tx_pkts', 'tx_pps']
    ]);
    this.tunnelFieldMap = new Map([
      ['status', 'status'],
      ['rtt', 'rtt'],
      ['drop_rate', 'drop_rate']
    ]);
    this.lastApplicationsStatusTime = {};
    this.statsPollPeriod = configs.get('statsPollPeriod', 'number');
    this.statsTimeout = configs.get('statsTimeout', 'number');

    this.start = this.start.bind(this);
    this.periodicPollDevices = this.periodicPollDevices.bind(this);
    this.periodicPollOneDevice = this.periodicPollOneDevice.bind(this);
    this.getDeviceStatus = this.getDeviceStatus.bind(this);
    this.setDeviceStatus = this.setDeviceStatus.bind(this);
    this.setDeviceState = this.setDeviceState.bind(this);
    this.registerSyncUpdateFunc = this.registerSyncUpdateFunc.bind(this);
    this.removeDeviceStatus = this.removeDeviceStatus.bind(this);
    this.deviceConnectionClosed = this.deviceConnectionClosed.bind(this);

    this.devicesStatusByOrg = {};
    this.devicesStatusReasonByOrg = {};
    this.setDevicesStatusByOrg = this.setDevicesStatusByOrg.bind(this);
    this.getDevicesStatusByOrg = this.getDevicesStatusByOrg.bind(this);
    this.getDevicesStatusReasonByOrg = this.getDevicesStatusReasonByOrg.bind(this);
    this.clearDevicesStatusByOrg = this.clearDevicesStatusByOrg.bind(this);

    this.tunnelsStatusByOrg = {};
    this.setTunnelsStatusByOrg = this.setTunnelsStatusByOrg.bind(this);
    this.getTunnelsStatusByOrg = this.getTunnelsStatusByOrg.bind(this);
    this.clearTunnelsStatusByOrg = this.clearTunnelsStatusByOrg.bind(this);
    this.statusCallback = this.statusCallback.bind(this);

    const { redisAuth, redisUrlNoAuth } = getRedisAuthUrl(configs.get('redisUrl'));
    this.redisClient = createClient({ url: redisUrlNoAuth });
    if (redisAuth) this.redisClient.auth(redisAuth);

    this.redisClient.on('connect', () => {
      logger.info('Connected to Redis');
    });

    this.redisClient.on('error', (err) => {
      logger.error('Redis client encountered an error:', err);
    });

    this.redisClient.on('end', () => {
      logger.info('Redis client disconnected');
    });

    // register a callback function to be called when a device status is received on channel
    connections.registerStatusCallback(this.statusCallback);

    // Task information
    this.updateSyncStatus = async () => {};
    this.taskInfo = {
      name: 'poll_status',
      func: this.periodicPollDevices,
      handle: null,
      period: this.statsPollPeriod
    };
  }

  registerSyncUpdateFunc (func) {
    this.updateSyncStatus = func;
  }

  /**
     * Checks the validity of a device-stats message
     * sent by the device.
     * @param  {Object} msg device stat message
     * @return {{valid: boolean, err: string}}
     */
  validateDevStatsMessage (msg) {
    if (!Array.isArray(msg)) {
      return { valid: false, err: 'get-device-stats response should be an array' };
    };

    if (msg.length === 0) return { valid: true, err: '' };

    const devStatsSchema = Joi.object().keys({
      ok: Joi.number().integer().required(),
      running: Joi.boolean().optional(),
      // TBD : when v0.X.X not supported, change to required
      state: Joi.string().valid('running', 'stopped', 'failed').optional(),
      // stateReason:  Joi.string().regex(/^[a-zA-Z0-9]{0,200}$/i).allow('').optional(),
      // TBD: Now no validation, need to fix on agent
      stateReason: Joi.string().allow('').optional(),
      period: Joi.number().required(),
      utc: Joi.date().timestamp('unix').required(),
      tunnel_stats: Joi.object().optional(),
      application_stats: Joi.object().optional(),
      lte_stats: Joi.object().optional(),
      wifi_stats: Joi.object().optional(),
      alerts: Joi.object().optional(),
      alerts_hash: Joi.string().allow('').optional(),
      reconfig: Joi.string().allow('').optional(),
      ikev2: Joi.object({
        certificateExpiration: Joi.string().allow('').optional(),
        error: Joi.string().allow('').optional()
      }).allow({}).optional(),
      health: Joi.object({
        cpu: Joi.array().items(Joi.number()).min(1).optional(),
        mem: Joi.number().optional(),
        disk: Joi.number().optional(),
        temp: Joi.object({
          value: Joi.number(),
          high: Joi.number(),
          critical: Joi.number()
        }).optional()
      }).allow({}).optional(),
      stats: Joi.object().pattern(/^[a-z0-9:._/-]{1,64}$/i, Joi.object({
        rx_bytes: Joi.number().required(),
        rx_pkts: Joi.number().required(),
        tx_bytes: Joi.number().required(),
        tx_pkts: Joi.number().required()
      })),
      vrrp: Joi.object().pattern(Joi.number().min(1).max(255), Joi.object({
        state: Joi.string().valid('Master', 'Backup', 'Initialize', 'Interface Down'),
        adjusted_priority: Joi.number().min(0).max(255).optional()
      })).allow({}).optional(),
      bgp: Joi.object({
        routerId: Joi.string(),
        as: Joi.number(),
        failedPeers: Joi.number(),
        displayedPeers: Joi.number(),
        totalPeers: Joi.number(),
        peers: Joi.object().pattern(Joi.string().ip({ version: ['ipv4'] }), Joi.object({
          remoteAs: Joi.number(),
          msgRcvd: Joi.number(),
          msgSent: Joi.number(),
          peerUptime: Joi.string(),
          peerUptimeMsec: Joi.number(),
          pfxRcd: Joi.number(),
          pfxSnt: Joi.number(),
          state: Joi.string(),
          peerState: Joi.string()
        }))
      }).allow({}).optional()
    });

    for (const updateEntry of msg) {
      const result = devStatsSchema.validate(updateEntry);
      if (result.error) {
        return {
          valid: false,
          err: `${result.error.name}: ${result.error.details[0].message}`
        };
      }
    }

    return { valid: true, err: '' };
  }

  /**
    * Starts the poll_status periodic task.
    * @return {void}
    */
  start () {
    const { name, func, period } = this.taskInfo;
    periodic.registerTask(name, func, period);
    periodic.startTask('poll_status');
  }

  /**
    * Polls the status of all connected devices
    * @return {void}
    */
  periodicPollDevices () {
    const devices = connections.getAllDevices();
    devices.forEach((deviceID) => {
      // run periodic task if device is connected to this host
      const { socket } = connections.getDeviceInfo(deviceID) ?? {};
      if (connections.isSocketAlive(socket)) this.periodicPollOneDevice(deviceID);
    });
  }

  /**
   * Generates a unique notification key based on the provided parameters.
   *
   * @param {string} notificationName - The name of the notification.
   * @param {Object} notificationTargets - Contains targets such as tunnelId, deviceId, etc.
   * @param {boolean} isResolved - Indicates if the notification relates to a resolved issue.
   * @param {string} orgId - Organization ID associated with the notification.
   * @param {string} severity - Optional: The severity of the notification
   * (relevant only to agent alerts)
   * @returns {string} The unique notification key.
   * @throws {Error} Throws an error if no valid target ID is found.
   */
  async generateTunnelNotificationKey (
    notificationName, notificationTargets, isResolved, orgId, severity) {
    if (!notificationTargets.tunnelId) {
      logger.warn('Failed to generate notification key: No valid tunnel ID found', {
        params: { notificationName, notificationTargets, orgId }
      });
      throw new Error('Unable to generate notification key: No valid target ID found');
    }

    const tunnelId = `tunnelId:${notificationTargets.tunnelId}`;
    const notificationKey = severity ? 'notification-lock:' + notificationName + ':' +
    tunnelId + ':' + isResolved + ':' + severity + orgId
      : 'notification-lock:' + notificationName + ':' + tunnelId + ':' + isResolved + ':' + orgId;

    return notificationKey;
  }

  /**
   * Processes and handles an alert received by the agent in get-stats.
   *
   * @param {string} deviceID - The ID of the device associated with the alert.
   * @param {Object} deviceInfo - Detailed information about the device in memory.
   * @param {string} alertName - The name of the specific alert being processed.
   * @param {Object} lastUpdateEntry -  The current alerts of the device (received in get-stats).
   * @param {number} [tunnelNum=null] - Optional tunnel number if the alert is specific to a tunnel.
   * @throws {Error} Logs an error if there's a failure in creating or sending the notification.
   */
  async handleAlert (
    deviceID, deviceInfo, alertName, lastUpdateEntry, tunnelNum = null) {
    let { value, unit, threshold, type } = tunnelNum
      ? lastUpdateEntry.alerts[alertName][tunnelNum]
      : lastUpdateEntry.alerts[alertName];

    // Ensure that 'value' has only one digit after the '.'
    value = parseFloat(value.toFixed(1));
    try {
      this.createAndSendNotification(
        deviceInfo, lastUpdateEntry.alerts, alertName,
        { value, threshold, unit, type }, tunnelNum);
    } catch (err) {
      logger.error(`Failed to add the "${alertName}" alert for
       ${tunnelNum ? 'tunnel ' + tunnelNum : 'device ' + deviceInfo.name}`
      , {
        params: { deviceID: deviceID, err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
   * Retrieves threshold information based on the provided parameters.
   *
   * This function determines the type of threshold (either warning or critical) based on the
   * given severity. It then fetches the corresponding threshold value and unit.
   * This function is used for resolved alerts to determine the threshold value
   * below which the alert is considered resolved.
   * @param {string} alertKey - The key(name) identifying the specific alert in the alerts object.
   * @param {Object} notificationsConfRules - Settings object from the db.
   * @param {string} severity - The severity of the alert (e.g., 'warning' or 'critical').
   * @param {string} org - Organization ID or name associated with the alert.
   * @param {number} [tunnelId=null] - tunnel ID to fetch tunnel-specific threshold settings.
   * @returns {Object} Returns an object containing the threshold value and unit.
  */
  getThresholdInfo (
    alertKey, notificationsConfRules, severity, org, tunnelId = null) {
    const thresholdType = (severity === 'warning') ? 'warningThreshold' : 'criticalThreshold';

    const thresholdValue = tunnelId
      ? (tunnels.findOne(
        { num: tunnelId, org }, { fields: { notificationsSettings: 1 } }
      )?.notificationsSettings?.[thresholdType] ?? notificationsConfRules[alertKey][thresholdType])
      : notificationsConfRules[alertKey][thresholdType];

    const thresholdUnit = notificationsConfRules[alertKey].thresholdUnit;

    return { threshold: thresholdValue, unit: thresholdUnit };
  }

  /**
   * Processes and handles resolved alerts for a device based on the given parameters.
   *
   * This function first determines if the alert is one of the known 'agent-only' alerts.
   * For device-specific alerts, it checks if the alert severity has changed since the last update.
   * If it has, it fetches the relevant threshold information and sends a notification.
   * For alerts related to tunnels, the function delegates to `resolveTunnelAlerts`.
   *
   * @param {Object} alerts - The most recent alerts of the device in the memory (if there is no
   * memory we fetched it from the db)
   * @param {Object} lastUpdateEntry -  The current alerts of the device (received in get-stats).
   * @param {string} deviceID - The ID of the device associated with the alerts.
   * @param {Object} orgNotificationsConf - Configuration for organization notifications.
   * @param {Object} deviceInfo - Detailed information about the device in memory.
   * @throws {Error} Logs an error if there's an issue resolving any alert.
  */
  async handleResolvedAlerts (alerts, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo) {
    try {
      const agentOnlyAlerts = ['Link/Tunnel round trip time',
        'Link/Tunnel default drop rate', 'Device memory usage', 'Hard drive usage', 'Temperature'];
      const notificationsConfRules = orgNotificationsConf.rules;

      for (const alertName in alerts) {
        const isAgentAlert = agentOnlyAlerts.includes(alertName);
        if (!isAgentAlert) {
          continue;
        }
        if (alerts[alertName].type === 'device') {
          if ((!lastUpdateEntry.alerts[alertName] ||
            lastUpdateEntry.alerts[alertName].severity !== alerts[alertName].severity)) {
            const agentAlertsInfo = this.getThresholdInfo(
              alertName, notificationsConfRules, alerts[alertName].severity, deviceInfo.org);
            this.createAndSendNotification(
              deviceInfo, alerts, alertName,
              agentAlertsInfo, null, true);
          }
        } else {
          this.resolveTunnelAlerts(
            alertName, alerts, lastUpdateEntry, deviceInfo, notificationsConfRules);
        }
      }
    } catch (error) {
      logger.error(`Failed to resolve alert for device ${deviceInfo.name}`, {
        params: { deviceID: deviceID, err: error.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
   * Processes and resolves tunnel-related alerts based on the given parameters.
   *
   * This function iterates over each tunnel alert. For each tunnel, it determines if
   * the alert exists in the last update and if the severity has changed. If either
   * condition is met, it fetches the threshold information and sends a resolved notification.
   *
   * @param {string} alertKey - The key(name) identifying the specific alert in the alerts object.
   * @param {Object} alerts - The most recent alerts of the device in the memory.
   * @param {Object} lastUpdateEntry -  The current alerts of the device (received in get-stats).
   * @param {Object} deviceInfo - Detailed information about the device in memory.
   * @param {Object} notificationsConfRules - Settings object from the db.
  */
  resolveTunnelAlerts (alertKey, alerts, lastUpdateEntry, deviceInfo, notificationsConfRules) {
    for (const tunnelId in alerts[alertKey]) {
      const alertExistsForTunnel = lastUpdateEntry.alerts[alertKey]?.[tunnelId];
      const severityHasChanged = alertExistsForTunnel &&
      alertExistsForTunnel.severity !== alerts[alertKey][tunnelId].severity;

      const shouldResolveTunnelAlert = !lastUpdateEntry.alerts[alertKey] ||
       !alertExistsForTunnel || severityHasChanged;

      if (shouldResolveTunnelAlert) {
        const agentAlertsInfo = this.getThresholdInfo(
          alertKey,
          notificationsConfRules,
          alerts[alertKey][tunnelId].severity,
          deviceInfo.org, tunnelId
        );
        this.createAndSendNotification(
          deviceInfo, alerts, alertKey,
          agentAlertsInfo, tunnelId, true);
      }
    }
  }

  /**
   * Convert an alert into a notification and send it.
   * @param {Object} deviceInfo - Detailed information about the device in memory.
   * @param {Object} alerts - All alerts related to the device.
   * @param {string} alertName - The specific alert's name being processed.
   * @param {Object} agentAlertsInfo - Contains the threshold, unit, and value of the alert.
   * @param {string} [tunnelId=null] - Optional tunnel ID if applicable.
   * @param {boolean} [isResolved=false] - Indicates if the alert has been resolved.
  */
  async createAndSendNotification (
    deviceInfo, alerts, alertName,
    agentAlertsInfo, tunnelId = null, isResolved = false) {
    const { org, deviceObj: deviceId, name } = deviceInfo;
    const targets = {
      deviceId,
      tunnelId,
      interfaceId: null
    };
    const severity = tunnelId ? alerts[alertName][tunnelId].severity : alerts[alertName].severity;

    const title = isResolved ? `[resolved] ${alertName}` : alertName;
    const details = 'The value of the ' + alertName + ' in ' + (tunnelId ? 'tunnel ' +
    tunnelId : 'device ' + name) + ' has ' + (isResolved ? 'returned to normal (under ' +
    agentAlertsInfo.threshold + agentAlertsInfo.unit + ')' : 'increased to ' +
    agentAlertsInfo.value + agentAlertsInfo.unit);
    const notification = {
      org,
      title,
      details,
      eventType: alertName,
      targets,
      severity,
      resolved: isResolved,
      agentAlertsInfo
    };

    let notificationKey;
    if (tunnelId) {
      notificationKey = await this.generateTunnelNotificationKey(
        alertName, targets, isResolved, org, severity);
    }
    this.handleNotificationSending(notification, notificationKey);
  }

  /**
   * Set a notification lock key in Redis with a specified TTL.
   *
   * This function utilizes the Redis "SET" command with "PX" and "NX" options to ensure that the
   * key is set with the specified TTL and that it only gets set if the key doesn't already exist.
   * This was meant to prevent different servers from processing the same notification.
   *
   * @param {string} key - The Redis key to be locked (notification key).
   * @param {number} ttl - The time-to-live for the key in milliseconds.
   * @param {Function} cb - The callback function to execute upon completion.
  */
  setNotificationKeyWithTtlLock (key, ttl, cb) {
    this.redisClient.set(key, 'LOCK', 'PX', ttl, 'NX', (err, reply) => {
      if (err) {
        logger.error('Notification key lock failed.', { params: { error: err, key } });
        return cb(err);
      }
      if (reply === 'OK') {
        logger.info('Notification key lock acquired.', { params: { key } });
        return cb(null, true);
      } else {
        logger.warn('Notification key lock denied. Key already locked.', { params: { key } });
        return cb(null, false);
      }
    });
  }

  /**
   * Removes a previously set notification lock key from Redis.
   *
   * @param {string} key - The Redis key to be removed.
  */
  removeNotificationKeyLock (key) {
    this.redisClient.del(key, (err) => {
      if (err) {
        logger.error('Failed to release Redis notification lock.', { params: { key, error: err } });
      } else {
        logger.info('The Redis notification lock has been released.', { params: key });
      }
    });
  }

  /**
   * Handles the logic of sending a notification.
   *
   * The function checks if the notificationKey is truthy.
   * If not, it sends the notification directly.
   * Else, the function first tries to acquire a lock using the provided key.
   * Once the lock is acquired, the notification is sent for processing and the lock is released.
   *
   * @param {Object} notification - The notification object to send.
   * @param {string} notificationKey - The Redis key used for locking
  */
  handleNotificationSending (notification, notificationKey = null) {
    if (!notificationKey) {
      notificationsMgr.sendNotifications([notification]);
      return;
    }

    // First, try to acquire the lock
    this.setNotificationKeyWithTtlLock(
      notificationKey, 30000, (lockErr, acquired) => {
        if (lockErr || !acquired) {
          return;
        }

        // Lock was acquired successfully. Send the notification.
        notificationsMgr.sendNotifications([notification])
          .then(() => {
            logger.info('Releasing tunnel notification lock & deleting from Redis.',
              { params: { notificationKey } });
            this.removeNotificationKeyLock(notificationKey);
          });
      });
  }

  /**
   * Calculates and handles both current and resolved alerts for a given device.
   *
   * This function performs the following tasks:
   * 1. Retrieves the notification configuration for the organization to which the device belongs.
   * 2. Iterates over the alerts in the last update entry of the device.
   * If this is a tunnel-specific alert like RTT, the function handles it for each tunnel.
   * Otherwise, it handles the device-level alert.
   * 3. If there are alerts present in the device's memory, it handles the resolved alerts.
   * 4. If the device's memory doesn't contain alerts,
   * it fetches the unresolved alerts from the database and processes them.
   *
   * @async
   * @param {string} deviceID - The unique identifier for the device.
   * @param {Object} deviceInfo - Detailed information about the device in memory.
   * @param {Object} lastUpdateEntry -  The current alerts of the device (received in get-stats).
   * @throws Will throw an error if the notification configuration retrieval / alert handling fails.
  */
  async calculateNotifications (deviceID, deviceInfo, lastUpdateEntry) {
    const orgNotificationsConf = await notificationsConf.findOne({ org: deviceInfo.org });
    for (const alertName in lastUpdateEntry.alerts) {
      if (alertName.toLowerCase().includes('tunnel')) {
        for (const tunnelId in lastUpdateEntry.alerts[alertName]) {
          await this.handleAlert(
            deviceID, deviceInfo, alertName, lastUpdateEntry, tunnelId);
        }
      } else {
        await this.handleAlert(
          deviceID, deviceInfo, alertName, lastUpdateEntry);
      }
    }
    // handle resolved alerts if needed (exist in the memory but not in the current alerts)
    if (deviceInfo.alerts) {
      await this.handleResolvedAlerts(
        deviceInfo.alerts, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo);
      // There is no memory so we should look after the unresolved alerts in th db
    } else {
      const previousAlerts = await notifications.find({
        'targets.deviceId': deviceInfo.deviceObj,
        resolved: false
      });
      const prevAlertsDict = {};
      for (let i = 0; i < previousAlerts.length; i++) {
        if (previousAlerts[i].severity) {
          if (previousAlerts[i].targets?.tunnelId) {
            const tunnelId = previousAlerts[i].targets.tunnelId;
            const eventType = previousAlerts[i].eventType; // eventType = alert name
            prevAlertsDict[eventType] = {
              [tunnelId]: {
                value: previousAlerts[i].agentAlertsInfo.value,
                threshold: previousAlerts[i].agentAlertsInfo.threshold,
                severity: previousAlerts[i].severity,
                unit: previousAlerts[i].agentAlertsInfo.unit,
                type: previousAlerts[i].agentAlertsInfo.type
              }
            };
          } else {
            prevAlertsDict[previousAlerts[i].eventType] = {
              value: previousAlerts[i].agentAlertsInfo.value,
              threshold: previousAlerts[i].agentAlertsInfo.threshold,
              severity: previousAlerts[i].severity,
              unit: previousAlerts[i].agentAlertsInfo.unit,
              type: previousAlerts[i].agentAlertsInfo.type
            };
          }
        }
      }
      await this.handleResolvedAlerts(
        prevAlertsDict, lastUpdateEntry, deviceID, orgNotificationsConf, deviceInfo);
    }
  }

  /**
     * Sends a get-device-stats message to a device.
     * @param  {string} deviceID the host id of the device
     * @return {void}
     */
  periodicPollOneDevice (deviceID) {
    const deviceInfo = connections.getDeviceInfo(deviceID);
    if (!deviceInfo) {
      logger.warn('Failed to get device info', {
        params: { deviceID: deviceID },
        periodic: { task: this.taskInfo }
      });
      return;
    }
    const now = Date.now();
    const { statsSentTime, statsCompleteTime } = deviceInfo;
    if ((statsSentTime && now - statsSentTime < this.statsTimeout) ||
      (statsCompleteTime && now - statsCompleteTime < this.statsPollPeriod / 2)) {
      // wait until the previous 'get-device-stats' processing is finished
      // skip one if the process took more than half of the poll period
      return;
    }
    connections.devices.updateDeviceInfo(deviceID, 'statsSentTime', now, false);
    connections.devices.updateDeviceInfo(deviceID, 'statsCompleteTime', undefined, false);
    connections.deviceSendMessage(null, deviceID,
      { entity: 'agent', message: 'get-device-stats' }, undefined, '', this.validateDevStatsMessage)
      .then(async (msg) => {
        if (msg != null) {
          if (msg.ok === 1) {
            if (msg.message.length === 0) return;
            // Update device status according to the last update entry in the list
            const lastUpdateEntry = msg.message[msg.message.length - 1];
            await this.setDeviceStatus(deviceID, deviceInfo, lastUpdateEntry);
            this.updateAnalyticsInterfaceStats(deviceID, deviceInfo, msg.message);
            this.updateAnalyticsApplicationsStats(deviceID, deviceInfo, msg.message);
            this.updateUserDeviceStats(deviceInfo.org, deviceID, msg.message);

            // Compare notification hashes between the device and last update.
            // This code won't executed if the device's version is older than 6.3.X
            // since deviceInfo won't have the key notificationsHash and lastUpdateEntry
            // won't have the key alerts_hash
            if ((!deviceInfo.notificationsHash && lastUpdateEntry.alerts_hash) ||
                deviceInfo.notificationsHash !== lastUpdateEntry.alerts_hash) {
              this.calculateNotifications(deviceID, deviceInfo, lastUpdateEntry).then(() => {
                connections.devices.updateDeviceInfo(
                  deviceID, 'notificationsHash', lastUpdateEntry.alerts_hash);
                connections.devices.updateDeviceInfo(
                  deviceID, 'alerts', lastUpdateEntry.alerts);
              });
            }

            this.updateDeviceSyncStatus(
              deviceInfo.org,
              deviceInfo.deviceObj,
              deviceID,
              msg['router-cfg-hash']
            );
            // check if need to generate a new IKEv2 certificate
            let needNewIKEv2Certificate = false;
            const { encryptionMethod } = await orgModel.findOne({ _id: deviceInfo.org });

            if (encryptionMethod === 'ikev2') {
              const { ikev2 } = lastUpdateEntry;
              if (!ikev2) {
                needNewIKEv2Certificate = true;
              } else if (ikev2.error) {
                logger.warn('IKEv2 certificate error on device', {
                  params: { deviceID: deviceID, err: ikev2.error },
                  periodic: { task: this.taskInfo }
                });
                needNewIKEv2Certificate = true;
              } else {
                const certificateExpiration =
                  (new Date(ikev2.certificateExpiration)).getTime();
                // check if expiration is different on agent and management
                // or certificate is about to expire
                if (deviceInfo.certificateExpiration !== certificateExpiration ||
                  certificateExpiration < getRenewBeforeExpireTime()) {
                  needNewIKEv2Certificate = true;
                }
              }
            }

            // Check if config was modified on the device or need to check IKEv2 certificate
            const { reconfig } = lastUpdateEntry;
            if ((reconfig && reconfig !== deviceInfo.reconfig) || needNewIKEv2Certificate) {
              // Check if device is blocked due to many error in a row
              const deviceId = deviceInfo.deviceObj.toString();
              const isBlocked = await reconfigErrorsLimiter.isBlocked(deviceId);
              if (!isBlocked) {
                // Call get-device-info and reconfig
                connections.sendDeviceInfoMsg(deviceID, deviceInfo.deviceObj, deviceInfo.org);
              } else {
                logger.warn('Failed to send get-device-info due to reconfig errors limiter', {
                  params: { deviceID, reconfig, needNewIKEv2Certificate },
                  periodic: { task: this.taskInfo }
                });
              }
            }
            // status received and updated in memory, so it can be published to other hosts
            connections.publishStatus(deviceID, this.status[deviceID]);
          } else {
            this.setDeviceState(deviceID, 'pending');
          }
        } else {
          logger.warn('Failed to get device status', {
            params: { deviceID: deviceID, message: msg },
            periodic: { task: this.taskInfo }
          });
        }
      }, (err) => {
        logger.warn('Failed to get device status', {
          params: { deviceID: deviceID, err: err.message },
          periodic: { task: this.taskInfo }
        });
        return err;
      })
      .catch((err) => {
        logger.warn('Failed to get device status', {
          params: { deviceID: deviceID, err: err.message },
          periodic: { task: this.taskInfo }
        });
      })
      .finally(() => {
        connections.devices.updateDeviceInfo(deviceID, 'statsSentTime', undefined, false);
        connections.devices.updateDeviceInfo(deviceID, 'statsCompleteTime', Date.now(), false);
      });
  }

  async updateDeviceSyncStatus (org, deviceId, machineId, hash) {
    try {
      await this.updateSyncStatus(org, deviceId, machineId, hash);
    } catch (err) {
      logger.error('Failed to update device sync status', {
        params: { deviceID: deviceId, err: err.message },
        periodic: { task: this.taskInfo }
      });
    }
  }

  /**
     * Updates the applications stats per device in the database
     * @param  {string} deviceID   device UUID
     * @param  {Object} deviceInfo device info stored per connection (org, mongo device id, socket)
     * @param  {Object} stats      contains the per-application stats
     * @return {void}
     */
  updateAnalyticsApplicationsStats (deviceID, deviceInfo, statsList) {
    for (const statsEntry of statsList) {
      // Update the database once per update time configuration (default: 5min)
      const msgTime = Math.floor(statsEntry.utc / configs.get('analyticsUpdateTime', 'number')) *
        configs.get('analyticsUpdateTime', 'number');

      if (this.lastApplicationsStatusTime[deviceID] === msgTime) return;

      const appsStats = statsEntry.application_stats;
      for (const identifier in appsStats) {
        const appData = appsStats[identifier];

        this.lastApplicationsStatusTime[deviceID] = msgTime;

        // update the db
        applicationStats.update(
          // Query
          { org: deviceInfo.org, device: deviceInfo.deviceObj, app: identifier, time: msgTime },
          // Update
          { $set: { stats: appData } },
          // Options
          { upsert: true })
          .then((resp) => {
            logger.debug('Storing applications statistics in DB', {
              params: { deviceId: deviceID, identifier, appData },
              periodic: { task: this.taskInfo }
            });
          }, (err) => {
            logger.warn('Failed to store applications statistics', {
              params: { deviceId: deviceID, identifier, appData, err: err.message },
              periodic: { task: this.taskInfo }
            });
          })
          .catch((err) => {
            logger.warn('Failed to store applications statistics', {
              params: { deviceId: deviceID, identifier, appData, err: err.message },
              periodic: { task: this.taskInfo }
            });
          });
      }
    }
  }

  /**
     * Updates the interface stats per device in the database
     * @param  {string} deviceID   device UUID
     * @param  {Object} stats      contains the per-interface stats: rx/tx bps/pps
     * @param  {Object} deviceInfo device info stored per connection (org, mongo device id, socket)
     * @return {void}
     */
  updateAnalyticsInterfaceStats (deviceID, deviceInfo, statsList) {
    statsList.forEach((statsEntry) => {
      // Update the database once per update time configuration (default: 5min)
      const msgTime = Math.floor(statsEntry.utc / configs.get('analyticsUpdateTime', 'number')) *
        configs.get('analyticsUpdateTime', 'number');
      if (this.getDeviceLastUpdateTime(deviceID) === msgTime) return;

      // Build DB updates
      const dbStats = {};
      let shouldUpdate = false;
      const stats = statsEntry.stats;
      for (const intf in stats) {
        if (!stats.hasOwnProperty(intf)) continue;
        const intfStats = stats[intf];
        for (const stat in intfStats) {
          if (!intfStats.hasOwnProperty(stat) || !this.statsFieldsMap.get(stat)) continue;
          const key = 'stats.' + intf.replaceAll('.', ':') + '.' + this.statsFieldsMap.get(stat);
          dbStats[key] = intfStats[stat] / statsEntry.period;
          shouldUpdate = true;
        }
      }
      // Add tunnel info
      const tunnelStats = statsEntry.tunnel_stats;
      for (const tunnelId in tunnelStats) {
        if (!tunnelStats.hasOwnProperty(tunnelId)) continue;
        const tunnelIdStats = tunnelStats[tunnelId];
        for (const stat in tunnelIdStats) {
          if (!tunnelIdStats.hasOwnProperty(stat)) continue;
          if (this.statsFieldsMap.get(stat)) {
            const key = 'tunnels.' + tunnelId + '.' + this.statsFieldsMap.get(stat);
            dbStats[key] = tunnelIdStats[stat] / statsEntry.period;
            shouldUpdate = true;
          }
          if (this.tunnelFieldMap.get(stat)) {
            const key = 'tunnels.' + tunnelId + '.' + this.tunnelFieldMap.get(stat);
            dbStats[key] = tunnelIdStats[stat];
            shouldUpdate = true;
          }
        }
      }
      // Update health info
      const healthStats = statsEntry.health;
      for (const param in healthStats) {
        dbStats['health.' + param] = healthStats[param];
        shouldUpdate = true;
      }

      if (!shouldUpdate) return;
      this.setDeviceStatsField(deviceID, 'lastUpdateTime', msgTime);

      deviceStats.update(
        // Query
        { org: deviceInfo.org, device: deviceInfo.deviceObj, time: msgTime },
        // Update
        { $set: dbStats },
        // Options
        { upsert: true })
        .then((resp) => {
          logger.debug('Storing interfaces statistics in DB', {
            params: { deviceId: deviceID, stats: statsEntry },
            periodic: { task: this.taskInfo }
          });
        }, (err) => {
          logger.warn('Failed to store interface statistics', {
            params: { deviceId: deviceID, stats: statsEntry, err: err.message },
            periodic: { task: this.taskInfo }
          });
        })
        .catch((err) => {
          logger.warn('Failed to store interface statistics', {
            params: { deviceId: deviceID, stats: statsEntry, err: err.message },
            periodic: { task: this.taskInfo }
          });
        });
    });
  }

  /**
   * @param  {string} machineId   device machine Id
   * @param  {string} state       device state
   * @param  {string} reason      a reason for device state (error usually)
   * @return {void}
   */
  async setDeviceState (machineId, newState, needToPublish = true, reason = '') {
    // Generate a notification if there was a transition in the device's status
    const deviceInfo = connections.getDeviceInfo(machineId);
    if (!deviceInfo) {
      logger.warn('Failed to get device info', {
        params: { machineId }
      });
      return;
    }
    const { org, deviceObj: deviceId, name } = deviceInfo;
    if (!this.status[machineId] || newState !== this.status[machineId].state) {
      const targets = {
        deviceId: deviceId,
        tunnelId: null,
        interfaceId: null
      };
      const resolved = newState === 'running';

      const notification = {
        org: org,
        title: resolved ? '[resolved] Router state change' : 'Router state change',
        details: `Router state changed to ${newState} in the device ${name}`,
        eventType: 'Running router',
        targets,
        resolved
      };

      this.handleNotificationSending(notification);

      this.setDevicesStatusByOrg(org, deviceId, newState, reason);
    }
    this.setDeviceStatsField(machineId, 'state', newState);
    this.status[machineId].reason = !reason || JSON.parse(reason);
    // status updated in memory, publish it to other hosts
    if (needToPublish) {
      connections.publishStatus(machineId, this.status[machineId]);
    }
  }

  /**
    * Store LTE status in memory to improve the response speed of the LTE monitoring requests
    * @param  {string} machineId  device machine id
    * @param  {string} devId LTE device devId
    * @param  {Object} lteStatus   LTE status
    * @return {void}
    */
  setDeviceLteStatus (machineId, devId, lteStatus) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].lteStatus) {
      this.status[machineId].lteStatus = {};
    }
    if (!this.status[machineId].lteStatus[devId]) {
      this.status[machineId].lteStatus[devId] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].lteStatus[devId], { ...lteStatus, time });
  }

  getDeviceLteStatus (machineId, devId) {
    return this.status?.[machineId]?.lteStatus?.[devId] ?? {};
  }

  /**
    * Store LTE status in memory to improve the response speed of the WiFi monitoring requests
    * @param  {string} machineId  device machine id
    * @param  {string} devId WiFi device devId
    * @param  {Object} wifiStatus   WiFi status
    * @return {void}
    */
  setDeviceWifiStatus (machineId, devId, wifiStatus) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].wifiStatus) {
      this.status[machineId].wifiStatus = {};
    }
    if (!this.status[machineId].wifiStatus[devId]) {
      this.status[machineId].wifiStatus[devId] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].wifiStatus[devId], { ...wifiStatus, time });
  }

  getDeviceWifiStatus (machineId, devId) {
    return this.status?.[machineId]?.wifiStatus?.[devId] ?? {};
  }

  /**
    * Store Vrrp status in memory
    * @param  {string} machineId  device machine id
    * @param  {string} vrid VRID
    * @param  {Object} status VRRP status
    * @return {void}
    */
  setDeviceVrrpStatus (machineId, vrid, status) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].vrrp) {
      this.status[machineId].vrrp = {};
    }
    if (!this.status[machineId].vrrp[vrid]) {
      this.status[machineId].vrrp[vrid] = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].vrrp[vrid], { ...status, time });
  }

  /**
    * Store BGP status in memory
    * @param  {string} machineId  device machine id
    * @param  {string} vrid VRID
    * @param  {Object} status VRRP status
    * @return {void}
    */
  setDeviceBgpStatus (machineId, status) {
    if (!this.status[machineId]) {
      this.status[machineId] = {};
    }
    if (!this.status[machineId].bgp) {
      this.status[machineId].bgp = {};
    }
    const time = new Date().getTime();
    Object.assign(this.status[machineId].bgp = { ...status, time });
    return this.getDeviceBgpStatus(machineId);
  }

  getDeviceBgpStatus (machineId) {
    return this.status?.[machineId]?.bgp ?? {};
  }

  /**
    * Get the Vrrp status from memory
    * @param  {string} machineId  device machine id
    * @return {void}
    */
  getDeviceVrrpStatus (machineId, vrid) {
    return this?.status?.[machineId]?.vrrp?.[vrid] ?? {};
  }

  /**
    * Clear the Vrrp status from memory
    * @param  {string} machineId  device machine id
    * @return {void}
    */
  clearDeviceVrrpStatus (machineId) {
    delete this?.status?.[machineId]?.vrrp;
  }

  isCustomNotificationsSupported (deviceVersion) {
    const majorVersion = getMajorVersion(deviceVersion);
    const minorVersion = getMinorVersion(deviceVersion);
    return (majorVersion > 6 || (majorVersion === 6 && minorVersion >= 3));
  };

  async processTunnelNotificationsForOldDevices (
    eventType, prevValue, currentValue, firstUpdate, deviceInfo, targets, unit,
    criticalThreshold, warningThreshold) {
    if (firstUpdate || currentValue !== prevValue) {
      let resolved = false;
      let severity = null;

      if (prevValue > criticalThreshold && currentValue < criticalThreshold) {
        resolved = true;
        severity = 'critical';
      } else if (prevValue > warningThreshold && currentValue < warningThreshold) {
        resolved = true;
        severity = 'warning';
      } else if (currentValue > criticalThreshold) {
        severity = 'critical';
      } else if (currentValue > warningThreshold) {
        severity = 'warning';
      }

      if (severity) {
        const threshold = severity === 'warning' ? warningThreshold : criticalThreshold;
        const notificationKey = await this.generateTunnelNotificationKey(
          eventType, targets, resolved, deviceInfo.org
        );
        const notification = {
          org: deviceInfo.org,
          title: eventType,
          details: resolved ? `
          ${eventType} has returned to normal in Tunnel ${targets.tunnelId}`
            : `${eventType} has reached ${parseFloat(currentValue.toFixed(1))}${unit}
             in Tunnel ${targets.tunnelId}`,
          targets,
          eventType,
          resolved,
          agentAlertsInfo: {
            value: parseFloat(currentValue.toFixed(1)),
            threshold,
            unit,
            type: 'tunnel'
          },
          severity
        };
        this.handleNotificationSending(notification, notificationKey);
      }
    }
  }

  /**
     * @param  {string} machineId  device machine id
     * @param  {Object} deviceInfo device info entry
     * @param  {Object} rawStats   device stats supplied by the device
     * @return {void}
     */
  async setDeviceStatus (machineId, deviceInfo, rawStats) {
    let devStatus = 'failed';
    if (rawStats.hasOwnProperty('state')) { // Agent v1.X.X
      devStatus = rawStats.state;
    // v0.X.X TBD: remove when v0.X.X is not supported, e.g. mgmt=2.X.X
    } else if (rawStats.hasOwnProperty('running')) {
      devStatus = rawStats.running === true ? 'running' : 'stopped';
    }

    let stateReason = '';
    if (rawStats.hasOwnProperty('stateReason')) { // Agent v1.X.X
      stateReason = rawStats.stateReason;
    }

    await this.setDeviceState(machineId, devStatus, false, stateReason);
    const { org, deviceObj: deviceId } = deviceInfo;

    // Interface statistics
    const timeDelta = rawStats.period;
    const ifStats = rawStats.hasOwnProperty('stats') ? rawStats.stats : {};
    const devStats = {};

    const appStatus = rawStats.application_stats;
    if (rawStats.hasOwnProperty('application_stats') && Object.entries(appStatus).length !== 0) {
      if (!this.status[machineId].applicationStatus) {
        this.status[machineId].applicationStatus = {};
      }
      // Generate tunnel notifications
      Object.entries(appStatus).forEach(ent => {
        const [identifier, status] = ent;
        this.status[machineId].applicationStatus[identifier] = {
          running: status.running,
          monitoring: status.statistics
        };
      });
    } else {
      if (this.status[machineId].applicationStatus) {
        for (const identifier in this.status[machineId].applicationStatus) {
          delete this.status[machineId].applicationStatus[identifier];
        }
      }
    }

    // Set lte status in memory for now
    const lteStatus = rawStats.lte_stats;
    if (rawStats.hasOwnProperty('lte_stats') && Object.entries(lteStatus).length !== 0) {
      if (!this.status[machineId].lteStatus) {
        this.status[machineId].lteStatus = {};
      }
      for (const devId in lteStatus) {
        const mappedLteStatus = parseLteStatus(lteStatus[devId]);
        this.setDeviceLteStatus(machineId, devId, mappedLteStatus);
      }
    };

    // Set wifi status in memory for now
    const wifiStatus = rawStats.wifi_stats;
    if (rawStats.hasOwnProperty('wifi_stats') && Object.entries(wifiStatus).length !== 0) {
      if (!this.status[machineId].wifiStatus) {
        this.status[machineId].wifiStatus = {};
      }
      for (const devId in wifiStatus) {
        this.setDeviceWifiStatus(machineId, devId, mapWifiNames(wifiStatus[devId]));
      }
    };

    // Set VRRP status in memory for now
    for (const vrId in rawStats?.vrrp ?? {}) {
      this.setDeviceVrrpStatus(machineId, vrId, rawStats.vrrp[vrId]);
    }

    // Set BGP status in memory for now.
    // ""> 0" since bgp status arrives once in a few minutes
    if (Object.entries(rawStats?.bgp ?? {}).length > 0) {
      this.setDeviceBgpStatus(machineId, rawStats.bgp);
    }

    // Set tunnel status in memory for now
    const tunnelStatus = rawStats.tunnel_stats;
    if (rawStats.hasOwnProperty('tunnel_stats') && Object.entries(tunnelStatus).length !== 0) {
      if (!this.status[machineId].tunnelStatus) {
        this.status[machineId].tunnelStatus = {};
      }

      // Generate tunnel notifications
      const tunnelStatusEntries = Object.entries(tunnelStatus);
      await Promise.all(tunnelStatusEntries.map(async entry => {
        const [tunnelID, tunnelState] = entry;
        const firstTunnelUpdate = !this.status[machineId].tunnelStatus[tunnelID];

        // Update changed tunnel status in memory by org
        if ((firstTunnelUpdate ||
          tunnelState.status !== this.status[machineId].tunnelStatus[tunnelID].status)) {
          this.setTunnelsStatusByOrg(org, tunnelID, machineId, tunnelState.status);
        }

        // Generate a notification if tunnel status has changed since
        // the last update
        if (
          (firstTunnelUpdate ||
           tunnelState.status !== this.status[machineId].tunnelStatus[tunnelID].status)
        ) {
          const targets = {
            deviceId,
            tunnelId: tunnelID,
            interfaceId: null
          };
          const resolved = tunnelState.status === 'up';
          const notificationName = 'Tunnel connection';
          const notificationKey = await this.generateTunnelNotificationKey(
            notificationName, targets, resolved, org);

          const notification = {
            org: org,
            title: tunnelState.status === 'up' ? '[resolved] Tunnel connection change'
              : 'Tunnel connection change',
            details: 'Tunnel ' + tunnelID + ' state changed to ' + (tunnelState.status === 'down'
              ? 'Not connected' : 'Connected'),
            targets,
            eventType: notificationName,
            resolved
          };

          this.handleNotificationSending(notification, notificationKey);

          // Make sure to send notifications for old devices as before (only RTT and Drop rate)
          const isCustomNotificationsSupported = this.isCustomNotificationsSupported(
            deviceInfo.version);
          if (!isCustomNotificationsSupported) {
            await this.processTunnelNotificationsForOldDevices('Link/Tunnel default drop rate',
              this.status[machineId]?.tunnelStatus[tunnelID]?.drop_rate,
              tunnelState.drop_rate, firstTunnelUpdate, deviceInfo, targets, '%', 5, 20);
            await this.processTunnelNotificationsForOldDevices('Link/Tunnel round trip time',
              this.status[machineId]?.tunnelStatus[tunnelID]?.rtt, tunnelState.rtt,
              firstTunnelUpdate, deviceInfo, targets, 'ms', 300, 600);
          }
        }
      }));
      Object.assign(this.status[machineId].tunnelStatus, rawStats.tunnel_stats);
    }

    // Set interface rx/tx rates in memory
    Object.keys(ifStats).forEach((ifc) => {
      devStats[ifc] = {};
      Object.keys(ifStats[ifc]).forEach((statKey) => {
        const mappedKey = this.statsFieldsMap.get(statKey);
        if (!mappedKey) return;
        devStats[ifc][mappedKey] = ifStats[ifc][statKey] / timeDelta;
      });
    });

    if (Object.entries(devStats).length !== 0) {
      this.setDeviceStatsField(machineId, 'ifStats', devStats);
    }
  }

  /**
     * Get devices status by ID
     * @param  {string} deviceID device host id
     * @return {Object}          details about the device status
     */
  getDeviceStatus (deviceID) {
    return this.status[deviceID];
  }

  /**
   * Remove devices status by ID
   * @param  {string} deviceID device host id
   * @return {void}
   */
  removeDeviceStatus (deviceID) {
    if (deviceID && this.status[deviceID]) {
      delete this.status[deviceID];
    }
  }

  /**
     * Retrieve the tunnel statistics for the specific device
     * @param {string} deviceID Device Id
     * @param {number} tunnelId Tunnel Id
     */
  getTunnelStatus (deviceID, tunnelId) {
    const isConnected = connections.isConnected(deviceID);
    if (!isConnected) {
      return null;
    }
    if (this.status[deviceID] && this.status[deviceID].state !== 'running') {
      return { status: 'down' };
    }
    if (this.status[deviceID] && this.status[deviceID].tunnelStatus) {
      return this.status[deviceID].tunnelStatus[tunnelId] || { status: 'down' };
    }
    return { status: 'down' };
  }

  /**
    * Removes the tunnel status for the specific device
    * @param {string} deviceID Device Id
    * @param {number} tunnelId Tunnel Id
    */
  clearTunnelStatus (deviceID, tunnelId) {
    if (this.status[deviceID] && this.status[deviceID].tunnelStatus &&
      this.status[deviceID].tunnelStatus[tunnelId]) {
      this.status[deviceID].tunnelStatus[tunnelId] = null;
    }
  }

  /**
     * Sets a specific field in the device status object
     * @param  {string} deviceID device host id
     * @param  {string} key      field name
     * @param  {any}    value    field value
     * @return {void}
     */
  setDeviceStatsField (deviceID, key, value) {
    if (!this.status[deviceID]) this.status[deviceID] = {};
    this.status[deviceID][key] = value;
  }

  /**
     * Updates the in-memory representation and the database
     * entries with the total number of bytes processed by the device.
     * @param  {string} org       device organization id
     * @param  {string} deviceID  device host id
     * @param  {Array}  statsList array of device statistics entries
     * @return {void}
     */
  updateUserDeviceStats (org, deviceID, statsList) {
    this.usersDeviceAggregatedStats.org = org;
    this.usersDeviceAggregatedStats.deviceID = deviceID;
    this.usersDeviceAggregatedStats.bytes = 0;

    statsList.forEach((statsEntry) => {
      const ifStats = statsEntry.stats;
      Object.keys(ifStats).forEach((ifc) => {
        this.usersDeviceAggregatedStats.bytes += ifStats[ifc].rx_bytes + ifStats[ifc].tx_bytes;
      });
    });

    if (this.usersDeviceAggregatedStats.bytes > 0) this.updateUsersDevicesStatsInDb();
  }

  /**
    * Updates the total number of bytes processed by a device
    * in the devices database.
    * @return {void}
    */
  async updateUsersDevicesStatsInDb () {
    // Clone the stats object to avoid overriding of the data by next updates
    const stats = Object.assign({}, this.usersDeviceAggregatedStats);
    const month = this.getCurrentMonth();

    // Update the database
    const org = stats.org;
    const device = stats.deviceID;
    const bytes = stats.bytes;

    // save account in order to keep relations between *deleted* orgs and accounts
    const { account } = await orgModel.findOne({ _id: org });

    try {
      const update = {
        $inc: { [`stats.orgs.${org}.devices.${device}.bytes`]: bytes },
        $set: { [`stats.orgs.${org}.account`]: account }
      };
      await deviceAggregateStats.findOneAndUpdate({ month: month }, update, {
        upsert: true,
        useFindAndModify: false
      });
    } catch (err) {
      logger.warn('Error storing aggregated device statistics to db',
        {
          params: { deviceId: device, bytes: bytes, err: err.message },
          periodic: { task: this.taskInfo }
        });
    }

    // Clear the in-memory orgs stats array to avoid duplicate counting
    this.usersDeviceAggregatedStats = {};
  }

  /**
     * Calculates the time stamp of the current month
     * @return {number} time stamp of the current month
     */
  getCurrentMonth () {
    // Set the date to the first day of the month, at 00:00:00
    const date = new Date();
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /**
     * @param  {string} deviceID the device host id
     * @return {number}          last time the device statistics
     *                           were updated in the database
     */
  getDeviceLastUpdateTime (deviceID) {
    return !this.status[deviceID].lastUpdateTime
      ? 0 : this.status[deviceID].lastUpdateTime;
  }

  /**
   * A callback that is called when a device disconnects from the MGMT
   * @param  {string} deviceID device host id
   * @return {void}
   */
  deviceConnectionClosed (deviceID) {
    this.removeDeviceStatus(deviceID);
  }

  /**
   * Sets the devices status information in memory by org
   * @param  {string} org       org id
   * @param  {string} deviceID  device id
   * @param  {string} status    status
   * @param  {string} status    status reason
   * @return {void}
   */
  setDevicesStatusByOrg (org, deviceID, status, reason = '') {
    if (org && deviceID && status !== undefined) {
      if (!this.devicesStatusByOrg.hasOwnProperty(org)) {
        this.devicesStatusByOrg[org] = {};
      }
      this.devicesStatusByOrg[org][deviceID] = status;

      if (!this.devicesStatusReasonByOrg.hasOwnProperty(org)) {
        this.devicesStatusReasonByOrg[org] = {};
      }
      this.devicesStatusReasonByOrg[org][deviceID] = reason;
    }
  }

  /**
   * Gets all organizations ids with updated devices status
   * @return {Array} array of org ids
   */
  getDevicesStatusOrgs () {
    return Object.keys(this.devicesStatusByOrg);
  }

  /**
   * Gets all devices with updated status of the org
   * @param  {string} org the org id
   * @return {Object} an object of devices ids of the org
   * or undefined if no updated statuses
   */
  getDevicesStatusByOrg (org) {
    return this.devicesStatusByOrg[org];
  }

  getDevicesStatusReasonByOrg (org) {
    return this.devicesStatusReasonByOrg[org];
  }

  /**
   * Deletes devices status of the org in memory
   * @param  {string} org the org id
   * @return {void}
   */
  clearDevicesStatusByOrg (org) {
    if (org && this.devicesStatusByOrg.hasOwnProperty(org)) {
      delete this.devicesStatusByOrg[org];
    }
  }

  /**
   * Sets the tunnels status information in memory by org
   * @param  {string} org       org id
   * @param  {string} tunnelNum  tunnel's number
   * @param  {string} status    status
   * @return {void}
   */
  setTunnelsStatusByOrg (org, tunnelNum, machineId, status) {
    if (org && tunnelNum && status !== undefined) {
      if (!this.tunnelsStatusByOrg.hasOwnProperty(org)) {
        this.tunnelsStatusByOrg[org] = {};
      }
      if (!this.tunnelsStatusByOrg[org].hasOwnProperty(tunnelNum)) {
        this.tunnelsStatusByOrg[org][tunnelNum] = {};
      }
      this.tunnelsStatusByOrg[org][tunnelNum][machineId] = status;
    }
  }

  /**
   * Gets all organizations ids with updated tunnels status
   * @return {Array} array of org ids
   */
  getTunnelsStatusOrgs () {
    return Object.keys(this.tunnelsStatusByOrg);
  }

  /**
   * Gets all tunnels with updated status of the org
   * @param  {string} org the org id
   * @return {Object} an object of tunnels ids of the org
   * or undefined if no updated statuses
   */
  getTunnelsStatusByOrg (org) {
    return this.tunnelsStatusByOrg[org];
  }

  /**
   * Deletes tunnels status of the org in memory
   * @param  {string} org the org id
   * @return {void}
   */
  clearTunnelsStatusByOrg (org) {
    if (org && this.tunnelsStatusByOrg.hasOwnProperty(org)) {
      delete this.tunnelsStatusByOrg[org];
    }
  }

  /**
   * Called when a device status is received on the hosts channel from another server
   * @param  {string} machineId the machine id
   * @param  {object} status    new status of the device
   * @return {void}
   */
  statusCallback (machineId, status) {
    if (this.status[machineId]?.state !== status.state) {
      const deviceInfo = connections.getDeviceInfo(machineId);
      if (!deviceInfo) {
        logger.warn('Failed to get device info', {
          params: { machineId }
        });
        return;
      }
      const { org, deviceObj } = deviceInfo;
      this.setDevicesStatusByOrg(org, deviceObj, status.state);
    }
    this.status[machineId] = status;

    // Update changed tunnel status in memory by org
    if (status.tunnelStatus) {
      const { tunnelStatus } = status;
      const { org } = connections.getDeviceInfo(machineId) ?? {};
      for (const tunnelID in tunnelStatus) {
        this.setTunnelsStatusByOrg(org, tunnelID, machineId, tunnelStatus.status);
      }
    }
  }
}

var deviceStatus = null;
module.exports = function () {
  if (deviceStatus) return deviceStatus;
  else {
    deviceStatus = new DeviceStatus();
    return deviceStatus;
  }
};
