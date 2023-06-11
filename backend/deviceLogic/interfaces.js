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
const Joi = require('joi');
const omitBy = require('lodash/omitBy');
const omit = require('lodash/omit');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const { getBridges } = require('../utils/deviceUtils');

/**
 * Builds collection of interfaces to be sent to device
 *
 * @param {array} deviceInterfaces interfaces stored in db
 * @param {object} globalOSPF global OSPF configuration to apply on each interfaces
 * @param {string} deviceVersion device version
 * @returns array of interfaces
 */
const buildInterfaces = (deviceInterfaces, globalOSPF, deviceVersion) => {
  const interfaces = [];

  const majorVersion = getMajorVersion(deviceVersion);
  const minorVersion = getMinorVersion(deviceVersion);

  const bridges = getBridges(deviceInterfaces);

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
      useStun,
      monitorInternet,
      bandwidthMbps,
      routing,
      type,
      pathlabels,
      gateway,
      metric,
      dhcp,
      deviceType,
      configuration,
      dnsServers,
      dnsDomains,
      useDhcpDnsServers,
      ospf
    } = ifc;
    // Non-DIA interfaces should not be
    // sent to the device
    const labels = pathlabels.filter(
      (label) => label.type === 'DIA'
    );
    // Skip interfaces with invalid IPv4 addresses.
    // Currently we allow empty IPv6 address
    if (dhcp !== 'yes' && type !== 'TRUNK' &&
      !isIPv4Address(IPv4, IPv4Mask) && deviceType !== 'wifi') continue;

    const ifcInfo = {
      dev_id: devId,
      dhcp: dhcp || 'no',
      addr: `${(IPv4 && IPv4Mask ? `${IPv4}/${IPv4Mask}` : '')}`,
      addr6: `${(IPv6 && IPv6Mask ? `${IPv6}/${IPv6Mask}` : '')}`,
      type,
      multilink: { labels: labels.map((label) => label._id.toString()) },
      deviceType,
      configuration
    };

    if (majorVersion > 5 || (majorVersion === 5 && minorVersion >= 3)) {
      ifcInfo.routing = routing.split(/,\s*/); // send as a list
    } else {
      ifcInfo.routing = routing.includes('OSPF') ? 'OSPF' : 'NONE';
    }

    if (ifc.type === 'WAN') {
      ifcInfo.gateway = gateway;
      ifcInfo.metric = metric;
      ifcInfo.useStun = useStun;
      ifcInfo.monitorInternet = monitorInternet;
      ifcInfo.dnsServers = dnsServers;
      ifcInfo.dnsDomains = dnsDomains;

      // if useDhcpDnsServers is true, we set empty array to the agent
      if (ifcInfo.dhcp === 'yes' && useDhcpDnsServers === true) {
        ifcInfo.dnsServers = [];
      }
      if (majorVersion >= 6) {
        ifcInfo.bandwidthMbps = bandwidthMbps;
      }
    }

    if (routing.includes('OSPF')) {
      ifcInfo.ospf = {
        ...ospf,
        helloInterval: globalOSPF.helloInterval,
        deadInterval: globalOSPF.deadInterval
      };

      // remove empty values since they are optional
      ifcInfo.ospf = omitBy(ifcInfo.ospf, val => val === '');

      // No need to send this field for interfaces. We use them for other things in the system
      const omitFields = ['routerId'];
      ifcInfo.ospf = omit(ifcInfo.ospf, omitFields);
    }

    if (bridges[ifcInfo.addr]) {
      ifcInfo.bridge_addr = ifcInfo.addr;
    } else {
      ifcInfo.bridge_addr = null;
    }

    // do not send MTU for VLANs
    if (!ifc.vlanTag) {
      ifcInfo.mtu = ifc.mtu;
    }

    // Currently, when sending modify-x device the agent does smart replacement in a way
    // that if only one field exists in a sub-object, it adds this field
    // to the sub-object but it keeps the other existing fields.
    // So, in WiFi we need to send both keys (2.4GHz, and 5GHz) always.
    // Otherwise, if we will send only the enabled one, ans user changed the enabled band,
    // in some case, at the agent both can be enabled which is not supported.
    // Hence, we send both always.
    if (ifcInfo.deviceType === 'wifi') {
      if (!('2.4GHz' in ifcInfo.configuration)) {
        ifcInfo.configuration['2.4GHz'] = { enable: false };
      }
      if (!('5GHz' in ifcInfo.configuration)) {
        ifcInfo.configuration['5GHz'] = { enable: false };
      }
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
