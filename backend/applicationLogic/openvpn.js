// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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
const ObjectId = require('mongoose').Types.ObjectId;
const pick = require('lodash/pick');
const applications = require('../models/applications');
const { devices } = require('../models/devices');
const diffieHellmans = require('../models/diffieHellmans');

const {
  getAvailableIps,
  getSubnetMask,
  getStartIp
} = require('../utils/networks');

const {
  generateKeys,
  generateCA,
  generateTlsKey,
  generateDhKey
} = require('../utils/certificates');

/**
 * Get initial configuration object for VPN application
 * @return {object}
 */
const getOpenVpnInitialConfiguration = () => {
  return {
    authentications: [
      {
        type: 'G-Suite',
        enabled: false,
        domainName: '',
        group: ''
      },
      {
        type: 'Office365',
        enabled: false,
        domainName: '',
        group: ''
      }
    ]
  };
};

/**
 * Indicate if application is remote vpn
 * @param {string} applicationName
 * @return {boolean}
 */
const isVpn = applicationName => {
  return applicationName === 'Remote VPN';
};

const allowedFields = [
  'networkId',
  'serverPort',
  'remoteClientIp',
  'connectionsPerDevice',
  'routeAllOverVpn',
  'dnsIp',
  'dnsDomain',
  'authentications'
];

const pickOnlyVpnAllowedFields = configurationRequest => {
  return pick(configurationRequest, allowedFields);
};

const domainRegex = new RegExp(/(^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$)/);
const getAuthValidator = type => {
  return Joi.object().keys({
    type: Joi.string().valid(type).required(),
    enabled: Joi.boolean().required(),
    domainName: Joi.string().required().when('enabled', {
      is: true,
      then: Joi.invalid(''),
      otherwise: Joi.allow('')
    }).custom((val, helpers) => {
      const domains = val.split(',');
      const invalid = domains.filter(d => !d.trim().match(domainRegex));
      if (invalid.length) {
        return helpers.error(`Invalid domain name: ${invalid[0]}`);
      }
      return val.toString();
    }),
    group: Joi.string().allow('').optional()
  }).required();
};

const vpnConfigSchema = Joi.object().keys({
  networkId: Joi.string().pattern(/^[A-Za-z0-9]+$/).min(3).max(20).required(),
  serverPort: Joi.number().port().optional().allow(''),
  remoteClientIp: Joi.string().ip({ version: ['ipv4'], cidr: 'required' }).required(),
  routeAllOverVpn: Joi.boolean().optional(),
  connectionsPerDevice: Joi.number().min(8)
    .custom((val, helpers) => {
      const isPowerOfTwo = (Math.log(val) / Math.log(2)) % 1 === 0;
      if (!isPowerOfTwo) {
        return helpers.message('connections per device should be a power of 2');
      };

      return val.toString();
    })
    .required(),
  dnsIp: Joi.string().ip({ version: ['ipv4'], cidr: 'forbidden' }).allow('').optional(),
  dnsDomain: Joi.string().min(3).max(50).allow('').optional(),
  authentications: Joi.array().length(2).items(
    getAuthValidator('G-Suite'),
    getAuthValidator('Office365')
  ).optional()
}).custom((obj, helpers) => {
  const { remoteClientIp, connectionsPerDevice } = obj;
  const mask = remoteClientIp.split('/').pop();
  const range = getAvailableIps(mask);

  if (typeof helpers.original.connectionsPerDevice === 'number') {
    return helpers.message('connectionsPerDevice should be a number within a string');
  }

  if (range < connectionsPerDevice) {
    return helpers.message('connections per device is larger then network size');
  }

  return obj;
});

/**
 * Validate vpn configurations. called when a user update the configurations
 * @param {object} configurationRequest
 * @param {objectId} applicationId
 * @param {[orgList]} orgList array of organizations
 * @return {{valid: boolean, err: string}}  test result + error if message is invalid
 */
const validateVpnConfiguration = async (configurationRequest, applicationId, orgList) => {
  // validate user inputs
  const result = vpnConfigSchema.validate(configurationRequest);
  if (result.error) {
    return { valid: false, err: `${result.error.details[0].message}` };
  }

  // check if unique networkId already taken
  const networkId = configurationRequest.networkId;
  const regex = new RegExp(`\\b${networkId}\\b`, 'i');
  const existsNetworkId = await applications.findOne(
    {
      _id: { $ne: applicationId },
      configuration: { $exists: 1 },
      'configuration.networkId': { $regex: regex, $options: 'i' }
    }
  );

  if (existsNetworkId) {
    const err = 'This Network ID is already in use by another account. ' +
    'Please choose another Unique Network ID';
    return { valid: false, err: err };
  }

  // validate subnets
  if (configurationRequest.remoteClientIp && configurationRequest.connectionsPerDevice) {
    const installedDevices = await devices.find({
      org: { $in: orgList },
      'applications.applicationInfo': applicationId,
      $or: [
        { 'applications.status': 'installed' },
        { 'applications.status': 'installing' }
      ]
    });

    const updatedSubnetsCount = calculateNumberOfSubnets(
      configurationRequest.remoteClientIp,
      configurationRequest.connectionsPerDevice
    );

    if (installedDevices.length > updatedSubnetsCount) {
      return {
        valid: false,
        err: 'There are more installed devices then subnets. Please increase the number of subnets'
      };
    }
  }

  return { valid: true, err: '' };
};

/**
 * divide network and return the subnets count
 * @param {string} remoteClientIp
 * @param {string} connectionsPerDevice
 * @return {number}  number of splitted subnets
 */
const calculateNumberOfSubnets = (remoteClientIp, connectionsPerDevice) => {
  const mask = remoteClientIp.split('/').pop();

  const deviceMask = getSubnetMask(connectionsPerDevice);

  const subnetsCount = Math.pow(2, deviceMask - parseInt(mask));

  return subnetsCount;
};

/**
 * Get the subnet that will be assigned to the device
 * @param {object} config configuration object
 * @param {ObjectID} deviceId the if of the device to be assigned
 * @return {[{device: ObjectID, subnet: string}, status]} object of subnet to be assigned
 */
const getSubnetForDevice = (config, deviceId = '') => {
  // if subnet already assigned to this device, return the subnet
  const assignedSubnets = config.subnets || [];
  const exists = assignedSubnets.find(
    s => s.device && (s.device.toString() === deviceId)
  );
  if (exists) return [exists, 'exists'];

  // check if there is free subnet on db, return the subnet
  const freeSubnetOnDb = assignedSubnets.find(s => {
    return s.device === null;
  });
  if (freeSubnetOnDb) return [{ ...freeSubnetOnDb, device: ObjectId(deviceId) }, 'update'];

  // allocate the next subnet
  const [ip, mask] = config.remoteClientIp.split('/');
  const deviceMask = getSubnetMask(config.connectionsPerDevice);
  const range = getAvailableIps(deviceMask);
  const deviceNumber = config.subnets ? config.subnets.length : 0;
  const startIp = getStartIp(ip, parseInt(mask), range * deviceNumber);

  return [{
    device: ObjectId(deviceId),
    subnet: `${startIp}/${deviceMask}`
  }, 'new'];
};

const onVpnJobComplete = async (org, app, op, deviceId) => {
  if (op === 'uninstall') {
    // release the subnet if deploy job removed
    await releaseSubnetForDevice(org, app._id, ObjectId(deviceId));
  }
};

const onVpnJobRemoved = async (org, app, op, deviceId) => {
  if (op === 'deploy') {
    // release the subnet if deploy job removed
    await releaseSubnetForDevice(org, app._id, ObjectId(deviceId));
  }
};

const onVpnJobFailed = async (org, app, op, deviceId) => {
  if (op === 'deploy') {
    // release the subnet if deploy job removed
    await releaseSubnetForDevice(org, app._id, ObjectId(deviceId));
  }
};

/**
 * Release subnet assigned to device
 * @async
 * @param  {ObjectId} org org id to filter by
 * @param  {ObjectId} appId app id to filter by
 * @param  {ObjectId} deviceId device to release
 * @return {void}
 */
const releaseSubnetForDevice = async (org, appId, deviceId) => {
  // await applications.updateOne(
  //   { org: org, _id: appId },
  //   { $pull: { 'configuration.subnets': { device: ObjectId(deviceId) } } }
  // );
  await applications.updateOne(
    { org: org, _id: appId, 'configuration.subnets.device': ObjectId(deviceId) },
    { $set: { 'configuration.subnets.$.device': null } }
  );
};

/**
 * Validate application. called before starting to install application on the devices
 * @param {object} app the application will be installed
 * @param {string} op the operation of the job (deploy, config, etc.)
 * @param {[ObjectID]} deviceIds the devices id, that application should installed on them
 * @return {{valid: boolean, err: string}}  test result + error if message is invalid
 */
const validateVpnApplication = (app, op, deviceIds) => {
  if (op === 'deploy') {
    // prevent installation if there are missing required configurations
    if (!app.configuration.remoteClientIp || !app.configuration.connectionsPerDevice) {
      return {
        valid: false,
        err: 'Required configurations is missing. Please check again the configurations'
      };
    }

    // prevent installation if selected more devices then subnets
    const subnets = app.configuration.subnets;
    const takenSubnets = subnets ? subnets.filter(s => s.device != null).length : 0;

    const totalNumberOfSubnets = calculateNumberOfSubnets(
      app.configuration.remoteClientIp,
      app.configuration.connectionsPerDevice
    );

    const freeSubnets = totalNumberOfSubnets - takenSubnets;

    // create a new devicesIds array contains the devices without assigned subnet
    const devicesWithoutSubnets = takenSubnets ? deviceIds.filter(d => {
      return subnets.findIndex(s => s.device && s.device.toString() === d.toString()) === -1;
    }) : [...deviceIds];

    const isMoreDevicesThenSubnets = freeSubnets < devicesWithoutSubnets.length;

    if (isMoreDevicesThenSubnets) {
      return {
        valid: false,
        err: 'There are no remained subnets. Please check the configurations'
      };
    }
  }

  return { valid: true, err: '' };
};

/**
 * Generate key for vpn server
 * @param {object} application the application to generate for
 * @return {{
    isNew: boolean
    caPrivateKey: string
    caPublicKey: string
    serverKey: string
    serverCrt: string
    tlsKey: string
    dhKey: string
  }}  the keys to send to device
 */
const getDeviceKeys = async application => {
  let isNew = false;
  let caPrivateKey;
  let caPublicKey;
  let serverKey;
  let serverCrt;
  let tlsKey;
  let dhKey;

  if (!application.configuration.keys) {
    isNew = true;
    const ca = generateCA();
    const server = generateKeys(ca.privateKey);
    tlsKey = generateTlsKey();
    caPrivateKey = ca.privateKey;
    caPublicKey = ca.publicKey;
    serverKey = server.privateKey;
    serverCrt = server.publicKey;

    // check if there is DH key on stack
    const dhKeyDoc = await diffieHellmans.findOne();

    if (!dhKeyDoc) {
      dhKey = await generateDhKey();
    } else {
      dhKey = dhKeyDoc.key;
      await diffieHellmans.remove({ _id: dhKeyDoc._id });
    }
  } else {
    caPrivateKey = application.configuration.keys.caKey;
    caPublicKey = application.configuration.keys.caCrt;
    serverKey = application.configuration.keys.serverKey;
    serverCrt = application.configuration.keys.serverCrt;
    tlsKey = application.configuration.keys.tlsKey;
    dhKey = application.configuration.keys.dhKey;
  }

  return {
    isNew: isNew,
    caPrivateKey,
    caPublicKey,
    serverKey,
    serverCrt,
    tlsKey,
    dhKey
  };
};

/**
 * Generate params object to be sent to the device
 * @param {object} device the device to get params for
 * @param {string} applicationId the application id to be installed
 * @param {string} op the operation of the job (deploy, config, etc.)
 * @return {object} params to be sent to device
*/
const getOpenVpnParams = async (device, applicationId, op) => {
  const params = {};
  const { _id, interfaces } = device;

  const application = await applications.findOne({ _id: applicationId })
    .populate('libraryApp').lean();
  const config = application.configuration;

  if (op === 'deploy' || op === 'config' || op === 'upgrade') {
    // get the WanIp to be used by remote vpn server to listen
    const wanIp = interfaces.find(ifc => ifc.type === 'WAN' && ifc.isAssigned).IPv4;

    // get new subnet if there is no subnet already assigned to current device
    const [deviceSubnet, status] = getSubnetForDevice(config, _id.toString());

    const query = { _id: application._id };
    const update = {
      $set: {}
    };

    if (status === 'update') {
      query['configuration.subnets.subnet'] = deviceSubnet.subnet;
      update.$set['configuration.subnets.$.device'] = deviceSubnet.device;
    } else if (status === 'new') {
      update.$push = {
        'configuration.subnets': deviceSubnet
      };
    }

    const {
      isNew, caPrivateKey, caPublicKey,
      serverKey, serverCrt, tlsKey, dhKey
    } = await getDeviceKeys(application);

    // if is new keys, save them on db
    if (isNew) {
      update.$set['configuration.keys.caKey'] = caPrivateKey;
      update.$set['configuration.keys.caCrt'] = caPublicKey;
      update.$set['configuration.keys.serverKey'] = serverKey;
      update.$set['configuration.keys.serverCrt'] = serverCrt;
      update.$set['configuration.keys.tlsKey'] = tlsKey;
      update.$set['configuration.keys.dhKey'] = dhKey;
    }

    // set subnet to device to prevent same subnet on multiple devices
    await applications.updateOne(query, update);

    let version = application.installedVersion;
    if (op === 'upgrade') {
      version = application.libraryApp.latestVersion;
    }

    const dnsIp = config.dnsIp && config.dnsIp !== ''
      ? config.dnsIp.split(';') : [];

    const dnsDomain = config.dnsDomain && config.dnsDomain !== ''
      ? config.dnsDomain.split(';') : [];

    params.version = version;
    params.routeAllOverVpn = config.routeAllOverVpn || false;
    params.remoteClientIp = deviceSubnet.subnet;
    params.port = config.serverPort ? config.serverPort : '';
    params.deviceWANIp = wanIp;
    params.caKey = caPrivateKey;
    params.caCrt = caPublicKey;
    params.serverKey = serverKey;
    params.serverCrt = serverCrt;
    params.tlsKey = tlsKey;
    params.dnsIp = dnsIp;
    params.dnsName = dnsDomain;
    params.dhKey = dhKey;
  }

  return params;
};

const needToUpdatedVpnServers = (oldConfig, updatedConfig) => {
  if (oldConfig.remoteClientIp !== updatedConfig.remoteClientIp) return true;
  if (oldConfig.connectionsPerDevice !== updatedConfig.connectionsPerDevice) return true;
  if (oldConfig.serverPort !== updatedConfig.serverPort) return true;
  if (oldConfig.dnsIp !== updatedConfig.dnsIp) return true;
  if (oldConfig.dnsDomain !== updatedConfig.dnsDomain) return true;
  return false;
};

module.exports = {
  isVpn,
  getOpenVpnInitialConfiguration,
  validateVpnConfiguration,
  getSubnetForDevice,
  onVpnJobComplete,
  onVpnJobRemoved,
  onVpnJobFailed,
  validateVpnApplication,
  pickOnlyVpnAllowedFields,
  getOpenVpnParams,
  needToUpdatedVpnServers
};
