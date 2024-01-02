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

const net = require('net');
const email = require('isemail');
const urlValidator = require('valid-url');
const validator = require('validator');
const filenamify = require('filenamify');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const configs = require('../configs')();
const IPCidr = require('ip-cidr');
const Joi = require('joi');

// Globals
const protocols = ['OSPF', 'NONE', 'BGP', 'OSPF,BGP'];
const interfaceTypes = ['WAN', 'LAN', 'TRUNK', 'NONE'];

// Helper functions
const isEmpty = (val) => { return val === null || val === undefined; };
const isValidURL = (url) => { return urlValidator.isUri(url) !== undefined; };
const isValidFileName = (name) => {
  return !isEmpty(name) && name !== '' && filenamify(name) === name;
};
const validateIsInteger = val => /^[1-9]\d+|^\d$/.test(val);

const validateIsPhoneNumber = (number) => {
  try {
    if (isEmpty(number) || number === '') return false;
    return phoneUtil.isValidNumber(phoneUtil.parse(number));
  } catch (err) {

  }
};
const validateDHCP = dhcp => ['yes', 'no'].includes(dhcp);

// Accept empty IP address values, as they are not mandatory at registration time
const validateIPv4 = (ip, allowEmpty = true) => (allowEmpty && ip === '') || net.isIPv4(ip);
const validateIPv4WithMask = field => {
  const [ip, mask] = field.split('/');
  return validateIPaddr(ip) && validateIPv4Mask(mask);
};
const validateIPv4Mask = mask => {
  return (
    !isEmpty(mask) &&
    mask.length < 3 &&
    !isNaN(Number(mask)) &&
    mask >= 0 && mask <= 32
  );
};
const validateIPv4Prefix = (ipWithMask) => {
  const ip = ipWithMask.split('/')[0];
  const ipCidr = new IPCidr(ipWithMask);
  return (ipCidr.start() === ip);
};
const validateIPv6Mask = mask => {
  return (
    !isEmpty(mask) &&
    mask.length < 4 &&
    !isNaN(Number(mask)) &&
    mask >= 0 && mask <= 128
  );
};
const validateIPv6 = (ip) => { return ip === '' || net.isIPv6(ip); };
const validateIPaddr = (ip) => { return validateIPv4(ip) || validateIPv6(ip); };
const validateTunnelRangeIP = (ip) => {
  const ipCidr = new IPCidr(ip + '/' + configs.get('tunnelRangeMask'));
  return (ipCidr.start() === ip);
};

const validateDevId = (devId) => {
  return (
    validatePciAddress(devId) ||
    validateUsbAddress(devId) ||
    validateVlanAddress(devId)
  );
};
const validateParentDevId = (devId) => {
  return (
    validatePciAddress(devId) ||
    validateUsbAddress(devId)
  );
};

// specific validator for interfaces used in firewall rules
const validateFirewallDevId = (devId) => validateDevId(devId) || devId.startsWith('app_');

const validatePciAddress = pci => {
  return (
    pci === '' ||
    /^pci:([A-F0-9]{2,4}:)?([A-F0-9]{2}|[A-F0-9]{4}):[A-F0-9]{2}\.[A-F0-9]{2}$/i.test(
      pci
    )
  );
};
const validateUsbAddress = usb => {
  return (
    usb === '' ||
    /^usb:usb[0-9]\/[0-9]+-[0-9]+\/[0-9]+-[0-9]+:[0-9]+\.[0-9]+$/i.test(usb) ||
    /* eslint-disable max-len */
    /^usb:usb[0-9]\/[0-9]+-[0-9]+\/[0-9]+-[0-9]+.[0-9]+\/[0-9]+-[0-9]+.[0-9]:[0-9].[0-9]+$/i.test(usb)
  );
};
const validateVlanAddress = devId => {
  return (
    devId === '' ||
    /* eslint-disable max-len */
    /^vlan\.([1-9]|[1-9][0-9]{1,2}|[1-3][0-9]{1,3}|40([0-8][0-9]|9[0-4]))\.pci:([A-F0-9]{2,4}:)?([A-F0-9]{2}|[A-F0-9]{4}):[A-F0-9]{2}\.[A-F0-9]{2}$/i.test(devId)
  );
};
const validateIfcName = (name) => { return /^[a-zA-Z0-9_/.]{1,64}$/i.test(name || ''); };
const validateIsNumber = (str) => { return !isNaN(Number(str)); };
const validateDriverName = (name) => { return /^[a-z0-9_-]{1,30}$/i.test(name || ''); };
const validateMacAddress = mac => {
  return /^(([A-F0-9]{2}:){5}[A-F0-9]{2})|(([A-F0-9]{2}-){5}[A-F0-9]{2})$/i.test(
    mac
  );
};
const validateRoutingProto = protocol => {
  return !isEmpty(protocol) && protocols.includes(protocol.toUpperCase());
};
const validateIfcType = type => {
  return !isEmpty(type) && interfaceTypes.includes(type.toUpperCase());
};

const validateDeviceName = name => {
  return name === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(name || '');
};
const validateDescription = desc => {
  return desc === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(desc || '');
};
const validateDeviceSite = site => {
  return site === '' || /^[a-z0-9-_ .!#%():@[\]]{1,50}$/i.test(site || '');
};

// Hostname validation according to RFC 952, RFC 1123
// Allow also underscore as some systems allow it
const validateHostName = (name) => { return /^[a-z0-9-_.]{1,253}$/i.test(name || ''); };
const validateIpList = (list) => {
  if (isEmpty(list)) return false;

  const IpArr = list !== '' ? list.replace(/\s/g, '').split(',') : [];
  for (const ip of IpArr) {
    if (!net.isIPv4(ip) && !net.isIPv6(ip)) return false;
  }

  return true;
};
const isPort = (val) => {
  return !isEmpty(val) && !(val === '') && validateIsInteger(+val) && val >= 0 && val <= 65535;
};
const validatePort = port => port === '' || isPort(port);
const validateVxlanPort = port => validatePort(port) && port !== '500' && port !== '4500' && port !== '0';
const validatePortRange = (range) => {
  if (range === '') return true;
  if (!(range || '').includes('-')) return isPort(range);

  const [portLow, portHigh] = (range || '').split('-');
  return isPort(portLow) && isPort(portHigh) && (+portLow < +portHigh);
};
const validateMachineID = (id) => { return /^[a-f0-9-]{1,50}$/i.test(id || ''); };
const validateSerial = (id) => {
  return (id !== null) &&
  (id !== undefined) &&
  /^[a-z0-9-_ .#%/():[\]]{0,250}$/i.test(id || '');
};
const validateTokenName = (name) => { return /^[a-z0-9-_ .!#%():@[\]]{3,15}$/i.test(name || ''); };

const validateURL = (url) => { return !isEmpty(url) && isValidURL(url); };
const validateFileName = (name) => { return isValidFileName(name); };
const validateFieldName = (name) => { return /^[a-z0-9-. ]{1,100}$/i.test(name || ''); };

const validateUserName = name => {
  return (
    !isEmpty(name) &&
    (email.validate(name) || /^[a-z0-9-. ]{2,15}$/i.test(name))
  );
};
const validateEmail = (mail) => { return !isEmpty(mail) && email.validate(mail); };

const validateLabelName = (name) => { return /^[a-z0-9-_ .:]{3,30}$/i.test(name || ''); };
const validateLabelColor = (color) => { return /^#[0-9A-F]{6}$/i.test(color); };

const validatePolicyName = (name) => { return /^[a-z0-9-_ .:]{3,50}$/i.test(name || ''); };
const validateRuleName = (name) => { return /^[a-z0-9-_ .:]{3,15}$/i.test(name || ''); };

const validateMetric = (val) => val === '' || (val && validateIsInteger(val) && +val >= 0);
const validateMtu = (val) => val && validateIsInteger(val) && +val >= 500 && +val <= 9999;
const validateOSPFArea = (val) => val !== null && (validateIPv4(val) || (validateIsInteger(val) && +val >= 0));
const validateOSPFCost = (val) => val === null || (validateIsInteger(val) && +val >= 0 && +val < 65535);
const validateOSPFInterval = val => val && validateIsInteger(val) && +val >= 1 && +val < 65535;
const validateFQDN = (val, require_tld = true) => val && validator.isFQDN(val, { require_tld });
const validateStringNoSpaces = str => { return str === '' || /^\S+$/i.test(str || ''); };
const validateApplicationIdentifier = str => { return /[A-Za-z_.-]/i.test(str || ''); };
const validateBGPASN = val => val && validateIsInteger(val) && +val >= 1;
const validateBGPInterval = val => val && validateIsInteger(val) && +val >= 0 && +val < 65535;
const validateCpuCoresNumber = val => val && validateIsInteger(val) && +val >= 1 && +val < 65535;
const validateVlanTag = val => val === '' || (val && validateIsInteger(val) && +val >= 0 && +val <= 4096);

const validateNotificationsThresholds = (notificationsSettingsObj) => {
  const MIN_VALUE = 1;
  const UNIT_LIMITS = {
    ms: 2000,
    '%': 100
  };

  const errors = [];

  for (const [eventType, eventSettings] of Object.entries(notificationsSettingsObj)) {
    if (hasValue(eventSettings.warningThreshold)) {
      const warningVal = Number(eventSettings.warningThreshold);
      const criticalVal = Number(eventSettings.criticalThreshold);

      if (!isWarningBelowCritical(warningVal, criticalVal)) {
        errors.push({
          eventType,
          message: 'The critical threshold must be greater than the warning.'
        });
      } else {
        validateNotificationField(eventType, warningVal, eventSettings.thresholdUnit, errors, MIN_VALUE, UNIT_LIMITS);
        validateNotificationField(eventType, criticalVal, eventSettings.thresholdUnit, errors, MIN_VALUE, UNIT_LIMITS);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

const hasValue = (value) => typeof value !== 'undefined' && value !== null && value !== 'varies';

const isWarningBelowCritical = (warningVal, criticalVal) => warningVal < criticalVal;

const validateNotificationField = (eventType, value, unit, errors, minValue, unitLimits) => {
  if (value < minValue) {
    errors.push({
      eventType,
      message: `Please enter a value greater than ${minValue - 1} for ${eventType}.`
    });
  }

  if (unit in unitLimits && value > unitLimits[unit]) {
    errors.push({
      eventType,
      message: `Please enter a value less than or equal to ${unitLimits[unit]} for ${eventType}.`
    });
  }
};

const validateNotificationsSettings = (notificationsRules, isTunnelSettings = false) => {
  let notificationsRulesSchema;
  if (!isTunnelSettings) {
    notificationsRulesSchema = Joi.object().keys({
      'Device connection': Joi.object().required(),
      'Running router': Joi.object().required(),
      'Link/Tunnel round trip time': Joi.object().required(),
      'Link/Tunnel default drop rate': Joi.object().required(),
      'Device memory usage': Joi.object().required(),
      'Hard drive usage': Joi.object().required(),
      Temperature: Joi.object().required(),
      'Software update': Joi.object().required(),
      'Link status': Joi.object().required(),
      'Missing interface ip': Joi.object().required(),
      'Pending tunnel': Joi.object().required(),
      'Tunnel connection': Joi.object().required(),
      'Internet connection': Joi.object().required(),
      'Static route state': Joi.object().required(),
      'Failed self-healing': Joi.object().required()
    });
  } else {
    notificationsRulesSchema = Joi.object().keys({
      'Link/Tunnel round trip time': Joi.object().required(),
      'Link/Tunnel default drop rate': Joi.object().required()
    });
  }

  const { error } = notificationsRulesSchema.validate(notificationsRules, { abortEarly: false });
  let messages = [];
  if (error) {
    messages = error.details.map(detail => detail.message);
  } else {
    for (const [eventType, eventSettings] of Object.entries(notificationsRules)) {
      const validationMessages = validateNotificationFields(eventType, eventSettings, isTunnelSettings);
      if (validationMessages && validationMessages.length) {
        messages = [...messages, ...validationMessages];
      }
    }
    const thresholdsValidation = validateNotificationsThresholds(notificationsRules);
    if (!thresholdsValidation.valid) {
      messages = [...messages, ...thresholdsValidation.errors.map(err => `${err.eventType}: ${err.message}`)];
    }
  }
  return messages.length > 0 ? messages : null;
};

const validateNotificationFields = (eventType, notificationSettingsFields, isTunnelSettings) => {
  let baseSchema;
  if (!isTunnelSettings) {
    baseSchema = {
      warningThreshold: Joi.number().required(),
      criticalThreshold: Joi.number().required(),
      thresholdUnit: Joi.string().valid('ms', '%', 'C°').required(),
      severity: Joi.string().valid('critical', 'warning').required(),
      immediateEmail: Joi.boolean().required(),
      resolvedAlert: Joi.boolean().required(),
      sendWebHook: Joi.boolean().required(),
      type: Joi.string().valid('device', 'tunnel', 'interface').required()
    };

    const setNullForFields = (schema, fields) => {
      fields.forEach(field => {
        schema[field] = Joi.valid(null).required();
      });
      return schema;
    };

    const eventTypeConfig = {
      'Device connection': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Running router': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Link/Tunnel round trip time': ['severity'],
      'Link/Tunnel default drop rate': ['severity'],
      'Device memory usage': ['severity'],
      'Hard drive usage': ['severity'],
      Temperature: ['warningThreshold', 'criticalThreshold'],
      'Software update': ['warningThreshold', 'criticalThreshold', 'thresholdUnit', 'resolvedAlert'],
      'Link status': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Missing interface ip': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Pending tunnel': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Tunnel connection': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Internet connection': ['warningThreshold', 'criticalThreshold', 'thresholdUnit'],
      'Static route state': ['warningThreshold', 'criticalThreshold', 'thresholdUnit', 'resolvedAlert'],
      'Failed self-healing': ['warningThreshold', 'criticalThreshold', 'thresholdUnit', 'resolvedAlert']
    };

    setNullForFields(baseSchema, eventTypeConfig[eventType]);
  } else {
    baseSchema = {
      warningThreshold: Joi.number().required(),
      criticalThreshold: Joi.number().required(),
      thresholdUnit: Joi.string().valid('ms', '%', 'C°').required()
    };
  }

  const schema = Joi.object().keys(baseSchema);

  const { error } = schema.validate(notificationSettingsFields, { abortEarly: false });

  return error ? error.details.map(detail => detail.message) : null;
};

const validateEmailNotifications = (emailNotificationsUsersList, allowNull) => {
  const emailSigningSchema = allowNull ? Joi.object({
    _id: Joi.string().required(),
    email: Joi.string().email(),
    name: Joi.string(),
    lastName: Joi.string(),
    signedToCritical: Joi.alternatives().try(Joi.boolean(), Joi.valid(null)).required(),
    signedToWarning: Joi.alternatives().try(Joi.boolean(), Joi.valid(null)).required(),
    signedToDaily: Joi.alternatives().try(Joi.boolean(), Joi.valid(null)).required()
  }) : Joi.object({
    _id: Joi.string().required(),
    email: Joi.string().email(),
    name: Joi.string(),
    lastName: Joi.string(),
    signedToCritical: Joi.boolean().required(),
    signedToWarning: Joi.boolean().required(),
    signedToDaily: Joi.boolean().required()
  });

  for (const user of emailNotificationsUsersList) {
    const { error } = emailSigningSchema.validate(user, { abortEarly: false });
    if (error) {
      const message = error.details.map(detail => detail.message);
      return message;
    }
  }

  return null;
};

const validateWebhookSettings = (webhookNotificationsSettings, allowNull) => {
  const webHookSettingsSchema = allowNull ? Joi.object({
    webhookURL: Joi.alternatives().try(Joi.string(), Joi.valid(null)).required(),
    sendCriticalAlerts: Joi.alternatives().try(Joi.boolean(), Joi.valid(null)).required(),
    sendWarningAlerts: Joi.alternatives().try(Joi.boolean(), Joi.valid(null)).required()
  }) : Joi.object({
    _id: Joi.string(),
    webhookURL: Joi.string().required(),
    sendCriticalAlerts: Joi.boolean().required(),
    sendWarningAlerts: Joi.boolean().required()
  });
  const { error } = webHookSettingsSchema.validate(webhookNotificationsSettings, { abortEarly: false });
  let messages = [];

  if (error) {
    messages = error.details.map(detail => detail.message);
  }

  const webhookURL = webhookNotificationsSettings.webhookURL;
  if (webhookURL) {
    if (webhookURL.trim() === '') {
      messages.push('Webhook URL cannot be empty');
    } else {
      if (!webhookURL.startsWith('https://')) {
        messages.push('Webhook URL must start with "https://"');
      }

      try {
        Boolean(new URL(webhookURL));
      } catch (_) {
        messages.push('Invalid Webhook URL');
      }

      if (webhookURL.length > 256) {
        messages.push('Webhook URL is too long');
      }
    }
  }

  return messages.length > 0 ? messages : null;
};

module.exports = {
  validateDHCP,
  validateIPv4,
  validateIPv4WithMask,
  validateIPv4Prefix,
  validateIPv6,
  validateIPaddr,
  validateTunnelRangeIP,
  validatePciAddress,
  validateDevId,
  validateParentDevId,
  validateFirewallDevId,
  validateVlanTag,
  validateIfcName,
  validateIPv4Mask,
  validateIPv6Mask,
  validatePort,
  validatePortRange,
  validateDriverName,
  validateMacAddress,
  validateRoutingProto,
  validateIfcType,
  validateDeviceName,
  validateDescription,
  validateDeviceSite,
  validateHostName,
  validateIpList,
  validateMachineID,
  validateSerial,
  validateTokenName,
  validateURL,
  validateFileName,
  validateFieldName,
  validateUserName,
  validateEmail,
  validateIsPhoneNumber,
  validateLabelName,
  validateLabelColor,
  validatePolicyName,
  validateRuleName,
  validateMetric,
  validateMtu,
  validateIsInteger,
  validateOSPFArea,
  validateOSPFCost,
  validateOSPFInterval,
  validateFQDN,
  validateStringNoSpaces,
  validateApplicationIdentifier,
  validateBGPASN,
  validateBGPInterval,
  validateIsNumber,
  validateCpuCoresNumber,
  validateVxlanPort,
  validateNotificationsSettings,
  validateNotificationField,
  validateNotificationsThresholds,
  validateEmailNotifications,
  validateWebhookSettings
};
