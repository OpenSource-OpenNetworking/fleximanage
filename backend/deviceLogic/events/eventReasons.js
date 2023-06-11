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

const pendingTypes = {
  // if interfaces loses is IP, we set tunnels/static routes
  // via this interface as pending due to missing ip
  interfaceHasNoIp: 'interfaceHasNoIp',
  // if tunnel marked as pending, we set static routes
  // via this tunnel as pending due to tunnel pending
  tunnelIsPending: 'tunnelIsPending',
  // if we marked tunnels as pending because we are waiting for STUN in both sides
  waitForStun: 'waitForStun',
  // if public port changed a lot and tunnel is down,
  // we reduce system effort and put tunnels as pending until the port will be stabilized
  publicPortHighRate: 'publicPortHighRate'
};

const pendingReasons = {
  [pendingTypes.interfaceHasNoIp]: (ifcName, deviceName) => {
    return `Interface ${ifcName} in device ${deviceName} has no IP address`;
  },
  [pendingTypes.tunnelIsPending]: (tunnelNumber) => {
    return `Tunnel ${tunnelNumber} is in pending state`;
  },
  [pendingTypes.waitForStun]: () => {
    return 'Wait for STUN update to reconstruct. ' +
    'To activate it without waiting for STUN, click on the "sync" button';
  },
  [pendingTypes.publicPortHighRate]: (ifcName, deviceName) => {
    return `The public IP/Port of interface ${ifcName}` +
    ` in device ${deviceName} is changing at a high rate.\n` +
    ' Usually this is due to ISP symmetric NAT with port randomization.\n' +
    ' Self-healing is disabled for this tunnel and it might lose connection.\n' +
    ' Recommended action: Disable STUN on the mentioned interface.\n' +
    ' Click on "Sync" button for that device to re-enable self-healing.';
  }
};

const getReason = (type, ...args) => {
  return pendingReasons[type](...args);
};

module.exports = {
  pendingTypes,
  getReason
};
