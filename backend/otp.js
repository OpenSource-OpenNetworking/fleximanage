// flexiWAN SD-WAN software - flexiEdge,flexiManage.
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

const twofactor = require('node-2fa');

const generateSecret = (name, account) => {
  const newSecret = twofactor.generateSecret({ name, account });
  return newSecret;
};

const verifyCode = (token, secret) => {
  const result = twofactor.verifyToken(secret, token);
  if (!result) { // result is null in case of not match
    return false;
  }

  // "delta" is an integer of how for behind/forward the code time sync is in terms
  // of how many new codes have been generated since entry
  // delta -1  means that the client entered the key too late (a newer key was meant to be used).
  // delta 1 means the client entered the key too early (an older key was meant to be used).
  // delta 0 means the client was within the time frame of the current key.
  // delta can be up to 4.
  const { delta } = result;
  if (delta >= -1 && delta <= 1) {
    return true;
  }

  return false;
};

module.exports = {
  verifyCode,
  generateSecret
};
