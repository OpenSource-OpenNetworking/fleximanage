// flexiWAN SD-WAN software - flexiEdge,flexiManage.
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

var configs = require('../configs')();
const express = require('express');
const router = express.Router();
const createError = require('http-errors');
const bodyParser = require('body-parser');
const User = require('../models/users');
const Account = require('../models/accounts');
const { membership, preDefinedPermissions } = require('../models/membership');
const auth = require('../authenticate');
const { getToken, getRefreshToken } = require('../tokens');
const cors = require('./cors');
const mongoConns = require('../mongoConns.js')();
const randomKey = require('../utils/random-key');
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const reCaptcha = require('../utils/recaptcha')(configs.get('captchaKey'));
const webHooks = require('../utils/webhooks')();
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const { getUiServerUrl } = require('../utils/httpUtils');
const flexibilling = require('../flexibilling');

router.use(bodyParser.json());

// Error formatter
const formatErr = (err, msg) => {
  // Check for unique error
  if (err.name === 'MongoError' && err.code === 11000) {
    return ({ status: 500, error: 'User ' + msg.email + ' already exists' });
  } else if (err.name === 'ValidationError') {
    return ({ status: 500, error: err.message.split(':')[2] });
  } else {
    return ({ status: 500, error: err.message });
  }
};

// register user
router.route('/register')
  .options(cors.cors, (req, res) => { res.sendStatus(200); })
  .post(cors.cors, async (req, res, next) => {
    let session = null;
    let registerUser = null;
    let registerAccount = null;

    // log info
    logger.info('Create account request', {
      params: {
        account: req.body.accountName,
        firstName: req.body.userFirstName,
        lastName: req.body.userLastName,
        email: req.body.email,
        jobTitle: req.body.userJobTitle,
        phoneNumber: req.body.userPhoneNumber,
        country: req.body.country,
        companySize: req.body.companySize,
        usageType: req.body.serviceType,
        numSites: req.body.numberSites,
        companyType: '',
        companyDesc: ''
      }
    });

    // check if registration is allowed
    if (!configs.get('allowUsersRegistration', 'boolean')) {
      return next(createError(500, 'Users registration is not allowed'));
    }

    // Validate password
    if (!auth.validatePassword(req.body.password)) return next(createError(500, 'Bad Password'));

    // Verify captcha
    if (!await reCaptcha.verifyReCaptcha(req.body.captcha)) {
      return next(createError(500, 'Wrong Captcha'));
    }

    // Continue with registration
    let registerCustomerId;

    mongoConns.getMainDB().startSession()
      .then((_session) => {
        session = _session;
        return session.startTransaction();
      })
      .then(() => {
        return flexibilling.createCustomer({
          first_name: req.body.userFirstName,
          last_name: req.body.userLastName,
          email: req.body.email,
          company: req.body.accountName,
          billing_address: {
            first_name: req.body.userFirstName,
            last_name: req.body.userLastName,
            country: req.body.country || ''
          }
        });
      })
      .then(customerId => {
        registerCustomerId = customerId;
        return Account.create([{
          name: req.body.accountName,
          country: req.body.country,
          companySize: req.body.companySize,
          serviceType: req.body.serviceType,
          numSites: req.body.numberSites,
          logoFile: '',
          billingCustomerId: customerId
        }], { session: session });
      })
      .then((account) => {
        registerAccount = account[0];
        const validateKey = randomKey(30);
        registerUser = new User({
          username: req.body.email,
          name: req.body.userFirstName,
          lastName: req.body.userLastName,
          email: req.body.email,
          jobTitle: req.body.userJobTitle,
          phoneNumber: req.body.userPhoneNumber,
          admin: false,
          state: 'unverified',
          emailTokens: { verify: validateKey, invite: '', resetPassword: '' },
          defaultAccount: registerAccount._id,
          defaultOrg: null
        });
        return registerUser.validate();
      })
      .then(() => {
        return registerUser.setPassword(req.body.password);
      })
      .then(() => {
        registerUser.$session(session);
        return registerUser.save();
      })
      .then(() => {
        const mem = {
          user: registerUser._id,
          account: registerAccount._id,
          group: '',
          organization: null,
          to: 'account',
          role: 'owner',
          perms: preDefinedPermissions.account_owner
        };
        return membership.create([mem], { session: session });
      })
      .then(() => {
        const uiServerUrl = getUiServerUrl(req);
        const p = mailer.sendMailHTML(
          configs.get('mailerFromAddress'),
          req.body.email,
          `Verify Your ${configs.get('companyName')} Account`,
          `<h2>Thank you for joining ${configs.get('companyName')}</h2>
            <b>Click below to verify your account:</b>
            <p><a href="${uiServerUrl}/verify-account?id=${
              registerUser._id
          }&t=${
            registerUser.emailTokens.verify
          }"><button style="color:#fff;background-color:#F99E5B;
            border-color:#F99E5B;font-weight:400;text-align:center;
            vertical-align:middle;border:1px solid transparent;
            padding:.375rem .75rem;font-size:1rem;line-height:1.5;
            border-radius:.25rem;
            cursor:pointer">Verify Account</button></a></p>
            <p>Your friends @ ${configs.get('companyName')}</p>`
        );
        return p;
      })
      .then(() => {
        return session.commitTransaction();
      })
      .then(async () => {
        // Session committed, set to null
        session = null;

        // Trigger web hook
        const webHookMessage = {
          account: req.body.accountName,
          firstName: req.body.userFirstName,
          lastName: req.body.userLastName,
          email: req.body.email,
          jobTitle: req.body.userJobTitle,
          phoneNumber: req.body.userPhoneNumber,
          country: req.body.country,
          companySize: req.body.companySize,
          usageType: req.body.serviceType,
          numSites: req.body.numberSites,
          companyType: '',
          companyDesc: '',
          state: 'unverified'
        };
        if (!await webHooks.sendToWebHook(configs.get('webHookAddUserUrl'),
          webHookMessage,
          configs.get('webHookAddUserSecret'))) {
          logger.error('Web hook call failed', { params: { message: webHookMessage } });
        }
        // Always resolve
        return Promise.resolve(true);
      })
      .then(() => {
        return res.status(200).json({ status: 'user registered' });
      })
      .catch(async (err) => {
        if (session) session.abortTransaction();

        // need to remove billing account
        if (registerCustomerId) {
          if (await flexibilling.removeCustomer({ id: registerCustomerId })) {
            logger.error('Deleted billing account', {
              params: { registerCustomerId: registerCustomerId }
            });
          } else {
            logger.error('Deleted billing account failed', {
              params: { registerCustomerId: registerCustomerId }
            });
          }
        }

        logger.error('Error in create account process', { params: { reason: err.message } });

        const fErr = formatErr(err, req.body);
        return next(createError(fErr.status, fErr.error));
      });
  });

// verify account again if user did not received a verification email
router.route('/reverify-account')
  .options(cors.cors, (req, res) => { res.sendStatus(200); })
  .post(cors.cors, async (req, res, next) => {
    const validateKey = randomKey(30);
    User.findOneAndUpdate(
      // Query, use the email
      { email: req.body.email },
      // Update
      { 'emailTokens.verify': validateKey },
      // Options
      { upsert: false, new: false }
    )
      .then((resp) => {
        const uiServerUrl = getUiServerUrl(req);
        // Send email if user found
        if (resp) {
          const p = mailer.sendMailHTML(
            configs.get('mailerFromAddress'),
            req.body.email,
            `Re-Verify Your ${configs.get('companyName')} Account`,
            `<h2>Re-Verify Your ${configs.get('companyName')} Account</h2>
                <b>It has been requested to re-verify your account. If it is asked by yourself,
                   click below to re-verify your account. If you do not know who this is,
                   ignore this message.</b>
                <p><a href="${uiServerUrl}/verify-account?id=${
              resp._id
            }&t=${validateKey}"><button style="color:#fff;background-color:#F99E5B;
                 border-color:#F99E5B;font-weight:400;text-align:center;
                 vertical-align:middle;border:1px solid transparent;
                 padding:.375rem .75rem;font-size:1rem;line-height:1.5;
                 border-radius:.25rem;
                cursor:pointer">Re-Verify Account</button></a></p>
                <p>Your friends @ ${configs.get('companyName')}</p>`
          );
          return p;
        }
      })
      .then(() => {
        // In case of re-verification, always return OK to not expose email addresses
        return res.status(200).json({ status: 'account reverified' });
      })
      .catch((err) => {
        logger.error('Account Re-verification process failed', { params: { reason: err.message } });
        return next(createError(500, 'Account Re-verification process failed'));
      });
  });

// verify account
router.route('/verify-account')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.cors, async (req, res, next) => {
    if (!req.body.id || !req.body.token || req.body.id === '' || req.body.token === '') {
      return next(createError(500, 'Verification Error'));
    }

    User.findOneAndUpdate(
      // Query, use the email and verification token
      {
        _id: req.body.id,
        'emailTokens.verify': req.body.token
      },
      // Update
      {
        state: 'verified',
        'emailTokens.verify': ''
      },
      // Options
      { upsert: false, new: false }
    )
      .then((resp) => {
        if (!resp) return next(createError(500, 'Verification Error'));
        return res.status(200).json({ status: 'account verified' });
      })
      .catch((err) => {
        logger.error('Verification Error', { params: { reason: err.message } });
        return next(createError(500, 'Verification Error'));
      });
  });

/**
 * Send reset password mail
 * @param {Object} req = request
 * @param {Object} res = response
 * @param {Function} next = next middleware
 */
const resetPassword = (req, res, next) => {
  if (!req.body.email) return next(createError(500, 'Password Reset Error'));

  const validateKey = randomKey(30);
  User.findOneAndUpdate(
    // Query, use the email and make sure user is verified when reset password
    { email: req.body.email, state: 'verified' },
    // Update
    { 'emailTokens.resetPassword': validateKey },
    // Options
    { upsert: false, new: false }
  )
    .then((resp) => {
      // Send email if user found
      if (resp) {
        const uiServerUrl = getUiServerUrl(req);
        const p = mailer.sendMailHTML(
          configs.get('mailerFromAddress'),
          req.body.email,
          `Reset Password for Your ${configs.get('companyName')} Account`,
          `<h2>Reset Password for your ${configs.get('companyName')} Account</h2>
                <b>It has been requested to reset your account password. If it is asked by yourself,
                   click below to reset your password. If you do not know who this is,
                   ignore this message.</b>
                <p><a href="${uiServerUrl}/reset-password?id=${
            resp._id
          }&t=${validateKey}"><button style="color:#fff;
          background-color:#F99E5B;border-color:#F99E5B;
          font-weight:400;text-align:center;
          vertical-align:middle;border:1px solid transparent;
          padding:.375rem .75rem;font-size:1rem;line-height:1.5;
          border-radius:.25rem;
                cursor:pointer">Reset Password</button></a></p>
                <p>Your friends @ ${configs.get('companyName')}</p>`
        );
        return p;
      }
    })
    .then(() => {
      // In case of password reset, always return OK to not expose email addresses
      return res.status(200).json({ status: 'password reset initiated' });
    })
    .catch((err) => {
      logger.error('Account Password Reset process failed', { params: { reason: err.message } });
      return next(createError(500, 'Password Reset process failed'));
    });
};

/**
 * Update password using email and token
 * @param {Object} req = request
 * @param {Object} res = response
 * @param {Function} next = next middleware
 */
const updatePassword = (req, res, next) => {
  if (!req.body.id || !req.body.token || !req.body.password ||
    req.body.id === '' || req.body.token === '') {
    return next(createError(500, 'Password Reset Error'));
  }

  // Validate password
  if (!auth.validatePassword(req.body.password)) return next(createError(500, 'Bad Password'));

  let registerUser = null;
  User.findOneAndUpdate(
    // Query, use the email and password reset token
    {
      _id: req.body.id,
      'emailTokens.resetPassword': req.body.token
    },
    // Update
    {
      state: 'verified',
      'emailTokens.resetPassword': ''
    },
    // Options
    { upsert: false, new: true }
  )
    .then((resp) => {
      if (!resp) throw new Error('Password Reset Error');
      else {
        registerUser = resp;
        return registerUser.setPassword(req.body.password);
      }
    })
    .then(() => {
      return registerUser.save();
    })
    .then(() => {
      return res.status(200).json({ status: 'password reset' });
    })
    .catch((err) => {
      logger.error('Password Reset Error', { params: { reason: err.message } });
      return next(createError(500, 'Password Reset Error'));
    });
};

/**
 * Reset password API
 * There are two modes:
 * 1) type = reset - send a mail to reset the password
 * 2) type = update - make the actual update of the password
 */
router.route('/reset-password')
  .options(cors.cors, (req, res) => { res.sendStatus(200); })
  .post(cors.cors, async (req, res, next) => {
    if (!req.body.type) return next(createError(500, 'Password Reset Error'));

    // Call function based on request type
    if (req.body.type === 'reset') return resetPassword(req, res, next);
    else return updatePassword(req, res, next);
  });

// Authentication check is done within passport, if passed, no login error exists
router.route('/login')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .post(cors.corsWithOptions, auth.verifyUserLocal, async (req, res) => {
    // Create token with user id and username
    const token = await getToken(req);
    const refreshToken = await getRefreshToken(req);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Refresh-JWT', token);
    res.setHeader('refresh-token', refreshToken);
    res.json({ name: req.user.name, status: 'logged in' });
  });

// Passport exposes a function logout() on the req object which removes the req.user
router.route('/logout')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, (req, res) => {
    req.logout();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.json({ status: 'logged out' });
  });

// Default exports
module.exports = router;
