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

const configs = require('../configs')();
const Service = require('./Service');
const Peers = require('../models/peers');
const Tunnels = require('../models/tunnels');
const isEqual = require('lodash/isEqual');
const omit = require('lodash/omit');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { sendRemoveTunnelsJobs, sendAddTunnelsJobs } = require('../deviceLogic/tunnels');
const DevicesService = require('./DevicesService');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const validators = require('../models/validators');

class PeersService {
  /**
   * Retrieve peers
   *
   * org ID of the Device to fetch tunnel information about
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async peersGET ({ org, offset, limit }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);
      const response = await Peers.find({
        org: { $in: orgList }
      }).skip(offset).limit(limit).lean();

      const peers = response.map(p => {
        return { ...p, _id: p._id.toString() };
      });

      return Service.successResponse(peers);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    };
  }

  /**
   * Validate peer object
   *
   * Note!
   * This function does not fully validate each field as it is validated in UI and Mongo schema.
   * Here, we only check dependencies between fields.
   *
   * @param  {object} peer peer request
   * @return {{ valid: boolean, err: null|string}}
   **/
  static validatePeer (peer) {
    const { idType, localId, remoteIdType, remoteId } = peer;

    if (!idType || !localId || !remoteIdType || !remoteId) {
      return { valid: false, err: 'Required fields are missing' };
    }

    if (idType === 'email' && !validators.validateEmail(localId)) {
      return { valid: false, err: 'Local ID must be a valid email address' };
    }

    if (remoteIdType === 'email' && !validators.validateEmail(remoteId)) {
      return { valid: false, err: 'Remote ID must be a valid email address' };
    }

    if (idType === 'ip4-addr' && localId !== 'Automatic' && !validators.validateIPv4(localId)) {
      return { valid: false, err: 'Local ID must be a valid IPv4 address' };
    }

    if (remoteIdType === 'ip4-addr' && !validators.validateIPv4(remoteId)) {
      return { valid: false, err: 'Remote ID must be a valid IPv4 address' };
    }

    return { valid: true, err: null };
  }

  /**
   * Create new peer
   *
   * peer
   * returns The new peer
   **/
  static async peersPOST ({ org, peer }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const { valid, err } = PeersService.validatePeer(peer);
      if (!valid) {
        throw new Error(err);
      }

      const newPeer = await Peers.create({ ...peer, org: orgList[0].toString() });
      return Service.successResponse(newPeer);
    } catch (e) {
      let msg = e.message || 'Internal Server Error';
      const status = e.status || 500;

      // Change the duplicate error message to make it clearer
      if (e.name === 'MongoError' && e.code === 11000) {
        msg = `Peer name "${peer.name}" already exists for this organization`;
      }

      return Service.rejectResponse(msg, status);
    }
  }

  /**
   * Update peer and reconstruct tunnels if needed
   **/
  static async peersIdPUT ({ id, org, peer }, { user, server }, response) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      const origPeer = await Peers.findOne({
        org: { $in: orgList },
        _id: id
      }).lean();

      if (!origPeer) {
        logger.error('Failed to find peer', {
          params: { id, org, orgList, peer }
        });
        throw new Error('The peer was not updated. Please check the ID or org parameters');
      }

      const { valid, err } = PeersService.validatePeer(peer);
      if (!valid) {
        throw new Error(err);
      }

      const nonRelevantFields = ['name', 'urls', 'ips', '_id', 'org', 'createdAt', 'updatedAt'];
      const origFieldsToRecreate = omit(origPeer, ...nonRelevantFields);
      const newFieldsToRecreate = omit(peer, ...nonRelevantFields);
      const isNeedToReconstructTunnels = !isEqual(origFieldsToRecreate, newFieldsToRecreate);

      // for these fields, no need to recreate but to modify
      const isNeedToModifyTunnels = (
        !isEqual(origPeer.urls, peer.urls) ||
        !isEqual(origPeer.ips, peer.ips)
      );

      const updatedPeer = await Peers.findOneAndUpdate(
        { org: { $in: orgList }, _id: id },
        peer,
        { upsert: false, new: true, runValidators: true }
      );

      let reconstructedTunnels = 0;
      if (isNeedToReconstructTunnels || isNeedToModifyTunnels) {
        const tunnels = await Tunnels.find({ peer: id, isActive: true }).populate('deviceA').lean();
        if (tunnels.length) {
          const ids = tunnels.map(t => t._id);

          let jobs = [];
          if (isNeedToReconstructTunnels) {
            const removeJobs = await sendRemoveTunnelsJobs(ids, user.username, true);
            const addJobs = await sendAddTunnelsJobs(ids, user.username, true);
            jobs = jobs.concat([...removeJobs, ...addJobs]);
            reconstructedTunnels += addJobs.length;
          } else {
            for (const tunnel of tunnels) {
              const tasks = [{
                entity: 'agent',
                message: 'modify-tunnel',
                params: {
                  'tunnel-id': tunnel.num,
                  peer: {
                    ips: peer.ips,
                    urls: peer.urls
                  }
                }
              }];

              const job = await deviceQueues.addJob(tunnel.deviceA.machineId, 'system', orgList[0],
                // Data
                { title: `Modify peer tunnel on device ${tunnel.deviceA.hostname}`, tasks },
                // Response data
                {
                  method: 'tunnels',
                  data: {
                    deviceId: tunnel.deviceA._id,
                    org: orgList[0],
                    username: user,
                    tunnelId: tunnel.num,
                    deviceA: tunnel.deviceA._id,
                    deviceB: null,
                    target: 'deviceAconf',
                    peer
                  }
                },
                // Metadata
                { priority: 'normal', attempts: 1, removeOnComplete: false },
                // Complete callback
                null
              );

              jobs.push(job);
              reconstructedTunnels++;
            }
          }

          const jobsIds = jobs.flat().map(job => job.id);
          DevicesService.setLocationHeader(server, response, jobsIds, orgList[0]);
        }
      }

      return Service.successResponse({ updatedPeer, reconstructedTunnels });
    } catch (e) {
      let msg = e.message || 'Internal Server Error';
      const status = e.status || 500;

      // Change the duplicate error message to make it clearer
      if (e.name === 'MongoError' && e.code === 11000) {
        msg = `Peer name "${peer.name}" already exists for this organization`;
      }

      return Service.rejectResponse(msg, status);
    }
  }

  /**
   * Delete peer
   **/
  static async peersIdDelete ({ id, org, peer }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, true);

      // Check if tunnels existing with this peer configurations
      const tunnels = await Tunnels.find({
        peer: id,
        org: { $in: orgList },
        isActive: true
      }).lean();

      if (tunnels.length) {
        const err = 'All peer tunnels must be deleted before deleting the peer configuration';
        throw new Error(err);
      }

      const resp = await Peers.deleteOne({ _id: id, org: { $in: orgList } });

      if (resp && resp.deletedCount === 1) {
        return Service.successResponse(null, 204);
      } else {
        logger.error('Failed to remove peer', {
          params: { id, org, orgList, peer, resp: resp }
        });
        return Service.rejectResponse('Peer not found', 404);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = PeersService;
