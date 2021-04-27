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

const { isIPv4Address } = require('./validators');
const wifiChannels = require('../utils/wifi-channels');
const Joi = require('@hapi/joi');

/**
 * Builds collection of interfaces to be sent to device
 *
 * @param {*} deviceInterfaces interfaces stored in db
 * @returns array of interfaces
 */
const buildInterfaces = (deviceInterfaces) => {
  const interfaces = [];
  for (const ifc of deviceInterfaces) {
    // Skip unassigned/un-typed interfaces, as they
    // cannot be part of the device configuration
    if (!ifc.isAssigned || ifc.type.toLowerCase() === 'none') continue;

    const {
      devId,
      IPv4,
      IPv6,
      IPv4Mask,
      IPv6Mask,
      PublicIP,
      PublicPort,
      useStun,
      monitorInternet,
      routing,
      type,
      pathlabels,
      gateway,
      metric,
      mtu,
      dhcp,
      deviceType,
      configuration,
      dnsServers,
      dnsDomains,
      useFixedPublicPort
    } = ifc;
    // Non-DIA interfaces should not be
    // sent to the device
    const labels = pathlabels.filter(
      (label) => label.type === 'DIA'
    );
    // Skip interfaces with invalid IPv4 addresses.
    // Currently we allow empty IPv6 address
    if (dhcp !== 'yes' && !isIPv4Address(IPv4, IPv4Mask) && deviceType !== 'wifi') continue;

    const ifcInfo = {
      dev_id: devId,
      dhcp: dhcp || 'no',
      addr: `${(IPv4 && IPv4Mask ? `${IPv4}/${IPv4Mask}` : '')}`,
      addr6: `${(IPv6 && IPv6Mask ? `${IPv6}/${IPv6Mask}` : '')}`,
      mtu,
      routing,
      type,
      multilink: { labels: labels.map((label) => label._id.toString()) },
      deviceType,
      configuration
    };
    if (ifc.type === 'WAN') {
      ifcInfo.gateway = gateway;
      ifcInfo.metric = metric;
      ifcInfo.PublicIP = PublicIP;
      ifcInfo.PublicPort = PublicPort;
      ifcInfo.useFixedPublicPort = useFixedPublicPort;
      ifcInfo.useStun = useStun;
      ifcInfo.monitorInternet = monitorInternet;
      ifcInfo.dnsServers = dnsServers;
      ifcInfo.dnsDomains = dnsDomains;
    }
    interfaces.push(ifcInfo);
  }

  return interfaces;
};

const lteConfigurationSchema = Joi.object().keys({
  enable: Joi.boolean().required(),
  apn: Joi.string().required(),
  auth: Joi.string().valid('MSCHAPV2', 'PAP', 'CHAP').allow(null, ''),
  user: Joi.string().allow(null, ''),
  password: Joi.string().allow(null, ''),
  pin: Joi.string().allow(null, '')
});

const shared = {
  enable: Joi.boolean().required(),
  ssid: Joi.alternatives().when('enable', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  password: Joi.alternatives().when('enable', {
    is: true,
    then: Joi.alternatives().when('securityMode', {
      is: 'wep',
      then: Joi.string()
        .regex(/^([a-z0-9]{5}|[a-z0-9]{13}|[a-z0-9]{16})$/)
        .error(() => 'Password length must be 5, 13 or 16'),
      otherwise: Joi.string().min(8)
    }).required(),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  operationMode: Joi.alternatives().when('enable', {
    is: true,
    then: Joi.string().required().valid('b', 'g', 'n', 'a', 'ac'),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  channel: Joi.string().regex(/^\d+$/).required(),
  bandwidth: Joi.string().valid('20').required(),
  securityMode: Joi.alternatives().when('enable', {
    is: true,
    then: Joi.string().valid(
      'open', 'wpa-psk', 'wpa2-psk'
      // 'wpa-eap', 'wpa2-eap'
    ).required().error(() => 'Security mode is required field on enabled WiFi band'),
    otherwise: Joi.string().allow(null, '')
  }).required(),
  hideSsid: Joi.boolean().required(),
  encryption: Joi.string().valid('aes-ccmp').required(),
  region: Joi.alternatives().when('enable', {
    is: true,
    then: Joi.string().required()
      .regex(/^([A-Z]{2}|other)$/).error(() => 'Region  must be 2 uppercase letters or "other"'),
    otherwise: Joi.string().allow(null, '')
  }).required()
};

const WifiConfigurationSchema = Joi.alternatives().try(
  Joi.object().keys({ '2.4GHz': Joi.object().keys(shared) }),
  Joi.object().keys({ '5GHz': Joi.object().keys(shared) }),
  Joi.object().keys({ '5GHz': Joi.object().keys(shared), '2.4GHz': Joi.object().keys(shared) })
);

const validateWifiCountryCode = (configurationReq) => {
  const regions = Object.values(wifiChannels);
  let err = null;
  for (const band in configurationReq) {
    if (configurationReq[band].enable === false) {
      continue;
    }

    const region = configurationReq[band].region;
    const exists = regions.find(r => r.code === region);
    if (!exists) {
      err = `Region ${region} is not valid`;
      break;
    };

    const channel = parseInt(configurationReq[band].channel);

    if (channel < 0) {
      err = 'Channel must be greater than or equal to 0';
      break;
    }

    if (band === '2.4GHz') {
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

const lteOperationSchema = Joi.object().keys({
  op: Joi.string().valid('reset', 'pin').required(),
  params: Joi.object().optional()
});

const wifiOperationSchema = Joi.object().keys({
  op: Joi.string().valid('start', 'stop').required(),
  params: Joi.object().required()
});

/**
 * Validate dynamic operation object for different types of interfaces
 *
 * @param {*} deviceInterfaces interfaces stored in db
 * @param {*} configurationReq configuration request to save
 * @returns array of interfaces
 */
const validateOperations = (deviceInterfaces, operationReq) => {
  const interfacesTypes = {
    lte: lteOperationSchema,
    wifi: wifiOperationSchema
  };

  const intType = deviceInterfaces.deviceType;

  if (interfacesTypes[intType]) {
    const result = interfacesTypes[intType].validate(operationReq);

    if (result.error) {
      return { valid: false, err: `${result.error.details[0].message}` };
    }

    if (intType === 'wifi') {
      const configuration = operationReq.params.configuration;
      const isBand2Enabled = configuration['2.4GHz'] && configuration['2.4GHz'].enable;
      const isBand5Enabled = configuration['5GHz'] && configuration['5GHz'].enable;

      if (isBand2Enabled && isBand5Enabled) {
        return {
          valid: false,
          err: 'You can\'t enabled two bands at the same time. Please enable one of them'
        };
      }
    }

    return { valid: true, err: '' };
  }

  return { valid: false, err: 'You can\'t perform requested operation for this interface' };
};

module.exports = {
  buildInterfaces,
  validateConfiguration,
  validateOperations
};
