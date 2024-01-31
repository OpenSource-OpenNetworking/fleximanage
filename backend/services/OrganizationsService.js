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

const Service = require('./Service');
const configs = require('../configs')();
const mongoose = require('mongoose');
const Accounts = require('../models/accounts');
const Devices = require('../models/devices');
const Users = require('../models/users');
const Vrrp = require('../models/vrrp');
const Peers = require('../models/peers');
const FirewallPolicies = require('../models/firewallPolicies');
const { appIdentifications, importedAppIdentifications } = require('../models/appIdentifications');
const Applications = require('../models/applications');
const Organizations = require('../models/organizations');
const NotificationsConf = require('../models/notificationsConf');
const Tunnels = require('../models/tunnels');
const TunnelIds = require('../models/tunnelids');
const Tokens = require('../models/tokens');
const AccessTokens = require('../models/accesstokens');
const MultiLinkPolicies = require('../models/mlpolicies');
const PathLabels = require('../models/pathlabels');
const { deviceAggregateStats } = require('../models/analytics/deviceStats');
const { membership } = require('../models/membership');
const QosPolicies = require('../models/qosPolicies');
const Connections = require('../websocket/Connections')();
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const Flexibilling = require('../flexibilling');
const {
  getUserOrganizations,
  getUserOrgByID,
  orgUpdateFromNull
} = require('../utils/membershipUtils');
const mongoConns = require('../mongoConns.js')();
const pick = require('lodash/pick');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getToken } = require('../tokens');
const DeviceEvents = require('../deviceLogic/events');
const { processModifyJob } = require('../deviceLogic/modifyDevice');
const { forceDevicesSync } = require('../deviceLogic/sync');
const { pendingTypes, getReason } = require('../deviceLogic/events/eventReasons');
const { prepareTunnelAddJob, prepareTunnelRemoveJob } = require('../deviceLogic/tunnels');
const { transformVxlanConfig } = require('../deviceLogic/jobParameters');
const { validateFirewallRules } = require('../utils/deviceUtils');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const notificationsMgr = require('../notifications/notifications')();
const { validateOverlappingSubnets } = require('../deviceLogic/validators');
const { checkOverlapping } = require('../utils/networks');
const ObjectId = require('mongoose').Types.ObjectId;

class OrganizationsService {
  /**
   * Select the API fields from mongo organization Object
   * @param {Object} item - mongodb organization object
   */
  static selectOrganizationParams (item) {
    const retOrg = pick(item, [
      'name',
      'description',
      '_id',
      'account',
      'group',
      'encryptionMethod',
      'vxlanPort',
      'tunnelRange'
    ]);
    retOrg._id = retOrg._id.toString();
    retOrg.account = retOrg.account.toString();

    return retOrg;
  }

  /**
   * Get all organizations
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async organizationsGET ({ offset, limit }, { user }) {
    try {
      const orgs = await getUserOrganizations(user, offset, limit);
      const result = Object.keys(orgs).map((key) => {
        return OrganizationsService.selectOrganizationParams(orgs[key]);
      });

      return Service.successResponse(result);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async organizationsSelectPOST (organizationSelectRequest, { user }, res) {
    try {
      if (!user._id || !user.defaultAccount) {
        return Service.rejectResponse('Error in selecting organization', 500);
      }
      // Check first that user is allowed for this organization
      let org = [];
      try {
        org = await getUserOrgByID(user, organizationSelectRequest.org);
      } catch (err) {
        logger.error('Finding organization for user', { params: { reason: err.message } });
        return Service.rejectResponse('Error selecting organization', 500);
      }
      if (org.length > 0) {
        const updUser = await Users.findOneAndUpdate(
          // Query, use the email and account
          { _id: user._id, defaultAccount: user.defaultAccount._id },
          // Update
          { defaultOrg: organizationSelectRequest.org },
          // Options
          { upsert: false, new: true }
        ).populate('defaultOrg');
        // Success, return OK and refresh JWT with new values
        user.defaultOrg = updUser.defaultOrg;
        const token = await getToken({ user }, {
          org: updUser.defaultOrg._id,
          orgName: updUser.defaultOrg.name
        });
        res.setHeader('Refresh-JWT', token);

        const result = OrganizationsService.selectOrganizationParams(updUser.defaultOrg);
        return Service.successResponse(result, 201);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get organization
   *
   * id String Numeric ID of the Organization to get
   * returns Organization
   **/
  static async organizationsIdGET ({ id }, { user }) {
    try {
      // Find org with the correct ID
      const resultOrg = await getUserOrgByID(user, id);
      if (resultOrg.length !== 1) throw new Error('Unable to find organization');
      return Service.successResponse(OrganizationsService.selectOrganizationParams(resultOrg[0]));
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete organization
   *
   * id String Numeric ID of the Organization to delete
   * no response value expected for this operation
   **/
  static async organizationsIdDELETE ({ id }, { user }, response) {
    let orgDevices;
    let deviceCount;
    let deviceOrgCount;

    try {
      await mongoConns.mainDBwithTransaction(async (session) => {
        // Find and remove organization from account
        // Only allow to delete current default org,
        // this is required to make sure the API permissions
        // are set properly for updating this organization
        const orgList = await getAccessTokenOrgList(user, undefined, false);
        if (!orgList.includes(id)) {
          throw new Error('Please select an organization to delete it');
        }

        const account = await Accounts.findOneAndUpdate(
          { _id: user.defaultAccount },
          { $pull: { organizations: id } },
          { upsert: false, new: true, session }
        );

        if (!account) {
          throw new Error('Cannot delete organization');
        }

        // Since the selected org is deleted, need to select another organization available
        user.defaultOrg = null;
        await orgUpdateFromNull({ user }, response);

        // Remove organization
        await Organizations.findOneAndRemove(
          { _id: id, account: user.defaultAccount },
          { session: session });

        // Remove all memberships that belong to the organization, but keep group even if empty
        await membership.deleteMany({ organization: id }, { session: session });

        // Remove organization inventory (devices, tokens, tunnelIds, tunnels, etc.)
        await Tunnels.deleteMany({ org: id }, { session: session });
        await TunnelIds.deleteMany({ org: id }, { session: session });
        await Tokens.deleteMany({ org: id }, { session: session });
        await AccessTokens.deleteMany({ organization: id }, { session: session });
        await MultiLinkPolicies.deleteMany({ org: id }, { session: session });
        await PathLabels.deleteMany({ org: id }, { session: session });
        await Vrrp.deleteMany({ org: id }, { session: session });
        await Peers.deleteMany({ org: id }, { session: session });
        await Applications.deleteMany({ org: id }, { session: session });
        await QosPolicies.deleteMany({ org: id }, { session: session });
        await FirewallPolicies.deleteMany({ org: id }, { session: session });
        await appIdentifications.deleteMany({ 'meta.org': id }, { session: session });
        await importedAppIdentifications.deleteMany({ 'meta.org': id }, { session: session });
        await NotificationsConf.deleteMany({ org: id }, { session: session });

        // Find all devices for organization
        orgDevices = await Devices.devices.find({ org: id },
          { machineId: 1, _id: 0 },
          { session: session });

        // Get the account total device count
        deviceCount = await Devices.devices.countDocuments({ account: user.defaultAccount._id })
          .session(session);

        deviceOrgCount = await Devices.devices.countDocuments(
          { account: user.defaultAccount._id, org: id }
        ).session(session);

        // Delete all devices
        await Devices.devices.deleteMany({ org: id }, { session: session });
        // Unregister a device (by removing the removed org number)
        await Flexibilling.registerDevice({
          account: user.defaultAccount._id,
          org: id,
          count: deviceCount,
          orgCount: deviceOrgCount,
          increment: -orgDevices.length
        }, session);
      });

      // If successful, Disconnect all devices
      orgDevices.forEach((device) => Connections.deviceDisconnect(device.machineId));

      return Service.successResponse(null, 204);
    } catch (e) {
      logger.error('Error deleting organization', { params: { reason: e.message } });

      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify organization
   *
   * id String Numeric ID of the Organization to modify
   * organizationRequest OrganizationRequest  (optional)
   * returns Organization
   **/
  static async organizationsIdPUT (organizationRequest, { user }, response) {
    try {
      const { id } = organizationRequest;
      // Only allow to update current default org, this is required to make sure the API permissions
      // are set properly for updating this organization
      const orgList = await getAccessTokenOrgList(user, undefined, false);
      if (!orgList.includes(id)) {
        throw new Error('Please select an organization to update it');
      }

      const { name, description, group, encryptionMethod, vxlanPort, tunnelRange } =
        organizationRequest;
      const org = await Organizations.findOne({ _id: id });
      if (!org) {
        throw new Error('Organization ID is incorrect');
      }
      const origVxlanPort = org.vxlanPort;
      const origTunnelRange = org.tunnelRange;
      const orgDevices = await Devices.devices
        .find({ org: id })
        .populate('org')
        .populate('policies.firewall.policy', '_id name rules');

      // update org, don't save
      org.name = name;
      org.description = description;
      org.group = group;
      org.encryptionMethod = encryptionMethod;
      org.vxlanPort = vxlanPort ?? origVxlanPort; // if not specified by user, set the orig value
      org.tunnelRange = tunnelRange ?? origTunnelRange;

      const isVxlanPortChanged = origVxlanPort !== vxlanPort;
      const isTunnelRangeChanged = origTunnelRange !== tunnelRange;
      if (isVxlanPortChanged) {
        validateVxlanPortChange(orgDevices, org);
      }

      if (isTunnelRangeChanged) {
        // check that no config used the old range
        const staticRoutesDevice = await Devices.devices.aggregate([
          // only device with static routes
          { $match: { org: ObjectId(id), 'staticroutes.0': { $exists: true } } },
          { $project: { _id: 1, name: 1, staticroutes: 1 } },
          {
            $addFields: {
              subnets: {
                $map: {
                  input: '$staticroutes',
                  as: 'staticroute',
                  in: { $concat: ['$$staticroute.gateway', '/', '32'] }
                }
              }
            }
          },
          {
            $addFields: {
              isOverlapping: {
                $function: {
                  body: checkOverlapping.toString(),
                  args: ['$subnets', [origTunnelRange + '/' + configs.get('tunnelRangeMask')]],
                  lang: 'js'
                }
              }
            }
          },
          { $match: { 'isOverlapping.0': { $exists: true } } },
          { $unset: ['isOverlapping', 'subnets'] }
        ]).allowDiskUse(true);

        if (staticRoutesDevice.length > 0) {
          throw new Error(
            `Static route is configured on device ${staticRoutesDevice[0].name} ` +
            `via the old tunnel range (${staticRoutesDevice[0].staticroutes[0].gateway}). ` +
            'Remove it first');
        }

        const tunnelRangeWithMask = `${tunnelRange}/${configs.get('tunnelRangeMask')}`;
        const overlappingSubnets = await validateOverlappingSubnets(org, [tunnelRangeWithMask]);
        for (const overlappingSubnet of overlappingSubnets) {
          const { type, overlappingWith, meta } = overlappingSubnet;

          let errMsg = 'The new tunnel range overlaps with ';

          if (type === 'lanInterface') {
            errMsg += `address ${overlappingWith} of the LAN interface `;
            errMsg += `${meta.interfaceName} in device ${meta.deviceName}`;
            throw new Error(errMsg);
          }

          if (type === 'tunnel') {
            continue; // we are going to change tunnel range, so no need to validate it
          }

          if (type === 'application') {
            errMsg += `address ${overlappingWith} of the application `;
            errMsg += `${meta.appName} in device ${meta.deviceName}`;
            throw new Error(errMsg);
          }
        }
      }

      // now, save
      const updatedOrg = await org.save({ validateBeforeSave: true });

      // after save, send jobs to devices
      if (isVxlanPortChanged) {
        // only 6.2 and later support vxlan port change.
        const devices = orgDevices.filter((d) => {
          const majorVersion = getMajorVersion(d.versions.agent);
          const minorVersion = getMinorVersion(d.versions.agent);
          return majorVersion > 6 || (majorVersion === 6 && minorVersion >= 2);
        });

        if (devices.length > 0) {
          await handleVxlanPortTunnelRangeChange(
            updatedOrg,
            vxlanPort,
            devices,
            user,
            isVxlanPortChanged,
            isTunnelRangeChanged
          );
        }
      } else if (isTunnelRangeChanged) {
        await handleVxlanPortTunnelRangeChange(
          updatedOrg,
          vxlanPort,
          orgDevices,
          user,
          isVxlanPortChanged,
          isTunnelRangeChanged
        );
      }

      // Update token
      const token = await getToken({ user }, { orgName: organizationRequest.name });
      response.setHeader('Refresh-JWT', token);

      return Service.successResponse(OrganizationsService.selectOrganizationParams(updatedOrg));
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get organization summary
   *
   * org String Numeric ID of the Organization to get
   * returns Organization summary
   **/
  static async organizationsSummaryGET ({ org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const devicesPipeline = [
        // org match
        { $match: { org: mongoose.Types.ObjectId(orgList[0]) } },
        {
          $group: {
            _id: null,
            // Connected devices
            connected: { $sum: { $cond: [{ $eq: ['$isConnected', true] }, 1, 0] } },
            // Approved devices
            approved: { $sum: { $cond: [{ $eq: ['$isApproved', true] }, 1, 0] } },
            // Running devices - connected and running
            running: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$isConnected', true] },
                    { $eq: ['$status', 'running'] }]
                }, 1, 0]
              }
            },
            // Devices with warning
            warning: {
              $sum: {
                $cond: [{
                  $and: [
                    // Device should be connected
                    { $eq: ['$isConnected', true] },
                    {
                      $or: [{
                        // One of the interfaces internet access != yes (size > 0)
                        $gt: [{
                          $size: {
                            $filter: {
                              input: '$interfaces',
                              as: 'intf',
                              cond: {
                                $and: [{
                                  $or: [
                                    { $eq: ['$$intf.linkStatus', 'down'] },
                                    {
                                      $and: [
                                        { $ne: ['$$intf.internetAccess', 'yes'] },
                                        { $eq: ['$$intf.monitorInternet', true] }]
                                    }]
                                },
                                { $eq: ['$$intf.type', 'WAN'] }]
                              }
                            }
                          }
                        }, 0]
                      },
                      {
                        // or one of the static routes is pending (size > 0)
                        $gt: [{
                          $size: {
                            $filter: {
                              input: '$staticroutes',
                              as: 'sr',
                              cond: { $eq: ['$$sr.isPending', true] }
                            }
                          }
                        }, 0]
                      }]
                    }]
                }, 1, 0]
              }
            },
            // Total devices
            total: { $sum: 1 }
          }
        }
      ];

      const tunnelsPipeline = [
        // org match and active
        { $match: { org: mongoose.Types.ObjectId(orgList[0]), isActive: true } },
        // Populate device A and B
        {
          $lookup: {
            from: 'devices',
            let: { idA: '$deviceA', idB: '$deviceB' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $or: [{ $eq: ['$_id', '$$idA'] }, { $eq: ['$_id', '$$idB'] }] },
                      { $eq: ['$isConnected', false] }
                    ]
                  }
                }
              },
              { $project: { _id: 0, isConnected: 1 } }
            ],
            as: 'devices'
          }
        },
        {
          $group: {
            _id: null,
            // Tunnels unknown - devices not connected
            tunUnknown: { $sum: { $cond: [{ $ne: ['$devices', []] }, 1, 0] } },
            // Tunnels with warning (pending) - devices connected and isPending
            tunWarning: {
              $sum: {
                $cond: [{ $and: [{ $eq: ['$isPending', true] }, { $eq: ['$devices', []] }] }, 1, 0]
              }
            },
            // Connected tunnels - devices connected, not pending, and status up
            tunConnected: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'up'] },
                      { $eq: ['$isPending', false] },
                      { $eq: ['$devices', []] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            // Total tunnels
            tunTotal: { $sum: 1 }
          }
        }
      ];

      const bytesPipeline = [
        { $match: { month: { $gte: 1632762341553 } } },
        { $project: { month: 1, ['stats.orgs.' + orgList[0]]: 1 } },
        { $project: { month: 1, orgs: { $objectToArray: '$stats.orgs' } } },
        { $unwind: '$orgs' },
        { $project: { month: 1, org: '$orgs.k', devices: { $objectToArray: '$orgs.v.devices' } } },
        { $unwind: '$devices' },
        { $project: { month: 1, org: 1, account: 1, bytes: '$devices.v.bytes' } },
        {
          $group: {
            _id: { month: '$month' },
            devices_bytes: { $sum: '$bytes' },
            devices_count: { $push: '$bytes' }
          }
        },
        {
          $project: {
            _id: 0,
            org: '$_id.org',
            month: '$_id.month',
            bytes: '$devices_bytes',
            deviceCount: { $size: '$devices_count' }
          }
        },
        { $sort: { month: -1 } }
      ];

      const devicesRes = await Devices.devices.aggregate(devicesPipeline).allowDiskUse(true);
      const { connected, approved, running, warning, total } =
        devicesRes.length > 0
          ? devicesRes[0]
          : { connected: 0, approved: 0, running: 0, warning: 0, total: 0 };
      const tunnelsRes = await Tunnels.aggregate(tunnelsPipeline).allowDiskUse(true);
      const { tunConnected, tunWarning, tunUnknown, tunTotal } =
        tunnelsRes.length > 0
          ? tunnelsRes[0]
          : { tunConnected: 0, tunWarning: 0, tunUnknown: 0, tunTotal: 0 };
      const bytesRes = await deviceAggregateStats.aggregate(bytesPipeline).allowDiskUse(true);

      const response = {
        devices: { connected, approved, running, warning, total },
        tunnels: {
          connected: tunConnected,
          warning: tunWarning,
          unknown: tunUnknown,
          total: tunTotal
        },
        traffic: bytesRes
      };

      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Add new organization
   *
   * organizationRequest OrganizationRequest  (optional)
   * returns Organization
   **/
  static async organizationsPOST (organizationRequest, { user }, response) {
    let session = null;
    try {
      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();
      const orgBody = { ...organizationRequest, account: user.defaultAccount };
      const _org = await Organizations.create([orgBody], { session: session });
      const org = _org[0];
      const updUser = await Users.findOneAndUpdate(
        // Query, use the email
        { _id: user._id },
        // Update
        { defaultOrg: org._id },
        // Options
        { upsert: false, new: true, session: session }
      );

      if (!updUser) throw new Error('Error updating default organization');
      // Add organization to default account
      const updAccount = await Accounts.findOneAndUpdate(
        { _id: updUser.defaultAccount },
        { $addToSet: { organizations: org._id } },
        { upsert: false, new: true, session: session }
      );

      if (!updAccount) throw new Error('Error adding organization to account');

      // Create a default QoS policy
      const qosPolicy = await QosPolicies.create(
        [
          {
            org: org,
            name: 'Default QoS',
            description: 'Created automatically',
            outbound: {
              realtime: {
                bandwidthLimitPercent: '30',
                dscpRewrite: 'CS0'
              },
              'control-signaling': {
                weight: '40',
                dscpRewrite: 'CS0'
              },
              'prime-select': {
                weight: '30',
                dscpRewrite: 'CS0'
              },
              'standard-select': {
                weight: '20',
                dscpRewrite: 'CS0'
              },
              'best-effort': {
                weight: '10',
                dscpRewrite: 'CS0'
              }
            },
            inbound: {
              bandwidthLimitPercentHigh: 90,
              bandwidthLimitPercentMedium: 80,
              bandwidthLimitPercentLow: 70
            },
            advanced: false
          }
        ],
        {
          session: session
        }
      );
      if (!qosPolicy) throw new Error('Error default QoS policy adding');

      // Add default notifications settings
      const notificationsSettings = await notificationsMgr.getDefaultNotificationsSettings(
        updUser.defaultAccount._id);
      const ownerMembership = await membership.find({
        account: updUser.defaultAccount,
        to: 'account',
        role: 'owner'
      });
      let accountOwners = [];
      if (ownerMembership.length > 1) {
        ownerMembership.forEach(owner => {
          accountOwners.push(owner.user);
        });
      } else {
        accountOwners = [ownerMembership[0].user];
      }
      const setNotificationsConf = await NotificationsConf.create({
        org: org._id,
        rules: notificationsSettings,
        signedToCritical: [],
        signedToWarning: [],
        signedToDaily: accountOwners,
        webHookSettings: { webhookURL: '', sendCriticalAlerts: false, sendWarningAlerts: false }
      });
      if (!setNotificationsConf) {
        throw new Error('Error adding default notifications settings');
      }
      session.commitTransaction();

      const token = await getToken({ user }, { org: org._id, orgName: org.name });
      response.setHeader('Refresh-JWT', token);

      return Service.successResponse(OrganizationsService.selectOrganizationParams(org), 201);
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = OrganizationsService;

const getTunnelsPipeline = (id, origVxlanPort) => {
  // if VXLAN port is changed, we need to reconstruct all tunnels
  // to use the new source port.
  // but, since that change in source port may trigger public port change,
  // the STUN may detect another public port and triggers another reconstruction of the same tunnel.
  //
  // So, the idea is to try to guess which tunnel will be reconstructed via STUN.
  // If *one of the interfaces* will cause the tunnels to be reconstructed,
  // there is no need to do a reconstruct right now but we can wait for STUN to fix it.
  return [
    // we don't use vxlan for peers, so filter those tunnels out.
    { $match: { org: id, isActive: true, isPending: false, peer: null } },
    {
      $project: {
        _id: 1,
        num: 1,
        org: 1,
        deviceA: 1,
        deviceB: 1,
        interfaceA: 1,
        interfaceB: 1,
        isPending: 1,
        pendingReason: 1,
        peer: 1,
        pathlabel: 1,
        advancedOptions: 1,
        encryptionMethod: 1
      }
    },
    {
      $lookup: {
        from: 'devices',
        let: { idA: '$deviceA', idB: '$deviceB', ifcA: '$interfaceA', ifcB: '$interfaceB' },
        as: 'devices',
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$org', id] },
                  { $or: [{ $eq: ['$_id', '$$idA'] }, { $eq: ['$_id', '$$idB'] }] }
                ]
              }
            }
          },
          {
            $project: {
              _id: 1,
              name: 1,
              machineId: 1,
              versions: 1,
              hostname: 1,
              IKEv2: 1,
              bgp: 1,
              'interfaces._id': 1,
              tunnelInterface: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: '$interfaces',
                      as: 'ifc',
                      cond: {
                        $and: [
                          { $eq: ['$$ifc.type', 'WAN'] },
                          {
                            $or: [
                              { $eq: ['$$ifc._id', '$$ifcA'] },
                              { $eq: ['$$ifc._id', '$$ifcB'] }
                            ]
                          }
                        ]
                      }
                    }
                  },
                  0
                ]
              }
            }
          }
        ]
      }
    },
    {
      $addFields: {
        deviceA: { $arrayElemAt: ['$devices', 0] },
        deviceB: { $arrayElemAt: ['$devices', 1] },
        interfaceA: {
          $let: {
            vars: { deviceA: { $arrayElemAt: ['$devices', 0] } },
            in: '$$deviceA.tunnelInterface'
          }
        },
        interfaceB: {
          $let: {
            vars: { deviceB: { $arrayElemAt: ['$devices', 1] } },
            in: '$$deviceB.tunnelInterface'
          }
        }
      }
    },
    {
      $addFields: {
        op: {
          $cond: {
            if: {
              // $or because one interface that met the conditions
              // is enough to decide whether the reconstruct or pending
              $or: [
                { $and: getInterfaceConditionsToBePending('interfaceA', origVxlanPort) },
                { $and: getInterfaceConditionsToBePending('interfaceB', origVxlanPort) }
              ]
            },
            then: 'pending',
            else: 'reconstruct'
          }
        }
      }
    },
    {
      $group: {
        _id: null,
        toPending: {
          $push: {
            $cond: {
              if: { $eq: ['$op', 'pending'] },
              then: '$$ROOT',
              else: '$$REMOVE'
            }
          }
        },
        toReconstruct: {
          $push: {
            $cond: {
              if: { $eq: ['$op', 'reconstruct'] },
              then: '$$ROOT',
              else: '$$REMOVE'
            }
          }
        }
      }
    }
  ];
};

const getInterfaceConditionsToBePending = (key, origVxlanPort) => {
  return [
    // uses STUN
    { $eq: [`$${key}.useStun`, true] },
    // doesn't use static public port
    { $eq: [`$${key}.useFixedPublicPort`, false] },
    // has public port and public IP
    { $ne: [`$${key}.PublicIP`, ''] },
    { $ne: [`$${key}.PublicPort`, ''] },
    // if original source port equals to the public port,
    // we can assume that new source port will be used
    // as the new public port so we can reconstruct now.
    { $ne: [`$${key}.PublicPort`, origVxlanPort] }
  ];
};

const handleToPendingTunnels = async (tunnels) => {
  if (tunnels.length === 0) return [];

  const failedDevices = new Set();
  const deviceIds = new Set();
  const interfacesIds = new Set();

  const events = new DeviceEvents();
  const pendingType = pendingTypes.waitForStun;
  const reason = getReason(pendingType);

  for (const tunnel of tunnels) {
    try {
      await events.setOneTunnelAsPending(tunnel, reason, pendingType, tunnel.deviceA);

      deviceIds.add(tunnel.deviceA._id.toString());
      deviceIds.add(tunnel.deviceB._id.toString());
      interfacesIds.add(tunnel.interfaceA._id.toString());
      interfacesIds.add(tunnel.interfaceB._id.toString());
    } catch (err) {
      logger.error('Failed to set tunnel as pending', { params: { reason: err.message, tunnel } });
      failedDevices.add(tunnel.deviceA._id.toString());
      failedDevices.add(tunnel.deviceB._id.toString());
    }
  }

  // remove public port from both interfaces
  await Devices.devices.updateMany(
    { _id: { $in: [...deviceIds] } },
    { $set: { 'interfaces.$[elem].PublicPort': '' } },
    { upsert: false, arrayFilters: [{ 'elem._id': { $in: [...interfacesIds] } }] }
  );

  return failedDevices;
};

const addDeviceTasks = (obj, device, task) => {
  if (!task) return;

  const deviceId = device._id.toString();

  if (!(deviceId in obj)) {
    obj[deviceId] = {
      device: device,
      tasks: []
    };
  }

  if (Array.isArray(task)) {
    obj[deviceId].tasks.push(...task);
  } else {
    obj[deviceId].tasks.push(task);
  }
};

const handleVxlanPortTunnelRangeChange = async (
  org,
  origVxlanPort,
  orgDevices,
  user,
  isVxlanPortChanged,
  isTunnelRangeChanged
) => {
  const orgId = org._id;
  const devicesJobs = {}; // mapping object [deviceId] = { device: {}, tasks: [] }
  const desynchronizedDevices = new Set();

  try {
    const pipeline = getTunnelsPipeline(mongoose.Types.ObjectId(orgId), origVxlanPort);
    const tunnels = await Tunnels.aggregate(pipeline).allowDiskUse(true);
    // The expected output is array with one object with two keys:
    //  [{ _id: null, toPending: [], toReconstruct: [] }]
    //
    const toPending = tunnels?.[0]?.toPending ?? [];
    const toReconstruct = tunnels?.[0]?.toReconstruct ?? [];

    if (isVxlanPortChanged) {
      // handle tunnels that should be pending. Do not send jobs
      const failedDevicesIds = await handleToPendingTunnels(toPending);
      failedDevicesIds.forEach((f) => desynchronizedDevices.add(f));
    } else if (isTunnelRangeChanged) {
      toReconstruct.push(...toPending);
    }

    // first prepare remove-tunnel tasks for each device
    for (const removeTunnel of [...toPending, ...toReconstruct]) {
      const [removeTasksDevA, removeTasksDevB] = await prepareTunnelRemoveJob(removeTunnel, true);
      addDeviceTasks(devicesJobs, removeTunnel.deviceA, removeTasksDevA);
      addDeviceTasks(devicesJobs, removeTunnel.deviceB, removeTasksDevB);
    }

    // now prepare the modify-vxlan-config task for each device
    if (isVxlanPortChanged) {
      const params = transformVxlanConfig(org);
      for (const orgDevice of orgDevices) {
        addDeviceTasks(devicesJobs, orgDevice, { message: 'modify-vxlan-config', params });
      }
    }

    // now prepare add-tunnel tasks for each device
    for (const addTunnel of toReconstruct) {
      const [addTasksDevA, addTasksDevB] = await prepareTunnelAddJob(addTunnel, org, true);
      addDeviceTasks(devicesJobs, addTunnel.deviceA, addTasksDevA);
      addDeviceTasks(devicesJobs, addTunnel.deviceB, addTasksDevB);
    }

    // finally, send one job to each device that contains all the tasks
    for (const deviceId in devicesJobs) {
      try {
        const tasks = devicesJobs[deviceId].tasks;
        const device = devicesJobs[deviceId].device;
        await processModifyJob(tasks, device, orgId, user);
      } catch (err) {
        logger.error('Error in sending modify vxlan jobs to device', {
          params: { reason: err.message, deviceId }
        });

        // send sync later but don't throw exception
        desynchronizedDevices.add(deviceId);
      }
    }
  } catch (err) {
    logger.error('Error in handling vxlan or tunnel range change', {
      params: {
        reason: err.message,
        origVxlanPort,
        newVxlanPort: org.vxlanPort,
        orgId: org._id
      }
    });

    // here, no job was sent (it was handled by nested try and catch). hence we sync all devices
    await forceDevicesSync(orgDevices.map((d) => d._id));
    desynchronizedDevices.clear();
  }

  if (desynchronizedDevices.size > 0) {
    await forceDevicesSync(desynchronizedDevices);
  }
};

const validateVxlanPortChange = (devices, org) => {
  for (const device of devices) {
    const { interfaces, firewall, policies } = device.toObject();
    const deviceRules = firewall?.rules ?? [];
    const globalRules = policies?.firewall?.status?.startsWith('install')
      ? policies?.firewall?.policy?.rules ?? []
      : [];
    const rules = [...globalRules, ...deviceRules];

    if (rules.length === 0) {
      continue;
    }

    const { valid } = validateFirewallRules(rules, org, interfaces);
    if (!valid) {
      const errMsg = `Your organization has a firewall rule using port ${org.vxlanPort}. ` +
      'The VxLAN port must not be used in any firewall rule';
      throw new Error(errMsg);
    }
  }
};
