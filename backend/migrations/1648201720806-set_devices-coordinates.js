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

const { devices } = require('../models/devices');
const geoip = require('geoip-lite');

function getIp (device) {
  let ll = null;
  if (device.interfaces) {
    device.interfaces
      // Check WAN interfaces IPs
      .filter((i) => i.type === 'WAN')
      // Put LTE last
      .sort((i1, i2) => {
        if (i1.deviceType === 'lte' && i2.deviceType !== 'lte') return 1;
        if (i1.deviceType !== 'lte' && i2.deviceType === 'lte') return -1;
        return 0;
      })
      // Try to find first location
      .some((i) => {
      // Try to match public IP first
        if (i.PublicIP) {
          const geoIpInfo = geoip.lookup(i.PublicIP);
          if (geoIpInfo) {
            ll = geoIpInfo.ll;
            return true; // Stop the interface loop
          }
        };
        if (i.IPv4) {
          const geoIpInfo = geoip.lookup(i.IPv4);
          if (geoIpInfo) {
            ll = geoIpInfo.ll;
            return true; // Stop the interface loop
          }
        };
      });
  }
  return ll;
}

async function up () {
  for await (const device of devices.find({}, { interfaces: 1 })) {
    let ll = getIp(device);
    if (!ll) ll = [40.416775, -3.703790]; // Default coordinate
    await devices.updateOne(
      { _id: device._id },
      { $set: { coords: ll } },
      { upsert: false }
    );
  }
}

async function down () {
  await devices.updateMany(
    {},
    { $unset: { coords: '' } },
    { upsert: false }
  );
}

module.exports = { up, down };
