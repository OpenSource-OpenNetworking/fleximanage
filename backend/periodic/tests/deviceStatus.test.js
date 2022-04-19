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

/* eslint-disable max-len */
const deviceStatus = require('../deviceStatus')();
const configs = require('../../configs')();
// deviceQueues and roleSelector is needed to release resources when the test finishes
// otherwise the test stuck and not finished
const deviceQueues = require('../../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const roleSelector = require('../../utils/roleSelector')(configs.get('redisUrl'));
afterAll(() => {
  deviceQueues.shutdown();
  roleSelector.shutDown();
});

let deviceStatsMsg;

beforeEach(() => {
  deviceStatsMsg = [{
    stats: {
      'GigabitEthernet0/8/0': {
        tx_bytes: 744.0,
        tx_pkts: 4.0,
        rx_pkts: 4.0,
        rx_bytes: 344.0
      },
      'GigabitEthernet0/3/0': {
        tx_bytes: 1024.0,
        tx_pkts: 6.0,
        rx_pkts: 25.0,
        rx_bytes: 4583.0
      }
    },
    tunnel_stats: { },
    running: true,
    state: 'running',
    stateReason: 'Test message',
    ok: 1,
    period: 30.253661155700684,
    utc: 1562659449.337439
  }];
});

describe('validateDevStatsMessage', () => {
  // Happy path
  it('Should be a valid message if all fields exists and contain valid values', () => {
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toMatchObject({ valid: true, err: '' });
  });

  it('Should be a valid message if message is an empty array', () => {
    const result = deviceStatus.validateDevStatsMessage([]);
    expect(result).toMatchObject({ valid: true, err: '' });
  });

  it('Should be a valid message if message.stats contains no interfaces', () => {
    deviceStatsMsg[0].stats = {};
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toMatchObject({ valid: true, err: '' });
  });

  // Test required fields
  it('Should be a valid message if message `running` field is missing', () => {
    const { running, ...validMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([validMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be an invalid message if message `ok` field is missing', () => {
    const { ok, ...invalidMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([invalidMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `period` field is missing', () => {
    const { period, ...invalidMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([invalidMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `utc` field is missing', () => {
    const { utc, ...invalidMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([invalidMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `stats` field is missing one of its fields', () => {
    // eslint-disable-next-line camelcase
    const { rx_bytes, ...invalidStats } = deviceStatsMsg[0].stats['GigabitEthernet0/8/0'];
    deviceStatsMsg[0].stats = invalidStats;
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  // Test fields values
  it('Should be an invalid message if message `running` field is not a boolean', () => {
    deviceStatsMsg[0].running = 'not-boolean';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be a valid message if state field is `stopped`', () => {
    deviceStatsMsg[0].state = 'stopped';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be a valid message if state field is `failed`', () => {
    deviceStatsMsg[0].state = 'failed';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be an invalid message if state field is `not running`', () => {
    deviceStatsMsg[0].state = 'not running';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be a valid message if stateReason field is empty', () => {
    deviceStatsMsg[0].stateReason = '';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be a valid message if state field is missing', () => {
    const { state, ...validMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([validMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be a valid message if stateReason field is missing', () => {
    const { stateReason, ...validMsg } = deviceStatsMsg[0];
    const result = deviceStatus.validateDevStatsMessage([validMsg]);
    expect(result).toEqual(expect.objectContaining({ valid: true }));
  });

  it('Should be an invalid message if message `ok` field  is not a number', () => {
    deviceStatsMsg[0].ok = 'not-a-number';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `period` field  is not a number', () => {
    deviceStatsMsg[0].period = 'not-a-number';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `utc` field  is not a number', () => {
    deviceStatsMsg[0].utc = 'not-a-time-stamp';
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `stats` field  contains invalid interface name', () => {
    deviceStatsMsg[0].stats = {
      'invalid@interface': {
        tx_bytes: 744.0,
        tx_pkts: 4.0,
        rx_pkts: 4.0,
        rx_bytes: 344.0
      }
    };
    const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
    expect(result).toEqual(expect.objectContaining({ valid: false }));
  });

  it('Should be an invalid message if message `stats` field contains invalid fields', () => {
    const fields = ['tx_bytes', 'tx_pkts', 'rx_pkts', 'rx_bytes'];
    for (const field of fields) {
      deviceStatsMsg[0].stats[field] = 'invalid-stat-value';
      const result = deviceStatus.validateDevStatsMessage(deviceStatsMsg);
      expect(result).toEqual(expect.objectContaining({ valid: false }));
      deviceStatsMsg[0].stats[field] = 0;
    }
  });
});
