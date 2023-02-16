// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2022  flexiWAN Ltd.

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

const orgModel = require('../models/organizations');
const qosPoliciesModel = require('../models/qosPolicies');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });

async function up () {
  try {
    const orgs = await orgModel.find({ });
    for (const org of orgs) {
      // Create a default QoS policy
      await qosPoliciesModel.create([{
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
      }]);
    }
  } catch (err) {
    logger.error('Database migration failed', {
      params: { collections: ['qospolicies'], operation: 'up', err: err.message }
    });
  }
}

async function down () { }

module.exports = { up, down };
