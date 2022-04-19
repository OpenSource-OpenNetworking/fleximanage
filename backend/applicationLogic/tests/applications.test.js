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

const appLogic = require('../applications')();

const vpnIdentifier = 'com.flexiwan.remotevpn';
describe('Validate vpn configuration', () => {
  let oldConfig = null;
  let newConfig = null;

  beforeEach(() => {
    oldConfig = {
      routeAllTrafficOverVpn: false,
      serverPort: '1194',
      dnsIps: '8.8.8.8',
      dnsDomains: 'local.dns'
    };
    newConfig = {
      routeAllTrafficOverVpn: false,
      serverPort: '1194',
      dnsIps: '8.8.8.8',
      dnsDomains: 'local.dns'
    };
  });

  it('Should return false', async (done) => {
    const res = await appLogic.needToUpdatedDevices(vpnIdentifier, oldConfig, newConfig);
    expect(res).toBe(false);
    done();
  });

  it('Should return true if serverPort is different', async done => {
    newConfig.serverPort = '1196';
    const res = await appLogic.needToUpdatedDevices(vpnIdentifier, oldConfig, newConfig);
    expect(res).toBe(true);
    done();
  });

  it('Should return true if dnsIps is different', async done => {
    newConfig.dnsIps = '8.8.4.4';
    const res = await appLogic.needToUpdatedDevices(vpnIdentifier, oldConfig, newConfig);
    expect(res).toBe(true);
    done();
  });

  it('Should return true if dnsDomains is different', async done => {
    newConfig.dnsDomains = 'local2.dns';
    const res = await appLogic.needToUpdatedDevices(vpnIdentifier, oldConfig, newConfig);
    expect(res).toBe(true);
    done();
  });

  it('Should return true if routeAllTraffic is different', async done => {
    newConfig.routeAllTrafficOverVpn = true;
    const res = await appLogic.needToUpdatedDevices(vpnIdentifier, oldConfig, newConfig);
    expect(res).toBe(true);
    done();
  });
});
