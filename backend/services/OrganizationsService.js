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

const mongoose = require('mongoose');
const Accounts = require('../models/accounts');
const Devices = require('../models/devices');
const Users = require('../models/users');
const Organizations = require('../models/organizations');
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
const { getUserOrganizations, getUserOrgByID, orgUpdateFromNull } =
  require('../utils/membershipUtils');
const mongoConns = require('../mongoConns.js')();
const pick = require('lodash/pick');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getToken } = require('../tokens');

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
      'encryptionMethod'
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

      const list = result.map(element => {
        return {
          _id: element._id.toString(),
          name: element.name,
          description: element.description,
          account: element.account ? element.account.toString() : '',
          group: element.group,
          encryptionMethod: element.encryptionMethod
        };
      });

      return Service.successResponse(list);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async organizationsSelectPOST ({ organizationSelectRequest }, { user }, res) {
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

        const result = {
          _id: updUser.defaultOrg._id.toString(),
          name: updUser.defaultOrg.name,
          description: updUser.defaultOrg.description,
          account: updUser.defaultOrg.account ? updUser.defaultOrg.account.toString() : '',
          group: updUser.defaultOrg.group,
          encryptionMethod: updUser.defaultOrg.encryptionMethod
        };
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
  static async organizationsIdPUT ({ id, organizationRequest }, { user }, response) {
    try {
      // Only allow to update current default org, this is required to make sure the API permissions
      // are set properly for updating this organization
      const orgList = await getAccessTokenOrgList(user, undefined, false);
      if (orgList.includes(id)) {
        const { name, description, group, encryptionMethod } = organizationRequest;
        const resultOrg = await Organizations.findOneAndUpdate(
          { _id: id },
          { $set: { name, description, group, encryptionMethod } },
          { upsert: false, multi: false, new: true, runValidators: true }
        );
        // Update token
        const token = await getToken({ user }, { orgName: organizationRequest.name });
        response.setHeader('Refresh-JWT', token);
        return Service.successResponse(OrganizationsService.selectOrganizationParams(resultOrg));
      } else {
        throw new Error('Please select an organization to update it');
      }
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
                                $and: [
                                  {
                                    $or: [
                                      { $eq: ['$$intf.linkStatus', 'down'] },
                                      {
                                        $and: [
                                          { $ne: ['$$intf.internetAccess', 'yes'] },
                                          { $eq: ['$$intf.monitorInternet', true] }
                                        ]
                                      }
                                    ]
                                  },
                                  { $eq: ['$$intf.type', 'WAN'] }
                                ]
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
                      { $eq: ['$isConnected', false] }]
                  }
                }
              },
              { $project: { _id: 0, isConnected: 1 } }],
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
                $cond: [
                  { $and: [{ $eq: ['$isPending', true] }, { $eq: ['$devices', []] }] }, 1, 0]
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
                      { $eq: ['$devices', []] }]
                  }, 1, 0]
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
      const { connected, approved, running, warning, total } = devicesRes.length > 0
        ? devicesRes[0]
        : { connected: 0, approved: 0, running: 0, warning: 0, total: 0 };
      const tunnelsRes = await Tunnels.aggregate(tunnelsPipeline).allowDiskUse(true);
      const { tunConnected, tunWarning, tunUnknown, tunTotal } = tunnelsRes.length > 0
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
  static async organizationsPOST ({ organizationRequest }, { user }, response) {
    try {
      const session = await mongoConns.getMainDB().startSession();
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
      const qosPolicy = await QosPolicies.create([{
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
      }], {
        session: session
      });
      if (!qosPolicy) throw new Error('Error default QoS policy adding');

      session.commitTransaction();

      const token = await getToken({ user }, { org: org._id, orgName: org.name });
      response.setHeader('Refresh-JWT', token);

      return Service.successResponse(OrganizationsService.selectOrganizationParams(org), 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = OrganizationsService;
