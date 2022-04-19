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
 * Get available ips from a mask
 * @param  {number} mask  subnet mask
 * @return {number}       number of available ips
 */
const getRangeAndMask = number => {
  const baseTwo = Math.ceil(Math.log2(number));
  const mask = 32 - baseTwo;
  const range = Math.pow(2, baseTwo);
  return { range, mask };
};

/**
 * Find the start and end IPv4 from ip + mask
 * @param {String} ip     IPv4 address
 * @param {String} mask   Number of bit masks
 * @param {String} shift  Number of IPs to shift from start
 */
const getStartIp = (ipString, mask, shift = 0) => {
  function u (n) { return n >>> 0; } // convert to unsigned
  function ip (n) {
    return [
      (n >>> 24) & 0xFF,
      (n >>> 16) & 0xFF,
      (n >>> 8) & 0xFF,
      (n >>> 0) & 0xFF
    ].join('.');
  }
  const m = ipString.split('.');
  const addr32 = m.reduce((a, o) => {
    return u(+a << 8) + +o;
  });
  const maskNum = u(~0 << (32 - +mask));
  return ip(u(addr32 & maskNum) + shift);
};

module.exports = {
  getRangeAndMask,
  getStartIp
};
