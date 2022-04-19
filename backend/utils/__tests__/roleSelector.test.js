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

// Module for deviceQueues Unit Test
var configs = require('../../configs')();
var roleSelector = require('../roleSelector')(configs.get('redisUrl'));

describe('Initialization', () => {
  afterAll(() => {
    roleSelector.shutDown();
  });

  test('Initialize selector role1test and role2test', async (done) => {
    let err;
    try {
      roleSelector.initializeSelector('role1test');
      roleSelector.initializeSelector('role2test');
    } catch (e) {
      err = e;
    }
    expect(err).toEqual(undefined);
    done();
  });

  test('Elect role for role2test', async (done) => {
    roleSelector.selectorSetActive('role2test');
    let isActive = false;
    // Give set active time to finish as its sync
    setTimeout(function () {
      roleSelector.runIfActive('role2test', () => {
        isActive = true;
      });
    }, 100);
    // Give runIfActive time to finish
    setTimeout(function () {
      expect(isActive).toEqual(true);
      done();
    }, 200);
  });

  test('Check if role1test active without election', async (done) => {
    let isActive = false;
    roleSelector.runIfActive('role1test', () => {
      isActive = true;
    });
    // Give runIfActive time to finish as its sync
    setTimeout(function () {
      expect(isActive).toEqual(false);
      done();
    }, 100);
  });

  test('Elect role for role1test', async (done) => {
    roleSelector.selectorSetActive('role1test');
    let isActive = false;
    // Give set active time to finish as its sync
    setTimeout(function () {
      roleSelector.runIfActive('role1test', () => {
        isActive = true;
      });
    }, 100);
    // Give runIfActive time to finish
    setTimeout(function () {
      expect(isActive).toEqual(true);
      done();
    }, 200);
  });
});
