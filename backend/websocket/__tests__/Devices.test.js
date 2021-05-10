// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2021  flexiWAN Ltd.

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

// Module for deviceQueues Unit Test
const configs = require('../../configs')();
const Devices = require('../Devices')('testdev', configs.get('redisUrl'));

describe('Initialization', () => {
  const obj = { isApproved: true, count: 2, org: 'abcdefg' };
  afterAll(() => {
    Devices.redisShutdown();
  });

  test('Set device AAA info string values', async (done) => {
    const ret1 = await Devices.setRedisDeviceInfo('AAA', 'info', {
      status: 'running', account: 'a1b2'
    });
    const ret2 = await Devices.setRedisDeviceInfo('BBB', 'info', { status: 'running' });
    expect(ret1).toEqual(2);
    expect(ret2).toEqual(1);

    const value1 = await Devices.getRedisDeviceInfo('AAA', 'info', { status: 1 });
    const value2 = await Devices.getRedisDeviceInfo('AAA', 'info', { account: 1 });
    const value3 = await Devices.getRedisDeviceInfo('BBB', 'info', { status: 1 });
    expect(value1).toEqual({ status: 'running' });
    expect(value2).toEqual({ account: 'a1b2' });
    expect(value3).toEqual({ status: 'running' });
    done();
  });

  test('Set device AAA info object value', async (done) => {
    const ret = await Devices.setRedisDeviceInfo('AAA', 'info', {
      object: obj
    });
    expect(ret).toEqual(1);
    const value = await Devices.getRedisDeviceInfo('AAA', 'info', { object: 1 });
    expect(value.object).toEqual(obj);
    done();
  });

  test('Getting multiple values from redis', async (done) => {
    const values = await Devices.getRedisDeviceInfo('AAA', 'info', { status: 1, account: 1 });
    expect(values).toEqual({ status: 'running', account: 'a1b2' });
    done();
  });

  test('Getting all values from redis', async (done) => {
    const values = await Devices.getRedisDeviceInfo('AAA', 'info', {});
    expect(values).toEqual({ status: 'running', account: 'a1b2', object: obj });
    done();
  });

  test('Getting all active devices', async (done) => {
    const devices = await Devices.getRedisAllDevices('info');
    expect(devices.sort()).toEqual(['AAA', 'BBB']);
    done();
  });

  test('Removing devices', async (done) => {
    await Devices.removeRedisDeviceInfo('AAA', 'info');
    const devices = await Devices.getRedisAllDevices('info');
    expect(devices).toEqual(['BBB']);
    await Devices.removeRedisDeviceInfo('BBB', 'info');
    const devices2 = await Devices.getRedisAllDevices('info');
    expect(devices2).toEqual([]);
    done();
  });

  test('Check error value for setFields', async (done) => {
    // fields must be an object
    const ret = await Devices.setRedisDeviceInfo('AAA', 'info', 'abc');
    expect(ret).toEqual(-1);
    done();
  });

  test('Check error value for getFields', async (done) => {
    // fields must be an object
    const ret = await Devices.getRedisDeviceInfo('AAA', 'info', ['abc']);
    expect(ret).toEqual(-1);
    done();
  });
});
