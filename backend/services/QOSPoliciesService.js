// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022 flexiWAN Ltd.

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
const createError = require('http-errors');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const QOSPolicies = require('../models/qosPolicies');
const QOSTrafficMap = require('../models/qosTrafficMap');
const { devices } = require('../models/devices');
const { ObjectId } = require('mongoose').Types;
const { applyPolicy } = require('../deviceLogic/qosPolicy');
const { getFullTrafficMap, apply: applyTrafficMap } = require('../deviceLogic/qosTrafficMap');

class QOSPoliciesService {
  static async verifyRequestSchema (qosPolicyRequest, org) {
    const { _id, name } = qosPolicyRequest;

    // Duplicate names are not allowed in the same organization
    const hasDuplicateName = await QOSPolicies.findOne(
      { org, name: { $regex: new RegExp(`^${name}$`, 'i') }, _id: { $ne: _id } }
    );
    if (hasDuplicateName) {
      return {
        valid: false,
        message: 'Duplicate names are not allowed in the same organization'
      };
    };
    const { outbound } = qosPolicyRequest;
    if (!outbound) {
      return {
        valid: false,
        message: 'WAN Outbound QoS parameters must be specified'
      };
    }

    const dscpOptions = [
      'CS0', 'CS1', 'CS2', 'CS3', 'CS4', 'CS5', 'CS6', 'CS7',
      'AF11', 'AF12', 'AF13', 'AF21', 'AF22', 'AF23', 'AF31',
      'AF32', 'AF33', 'AF41', 'AF42', 'AF43', 'EF', 'VA'
    ];

    const { bandwidthLimitPercent, dscpRewrite } = outbound.realtime || {};
    if (!bandwidthLimitPercent || bandwidthLimitPercent < 10 || bandwidthLimitPercent > 90) {
      return {
        valid: false,
        message: 'Wrong Realtime Bandwidth Limit Percent value'
      };
    }

    if (!dscpOptions.includes(dscpRewrite)) {
      return {
        valid: false,
        message: 'Wrong Realtime DSCP Rewrite value'
      };
    }

    const dataTrafficClasses = [
      'control-signaling',
      'prime-select',
      'standard-select',
      'best-effort'
    ];
    for (const trafficClassName of dataTrafficClasses) {
      const { weight, dscpRewrite } = outbound[trafficClassName] || {};
      if (!weight || weight < 10 || weight > 70) {
        return {
          valid: false,
          message: `Wrong ${trafficClassName} weight value`
        };
      }
      if (!dscpOptions.includes(dscpRewrite)) {
        return {
          valid: false,
          message: `Wrong ${trafficClassName} DSCP Rewrite value`
        };
      }
    }
    return { valid: true, message: '' };
  }

  /**
   * Get all QOS policies
   *
   * @static
   * @param {*} { offset, limit, org } pagination parameters and organization Id
   * @param {*} { user } the user object
   * @returns {Array} a list of QOS policies objects
   **/
  static async qosPoliciesGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const qosPolicies = await QOSPolicies.find(
        { org: { $in: orgList } },
        {
          name: 1,
          description: 1,
          advanced: 1,
          outbound: 1,
          inbound: 1
        }
      )
        .lean()
        .skip(offset)
        .limit(limit);

      return Service.successResponse(qosPolicies);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete a QOS policy
   *
   * @static
   * @param {*} { id, org } QOS policy and organization Ids
   * @param {*} { user } the user object
   *
   **/
  static async qosPoliciesIdDELETE ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Don't allow deleting a policy if it's
      // installed on at least one device
      const count = await devices.countDocuments({
        'policies.qos.policy': id,
        'policies.qos.status': { $in: ['installing', 'installed', 'installation failed'] },
        org: { $in: orgList }
      });

      if (count > 0) {
        const message = 'Cannot delete a policy that is being used';
        return Service.rejectResponse(message, 400);
      }

      await devices.updateMany({
        org: { $in: orgList },
        'policies.qos.policy': id,
        'policies.qos.status': { $nin: ['installing', 'installed', 'installation failed'] }
      }, {
        $set: {
          'policies.qos.policy': null,
          'policies.qos.status': '',
          'policies.qos.requestTime': null
        }
      });

      const { deletedCount } = await QOSPolicies.deleteOne({
        org: { $in: orgList },
        _id: id
      });

      if (deletedCount === 0) {
        return Service.rejectResponse('Not found', 404);
      }

      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get a QOS policy by id
   *
   * @static
   * @param {*} { id, org } QOS policy and organization Ids
   * @param {*} { user } the user object
   * @returns {Object} a QOS policy object
   **/
  static async qosPoliciesIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const qosPolicy = await QOSPolicies.findOne(
        {
          org: { $in: orgList },
          _id: id
        },
        {
          name: 1,
          description: 1,
          advanced: 1,
          outbound: 1,
          inbound: 1
        }
      )
        .lean();

      if (!qosPolicy) {
        return Service.rejectResponse('Not found', 404);
      }

      qosPolicy._id = qosPolicy._id.toString();
      return Service.successResponse(qosPolicy);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify a QOS policy
   *
   * @static
   * @param {*} { qosPolicyRequest, id, org } QOS policy request, QOS policy and organization Ids
   * @param {*} { user } the user object
   * @returns {Object} a QOS policy object
   **/
  static async qosPoliciesIdPUT ({ qosPolicyRequest, id, org }, { user }) {
    try {
      const { name, description, advanced, outbound, inbound } = qosPolicyRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Verify request schema
      const { valid, message } = await QOSPoliciesService.verifyRequestSchema(
        qosPolicyRequest, orgList[0]
      );
      if (!valid) {
        throw createError(400, message);
      }

      const qosPolicy = await QOSPolicies.findOneAndUpdate(
        {
          org: { $in: orgList },
          _id: id
        },
        {
          org: orgList[0].toString(),
          name: name,
          description: description,
          advanced: advanced,
          outbound: outbound,
          inbound: inbound
        },
        {
          fields: {
            name: 1,
            description: 1,
            advanced: 1,
            outbound: 1,
            inbound: 1
          },
          new: true
        }
      )
        .lean();

      if (!qosPolicy) {
        return Service.rejectResponse('Not found', 404);
      }

      const opDevices = await devices.find(
        {
          org: orgList[0],
          $or: [
            { 'policies.qos.policy': id },
            { 'interfaces.qosPolicy': id }
          ],
          'policies.qos.status': { $in: ['installing', 'installed', 'installation failed'] }
        },
        {
          name: 1,
          machineId: 1,
          cpuInfo: 1,
          versions: 1,
          interfaces: 1
        }
      )
        .populate('interfaces.qosPolicy')
        .populate('policies.qos.policy');

      // apply on devices
      qosPolicy._id = qosPolicy._id.toString();
      const applied = await applyPolicy(opDevices, qosPolicy, 'install', user, orgList[0], true);

      return Service.successResponse({ ...qosPolicy, ...applied });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get all QOS policies names and IDs only
   *
   * @static
   * @param {*} { offset, limit, org } pagination parameters and organization Id
   * @param {*} { user } the user object
   * @returns {Array} a list of QOS policies names and IDs objects
   **/
  static async qosPoliciesListGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const qosPolicies = await QOSPolicies.find(
        { org: { $in: orgList } },
        { name: 1 }
      )
        .skip(offset)
        .limit(limit);

      return Service.successResponse(qosPolicies);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Add a new QOS policy
   *
   * @static
   * @param {*} { qosPolicyRequest, org } QOS policy request object and organization Id
   * @param {*} { user } the user object
   * @returns {Object} a QOS policy object
   **/
  static async qosPoliciesPOST ({ qosPolicyRequest, org }, { user }) {
    try {
      const { name, description, advanced, outbound, inbound } = qosPolicyRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Verify request schema
      const { valid, message } = await QOSPoliciesService.verifyRequestSchema(
        qosPolicyRequest, orgList[0]
      );
      if (!valid) {
        throw createError(400, message);
      }

      const qosPolicy = await QOSPolicies.create({
        org: orgList[0].toString(),
        name: name,
        description: description,
        advanced: advanced,
        outbound: outbound,
        inbound: inbound
      });

      const converted = JSON.parse(JSON.stringify(qosPolicy));
      return Service.successResponse(converted, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get all QOS policies metadata
   *
   * @static
   * @param {*} { org } Organization to be filtered by (optional)
   * @param {*} { user } the user object
   * @returns {Array} a list of QOS policies metadata
   **/
  static async qosPoliciesMetaGET ({ org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);

      // Fetch all QOS policies of the organization.
      // To each policy, attach the installation status of
      // each of the devices the policy is installed on.
      const qosPoliciesMeta = await QOSPolicies.aggregate([
        { $match: { org: { $in: orgList.map(org => ObjectId(org)) } } },
        {
          $project: {
            _id: 1,
            name: 1,
            description: 1
          }
        },
        {
          $lookup: {
            from: 'devices',
            let: { id: '$_id' },
            pipeline: [
              { $unwind: '$interfaces' },
              {
                $match: {
                  $expr: {
                    $or: [
                      {
                        $eq: [
                          '$policies.qos.policy',
                          '$$id'
                        ]
                      },
                      {
                        $eq: [
                          '$interfaces.qosPolicy',
                          '$$id'
                        ]
                      }
                    ]
                  }
                }
              },
              {
                $group: {
                  _id: '$_id',
                  qos: { $first: '$policies.qos' }
                }
              },
              { $project: { qos: 1 } }
            ],
            as: 'policies'
          }
        },
        { $addFields: { statuses: '$policies.qos.status' } },
        {
          $project: {
            _id: { $toString: '$_id' },
            name: 1,
            description: 1,
            statuses: 1
          }
        }
      ]).allowDiskUse(true);

      const response = qosPoliciesMeta.map(policy => {
        const installCount = {
          installed: 0,
          pending: 0,
          failed: 0,
          deleted: 0
        };
        policy.statuses.forEach(policyStatus => {
          if (policyStatus === 'installed') {
            installCount.installed++;
          } else if (['installing', 'uninstalling'].includes(policyStatus)) {
            installCount.pending++;
          } else if (policyStatus.includes('fail')) {
            installCount.failed++;
          } else if (policyStatus.includes('deleted')) {
            installCount.deleted++;
          }
        });
        const { statuses, ...rest } = policy;
        return {
          ...rest,
          installCount
        };
      });
      return Service.successResponse(response);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Get the QOS traffic map
   *
   * @static
   * @param {*} { org } Organization to be filtered by (optional)
   * @param {*} { user } User object
   * @returns {Object} The QOS Traffic Map object
   **/
  static async qosTrafficMapGET ({ org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const { trafficMap } = await getFullTrafficMap(orgList);
      return Service.successResponse(trafficMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Update the QOS traffic map
   *
   * @static
   * @param {*} { org, qosTrafficMapRequest } org id (optional) and QOS traffic map request
   * @param {*} { user } User object
   * @returns {Object} The QOS Traffic Map object
   **/
  static async qosTrafficMapPUT ({ org, qosTrafficMapRequest }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      // todo: validate qos traffic map request
      await QOSTrafficMap.findOneAndUpdate(
        { org: { $in: orgList } },
        { $set: { trafficMap: qosTrafficMapRequest } },
        { upsert: true, new: true }
      );
      const opDevices = await devices.find({ org: { $in: orgList } });
      await applyTrafficMap(opDevices, user, { org: orgList[0] });
      const { trafficMap } = await getFullTrafficMap(orgList);
      return Service.successResponse(trafficMap);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = QOSPoliciesService;
