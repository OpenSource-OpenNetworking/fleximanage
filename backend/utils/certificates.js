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

const EasyRSA = require('easyrsa').default;
const forge = require('node-forge');
const fs = require('fs');
const { randomBytes } = require('crypto');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const deleteFolderRecursive = path => {
  if (!fs.existsSync(path)) {
    return;
  }

  fs.readdirSync(path).forEach((file, index) => {
    const curPath = path + '/' + file;
    if (fs.lstatSync(curPath).isDirectory()) { // recurse
      deleteFolderRecursive(curPath);
    } else { // delete file
      fs.unlinkSync(curPath);
    }
  });
  fs.rmdirSync(path);
};

const generateRemoteVpnPKI = async (orgName) => {
  const res = {
    caCert: null,
    caKey: null,
    serverCert: null,
    serverKey: null,
    clientCert: null,
    clientKey: null
  };

  return new Promise((resolve, reject) => {
    const pkiDir = `tmp/openvpn_pki/${orgName}`;

    // Make sure pki tmp folder is not exists, otherwise the package will throw an error
    deleteFolderRecursive(pkiDir);

    const easyrsa = new EasyRSA({ pkiDir: pkiDir });
    easyrsa.initPKI()
      .then(t => {
        return easyrsa.buildCA();
      })
      .then(data => {
        res.caCert = forge.pki.certificateToPem(data.cert);
        res.caKey = forge.pki.privateKeyToPem(data.privateKey);

        const commonName = 'server';
        return easyrsa.createServer({ commonName, nopass: true });
      }).then((data) => {
        res.serverCert = forge.pki.certificateToPem(data.cert);
        res.serverKey = forge.pki.privateKeyToPem(data.privateKey);

        const commonName = 'client';
        return easyrsa.createClient({ commonName, nopass: true });
      })
      .then((data) => {
        res.clientCert = forge.pki.certificateToPem(data.cert);
        res.clientKey = forge.pki.privateKeyToPem(data.privateKey);
        return resolve(res);
      })
      .catch(err => {
        logger.error('failed to create certificates', { params: { orgName, err } });
        const errMsg =
          new Error('An error occurred while creating the keys key for your organization');
        return reject(errMsg);
      })
      .finally(() => {
        // on any case, remove the pki dir
        deleteFolderRecursive(pkiDir);
      });
  });
};

const generateTlsKey = () => {
  const buf = randomBytes(256);
  const hex = buf.toString('hex');

  const key = splitLineEveryNChars(hex, /(.{32})/g);

  const ret =
`-----BEGIN OpenVPN Static key V1-----
${key}
-----END OpenVPN Static key V1-----`;

  return ret;
};

const splitLineEveryNChars = (str, regex) => {
  const tmp = str.replace(regex, '$1<break>');
  const arr = tmp.split('<break>');

  // Remove the last <break>
  arr.pop();

  const finalString = arr.join('\n');

  return finalString;
};

module.exports = {
  generateRemoteVpnPKI,
  generateTlsKey
};
