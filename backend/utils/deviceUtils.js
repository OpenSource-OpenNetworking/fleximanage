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

const path = require('path');
const apnsJson = require(path.join(__dirname, 'mcc_mnc_apn.json'));

/**
 * Get the default gateway of the device
 * @param {Object}  device
 * @return {string} defaultRouter
 */
const getDefaultGateway = device => {
  const defaultIfc = device.interfaces.reduce((d, i) => {
    return i.type !== 'WAN' || i.routing !== 'NONE' || !i.gateway ||
      (d && Number(d.metric) < Number(i.metric)) ? d : i;
  }, false);
  return !defaultIfc ? device.defaultRoute : defaultIfc.gateway;
};

const mapWifiNames = agentData => {
  const map = {
    ap_status: 'accessPointStatus'
  };
  return renameKeys(agentData, map);
};

/**
 * Map the LTE keys that come from the agent into one convention.
 * The keys from the agent are a bit messy, some with uppercase and some with lowercase, etc.
 * So this function is mapping between agent to an object with names in one convention.
 * @param {Object}  agentData LTE data from agent
 * @return {Object} Mapped object
 */
const mapLteNames = agentData => {
  const map = {
    sim_status: 'simStatus',
    hardware_info: 'hardwareInfo',
    packet_service_state: 'packetServiceState',
    phone_number: 'phoneNumber',
    system_info: 'systemInfo',
    default_settings: 'defaultSettings',
    pin_state: 'pinState',
    connection_state: 'connectionState',
    registration_network: 'registrationNetworkState',
    network_error: 'networkError',
    register_state: 'registrationState',
    PIN1_RETRIES: 'pin1Retries',
    PIN1_STATUS: 'pin1Status',
    PUK1_RETRIES: 'puk1Retries',
    pin1_retries: 'pin1Retries',
    pin1_status: 'pin1Status',
    puk1_retries: 'puk1Retries',
    cell_id: 'cellId',
    Cell_Id: 'cellId',
    Operator_Name: 'operatorName',
    operator_name: 'operatorName',
    Vendor: 'vendor',
    Model: 'model',
    Imei: 'imei',
    Uplink_speed: 'uplinkSpeed',
    uplink_speed: 'uplinkSpeed',
    Downlink_speed: 'downlinkSpeed',
    downlink_speed: 'downlinkSpeed',
    APN: 'apn',
    UserName: 'userName',
    Password: 'password',
    Auth: 'auth',
    RSRP: 'rsrp',
    RSRQ: 'rsrq',
    RSSI: 'rssi',
    SINR: 'sinr',
    SNR: 'snr',
    MCC: 'mcc',
    MNC: 'mnc'
  };

  return renameKeys(agentData, map);
};

const parseLteStatus = lteStatus => {
  lteStatus = mapLteNames(lteStatus);

  // calc default apn
  const defaultApn = lteStatus.defaultSettings ? lteStatus.defaultSettings.apn : '';
  const mcc = lteStatus.systemInfo.mcc;
  const mnc = lteStatus.systemInfo.mnc;

  if (defaultApn === '' && mcc && mnc) {
    const key = mcc + '-' + mnc;
    if (apnsJson[key]) {
      lteStatus.defaultSettings.apn = apnsJson[key];
    }
  }

  return lteStatus;
};

const renameKeys = (obj, map) => {
  Object.keys(obj).forEach(key => {
    const newKey = map[key];
    let value = obj[key];

    if (value && typeof value === 'object') {
      value = renameKeys(value, map);
    }

    if (newKey) {
      obj[newKey] = value;
      delete obj[key];
    } else {
      obj[key] = value;
    }
  });
  return obj;
};

/**
 * Calculation bridges by interfaces list
 * @param {array}  interfaces LTE data from agent
 * @return {object} dictionary contains the bridge IP as key with array of devIds
 */
const getBridges = interfaces => {
  const bridges = {};

  for (const ifc of interfaces) {
    const devId = ifc.devId;

    if (!ifc.isAssigned) {
      continue;
    }

    if (ifc.type !== 'LAN') {
      continue;
    }

    if (ifc.IPv4 === '' || ifc.IPv4Mask === '') {
      continue;
    }
    const addr = ifc.IPv4 + '/' + ifc.IPv4Mask;

    const needsToBridge = interfaces.some(i => {
      return devId !== i.devId && addr === i.IPv4 + '/' + i.IPv4Mask;
    });

    if (!needsToBridge) {
      continue;
    }

    if (!bridges.hasOwnProperty(addr)) {
      bridges[addr] = [];
    }

    bridges[addr].push(ifc.devId);
  };

  return bridges;
};

// Default exports
module.exports = {
  getDefaultGateway,
  getBridges,
  mapLteNames,
  parseLteStatus,
  mapWifiNames
};
