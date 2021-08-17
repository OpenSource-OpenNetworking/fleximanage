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

/**
 * Returns sorted and paginated array of data
 * @param {Array} data The array of objects (get items query result)
 * @param {Integer} offset The number of items to skip (optional)
 * @param {Integer} limit The numbers of items to return (optional)
 * @param {String} sortField The field by which the data will be ordered (optional)
 * @param {String} sortOrder Sorting order [asc|desc] (optional)
 * @returns {Array} Sorted and paginated array of objects
*/
const paginated = (data, offset, limit, sortField, sortOrder) => {
  if (sortField) {
    const fields = sortField.split('.');
    data.sort((a, b) => {
      let va = a;
      let vb = b;
      for (const field of fields) {
        va = va && va[field];
        vb = vb && vb[field];
      }
      return (sortOrder === 'desc' ? 1 : -1) * (va < vb ? 1 : -1);
    });
  }
  if (offset !== undefined || limit !== undefined) {
    if (limit !== undefined) {
      limit = +limit > 0 ? +limit : data.length;
    }
    if (offset !== undefined) {
      offset = +offset > 0 ? +offset : 0;
    }
    return data.slice(offset, offset + limit);
  }
  return data;
};

module.exports = {
  paginated
};
