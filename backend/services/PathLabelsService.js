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
const mongoConns = require('../mongoConns.js')();
const createError = require('http-errors');
const Service = require('./Service');
const PathLabels = require('../models/pathlabels');
const MultiLinkPolicies = require('../models/mlpolicies');
const { devices } = require('../models/devices');
const tunnels = require('../models/tunnels');
const { getAccessTokenOrgList } = require('../utils/membershipUtils');

class PathLabelsService {
  static createDeleteErrResp (counters) {
    const { devCount, tunCount, polCount } = counters;
    return (
      `Path label is used by ${
        devCount ? `${devCount} devices${tunCount || polCount ? ', ' : ''}` : ''
      }${
        tunCount ? `${tunCount} tunnels${polCount ? ', ' : ''}` : ''
      }${
        polCount ? `${polCount} policies` : ''
      }`
    );
  }

  /**
   * Validate path label request
   * @param {mongoID} id  - path label id
   * @param {mongoID} org - organization id
   * @param {Object} pathLabelRequest - request values
   * @throw error, if not valid
   */
  static async validatePathLabelRequest (id, org, pathLabelRequest) {
    // check for duplicated names
    const { name } = pathLabelRequest;
    const searchQuery = { org, name };
    if (id) {
      searchQuery._id = { $ne: id };
    }
    const hasDuplicatedNames = await PathLabels.countDocuments(searchQuery);
    if (hasDuplicatedNames) {
      throw new Error('Duplicated path labels names are not allowed');
    }
  }

  /**
   * Get all Path labels
   *
   * offset Integer The number of items to skip before starting to collect the result set (optional)
   * limit Integer The numbers of items to return (optional)
   * org String Organization to be filtered by (optional)
   * returns List
   **/
  static async pathlabelsGET ({ offset, limit, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const pathLabels = await PathLabels.find(
        { org: { $in: orgList } },
        { name: 1, description: 1, color: 1, type: 1 }
      ).skip(offset).limit(limit);

      return Service.successResponse(pathLabels);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Delete a Path label
   *
   * id String Numeric ID of the Path label to delete
   * no response value expected for this operation
   **/
  static async pathlabelsIdDELETE ({ id, org }, { user }) {
    try {
      // Don't allow to delete a label which is being used
      const orgList = await getAccessTokenOrgList(user, org, true);
      const devCount = await devices.countDocuments({ 'interfaces.pathlabels': id });
      const tunCount = await tunnels.countDocuments({ isActive: true, pathlabel: id });
      const polCount = await MultiLinkPolicies.countDocuments({
        'rules.action.links.pathlabels': id
      });

      if (devCount !== 0 || tunCount !== 0 || polCount !== 0) {
        const message = PathLabelsService.createDeleteErrResp({
          devCount,
          tunCount,
          polCount
        });
        return Service.rejectResponse(message, 400);
      }

      const { deletedCount } = await PathLabels.deleteOne({
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
   * Get a Path label by id
   *
   * id String Numeric ID of the Path label to retrieve
   * org String Organization to be filtered by (optional)
   * returns PathLabel
   **/
  static async pathlabelsIdGET ({ id, org }, { user }) {
    try {
      const orgList = await getAccessTokenOrgList(user, org, false);
      const pathLabel = await PathLabels.findOne(
        {
          org: { $in: orgList },
          _id: id
        },
        {
          name: 1,
          description: 1,
          color: 1,
          type: 1
        }
      );

      if (!pathLabel) {
        return Service.rejectResponse('Not found', 404);
      }

      return Service.successResponse(pathLabel);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify a Path label
   *
   * id String Numeric ID of the Path label to modify
   * pathLabelRequest PathLabelRequest
   * returns PathLabel
   **/
  static async pathlabelsIdPUT ({ id, org, pathLabelRequest }, { user }) {
    let newPathLabel;
    try {
      const { name, description, color, type } = pathLabelRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      await PathLabelsService.validatePathLabelRequest(id, orgList[0], pathLabelRequest);

      // A label's type field cannot be changed if the
      // labels being used. Therefore we perform the
      // update as a transaction with 3 steps:
      // 1. Update the path label in the database
      // 2. Check if the label type has changed
      // 3. Check if the label is being used
      //    and if so we abort the transaction
      await mongoConns.mainDBwithTransaction(async (session) => {
        const origPathLabel = await PathLabels.findOneAndUpdate(
          {
            org: { $in: orgList },
            _id: id
          },
          {
            org: orgList[0].toString(),
            name: name,
            description: description,
            color: color,
            type: type
          },
          {
            fields: { name: 1, description: 1, color: 1, type: 1 }
          }
        ).session(session);

        if (!origPathLabel) {
          throw createError(404, 'Not found');
        }

        // Type change is only allowed for labels
        // that are not being used by any other entity
        if (origPathLabel.type !== type) {
          const devCount = await devices.countDocuments({ 'interfaces.pathlabels': id });
          const tunCount = await tunnels.countDocuments({ isActive: true, pathlabel: id });
          const polCount = await MultiLinkPolicies.countDocuments({
            'rules.action.links.pathlabels': id
          });

          if (devCount !== 0 || tunCount !== 0 || polCount !== 0) {
            const message = PathLabelsService.createDeleteErrResp({
              devCount,
              tunCount,
              polCount
            });
            throw createError(400, message);
          }
        }

        // Fetch the updated label from the database
        newPathLabel = await PathLabels.findOne(
          {
            org: { $in: orgList },
            _id: id
          },
          {
            name: 1, description: 1, color: 1, type: 1
          }
        ).session(session);
      });

      return Service.successResponse(newPathLabel);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Add a new Path label
   *
   * pathLabelRequest PathLabelRequest
   * returns PathLabel
   **/
  static async pathlabelsPOST ({ org, pathLabelRequest }, { user }) {
    try {
      const { name, description, color, type } = pathLabelRequest;
      const orgList = await getAccessTokenOrgList(user, org, true);

      await PathLabelsService.validatePathLabelRequest(null, orgList[0], pathLabelRequest);

      // Allow up to 200 path labels per organization
      const count = await PathLabels.countDocuments({
        org: orgList[0].toString()
      });

      if (count >= 200) {
        const message = 'Can\'t create more than 200 Path Labels';
        return Service.rejectResponse(message, 400);
      }

      const result = await PathLabels.create({
        org: orgList[0].toString(),
        name: name,
        description: description,
        color: color,
        type: type
      });

      const pathLabel = (({ name, description, color, _id, type }) => ({
        name,
        description,
        color,
        _id,
        type
      }))(result);
      return Service.successResponse(pathLabel, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = PathLabelsService;
