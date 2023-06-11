// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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

const mongoose = require('mongoose');
const { devices } = require('../models/devices');
const tunnelsModel = require('../models/tunnels');
const notificationsMgr = require('../notifications/notifications')();
const cidr = require('cidr-tools');
const keyBy = require('lodash/keyBy');
const { getTunnelConfigDependencies } = require('./tunnels');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { apply } = require('./modifyDevice');
const { pendingTypes, getReason } = require('./events/eventReasons');
const publicAddrInfoLimiter = require('./publicAddressLimiter');
const { getMajorVersion } = require('../versioning');

class Events {
  constructor () {
    this.changedDevices = [];
    this.pendingTunnels = new Set();
    this.activeTunnels = new Set();
  }

  /**
   * Add device id to the changed devices list
   * @param  {string} deviceId device id
   * @param  {object?} origDevice origDevice object. We need it for modifyDevice process.
  */
  async addChangedDevice (deviceId, origDevice = null) {
    const id = deviceId.toString();
    if (!this.changedDevices[id]) {
      // save the orig device for job processing
      if (!origDevice) {
        origDevice = await devices.findOne({ _id: id });
      }

      this.changedDevices[id] = {
        orig: origDevice
      };
    }
  }

  /**
   * Handle event of static route become pending
   * @param  {object} route route object
   * @param  {object} device device object
   * @param  {string} reason  notification reason
  */
  async staticRouteSetToPending (route, device, reason) {
    await notificationsMgr.sendNotifications([{
      org: device.org,
      title: `Static route via ${route.gateway} in device ${device.name} is in pending state`,
      time: new Date(),
      device: device._id,
      machineId: device.machineId,
      details: reason
    }]);
  }

  /**
   * Handle public port/ip rate limited
   * @param  {object} origDevice device object
   * @param  {object} origIfc interface object
  */
  async publicInfoIsRateLimited (origDevice, origIfc) {
    logger.error('Public address rate limit exceeded. tunnels will set as pending',
      { params: { deviceId: origDevice._id, interfaceId: origIfc._id } }
    );

    const pendingType = pendingTypes.publicPortHighRate;
    const reason = getReason(pendingType, origIfc.name, origDevice.name);
    await this.setDeviceTunnelsAsPending(origDevice, origIfc, reason, pendingType, false);
  }

  /**
   * Handle public port/ip rate limit released
   * @param  {object} origDevice device object
   * @param  {object} origIfc interface object
  */
  async publicInfoRateLimitIsReleased (origDevice, origIfc) {
    await this.removePendingStateFromTunnels(origDevice, origIfc);
  }

  /**
   * Set pending state for tunnel if needed and send notification
   * @param  {number} num  tunnel number
   * @param  {string} org  organization id
   * @param  {boolean} isPending  indicate if need set as pending or not
   * @param  {string} reason  incomplete reason
   * @param  {object} device  device of incomplete tunnel
  */
  async setRemovePendingTunnelStatus (num, org, isPending, reason, pendingType, device) {
    await this.addChangedDevice(device._id);

    const tunnel = await tunnelsModel.findOneAndUpdate(
      // Query, use the org and tunnel number
      { org, num },
      {
        $set: {
          isPending: isPending,
          pendingReason: isPending ? reason : '',
          pendingType: isPending ? pendingType : '',
          pendingTime: isPending ? new Date() : ''
        }
      },
      // Options
      { upsert: false, new: true }
    ).lean();

    if (isPending) {
      this.pendingTunnels.add(tunnel._id.toString());
      await this.tunnelSetToPending(tunnel, device, reason);
    } else {
      this.activeTunnels.add(tunnel._id.toString());
      await this.tunnelSetToActive(tunnel);
    }
  };

  /**
   * Update pending tunnel reason
   * @param  {number} num  tunnel number
   * @param  {string} org  organization id
   * @param  {string} reason  incomplete reason
   * @param  {string} pendingType  pending type
  */
  async updatePendingTunnelReason (num, org, reason, pendingType) {
    await tunnelsModel.updateOne(
      // Query, use the org and tunnel number
      { org, num },
      {
        $set: {
          pendingReason: reason,
          pendingType: pendingType,
          pendingTime: new Date()
        }
      },
      // Options
      { upsert: false }
    );
  };

  /**
   * Send notification about interface connectivity state
   * @param  {object} device device object
   * @param  {object} origIfc interface object
   * @param  {boolean} state if true, the connectivity is online
  */
  async interfaceConnectivityChanged (device, origIfc, state) {
    const stateTxt = state === 'yes' ? 'online' : 'offline';
    logger.info(`Interface connectivity changed to ${stateTxt}`, { params: { origIfc } });
    await notificationsMgr.sendNotifications([{
      org: device.org,
      title: 'Interface connection changed',
      time: new Date(),
      device: device._id,
      machineId: device.machineId,
      details: `Interface ${origIfc.name} state changed to "${stateTxt}"`
    }]);
  };

  /**
   * Handle interface ip restored event
   * @param  {object} device device object
   * @param  {object} origIfc original interface object
   * @param  {object} ifc updated interface object
  */
  async interfaceIpExists (device, origIfc, ifc) {
    // no need to print it every time
    if (origIfc.hasIpOnDevice === false && ifc.hasIpOnDevice) {
      logger.info('Interface IP restored', {
        params: {
          deviceId: device._id,
          origIp: origIfc.IPv4,
          updatedIp: ifc.IPv4
        }
      });

      // only at the first time - send notification
      await notificationsMgr.sendNotifications([{
        org: device.org,
        title: 'Interface IP restored',
        time: new Date(),
        device: device._id,
        machineId: device.machineId,
        details: `The IP address of Interface ${origIfc.name} has been restored`
      }]);
    }

    if (origIfc.type === 'WAN') {
      // unset related tunnels as pending
      await this.removePendingStateFromTunnels(device, origIfc);
    }

    // unset related static routes as pending
    for (let i = 0; i < device.staticroutes.length; i++) {
      const s = device.staticroutes[i];
      if (!s.isPending) continue;

      const isSameIfc = s.ifname === ifc.devId;

      const gatewaySubnet = `${s.gateway}/32`;
      const isOverlapping = cidr.overlap(`${ifc.IPv4}/${ifc.IPv4Mask}`, gatewaySubnet);

      if (isSameIfc || isOverlapping) {
        await this.setIncompleteRouteStatus(s, false, '', '', device);
      }
    }
  };

  /**
   * Remove pending status from tunnels
   * @param  {object} device device object
   * @param  {?object} origIfc Original interface object.
   *  If not specified, The system will remove all device's tunnels
   * @param {boolean} forceWaitForStunRelease if true, wait for stun will be
   *  released even without public ports
  */
  async removePendingStateFromTunnels (device, origIfc = null, forceWaitForStunRelease = false) {
    const orQuery = [];
    if (origIfc) {
      orQuery.push({ deviceA: device._id, interfaceA: origIfc._id });
      orQuery.push({ deviceB: device._id, interfaceB: origIfc._id });
    } else {
      orQuery.push({ deviceA: device._id });
      orQuery.push({ deviceB: device._id });
    };

    const tunnels = await tunnelsModel.find({
      $or: orQuery,
      isActive: true
    })
      .populate('deviceA', '_id name interfaces')
      .populate('deviceB', '_id name interfaces')
      .lean();

    for (const tunnel of tunnels) {
      // at this point, set tunnel to active
      await this.setOneTunnelAsActive(tunnel, device, forceWaitForStunRelease);
    };
  }

  /**
   * Handle event: Interface has no expected IP
   * @param  {object} device device object
   * @param  {object} origIfc original interface before the event
   * @param  {object} ifc updated ifc from the device
  */
  async interfaceIpMissing (device, origIfc, ifc) {
    // only at the first time - send notification
    if (origIfc.hasIpOnDevice) {
      logger.info('Interface IP missing', { params: { origIfc, ifc } });
      await notificationsMgr.sendNotifications([{
        org: device.org,
        title: 'Interface IP missing',
        time: new Date(),
        device: device._id,
        machineId: device.machineId,
        details: `The interface ${origIfc.name} has no IP address`
      }]);
    }

    const pendingType = pendingTypes.interfaceHasNoIp;
    const reason = getReason(pendingType, origIfc.name, device.name);

    if (origIfc.type === 'WAN' && origIfc.dhcp === 'yes') {
      // set related tunnels as pending
      // static ip shouldn't set to pending - flexiManage knows how to configure it
      await this.setDeviceTunnelsAsPending(device, origIfc, reason, pendingType);
    }

    // for device version 4 we don't send the IP for bridged interface
    const deviceVersion = getMajorVersion(device.versions.agent);
    if (deviceVersion <= 4) {
      return;
    }

    // set related static routes as pending
    for (let i = 0; i < device.staticroutes.length; i++) {
      const s = device.staticroutes[i];
      if (s.isPending) continue;

      // check if the static route configured with the same devId as the missing IP interface
      const isSameIfc = s.ifname === ifc.devId;
      if (isSameIfc) {
        await this.setIncompleteRouteStatus(s, true, reason, pendingType, device);
        continue;
      }

      // check if the static route gateway is overlaps with the missing IP interface
      if (origIfc.IPv4 && origIfc.IPv4Mask && s.gateway) {
        const gatewaySubnet = `${s.gateway}/32`;
        const isOverlapping = cidr.overlap(`${origIfc.IPv4}/${origIfc.IPv4Mask}`, gatewaySubnet);

        if (isOverlapping) {
          await this.setIncompleteRouteStatus(s, true, reason, pendingType, device);
        }
      }
    }
  };

  /**
   * Set pending status to a tunnel
   * @param  {object} tunnel tunnel object
   * @param  {string} reason indicate why tunnel should be pending
   * @param  {string} pendingType the pending type
   * @param  {object} device device object
  */
  async setOneTunnelAsPending (tunnel, reason, pendingType, device) {
    // if tunnel already pending
    if (tunnel.isPending) {
      // if reason is different - update reason
      if (reason !== tunnel.pendingReason) {
        await this.updatePendingTunnelReason(tunnel.num, tunnel.org, reason, pendingType);
      }

      await this.tunnelSetToPending(tunnel, device, reason, false);
      return;
    }

    // set active tunnel to pending
    await this.setRemovePendingTunnelStatus(
      tunnel.num, tunnel.org, true, reason, pendingType, device);
  }

  /**
   * Set active status to a pending tunnel
   * @param  {object} tunnel tunnel object
   * @param  {object} device device object
   * @param {boolean} forceWaitForStunRelease if true, wait for stun will be
   *  released even without public ports
  */
  async setOneTunnelAsActive (tunnel, device, forceWaitForStunRelease = false) {
    const {
      isPending, pendingReason, pendingType, deviceA, deviceB, peer, interfaceA, interfaceB
    } = tunnel;

    // no need to update active tunnels, go and check routes
    if (!isPending) {
      await this.tunnelSetToActive(tunnel);
      return;
    }

    // get tunnel interfaces
    const ifcA = deviceA.interfaces.find(i => i._id.toString() === interfaceA.toString());
    let ifcB = null;
    if (!peer) {
      ifcB = deviceB.interfaces.find(i => i._id.toString() === interfaceB.toString());
    }

    // check if should keep it pending due to other reasons
    //
    // check for no ip
    if (ifcA.IPv4 === '' || (ifcB && ifcB.IPv4 === '')) {
      let ifcWithoutIp, deviceWithoutIp;
      if (peer) {
        ifcWithoutIp = ifcA;
        deviceWithoutIp = deviceA;
      } else {
        ifcWithoutIp = ifcA.IPv4 === '' ? ifcA : ifcB;
        deviceWithoutIp = ifcA.IPv4 === '' ? deviceA : deviceB;
      }

      const pendingType = pendingTypes.interfaceHasNoIp;
      const reason = getReason(pendingType, ifcWithoutIp.name, deviceWithoutIp.name);
      if (pendingReason !== reason) {
        await this.updatePendingTunnelReason(tunnel.num, tunnel.org, reason, pendingType);
      }
      return;
    }

    // check for rate limit blockage, peer is not blocked by public address limiter
    if (!peer) {
      const isABlocked = await publicAddrInfoLimiter.isBlocked(`${deviceA._id}:${ifcA._id}`);
      const isBBlocked = await publicAddrInfoLimiter.isBlocked(`${deviceB._id}:${ifcB._id}`);
      if (isABlocked || isBBlocked) {
        const pendingType = pendingTypes.publicPortHighRate;
        const reason = isABlocked
          ? getReason(pendingType, ifcA.name, deviceA.name)
          : getReason(pendingType, ifcB.name, deviceB.name);

        if (pendingReason !== reason) {
          await this.updatePendingTunnelReason(tunnel.num, tunnel.org, reason, pendingType);
        }
        return;
      }
    }

    // don't release tunnels that wait for STUN and no public port in both interfaces
    // if forceWaitForStunRelease is true, we release it with the default public port
    if (pendingType === pendingTypes.waitForStun && !forceWaitForStunRelease) {
      if (ifcA.PublicPort === '' || ifcB?.PublicPort === '') {
        return;
      }
    }

    logger.debug('Set Tunnel to active',
      { params: { num: tunnel.num, org: tunnel.org, trace: new Error().stack } }
    );

    // set pending tunnel to active state
    await this.setRemovePendingTunnelStatus(tunnel.num, tunnel.org, false, '', '', device);
  }

  /**
   * Set all device tunnels to pending state
   * @param  {object} device device object
   * @param  {object} origIfc original interface before the event
   * @param  {string} reason indicate why tunnel should be pending
   * @param  {string} pendingType the pending type
  */
  async setDeviceTunnelsAsPending (device, origIfc, reason, pendingType, includingPeers = true) {
    const query = {
      $or: [
        { deviceA: device._id, interfaceA: origIfc._id },
        { deviceB: device._id, interfaceB: origIfc._id }
      ],
      isActive: true
    };

    if (!includingPeers) {
      query.peer = null; // only normal tunnels
    }
    const tunnels = await tunnelsModel.find(query).lean();

    for (const tunnel of tunnels) {
      await this.setOneTunnelAsPending(tunnel, reason, pendingType, device);
    };
  }

  /**
   * Handle event: tunnel configured as a pending
   * @param  {object} tunnel tunnel object
   * @param  {object} device device that caused the event
   * @param  {string} reason indicate why tunnel should be pending
   * @param  {boolean} notify indicate if need to notify
  */
  async tunnelSetToPending (tunnel, device, reason, notify = true) {
    if (notify) {
      await notificationsMgr.sendNotifications([{
        org: tunnel.org,
        title: `Tunnel number ${tunnel.num} is in pending state`,
        time: new Date(),
        device: device._id,
        machineId: device.machineId,
        details: reason
      }]);
    }

    const dependedDevices = await getTunnelConfigDependencies(tunnel, false);

    for (const dependedDevice of dependedDevices) {
      for (const staticRoute of dependedDevice.staticroutes) {
        const pendingType = pendingTypes.tunnelIsPending;
        const reason = getReason(pendingType, tunnel.num);
        await this.setIncompleteRouteStatus(staticRoute, true, reason, pendingType, dependedDevice);
      }
    }
  };

  /**
   * Handle event: tunnel configured as a active
   * @param  {object} tunnel tunnel object
  */
  async tunnelSetToActive (tunnel) {
    // get tunnel static routes
    const dependedDevices = await getTunnelConfigDependencies(tunnel, true);

    for (const dependedDevice of dependedDevices) {
      for (const staticRoute of dependedDevice.staticroutes) {
        await this.setIncompleteRouteStatus(staticRoute, false, '', '', dependedDevice);
      }
    }
  };

  /**
   * Set incomplete state for static route if needed
   * @param  {object} route  static route object
   * @param  {boolean} isIncomplete  indicate if need set as incomplete or not
   * @param  {string} reason  incomplete reason
   * @param  {string} pendingType  pending type
   * @param  {object} device  device of incomplete tunnel
  */
  async setIncompleteRouteStatus (route, isIncomplete, reason, pendingType, device) {
    await this.addChangedDevice(device._id);

    await devices.findOneAndUpdate(
      { _id: mongoose.Types.ObjectId(device._id) },
      {
        $set: {
          'staticroutes.$[elem].isPending': isIncomplete,
          'staticroutes.$[elem].pendingType': isIncomplete ? pendingType : '',
          'staticroutes.$[elem].pendingReason': isIncomplete ? reason : '',
          'staticroutes.$[elem].pendingTime': isIncomplete ? new Date() : ''
        }
      },
      {
        arrayFilters: [{ 'elem._id': mongoose.Types.ObjectId(route._id) }]
      }
    );

    if (isIncomplete) {
      await this.staticRouteSetToPending(route, device, reason);
    }
  };

  /**
   * Computes and checks if need to trigger event
   * @param  {object} origDevice  original device from DB
   * @param  {array} newInterfaces  incoming interfaces from the device
  */
  async analyze (origDevice, newInterfaces) {
    try {
      const orig = keyBy(origDevice.interfaces, 'devId');
      const updated = keyBy(newInterfaces, 'devId');

      for (const devId in orig) {
        const origIfc = orig[devId];
        const updatedIfc = updated[devId];

        // no need to send events for unassigned interfaces
        if (!origIfc.isAssigned) {
          continue;
        }

        await this.handleConnectivityChange(origDevice, origIfc, updatedIfc);

        await this.handlePublicAddrChange(origDevice, origIfc, updatedIfc);

        await this.handleMissingIP(origDevice, updatedIfc, origIfc);

        await this.handleExistsIP(origDevice, updatedIfc, origIfc);
      }
    } catch (err) {
      logger.error('events check failed', { params: { err: err.message } });
      throw err;
    }
  }

  /**
   * Check and handle interface with IP
   * @param  {object} origDevice original device object
   * @param  {string} updatedIfc updated interface object
   * @param  {string} origIfc original interface object
  */
  async handleExistsIP (origDevice, updatedIfc, origIfc) {
    if (this.isIpExists(updatedIfc)) {
      await this.interfaceIpExists(origDevice, origIfc, updatedIfc);
    }
  }

  /**
   * Check and handle interface without IP
   * @param  {object} origDevice original device object
   * @param  {string} updatedIfc updated interface object
   * @param  {string} origIfc original interface object
  */
  async handleMissingIP (origDevice, updatedIfc, origIfc) {
    if (this.isIpMissing(updatedIfc)) {
      await this.interfaceIpMissing(origDevice, origIfc, updatedIfc);
    }
  }

  /**
   * Check and handle change in public IP or public port
   * @param  {object} origDevice original device object
   * @param  {string} updatedIfc updated interface object
   * @param  {string} origIfc original interface object
  */
  async handlePublicAddrChange (origDevice, origIfc, updatedIfc) {
    // if orig public port is empty and not we have new public port,
    // check if need to active pending tunnels due to "wait for stun"
    if (origIfc.PublicPort === '' && updatedIfc.PublicPort !== '') {
      const tunnels = await tunnelsModel.find({
        org: origDevice.org,
        isActive: true,
        isPending: true,
        pendingType: pendingTypes.waitForStun,
        $or: [
          { interfaceA: updatedIfc._id },
          { interfaceB: updatedIfc._id }
        ]
      })
        .populate('deviceA', '_id name interfaces')
        .populate('deviceB', '_id name interfaces');

      for (const tunnel of tunnels) {
        const { deviceA, deviceB, interfaceA, interfaceB, peer, num } = tunnel;

        const ifcAId = interfaceA.toString();
        const ifcBId = peer ? null : interfaceB.toString();
        // we now that we have new public port in this tunnel side.
        // let's check the other side. If both have public port, we can activate.
        const ifcA = deviceA.interfaces.find(i => i._id.toString() === ifcAId);
        const ifcB = peer ? null : deviceB.interfaces.find(i => i._id.toString() === ifcBId);

        const secondTunnelSide = updatedIfc._id.toString() === ifcAId ? ifcB : ifcA;

        if (secondTunnelSide.PublicPort !== '') {
          await this.setOneTunnelAsActive(tunnel, origDevice);
        } else {
          logger.info(
            `Tunnel ${num} is pending and waits for STUN. ` +
            `Interface got public port (${updatedIfc.PublicPort}) but ` +
            'the other side of the tunnel still does not have. waiting for the other side',
            { params: { tunnelNum: num, org: origDevice.org } }
          );
        }
      }
    }

    await this.handlePublicInfoLimiter(origDevice, origIfc, updatedIfc);
  }

  /**
   * Handle limiter logic of public ip/port change
   * @param  {object} origDevice original device object
   * @param  {string} updatedIfc updated interface object
   * @param  {string} origIfc original interface object
  */
  async handlePublicInfoLimiter (origDevice, origIfc, updatedIfc) {
    const isPublicPortChangeShouldBeCounted = (origIfc, updatedIfc) => {
      // if STUN is disabled for this interface, no need to count it
      if (origIfc.useStun === false) {
        return false;
      }

      // if not ip, there is no public port, so we can't count it as change
      if (updatedIfc.IPv4 === '' || updatedIfc.PublicPort === '') {
        return false;
      }

      if (origIfc.PublicPort === updatedIfc.PublicPort.toString()) {
        return false;
      }

      return true;
    };

    const isPublicIpChangeShouldBeCounted = (origIfc, updatedIfc) => {
      // if STUN is disabled for this interface, no need to count it
      if (origIfc.useStun === false) {
        return false;
      }

      // if not ip, there is no public port, so we can't count it as change
      if (updatedIfc.IPv4 === '' || updatedIfc.PublicIP === '') {
        return false;
      }

      if (origIfc.PublicIP === updatedIfc.PublicIP) {
        return false;
      }

      return true;
    };

    const isPublicPortChanged = isPublicPortChangeShouldBeCounted(origIfc, updatedIfc);
    const isPublicIpChanged = isPublicIpChangeShouldBeCounted(origIfc, updatedIfc);

    if (!isPublicPortChanged && !isPublicIpChanged) {
      return;
    }

    const key = `${origDevice._id.toString()}:${origIfc._id.toString()}`;
    const { allowed, blockedNow, releasedNow } = await publicAddrInfoLimiter.use(key);
    if (releasedNow) {
      await this.publicInfoRateLimitIsReleased(origDevice, origIfc);
      return;
    }

    if (!allowed && blockedNow) {
      await this.publicInfoIsRateLimited(origDevice, origIfc);
    }
  }

  async handleConnectivityChange (origDevice, origIfc, updatedIfc) {
    if (this.isInterfaceConnectivityChanged(origIfc, updatedIfc)) {
      await this.interfaceConnectivityChanged(origDevice, origIfc, updatedIfc.internetAccess);
    }
  }

  /**
   * Check if WAN interface lost connectivity
   * @param  {object} origIfc  interface from flexiManage DB
   * @param  {object} updatedIfc  incoming interface info from device
   * @return {boolean} if need to trigger event of internet connectivity lost
  */
  isInterfaceConnectivityChanged (origIfc, updatedIfc) {
    if (!origIfc.monitorInternet) {
      return false;
    }

    if (updatedIfc.internetAccess === origIfc.internetAccess) {
      return false;
    }

    return true;
  };

  /**
   * Prepares a dictionary of routers to send to modify-device job
   * @return {{machineId: {orig: object, updated: object}}} dictionary with orig and updated device
   */
  async prepareModifyDispatcherParameters () {
    const modifyDevices = { /* original, updated */ };

    const devicesIds = Object.keys(this.changedDevices);

    let updatedDevices = await devices.find({
      _id: { $in: devicesIds }
    }).populate('interfaces.pathlabels', '_id name type');

    updatedDevices = keyBy(updatedDevices, '_id');

    for (const deviceId in this.changedDevices) {
      const orig = this.changedDevices[deviceId].orig;
      const machineId = orig.machineId;
      modifyDevices[machineId] = {
        orig: orig,
        updated: updatedDevices[deviceId]
      };
    }

    return modifyDevices;
  };

  /**
   * Check if IP is exists on an interface
   * @param  {object} updatedIfc  incoming interface info from device
   * @return {boolean} if need to trigger event of ip restored
  */
  isIpExists (updatedIfc) {
    // check if the incoming interface has ip address
    if (updatedIfc.IPv4 === '') {
      return false;
    }

    return true;
  };

  /**
   * Check if IP is missing on an interface
   * @param  {object} updatedIfc  incoming interface info from device
   * @return {boolean} if need to trigger event of ip lost
   */
  isIpMissing (updatedIfc) {
    // check if incoming interface is without ip address
    if (updatedIfc.IPv4 !== '') {
      return false;
    }
    if (updatedIfc.type === 'TRUNK') { // TRUNK interfaces don't have an IP address
      return false;
    };
    return true;
  };
}

/**
 * Remove all pending tunnels for a device
 * @param {object} device  device object
 * @param {boolean} forceWaitForStunRelease wait for stun will be released even without public ports
*/
const activatePendingTunnelsOfDevice = async (device, forceWaitForStunRelease = false) => {
  // we have the needed logic for this operation in the event class.
  // so we use its method to get tunnels via this device
  // and release them, and then it triggers the events chain once tunnel becomes active.
  const events = new Events();
  await events.removePendingStateFromTunnels(device, null, forceWaitForStunRelease);

  const modifyDevices = await events.prepareModifyDispatcherParameters();
  for (const modified in modifyDevices) {
    await apply(
      [modifyDevices[modified].orig],
      { username: 'system' },
      {
        org: modifyDevices[modified].orig.org.toString(),
        newDevice: modifyDevices[modified].updated,
        sendAddTunnels: events.activeTunnels
      }
    );
  }
};

const releasePublicAddrLimiterBlockage = async (device) => {
  let blockagesReleased = false;

  const wanIfcs = device.interfaces.filter(i => i.type === 'WAN');
  const deviceId = device._id.toString();

  for (const ifc of wanIfcs) {
    const ifcId = ifc._id.toString();
    const isReleased = await publicAddrInfoLimiter.release(`${deviceId}:${ifcId}`);
    if (isReleased) {
      blockagesReleased = true;
    }
  }

  return blockagesReleased;
};

module.exports = Events; // default export
exports = module.exports;

exports.activatePendingTunnelsOfDevice = activatePendingTunnelsOfDevice; // named export
exports.releasePublicAddrLimiterBlockage = releasePublicAddrLimiterBlockage; // named export
exports.publicAddrInfoLimiter = publicAddrInfoLimiter; // named export
