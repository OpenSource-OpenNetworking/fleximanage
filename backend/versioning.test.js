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
const {
  isAgentVersionCompatible,
  isSemVer,
  isVppVersion,
  verifyAgentVersion,
  routerVersionsCompatible
} = require('./versioning');
const { checkDeviceVersion } = require('./routes/connect');
const configs = require('./configs')();
const httpMocks = require('node-mocks-http');
// const createError = require('http-errors');

describe('isAgentVersionCompatible', () => {
  // Different variations of compatible versions. Majors are equal.
  it.each([
    '4.0.0',
    '4.1.0',
    '4.0.1',
    '4.1.1'
  ])(
    'Should return 0 if MGMT and agent major version are equal (agent version=%s)',
    (version) => {
      expect(isAgentVersionCompatible(version)).toEqual(0);
    }
  );

  // Different variations of compatible versions.
  // MGMT version is greater than agent version by 1
  it.each([
    '3.0.0',
    '3.1.0',
    '3.0.1',
    '3.1.1'
  ])(
    'Should return 0 if MGMT major version is greater by 1 ' +
        'than agent major version (agent version=%s)',
    (version) => {
      expect(isAgentVersionCompatible(version)).toEqual(-1);
    }
  );

  // Different variations of incompatible versions.
  // MGMT version is greater than agent version by more than 1
  it.each([
    '1.0.0',
    '1.1.0',
    '1.0.1',
    '1.1.1'
  ])(
    'Should return -1 if MGMT major version is greater by more than 1 ' +
        'than agent major version (agent version=%s)',
    (version) => {
      expect(isAgentVersionCompatible(version)).toEqual(-1);
    }
  );

  // Different variations of incompatible versions.
  // MGMT is older than agent version
  it.each([
    '5.0.0',
    '5.1.0',
    '5.0.1',
    '5.1.1'
  ])(
    'Should return 1 if MGMT major version is older than agent major version (agent version=%s)',
    (version) => {
      expect(isAgentVersionCompatible(version)).toEqual(0);
    }
  );

  // Different variations of incompatible versions.
  // MGMT is older than agent version
  it.each([
    '6.0.0',
    '6.1.0',
    '6.0.1',
    '6.1.1'
  ])(
    'Should return 1 if MGMT major version is older than agent major version (agent version=%s)',
    (version) => {
      expect(isAgentVersionCompatible(version)).toEqual(1);
    }
  );
});

// Validates that the version complies with semantic version format
describe('isSemVer', () => {
  it.each`
        version           | result
        ${'1.0.0'}        | ${true}
        ${'11.1.0'}       | ${true}
        ${'111.1.0'}      | ${true}
        ${'1.11.0'}       | ${true}
        ${'1.111.0'}      | ${true}
        ${'1.1.00'}       | ${true}
        ${'1.1.000'}      | ${true}
        ${'1.1'}          | ${true}
        ${'1.12'}         | ${true}
        ${'1'}            | ${false}
        ${'1.'}           | ${false}
        ${'1.0.'}         | ${false}
        ${'1-0-0'}        | ${false}
        ${'.1.0.0'}       | ${false}
        ${'1111.1.0'}     | ${false}
        ${'x.1.0'}        | ${false}
        ${'1.x.0'}        | ${false}
        ${'1.1.x'}        | ${false}
        ${''}             | ${false}
        ${null}           | ${false}
        ${undefined}      | ${false}
  `('Should return $result if version is $version', ({ version, result }) => {
    expect(isSemVer(version)).toEqual(result);
  });
});

describe('isVppVersion', () => {
  const tooLongVppVersion = '1.0.0-thisstringistoolong';
  const maxLenVppVersion = '1.0.0-stable1234';
  it.each`
        version                 | result
        ${'1.0.0'}              | ${true}
        ${'1.1'}                | ${true}
        ${'1.12'}               | ${true}
        ${'1.1-rc0'}            | ${true}
        ${'1.1-rc01'}           | ${true}
        ${'19.01-rc0'}          | ${true}
        ${'19.01-stable'}       | ${true}
        ${'19.01-RC0'}          | ${true}
        ${maxLenVppVersion}     | ${true}
        ${'19.01-*&$'}          | ${false}
        ${'19.01rc0'}           | ${false}
        ${tooLongVppVersion}    | ${false}
        ${''}                   | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if version is $version', ({ version, result }) => {
    expect(isVppVersion(version)).toEqual(result);
  });
});

describe('routerVersionsCompatible', () => {
  it.each`
        ver1        | ver2          | result
        ${'1.0.0'}  | ${'1.0.0'}    | ${true}
        ${'1.0.0'}  | ${'1.1.0'}    | ${true}
        ${'1.0.0'}  | ${'1.0.1'}    | ${true}
        ${'1.0.0'}  | ${'0.0.0'}    | ${false}
        ${'1.0.0'}  | ${'0.1.0'}    | ${false}
        ${'1.0.0'}  | ${'0.0.1'}    | ${false}
 `('Should return $result if ver1 is $ver1 and ver2 is $ver2', ({ ver1, ver2, result }) => {
    expect(routerVersionsCompatible(ver1, ver2)).toEqual(result);
  });
});

describe('verifyAgentVersion', () => {
  it('Should return success object if agent version is valid', () => {
    const result = verifyAgentVersion(configs.get('agentApiVersion'));
    expect(result).toMatchObject({
      valid: true,
      statusCode: 200,
      err: ''
    });
  });

  it('Should return failure object if agent version is missing', () => {
    const result = verifyAgentVersion(undefined);
    expect(result).toMatchObject({
      valid: false,
      statusCode: 400,
      err: 'Invalid device version: none'
    });
  });

  it('Should return failure object if agent version is invalid', () => {
    const result = verifyAgentVersion('invalid-version');
    expect(result).toMatchObject({
      valid: false,
      statusCode: 400,
      err: 'Invalid device version: invalid-version'
    });
  });

  it('Should return failure object if agent version is lower', () => {
    const result = verifyAgentVersion('1.1.0');
    expect(result).toMatchObject({
      valid: false,
      statusCode: 403,
      err: 'Incompatible version: agent version: 1.1.0 too low, management version: 5.0.0'
    });
  });
});

it('Should return failure object if agent version is higher', () => {
  const result = verifyAgentVersion('6.1.0');
  expect(result).toMatchObject({
    valid: false,
    statusCode: 400,
    err: 'Incompatible version: agent version: 6.1.0 too high, management version: 5.0.0'
  });
});

describe('checkDeviceVersion', () => {
  it('Should call next() if versions are compatible', () => {
    const req = httpMocks.createRequest({
      body: { fwagent_version: configs.get('agentApiVersion') }
    });
    const res = httpMocks.createResponse({});
    const next = jest.fn();

    checkDeviceVersion(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toBeCalledWith();
  });

  // Disable this check as it require mongo access
  /*
  it('Should call next() with error object if fwagent_version is invalid', () => {
    const req = httpMocks.createRequest({ body: undefined });
    const res = httpMocks.createResponse({});
    const next = jest.fn();
    const err = createError(400, 'Invalid device version: none');

    checkDeviceVersion(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toBeCalledWith(err);
  });
  */
});
