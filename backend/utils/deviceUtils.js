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

const Joi = require('joi');
const path = require('path');
const apnsJson = require(path.join(__dirname, 'mcc_mnc_apn.json'));
const wifiChannels = require('./wifi-channels');
const { getOrgDefaultTunnelPort } = require('../utils/tunnelUtils');
const SHA1 = require('crypto-js/sha1');

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

/**
 * Checks whether a value is empty
 * @param  {string}  val the value to be checked
 * @return {boolean}     true if the value is empty, false otherwise
 */
const isEmpty = (val) => { return val === null || val === undefined || val === ''; };

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
  const defaultApn = lteStatus.defaultSettings?.apn ?? '';
  const mcc = lteStatus.systemInfo?.mcc;
  const mnc = lteStatus.systemInfo?.mnc;

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
      return i.isAssigned &&
        devId !== i.devId &&
        addr === i.IPv4 + '/' + i.IPv4Mask &&
        i.type === 'LAN';
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

/**
 * Get CPU info or set default values
 * @param {object}  cpuInfo object with CPU info
 * @return {object} object with CPU info or default values
 */
const getCpuInfo = cpuInfo => {
  // device vpp cores
  const vppCores = cpuInfo?.vppCores ? parseInt(cpuInfo?.vppCores) : 1;

  // configured vpp cores. It might be different than vppCores,
  // since vppCores reflects the current value of the device
  // and configuredVppCores is what user configured.
  const configuredVppCores =
    cpuInfo?.configuredVppCores ? parseInt(cpuInfo?.configuredVppCores) : vppCores;

  return {
    hwCores: cpuInfo?.hwCores ? parseInt(cpuInfo.hwCores) : 2,
    grubCores: cpuInfo?.grubCores ? parseInt(cpuInfo.grubCores) : 2,
    vppCores: vppCores,
    configuredVppCores: configuredVppCores,
    powerSaving: cpuInfo?.powerSaving === true
  };
};

const lteConfigurationSchema = Joi.object().keys({
  enable: Joi.boolean().required(),
  apn: Joi.string().required(),
  auth: Joi.string().valid('MSCHAPV2', 'PAP', 'CHAP').allow(null, ''),
  user: Joi.string().allow(null, ''),
  password: Joi.string().allow(null, ''),
  pin: Joi.string().allow(null, '')
});

const allowedSecurityModes = ['open', 'wpa-psk', 'wpa2-psk'];
const shared = {
  enable: Joi.boolean().required(),
  ssid: Joi.alternatives().conditional('enable', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  password: Joi.when('enable', {
    is: true,
    then: Joi.when('securityMode', {
      switch: [
        {
          is: 'wep',
          then: Joi.string()
            .regex(/^([a-z0-9]{5}|[a-z0-9]{13}|[a-z0-9]{16})$/)
            .error(() => 'Password length must be 5, 13 or 16')
        },
        { is: 'open', then: Joi.string().allow(null, '') }
      ],
      otherwise: Joi.string().min(8)
    }).required(),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  operationMode: Joi.when('enable', {
    is: true,
    then: Joi.string().required().valid('b', 'g', 'n', 'a', 'ac'),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  channel: Joi.string().regex(/^\d+$/).required().error(errors => {
    errors.forEach(err => {
      switch (err.code) {
        case 'string.pattern.base':
          err.message = `${err.local.value} is not a valid channel number`;
          break;
        default:
          break;
      }
    });
    return errors;
  }),
  bandwidth: Joi.string().valid('20').required(),
  securityMode: Joi.string().when('enable', {
    is: true,
    then: Joi.valid(...allowedSecurityModes),
    otherwise: Joi.valid(...allowedSecurityModes, '') // allowed empty if band disabled
  }).required(),
  hideSsid: Joi.boolean().required(),
  encryption: Joi.string().valid('aes-ccmp').required(),
  region: Joi.alternatives().conditional('enable', {
    is: true,
    then: Joi.string().required()
      .regex(/^([A-Z]{2}|other)$/).error(() => 'Region  must be 2 uppercase letters or "other"'),
    otherwise: Joi.string().allow(null, '')
  }).required()
};

const WifiConfigurationSchema = Joi.object({
  '2.4GHz': shared,
  '5GHz': shared
}).or('2.4GHz', '5GHz', { separator: false });

const validateWifiCountryCode = (configurationReq) => {
  let err = null;
  for (const band in configurationReq) {
    if (configurationReq[band].enable === false) {
      continue;
    }

    const channel = parseInt(configurationReq[band].channel);
    if (channel < 0) {
      err = 'Channel must be greater than or equal to 0';
      break;
    }

    const region = configurationReq[band].region;

    if (band === '2.4GHz') {
      const allowedRegions = ['AU', 'CN', 'DE', 'JP', 'RU', 'TW', 'US'];
      if (!allowedRegions.includes(region)) {
        err = `Region ${region} is not valid`;
        break;
      }

      if ((region === 'US' || region === 'TW') && channel > 11) {
        err = 'Channel must be between 0 to 11';
        break;
      }

      if (channel > 13) {
        err = 'Channel must be between 0 to 13';
        break;
      }
    }

    if (band === '5GHz') {
      const allowedRegions = Object.values(wifiChannels);
      const exists = allowedRegions.find(r => r.code === region);
      if (!exists) {
        err = `Region ${region} is not valid`;
        break;
      };

      const validChannels = exists.channels;
      if (channel > 0 && validChannels.findIndex(c => c === channel) === -1) {
        err = `Channel ${channel} is not valid number for country ${region}`;
        break;
      }
    }
  };

  if (err) {
    return { err: err, valid: false };
  }
  return { err: '', valid: true };
};

/**
 * Validate dynamic configuration object for different types of interfaces
 *
 * @param {*} deviceInterface interface stored in db
 * @param {*} configurationReq configuration request to save
 * @returns array of interfaces
 */
const validateConfiguration = (deviceInterface, configurationReq) => {
  const interfacesTypes = {
    lte: lteConfigurationSchema,
    wifi: WifiConfigurationSchema
  };

  const intType = deviceInterface.deviceType;

  if (interfacesTypes[intType]) {
    const result = interfacesTypes[intType].validate(configurationReq);

    if (result.error) {
      return {
        valid: false,
        err: `${result.error.details[result.error.details.length - 1].message}`
      };
    }

    if (intType === 'wifi') {
      const { err } = validateWifiCountryCode(configurationReq);
      if (err) {
        return { valid: false, err: err };
      }
    }

    return { valid: true, err: '' };
  }

  return { valid: false, err: 'You can\'t save configuration for this interface' };
};

/**
 * Checks whether firewall rules are valid
 * @param {array} rules - array of firewall rules to validate
 * @param {object} org  - organization object
 * @param {array}  interfaces - interfaces of the device to check for device-specific rules
 * @return {{valid: boolean, err: string}}  test result + error, if rules are invalid
 */
const validateFirewallRules = (rules, org, interfaces = undefined) => {
  const inboundRuleTypes = ['edgeAccess', 'portForward', 'nat1to1'];

  const rulesHashes = [];
  const tunnelPort = +getOrgDefaultTunnelPort(org);
  const usedInboundPorts = [];
  let inboundPortsCount = 0;
  const enabledRules = rules.filter(r => r.enabled);
  // Common rules validation
  for (const rule of enabledRules) {
    const { direction, inbound, classification } = rule;
    // Inbound rule type must be specified
    if (direction === 'inbound' && !inboundRuleTypes.includes(inbound)) {
      return { valid: false, err: 'Wrong inbound rule type' };
    }
    const { destination } = classification;
    if (direction === 'inbound') {
      // Destination must be specified for inbound rules
      if (!destination || !destination.ipProtoPort) {
        return { valid: false, err: 'Destination must be specified for inbound rules' };
      }
      // Ports must be specified in edgeAccess and portForward inbound rules
      if (inbound !== 'nat1to1' && !destination.ipProtoPort.ports) {
        return {
          valid: false,
          err: 'Ports must be specified in edgeAccess and portForward inbound rules'
        };
      }
      // WAN Interface must be specified in nat1to1 and portForward inbound rules
      const specifiedInterface = destination.ipProtoPort.interface;
      if (inbound !== 'edgeAccess' && !specifiedInterface) {
        return {
          valid: false,
          err: 'WAN Interface must be specified in nat1to1 and portForward inbound rules'
        };
      }
      // Inbound rules destination ports can't be overlapped
      if (direction === 'inbound' && destination.ipProtoPort.ports) {
        const { ports } = destination.ipProtoPort;
        let portLow, portHigh;
        if (ports.includes('-')) {
          [portLow, portHigh] = ports.split('-').map(p => +p);
        } else {
          portLow = portHigh = +ports;
        }
        if (+ports === tunnelPort) {
          return {
            valid: false,
            err: `Firewall rule cannot be added, port ${tunnelPort}
            is reserved for flexiWAN tunnel connectivity.`
          };
        }
        // implicit inbound edge-access rule for tunnel port on all WAN interfaces
        if (portLow <= tunnelPort && portHigh >= tunnelPort) {
          return {
            valid: false,
            err: `Inbound rule destination ports ${ports} overlapped with port ${tunnelPort}.
            Firewall rule cannot be added, port ${tunnelPort}
            is reserved for flexiWAN tunnel connectivity.`
          };
        }
        if (inbound === 'portForward' || inbound === 'edgeAccess') {
          // port forward rules overlapping not allowed
          for (const [usedPortLow, usedPortHigh] of usedInboundPorts) {
            if ((usedPortLow <= portLow && portLow <= usedPortHigh) ||
              (usedPortLow <= portHigh && portHigh <= usedPortHigh) ||
              (portLow <= usedPortLow && usedPortLow <= portHigh) ||
              (portLow <= usedPortHigh && usedPortHigh <= portHigh)) {
              return { valid: false, err: `Inbound rule destination ports ${ports} overlapped` };
            }
          }
        }
        usedInboundPorts.push([portLow, portHigh]);
        inboundPortsCount += (portHigh - portLow + 1);
      }
    }
    for (const side of ['source', 'destination']) {
      const { trafficId, trafficTags, ipPort, ipProtoPort, lanNat } = classification[side] || {};
      // trafficId cannot be empty string or null
      if (isEmpty(trafficId) && trafficId !== undefined) {
        return { valid: false, err: 'Traffic name must be specified' };
      }
      if (ipPort) {
        const { ip, ports } = ipPort;
        if (!ip && !ports) {
          return { valid: false, err: 'IP or ports range must be specified' };
        }
      };
      if (ipProtoPort && inbound !== 'nat1to1' && !trafficId && !trafficTags) {
        const { protocols } = ipProtoPort;
        if (!Array.isArray(protocols) || protocols.length === 0) {
          return { valid: false, err: 'At least one protocol must be specified' };
        };
      };
      if (trafficTags) {
        // Traffic Tags not allowed for source
        if (side === 'source') {
          return { valid: false, err: 'Traffic Tags not allowed for source' };
        }
        const { category, serviceClass, importance } = trafficTags;
        // Empty Traffic Tags not allowed
        if (!category && !serviceClass && !importance) {
          return { valid: false, err: 'Category, service class or importance must be provided' };
        }
      }
      if (direction === 'lanNat') {
        const { match, action, interface: devId } = lanNat || {};
        if (side === 'source') {
          if (!devId) {
            return { valid: false, err: 'Interface must be set for source' };
          }
          const lanIfc = interfaces.find(ifc => ifc.devId === devId);
          if (!lanIfc || !lanIfc.isAssigned || lanIfc.type !== 'LAN') {
            return {
              valid: false,
              err: 'Only assigned LAN interface can be selected in LAN NAT rule'
            };
          }
          if (!match || !action) {
            return { valid: false, err: 'Match and Action can not be empty for source' };
          }
        }
        if ((match && !action) || (!match && action)) {
          return { valid: false, err: 'Match and Action should be both empty or set for ' + side };
        }
        if (match) {
          const [, matchMask] = match.split('/');
          const [, actionMask] = action.split('/');
          if (matchMask !== actionMask) {
            return {
              valid: false,
              err: 'The prefix length of Match and Action has to be the same'
            };
          }
        }
      }
    }
    // check duplicated rules
    const ruleHash = SHA1(direction + inbound +
      JSON.stringify(classification) +
      JSON.stringify(rule.interfaces)
    ).toString();
    if (rulesHashes.includes(ruleHash)) {
      return {
        valid: false,
        err: `Duplicated ${direction} rules detected`
      };
    }
    rulesHashes.push(ruleHash);
  };

  if (inboundPortsCount > 1000) {
    return { valid: false, err: 'Inbound ports range is limited to 1000' };
  }

  // Device-specific rules validation
  if (interfaces) {
    // Port forward rules validation
    const forwardedPorts = {};
    const internalPorts = {};
    for (const rule of enabledRules.filter(r => r.inbound === 'portForward')) {
      const { internalIP, internalPortStart, classification } = rule;
      const { ports: destPorts, interface: devId } = classification.destination.ipProtoPort;
      if (isEmpty(devId)) {
        return { valid: false, err: 'WAN interface must be specified in port forward rule' };
      }
      const dstIfc = interfaces.find(ifc => ifc.devId === devId);
      if (!dstIfc || !dstIfc.isAssigned || dstIfc.type !== 'WAN') {
        return {
          valid: false,
          err: 'Only Assigned WAN interface can be selected in port forward rule'
        };
      }
      if (isEmpty(internalIP)) {
        return { valid: false, err: 'Internal IP address must be specified in port forward rule' };
      }
      if (isEmpty(internalPortStart)) {
        return { valid: false, err: 'Internal start port must be specified in port forward rule' };
      }
      if (isEmpty(destPorts)) {
        return { valid: false, err: 'Destination port must be specified in port forward rule' };
      }
      if (!internalPorts[internalIP]) {
        internalPorts[internalIP] = [];
      }
      if (!forwardedPorts[devId]) {
        forwardedPorts[devId] = [];
      }
      if (destPorts.includes('-')) {
        const [portLow, portHigh] = destPorts.split('-');
        for (let usedPort = +portLow; usedPort <= +portHigh; usedPort++) {
          forwardedPorts[devId].push(usedPort);
          internalPorts[internalIP].push(+internalPortStart + usedPort - portLow);
        }
      } else {
        forwardedPorts[devId].push(+destPorts);
        internalPorts[internalIP].push(+internalPortStart);
      }
    }
    // Forwarded destination port can be used only once
    for (const wanIfc of Object.keys(forwardedPorts)) {
      const destPortsArray = forwardedPorts[wanIfc];
      const destPortsOverlapped = destPortsArray.length !== new Set(destPortsArray).size;
      if (destPortsOverlapped) {
        return { valid: false, err: 'Destination forwarded ports overlapped on ' + wanIfc };
      }
    }
    // Internal port can be used only once for one internal IP
    for (const internalIP of Object.keys(internalPorts)) {
      const internalPortsArray = internalPorts[internalIP];
      const internalOverlapped = internalPortsArray.length !== new Set(internalPortsArray).size;
      if (internalOverlapped) {
        return { valid: false, err: 'Internal ports overlap for ' + internalIP };
      }
    }
  }
  return { valid: true };
};

// Default exports
module.exports = {
  getDefaultGateway,
  getBridges,
  mapLteNames,
  parseLteStatus,
  mapWifiNames,
  getCpuInfo,
  validateConfiguration,
  validateFirewallRules,
  isEmpty
};
