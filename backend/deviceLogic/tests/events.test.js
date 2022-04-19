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

const configs = require('../../configs')();

// deviceQueues is needed to release resources when the test finishes
// otherwise the test stuck and not finished
const deviceQueues = require('../../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);

const DeviceEvents = require('../events');

afterAll(() => {
  deviceQueues.shutdown();
});

describe('deviceEvents', () => {
  const events = new DeviceEvents();

  const origIfc = {};

  const updatedIfc = {};

  let routerIsRunning = false;

  beforeEach(() => {
    origIfc.IPv4 = '';
    origIfc.type = '';

    updatedIfc.IPv4 = '';
    updatedIfc.type = '';

    routerIsRunning = false;
  });

  // LAN
  it('LAN with IP and router is stopped should be ok', () => {
    origIfc.type = 'LAN';
    origIfc.IPv4 = '10.10.10.10/24';

    updatedIfc.type = 'LAN';
    updatedIfc.IPv4 = '10.10.10.10/24';

    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(false);
  });

  it('LAN with IP and router is running should be ok', () => {
    origIfc.type = 'LAN';
    origIfc.IPv4 = '10.10.10.10/24';

    updatedIfc.type = 'LAN';
    updatedIfc.IPv4 = '10.10.10.10/24';
    routerIsRunning = true;
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(false);
  });

  it('LAN without ip and router is stopped should be missing', () => {
    origIfc.type = 'LAN';
    updatedIfc.type = 'LAN';
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(true);
  });

  it('LAN without ip and router is running should be missing', () => {
    origIfc.type = 'LAN';
    updatedIfc.type = 'LAN';
    routerIsRunning = true;
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(true);
  });

  // WAN
  it('WAN with IP and router is stopped should be ok', () => {
    origIfc.type = 'WAN';
    origIfc.IPv4 = '10.10.10.10/24';

    updatedIfc.type = 'WAN';
    updatedIfc.IPv4 = '10.10.10.10/24';

    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(false);
  });

  it('WAN with IP and router is running should be ok', () => {
    origIfc.type = 'WAN';
    origIfc.IPv4 = '10.10.10.10/24';

    updatedIfc.type = 'WAN';
    updatedIfc.IPv4 = '10.10.10.10/24';
    routerIsRunning = true;
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(false);
  });

  it('WAN without ip and router is stopped should be missing', () => {
    origIfc.type = 'WAN';
    updatedIfc.type = 'WAN';
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(true);
  });

  it('WAN without ip and router is running should be missing', () => {
    origIfc.type = 'WAN';
    updatedIfc.type = 'WAN';
    routerIsRunning = true;
    const result = events.isIpMissing(updatedIfc, routerIsRunning);
    expect(result).toBe(true);
  });
});
