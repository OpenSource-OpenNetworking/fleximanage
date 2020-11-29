// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

const Service = require('./Service');

const configs = require('../configs')();
const auth = require('../authenticate');
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const { getToken, getRefreshToken } = require('../tokens');
const randomKey = require('../utils/random-key');
const Users = require('../models/users');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class UsersService {
  /**
   * Login
   *
   * loginRequest LoginRequest  (optional)
   * no response value expected for this operation
   **/
  static async usersLoginPOST ({ loginRequest }, { user }, response) {
    try {
      // Create token with user id and username
      const token = await getToken({ user });
      const refreshToken = await getRefreshToken({ user });

      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Refresh-JWT', token);
      response.setHeader('Refresh-Token', refreshToken);

      return Service.successResponse({ username: user.name }, 201);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Reset password
   *
   * resetPasswordRequest ResetPasswordRequest  (optional)
   * no response value expected for this operation
   **/
  static async usersResetPasswordPOST ({ resetPasswordRequest }) {
    try {
      const validateKey = randomKey(30);

      const resp = await Users.findOneAndUpdate(
        // Query, use the email and make sure user is verified when reset password
        { email: resetPasswordRequest.email, state: 'verified' },
        // Update
        { 'emailTokens.resetPassword': validateKey },
        // Options
        { upsert: false, new: false }
      );

      // Send email if user found
      if (resp) {
        await mailer.sendMailHTML(
          configs.get('mailerFromAddress'),
          resetPasswordRequest.email,
          `Reset Password for Your ${configs.get('companyName')} Account`,
          `<h2>Reset Password for your ${configs.get('companyName')} Account</h2>
                <b>It has been requested to reset your account password.
                   If it is asked by yourself,
                   click below to reset your password. If you do not know who this is,
                   ignore this message.</b>
                <p><a href="${configs.get(
                  'uiServerUrl'
                )}/reset-password?email=${
                  resetPasswordRequest.email
          }&t=${validateKey}"><button style="color:#fff;
          background-color:#F99E5B;border-color:#F99E5B;
          font-weight:400;text-align:center;
          vertical-align:middle;border:1px solid transparent;
          padding:.375rem .75rem;font-size:1rem;line-height:1.5;
          border-radius:.25rem;
                cursor:pointer">Reset Password</button></a></p>
                <p>Your friends @ ${configs.get('companyName')}</p>`
        );
      }

      // In case of password reset, always return OK to not expose email addresses
      return Service.successResponse({ status: 'password reset initiated' }, 201);
    } catch (e) {
      logger.error('Account Password Reset process failed', { params: { reason: e.message } });
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Update password
   *
   * updatePasswordRequest UpdatePasswordRequest  (optional)
   * no response value expected for this operation
   **/
  static async usersUpdatePasswordPOST ({ updatePasswordRequest }, { user }) {
    try {
      // Validate password
      if (!auth.validatePassword(updatePasswordRequest.password)) {
        return Service.rejectResponse('Bad Password', 403);
      }

      const registerUser = await Users.findOneAndUpdate(
        // Query, use the email and password reset token
        {
          email: updatePasswordRequest.email,
          'emailTokens.resetPassword': updatePasswordRequest.token
        },
        // Update
        {
          state: 'verified',
          'emailTokens.resetPassword': ''
        },
        // Options
        { upsert: false, new: true }
      );
      await registerUser.setPassword(updatePasswordRequest.password);
      await registerUser.save();

      return Service.successResponse({ status: 'password reset' }, 201);
    } catch (e) {
      logger.error('Account Password Udate process failed', { params: { reason: e.message } });
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = UsersService;
