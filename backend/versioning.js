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
const configs = require('./configs')();
const mgmtVersion = configs.get('agentApiVersion');

/**
 * Get the major version X from a string in semVer format X.Y.Z
 * @param {String} versionString
 */
const getMajorVersion = (versionString) => {
  return parseInt(versionString.split('.')[0], 10);
};

/**
 * Get the minor version Y from a string in semVer format X.Y.Z
 * @param {String} versionString
 */
const getMinorVersion = (versionString) => {
  return parseInt(versionString.split('.')[1], 10);
};

const mgmtMajorVersion = getMajorVersion(mgmtVersion);

const isSemVer = (version) => {
  return /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/.test(version);
};

const isVppVersion = (version) => {
  return /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?(-[a-z0-9]{1,10})?$/i.test(
    version
  );
};

const isAgentVersionCompatible = (agentVersion) => {
  const majorNum = parseInt(agentVersion.split('.')[0], 10);

  if (isNaN(majorNum) || majorNum > mgmtMajorVersion) return 1; // Version not valid or higher
  if (majorNum < mgmtMajorVersion - 1) return -1; // version lower
  return 0; // version compatible
};

const routerVersionsCompatible = (ver1, ver2) => {
  const [majorVer1, majorVer2] = [ver1, ver2].map(ver => {
    return parseInt((ver || '').split('.')[0], 10);
  });
  return (isNaN(majorVer1) || isNaN(majorVer2))
    ? false
    : majorVer1 === majorVer2;
};

const verifyAgentVersion = (version) => {
  if (!isSemVer(version)) {
    return {
      valid: false,
      statusCode: 400,
      err: `Invalid device version: ${version || 'none'}`
    };
  }

  const higher = isAgentVersionCompatible(version);

  switch (higher) {
    case 0:
      return {
        valid: true,
        statusCode: 200,
        err: ''
      };
    case 1:
      return {
        valid: false,
        statusCode: 400,
        err: `Incompatible version: agent version: ${
          version
        } too high, management version: ${
          mgmtVersion
        }`
      };
    case -1:
      return {
        valid: false,
        statusCode: 403,
        err: `Incompatible version: agent version: ${
          version
        } too low, management version: ${
          mgmtVersion
        }`
      };
  }
};

module.exports = {
  getMajorVersion: getMajorVersion,
  getMinorVersion: getMinorVersion,
  isAgentVersionCompatible: isAgentVersionCompatible,
  isSemVer: isSemVer,
  isVppVersion: isVppVersion,
  verifyAgentVersion: verifyAgentVersion,
  routerVersionsCompatible: routerVersionsCompatible
};
