
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
const mongoose = require('mongoose');
const { devices } = require('../models/devices');
const logger = require('../logging/logging')({ module: module.filename, type: 'migration' });

/**
 * Make any changes you need to make to the database here
 */
async function up () {
  try {
    const communityRes = await devices.updateMany(
      { 'bgp.neighbors': { $exists: true, $not: { $size: 0 } } },
      { $set: { 'bgp.neighbors.$[elem].sendCommunity': 'all' } },
      { upsert: false, arrayFilters: [{ 'elem.sendCommunity': { $exists: false } }] }
    );

    const operations = [];
    const devicesList = await devices.find(
      { routingFilters: { $exists: true, $not: { $size: 0 } } },
      { routingFilters: 1 }
    ).lean();

    for (const device of devicesList) {
      const routingFilters = device.routingFilters.map(r => {
        const ret = {
          _id: mongoose.Types.ObjectId(r._id),
          name: r.name,
          description: r.description,
          rules: []
        };

        let hasDefault = false;
        let idx = -1;
        for (const rule of r.rules) {
          idx++;

          // ensure to not touch rules that already have the new format.
          if ('route' in rule) {
            // check if updated format has default rule.
            if (rule.route === '0.0.0.0/0') {
              hasDefault = true;
            }

            // if rule has new format, push it as is.
            ret.rules.push(rule);
            continue;
          }

          // at this point, rule has old format and we migrate it now to the new one
          //
          if (rule.network === '0.0.0.0/0') {
            // if old format rule is default one, don't push it, we will push the default one later
            continue;
          }

          ret.rules.push({
            _id: mongoose.Types.ObjectId(rule._id),
            route: rule.network,
            action: r.defaultAction === 'allow' ? 'deny' : 'allow',
            nextHop: '',
            priority: idx + 1
          });
        }

        if (!hasDefault) {
          ret.rules.push({
            _id: mongoose.Types.ObjectId(),
            route: '0.0.0.0/0',
            action: r.defaultAction,
            nextHop: '',
            priority: 0
          });
        }

        return ret;
      });

      operations.push({
        updateOne: {
          filter: { _id: device._id },
          update: { $set: { routingFilters: routingFilters } },
          upsert: false
        }
      });
    }

    let res;
    if (operations.length > 0) {
      res = await devices.collection.bulkWrite(operations);
    }
    logger.info('Device bgp.neighbors.sendCommunity and routingFilter migration succeeded', {
      params: { collections: ['devices'], operation: 'up', communityRes, res }
    });
  } catch (err) {
    logger.error('Device bgp.neighbors.sendCommunity and routingFilter migration failed', {
      params: { collections: ['devices'], operation: 'up', err: err.message }
    });
    throw new Error(err.message);
  }
}

/**
 * Make any changes that UNDO the up function side effects here (if possible)
 */
async function down () {
  try {
    const communityRes = await devices.updateMany(
      { 'bgp.neighbors': { $exists: true, $not: { $size: 0 } } },
      { $unset: { 'bgp.neighbors.$[].sendCommunity': '' } },
      { upsert: false }
    );

    const operations = [];

    const devicesList = await devices.find(
      { routingFilters: { $exists: true, $not: { $size: 0 } } },
      { routingFilters: 1 }
    ).lean();

    for (const device of devicesList) {
      const routingFilters = device.routingFilters.map(r => {
        const ret = {
          _id: mongoose.Types.ObjectId(r._id),
          name: r.name,
          description: r.description,
          defaultAction: 'allow', // put allow as default, it will be override later if needed
          rules: []
        };

        for (const rule of r.rules) {
          // ensure to not touch rules that already have the old format.
          if ('network' in rule) {
            // if rule has old format, push it as is.
            ret.rules.push(rule);
            continue;
          }

          // at this point, rule has new format and we migrate it now to the old one
          if (rule.route === '0.0.0.0/0') {
            ret.defaultAction = rule.action;
            continue; // don't push defaultRule to the rules list.
          }

          // in old format, rules have automatically the opposite action then defaultAction
          // hance, if they have same action, don't push it. There is no need for this rule.
          if (rule.action === ret.defaultAction) {
            continue;
          }

          ret.rules.push({
            _id: mongoose.Types.ObjectId(rule._id),
            network: rule.route
          });
        }

        return ret;
      });

      operations.push({
        updateOne: {
          filter: { _id: device._id },
          update: { $set: { routingFilters: routingFilters } },
          upsert: false
        }
      });
    }

    // write bulk
    const res = await devices.collection.bulkWrite(operations);

    logger.info('Device bgp.neighbors.sendCommunity and routingFilter migration succeeded', {
      params: { collections: ['devices'], operation: 'down', communityRes, res }
    });
  } catch (err) {
    logger.error('Device bgp.neighbors.sendCommunity and routingFilter migration failed', {
      params: { collections: ['devices'], operation: 'down', err: err.message }
    });
    throw new Error(err.message);
  }
}

module.exports = { up, down };
