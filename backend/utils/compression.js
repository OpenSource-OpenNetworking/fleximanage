// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

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

// Compress an object to Base 64
const zlib = require('zlib');

/**
 * Compress and Object to Base 64
 * @param  {obj} obj Any Object to compress
 * @return {Promise} resolved to a B64 string
 */
function compressObj (obj) {
  const input = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    zlib.deflate(input, (err, buffer) => {
      if (err) return reject(new Error(err));
      const comp = buffer.toString('base64');
      resolve(comp);
    });
  });
}

module.exports = compressObj;
