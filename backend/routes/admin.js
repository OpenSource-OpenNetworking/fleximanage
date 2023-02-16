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

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('./cors');
const auth = require('../authenticate');
const connections = require('../websocket/Connections')();
const deviceStatus = require('../periodic/deviceStatus')();
const usersModel = require('../models/users');
const accountsModel = require('../models/accounts');
const flexibilling = require('../flexibilling');
const { deviceAggregateStats } = require('../models/analytics/deviceStats');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const keyBy = require('lodash/keyBy');

const adminRouter = express.Router();
adminRouter.use(bodyParser.json());

/**
 * This route is allowed only if the organization is marked as admin
 * Return internal information
 */
adminRouter
  .route('/')
// When options message received, reply origin based on whitelist
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, auth.verifyAdmin, async (req, res, next) => {
    // users
    const registeredUsers = await getRegisteredUsers();

    // monthly traffic from the first time of the system
    const monthlyStats = await getMonthlyStats();

    // traffic per organizations (last 6 months)
    const bytesPerOrg = await getDevicesTraffic();

    // account data
    const accounts = await getAccountsData(req);

    // !!! IMPORTANT INFORMATION !!!!
    // three databases are involved here - flexiManage, flexiBilling, and flexiwanAnalytics
    // When an organization is removed from flexiManage DB,
    // we don't remove it from billing and analytics.
    // If an organizations doesn't include in the `accounts` array,
    // but exists in `summary` (flexiBilling) or in `bytesPerOrg` (flexiwanAnalytics) -
    // it means that this org is removed from flexiManage.
    // In such a case, we fill the accounts array with this deleted organization and mark it
    // with `deleted=true`.
    // The reason is to let the admin know about the traffic and devices count.
    // `createDefaultOrg()` is the template for organization based on the pipeline above

    // mapping orgs to account - orgId -> accountId
    const orgs = { /* orgId -> accountId */ };

    // get billing summary
    const billing = {};
    const accountsCopy = [...accounts.data];
    do {
      const AccountsForProcessing = accountsCopy.splice(0, 500);
      const ids = AccountsForProcessing.map(a => a.account_id);
      const summary = await flexibilling.getMaxDevicesRegisteredSummmaryByAccounts(ids);
      const featuresSummary = await flexibilling.getFeaturesSummaryByAccounts(ids);
      for (const s of summary) {
        billing[s.account] = s;
      };

      for (const s of featuresSummary) {
        if (!(s.account in billing)) {
          continue;
        }

        if (!('features' in billing[s.account])) {
          billing[s.account].features = {};
        }

        billing[s.account].features[s.feature] = s;
      };
    } while (accountsCopy.length > 0);

    try {
      for (const account of accounts.data) {
        const accountId = account.account_id;
        const accountOrgs = { /* orgId -> index in account.organizations */ };

        // fill global orgs mapping with account organizations
        account.organizations.forEach((ao, aoIdx) => {
          const orgId = ao.organization_id.toString();
          orgs[orgId] = accountId.toString();
          accountOrgs[orgId] = aoIdx;
        });

        try {
          // fill billing
          const summary = billing[accountId];
          const accountBillingInfo = {
            current: summary ? summary.current : null,
            max: summary ? summary.max : null,
            lastBillingDate: summary ? summary.lastBillingDate : null,
            lastBillingMax: summary ? summary.lastBillingMax : null,
            features: {}
          };

          const orgsFeaturesBilling = {};
          if (summary && summary.features) {
            for (const f in summary.features) {
              const name = f.replace(/_/g, ' ');
              accountBillingInfo.features[name] = {
                current: summary.features[f].current,
                max: summary.features[f].max,
                lastBillingDate: summary.features[f].lastBillingDate,
                lastBillingMax: summary.features[f].lastBillingMax
              };

              if (summary.features[f].organizations) {
                orgsFeaturesBilling[f] = keyBy(summary.features[f].organizations, 'org');
              }
            };
          }
          account.billingInfo = accountBillingInfo;

          if (!summary) {
            continue;
          }

          summary.organizations.forEach(o => {
            const orgId = o.org.toString();
            const orgBillingInfo = {
              current: o.current,
              max: o.max,
              lastBillingMax: o.lastBillingMax,
              features: {}
            };

            for (const f in orgsFeaturesBilling) {
              if (orgId in orgsFeaturesBilling[f]) {
                const orgData = orgsFeaturesBilling[f][orgId];
                const name = f.replace(/_/g, ' ');
                orgBillingInfo.features[name] = {
                  current: orgData.current,
                  max: orgData.max,
                  lastBillingMax: orgData.lastBillingMax
                };
              }
            }

            // Check if organizations of billing exists in fleximanage db
            const orgExists = accountOrgs.hasOwnProperty(orgId);

            if (orgExists) {
              account.organizations[accountOrgs[orgId]].billingInfo = orgBillingInfo;
            } else {
              // org might be deleted from flexiManage but exists in billing database,
              // see the important comment above
              const newOrg = createDefaultOrg(orgId, 'Unknown (Deleted)', orgBillingInfo);
              account.organizations.push(newOrg);
              orgs[orgId] = accountId.toString();
              accountOrgs[orgId] = account.organizations.length - 1;
            }
          });
        } catch (err) {
          logger.error('Error in processing account billing data', {
            params: { error: err.message, account }
          });
          throw err;
        }

        // fill traffic
        const bytesPerMonth = bytesPerOrg.reduce((result, current) => {
          try {
            const orgId = current.org;
            // Until July 2021, the statistics database kept only the organization ID,
            // without the account ID.
            // That's why there are organizations that we are trying to associate
            // with an account manually.

            let orgAccountId = current.account ? current.account.toString() : null;
            // If account is empty, try to get it from global mapping object
            // At this point, the organizations of current account already populated
            // So we can try to get it.
            if (!orgAccountId) {
              orgAccountId = orgs[orgId];
            }

            // If the organization is deleted from the flexiManage database
            // and remains only in the statistics database,
            // we have no way to associate it, and we continue without it.
            if (!orgAccountId) {
              return result;
            }

            // check if org is under current account
            if (accountId.toString() !== orgAccountId) return result;

            // Check if organizations of billing exists in fleximanage db
            const orgExists = accountOrgs.hasOwnProperty(orgId);

            let org = null;
            if (orgExists) {
              org = account.organizations[accountOrgs[orgId]];
            } else {
              // org might be deleted from flexiManage but exists in statistic database
              // see the important comment above
              const newOrg = createDefaultOrg(orgId, 'Unknown (Deleted)');
              account.organizations.push(newOrg);
              orgs[orgId] = accountId.toString();
              accountOrgs[orgId] = account.organizations.length - 1;
              org = account.organizations[account.organizations.length - 1]; // get pushed item
            }

            const monthName = current.month.toLocaleDateString();

            // add traffic data per organization
            if (!org.bytes) {
              org.bytes = {};
            }
            org.bytes[monthName] = current.devices_bytes;

            if (!result[monthName]) {
              result[monthName] = { bytes: 0 };
            }

            result[monthName].bytes += current.devices_bytes;
            result[monthName].devices = current.devices_count;

            return result;
          } catch (err) {
            logger.error('Error in processing account traffic data', {
              params: { error: err.message, bytesPerOrg, result, current, account }
            });
            throw err;
          }
        }, {});

        account.account_bytes = bytesPerMonth;
      }
    } catch (err) {
      logger.error('Error in processing accounts data', { params: { error: err.message } });
      return res.status(500).send('Failed to process accounts data');
    }

    // Return  static info from:
    const result = {
      ...registeredUsers[0],
      monthlyStats: monthlyStats,
      connectedDevices: [],
      accounts
    };

    // 1. Open websocket connections and connection info
    const devices = connections.getAllDevices();
    result.numConnectedDevices = devices.length;
    devices.forEach(deviceMachineId => {
      const deviceInfo = connections.getDeviceInfo(deviceMachineId);
      const devStatus = deviceStatus.getDeviceStatus(deviceMachineId);

      let deviceOrg = null;
      const account = accounts.data.find(a => {
        const org = a.organizations.find(ao => ao.organization_id.toString() === deviceInfo.org);
        if (org) {
          deviceOrg = org;
        }
        return org !== undefined;
      });
      result.connectedDevices.push({
        machineID: deviceMachineId,
        status: devStatus ? devStatus.state : 'unknown',
        version: deviceInfo.version,
        org: deviceInfo.org,
        orgName: deviceOrg ? deviceOrg.organization_name : '',
        accountId: account ? account.account_id : '',
        accountName: account ? account.account_name : ''
      });
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.json(result);
  });

// Default exports
module.exports = adminRouter;

const getRegisteredUsers = async () => {
  let registeredUsers = 'No info';
  try {
    registeredUsers = await usersModel
      .aggregate([{ $project: { username: 1 } }, { $count: 'num_registered_users' }])
      .allowDiskUse(true);
  } catch (e) {
    registeredUsers = 'Error getting registered users info, error=' + e.message;
  }
  return registeredUsers;
};

const getMonthlyStats = async () => {
  let monthlyStats = 'No info';
  try {
    monthlyStats = await deviceAggregateStats
      .aggregate([
        { $project: { month: 1, orgs: { $objectToArray: '$stats.orgs' } } },
        { $unwind: '$orgs' },
        { $project: { month: 1, org: '$orgs.k', devices: { $objectToArray: '$orgs.v.devices' } } },
        { $unwind: '$devices' },
        { $project: { month: 1, org: 1, device: '$devices.k', bytes: '$devices.v.bytes' } },
        {
          $group: {
            _id: { month: '$month' },
            active_orgs: { $addToSet: '$org' },
            active_devices: { $addToSet: '$device' },
            total_bytes: { $sum: '$bytes' }
          }
        },
        {
          $project: {
            _id: 0,
            month: '$_id.month',
            activeOrgs: { $size: '$active_orgs' },
            activeDevices: { $size: '$active_devices' },
            totalBytes: '$total_bytes'
          }
        },
        { $sort: { month: -1 } }
      ]).allowDiskUse(true);
    monthlyStats.forEach((result) => {
      result.month = (new Date(result.month)).toLocaleDateString();
      result.totalBytes = result.totalBytes.valueOf();
    });
  } catch (e) {
    monthlyStats = 'Error getting installed tunnels info, error=' + e.message;
  }
  return monthlyStats;
};

/**
  * Get traffic data - 6 months ago.
  * @async
  * @return {{trafficByAccount: {}, trafficByOrganization: {}}}
*/
const getDevicesTraffic = async () => {
  let result = [];
  try {
    const sixMonths = new Date();
    sixMonths.setMonth(sixMonths.getMonth() - 6);
    result = await deviceAggregateStats.aggregate([
      { $match: { month: { $gte: sixMonths.getTime() } } },
      { $project: { month: 1, orgs: { $objectToArray: '$stats.orgs' } } },
      { $unwind: '$orgs' },
      {
        $project: {
          month: 1,
          org: '$orgs.k',
          account: '$orgs.v.account',
          devices: { $objectToArray: '$orgs.v.devices' }
        }
      },
      { $unwind: '$devices' },
      { $project: { month: 1, org: 1, account: 1, bytes: '$devices.v.bytes' } },
      {
        $group: {
          _id: { org: '$org', month: '$month', account: '$account' },
          devices_bytes: { $sum: '$bytes' },
          devices_count: { $push: '$bytes' }
        }
      },
      {
        $project: {
          _id: 0,
          org: '$_id.org',
          account: '$_id.account',
          month: { $toDate: '$_id.month' },
          devices_bytes: '$devices_bytes',
          devices_count: { $size: '$devices_count' }
        }
      }
    ]).allowDiskUse(true);
  } catch (e) { }
  return result;
};

const getAccountsData = async req => {
  const accounts = {
    all: 0,
    data: []
  };

  try {
    const accountPipeline = [
      {
        $facet: {
          all: [
            { $count: 'account_id' }
          ],
          data: [
            {
              $project: {
                _id: 0,
                account_id: '$_id',
                account_name: '$name',
                country: '$country',
                billing_customer_id: '$billingCustomerId',
                organizations: '$organizations'
              }
            },
            // lookup organizations to get organizations names
            {
              $lookup: {
                from: 'organizations',
                localField: 'organizations',
                foreignField: '_id',
                as: 'organizations'
              }
            },
            {
              $unwind: {
                path: '$organizations',
                preserveNullAndEmptyArrays: true
              }
            },
            // lookup devices by orgId
            {
              $lookup: {
                from: 'devices',
                localField: 'organizations._id',
                foreignField: 'org',
                as: 'devices'
              }
            },
            // lookup tunnels by orgId
            {
              $lookup: {
                from: 'tunnels',
                localField: 'organizations._id',
                foreignField: 'org',
                as: 'tunnels'
              }
            },
            // project each *organization* data
            {
              $project: {
                account_name: 1,
                account_id: 1,
                country: 1,
                users: 1,
                billing_customer_id: 1,
                organization_id: { $ifNull: ['$organizations._id', null] },
                organization_name: { $ifNull: ['$organizations.name', null] },
                num_devices: { $size: '$devices' },
                num_tunnels: {
                  $size: {
                    $filter: {
                      input: '$tunnels',
                      as: 't',
                      cond: {
                        $eq: ['$$t.isActive', true]
                      }
                    }
                  }
                }
              }
            },
            // group organizations by account data, and put organizations array in each account
            {
              $group: {
                _id: {
                  account_id: '$account_id',
                  account_name: '$account_name',
                  country: '$country',
                  billing_customer_id: '$billing_customer_id'
                },
                num_devices: { $sum: '$num_devices' },
                num_tunnels: { $sum: '$num_tunnels' },
                organizations: {
                  $push: {
                    organization_id: '$organization_id',
                    organization_name: '$organization_name',
                    num_devices: '$num_devices',
                    num_tunnels: '$num_tunnels'
                  }
                }
              }
            },
            // sum the organizations data into account data
            {
              $project: {
                _id: 0,
                account_id: '$_id.account_id',
                account_name: '$_id.account_name',
                country: '$_id.country',
                billing_customer_id: '$_id.billing_customer_id',
                num_devices: 1,
                num_tunnels: 1,
                organizations: {
                  // if accounts doesn't have organizations, the pipeline returns array without org
                  // So we filter here empty objects
                  $filter: {
                    input: '$organizations',
                    as: 'org',
                    cond: {
                      $ne: ['$$org.organization_id', null]
                    }
                  }
                }
              }
            },
            {
              $addFields: {
                num_organizations: { $size: '$organizations' }
              }
            }
          ]
        }
      }
    ];

    // handle filter pagination
    let facetStageIdx = 0;
    if (req.query.filters) {
      const parsed = JSON.parse(req.query.filters);

      const mapping = {
        account_name: 'name'
      };

      const filters = {};
      for (const key in parsed) {
        if (key in mapping) {
          filters[mapping[key]] = { $regex: parsed[key], $options: 'i' };
        }
      }

      // we put filters at the beginning of the pipeline to reduce computing resources
      accountPipeline.unshift({ $match: filters });
      facetStageIdx = 1;
    }

    // get the pointer of the data pipeline inside the facet stage
    const dataStage = accountPipeline[facetStageIdx].$facet.data;

    // handle sort pagination
    if (req.query.sort) {
      const parsed = JSON.parse(req.query.sort);
      dataStage.push({ $sort: { [parsed.key]: parsed.value === 'desc' ? -1 : 1 } });
    } else {
      dataStage.push({ $sort: { account_name: -1 } });
    }

    // handle pagination skip and limit
    if (+req.query.page > 0) {
      dataStage.push({ $skip: req.query.page * req.query.size });
    }
    if (+req.query.size > 0) {
      dataStage.push({ $limit: +req.query.size });
    }

    // add users per account.
    // we added this flookup after limit and sort in order to fetch users for needed accounts only
    dataStage.push({
      $lookup: {
        from: 'memberships',
        let: { account_id: '$account_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$$account_id', '$account'] } } },
          {
            $lookup: {
              from: 'users',
              localField: 'user',
              foreignField: '_id',
              as: 'user'
            }
          },
          { $unwind: '$user' },
          { $project: { email: '$user.email', role: 1, name: '$user.name' } }
        ],
        as: 'users'
      }
    });

    // run pipeline
    const accountsData = await accountsModel.aggregate(accountPipeline).allowDiskUse(true);

    accounts.all = accountsData[0].all[0].account_id;
    accounts.data = accountsData[0].data;
  } catch (e) { }

  return accounts;
};

const createDefaultOrg = (id = '', name = '', billingInfo = { current: 0, max: 0 }) => {
  return {
    organization_id: id,
    deleted: true,
    organization_name: name,
    num_devices: 0,
    num_tunnels: 0,
    billingInfo: billingInfo
  };
};
