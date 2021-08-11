const { randomBytes } = require('crypto');
const configs = require('../configs')();
const forge = require('node-forge');
const axios = require('axios');
const pki = forge.pki;

const generateCA = () => {
  var keys = pki.rsa.generateKeyPair(2048);
  var cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);

  var attrs = [{
    name: 'commonName',
    value: 'ChangeMe'
  }];

  cert.setSubject(attrs);

  cert.setIssuer(attrs);

  cert.setExtensions([{
    name: 'subjectKeyIdentifier'
  }, {
    name: 'authorityKeyIdentifier',
    keyIdentifier: true,
    authorityCertIssuer: true,
    serialNumber: true
  }, {
    name: 'basicConstraints',
    cA: true
  }]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  var certificate = pki.certificateToPem(cert);
  var privateKey = pki.privateKeyToPem(keys.privateKey);

  return { publicKey: certificate, privateKey: privateKey };
};

const generateKeys = (caKay) => {
  var keys = pki.rsa.generateKeyPair(2048);
  var cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  var attrs = [{
    name: 'commonName',
    value: 'ChangeMe'
  }];

  cert.setSubject(attrs);

  cert.setIssuer(attrs);

  // Sign with CA private key
  var caPrivateKey = pki.privateKeyFromPem(caKay);
  cert.sign(caPrivateKey, forge.md.sha256.create());

  var certificate = pki.certificateToPem(cert);
  var privateKey = pki.privateKeyToPem(keys.privateKey);

  return { publicKey: certificate, privateKey: privateKey };
};

const generateTlsKey = () => {
  const buf = randomBytes(256);
  const hex = buf.toString('hex');

  const key = splitLineEveryNChars(hex, /(.{32})/g);

  const ret = `
#
# 2048 bit OpenVPN static key
#
-----BEGIN OpenVPN Static key V1-----
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

const generateDhKey = () => {
  return new Promise((resolve, reject) => {
    axios.get(configs.get('createDiffieHellmanApi'))
      .then(res => {
        resolve(res.data);
      })
      .catch(err => {
        resolve(null);
      });
  });
};

module.exports = {
  generateKeys,
  generateCA,
  generateDhKey,
  generateTlsKey
};
