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

jest.setTimeout(40000);

const Limiter = require('../limiter');

const key = 'a';

const sleep = seconds => {
  return new Promise((resolve, reject) => {
    setTimeout(() => resolve(), seconds * 1000);
  });
};

describe('Limiter functionally', () => {
  let testLimiter = null;
  beforeEach(() => {
    testLimiter = new Limiter('test', 5, 10, 10);
  });

  it('should not be blocked before the sixth time', async (done) => {
    for (let i = 0; i < 5; i++) {
      await sleep(1);
      await testLimiter.use(key);
    }

    const res = await testLimiter.isBlocked(key);
    expect(res).toBe(false);
    done();
  });

  it('should be blocked at the sixth time', async (done) => {
    for (let i = 0; i < 6; i++) {
      await sleep(1);
      await testLimiter.use(key);
    }

    const res = await testLimiter.isBlocked(key);
    expect(res).toBe(true);
    done();
  });

  it('should be released after 10 seconds', async (done) => {
    for (let i = 0; i < 6; i++) {
      await sleep(1);
      await testLimiter.use(key);
    }

    let res = await testLimiter.isBlocked(key);
    expect(res).toBe(true);

    await sleep(11);

    res = await testLimiter.isBlocked(key);
    expect(res).toBe(false);
    done();
  });

  it('should be expired after 10 seconds without activity', async (done) => {
    for (let i = 0; i < 6; i++) {
      await sleep(1);
      await testLimiter.use(key);
    }

    let res = await testLimiter.isBlocked(key);
    expect(res).toBe(true);

    await sleep(11);

    res = await testLimiter.limiter.get(key);
    expect(res).toBe(null);
    done();
  });

  // test the secondary limiter
  it('should not be released after 10 seconds if still error', async (done) => {
    // block it quickly
    for (let i = 0; i < 8; i++) {
      await testLimiter.use(key);
    }
    // should be blocked for 10 seconds

    await sleep(7);

    // block it quickly again
    for (let i = 0; i < 5; i++) {
      await testLimiter.use(key);
    }

    await sleep(5);

    // main limiter should be blocked even 10 seconds is over
    let res = await testLimiter.limiter.get(key);
    expect(res).not.toBe(null);

    // isBlocked should return true
    res = await testLimiter.isBlocked(key);
    expect(res).toBe(true);
    done();
  });

  // test the release functionally
  it('should not be released totally from both limiters', async (done) => {
    // block both limiters quickly
    for (let i = 0; i < 12; i++) {
      await testLimiter.use(key);
    }

    let res = await testLimiter.isBlocked(key);
    expect(res).toBe(true);

    await testLimiter.release(key);

    res = await testLimiter.isBlocked(key);
    expect(res).toBe(false);

    res = await testLimiter.limiter.get(key);
    expect(res).toBe(null);
    done();
  });
});
