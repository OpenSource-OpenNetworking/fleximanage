// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2023  flexiWAN Ltd.

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
const { getMajorVersion, getMinorVersion } = require('../versioning');

const isLanNatSupported = (device) => {
  const majorVersion = getMajorVersion(device.versions.agent);
  const minorVersion = getMinorVersion(device.versions.agent);
  return (majorVersion > 6 || (majorVersion === 6 && minorVersion >= 3));
};

/**
 * Gets the device LAN NAT info for creating a job
 * @param   {Object} device - the device object where to send LAN NAT parameters
 * @param   {Boolean} isSync - true if called for generating sync tasks
 * @return  {Object} parameters to include in the job response data
*/
const getLanNatJobInfo = (device, isSync = false) => {
  const tasks = [];
  if (!isLanNatSupported(device)) {
    return { tasks };
  }
  const lanNatRules = device.firewall?.rules?.filter(
    r => r.enabled && r.direction === 'lanNat'
  ).sort((r1, r2) => r1.priority - r2.priority).map(rule => {
    return {
      source: rule.classification?.source?.lanNat,
      destination: rule.classification?.destination?.lanNat
    };
  });
  if (lanNatRules?.length > 0) {
    const params = { 'nat44-1to1': lanNatRules };
    tasks.push({
      entity: 'agent',
      message: 'add-lan-nat-policy',
      params: params
    });
  } else if (!isSync) {
    tasks.push({
      entity: 'agent',
      message: 'remove-lan-nat-policy',
      params: null
    });
  }
  return { tasks };
};

/**
 * Creates the LAN NAT section in the full sync job.
 * @return Object
 */
const sync = async (deviceId, org, device) => {
  const callComplete = false;
  // if no firewall policy then device specific rules will be sent
  const res = getLanNatJobInfo(device, true);
  return {
    requests: res.tasks,
    callComplete
  };
};

module.exports = { getLanNatJobInfo, sync };
