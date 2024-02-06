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
const { getLoginProcessToken, getToken, getRefreshToken } = require('../tokens');
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
const { getUserOrganizations } = require('../utils/membershipUtils');
const { generateSecret, verifyCode } = require('../otp');
const SHA256 = require('crypto-js/sha256');
const rateLimit = require('express-rate-limit');
const RateLimitStore = require('../rateLimitStore');

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
  .options((req, res) => { res.sendStatus(200); })
  .post(async (req, res, next) => {
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
      .then(async customerId => {
        registerCustomerId = customerId;
        const subscription = await flexibilling.getAllSubscriptionsForQuery({
          'customer_id[is]': customerId
        });
        return Account.create([{
          name: req.body.accountName,
          country: req.body.country,
          companySize: req.body.companySize,
          serviceType: req.body.serviceType,
          numSites: req.body.numberSites,
          logoFile: '',
          billingCustomerId: customerId,
          isSubscriptionValid: true,
          trial_end: subscription?.[0]?.subscription?.trial_end ?? null
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
          configs.get('mailerEnvelopeFromAddress'),
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
  .options((req, res) => { res.sendStatus(200); })
  .post(async (req, res, next) => {
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
            configs.get('mailerEnvelopeFromAddress'),
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
  .options((req, res) => { res.sendStatus(200); })
  .post(async (req, res, next) => {
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
          configs.get('mailerEnvelopeFromAddress'),
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
  .options((req, res) => { res.sendStatus(200); })
  .post(async (req, res, next) => {
    if (!req.body.type) return next(createError(500, 'Password Reset Error'));

    // Call function based on request type
    if (req.body.type === 'reset') return resetPassword(req, res, next);
    else return updatePassword(req, res, next);
  });

// This endpoint receives the username and password from the initial screen of the login process.
// Here, a check is made as to whether to allow the user to enter,
// or whether he needs to pass another identification factor (like 2FA)
router.route('/login')
  .options((req, res) => { res.sendStatus(200); })
  .post(auth.verifyUserLocal, async (req, res) => {
    // if user enabled 2fa or account forces using it- send login process token
    // else, allow login without mfa
    const isUserEnabledMfa = req.user?.mfa?.enabled;
    const isAccountForcesIt = req.user?.defaultAccount?.forceMfa;
    if (isUserEnabledMfa || isAccountForcesIt) {
      const token = await getLoginProcessToken(req.user);
      res.status(200).json({ name: req.user.name, token });
    } else {
      return await sendJwtToken(req, res, false);
    }
  });

// This endpoint returns to the user his options,
// which he can use to identify himself and enter the system
router.route('/login/methods')
  .options((req, res) => { res.sendStatus(200); })
  .get(auth.verifyUserOrLoginJWT, async (req, res) => {
    const methods = {
      recoveryCodes: 0,
      authenticatorApp: 0
    };

    const recoveryCodes = req.user?.mfa?.recoveryCodes ?? [];
    // Check if there is a recovery code,
    // and also if there is at least one that has not been used yet
    if (recoveryCodes.length > 0 && recoveryCodes.some(c => c.usedTime === null)) {
      methods.recoveryCodes = 1;
    }

    if (req.user?.mfa?.enabled) {
      methods.authenticatorApp = 1;
    }

    res.status(200).json({ methods });
  });

// Authentication check is done within passport, if passed, no login error exists
router.route('/auth')
  .options((req, res) => { res.sendStatus(200); })
  .post(auth.verifyUserLocal, async (req, res) => {
    const orgs = await getUserOrganizations(req.user);
    res.status(200).json({
      email: req.user.email,
      name: `${req.user.name} ${req.user.lastName}`,
      orgs: Object.keys(orgs)
    });
  });

// Passport exposes a function logout() on the req object which removes the req.user
router.route('/logout')
  .options((req, res) => { res.sendStatus(200); })
  .get((req, res) => {
    req.logout();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.json({ status: 'logged out' });
  });

// This endpoint checks if user enabled and verified 2FA for himself.
// Once user enabled it, he cannot login without it.
router.route('/mfa/isEnabled')
  .options((req, res) => { res.sendStatus(200); })
  .get(auth.verifyUserOrLoginJWT, async (req, res) => {
    res.status(200).json({ isEnabled: req?.user?.mfa?.enabled });
  });

// This endpoint generates for the user the URI that will be displayed in the UI as a QR code
// that can be scanned by an authenticator application
router.route('/mfa/getMfaConfigUri')
  .options((req, res) => { res.sendStatus(200); })
  .get(auth.verifyUserOrLoginJWT, async (req, res, next) => {
    // if verified - don't generate
    if (req.user.mfa.enabled) {
      return next(createError(500, 'Secret already verified'));
    }

    // generate unique secret for user
    // this secret will be used to check the verification code sent by user
    const userName = req.user.email;
    const secret = await generateSecret(configs.get('companyName'), userName);

    // save secret for the user
    await User.findOneAndUpdate(
      { _id: req.user._id },
      // keep the last 30
      { $push: { 'mfa.unverifiedSecrets': { $each: [secret.secret], $slice: -30 } } },
      { upsert: false });

    res.status(200).json({ configUri: secret.uri });
  });

// 2fa token is changed every 30 seconds.
// Hence allow 5 times in 30 seconds to verify,
const inMemoryStore = new RateLimitStore(1000 * 30); // 30 seconds
const verifyMfaRateLimit = rateLimit({
  store: inMemoryStore,
  max: 5, // Allow 5 times in token period. The 6th request will be blocked
  message: { error: 'Too many attempts. Please wait and try again later' },
  onLimitReached: (req, res, options) => {
    logger.warn(
      'MFA versification rate limit exceeded. blocking request for one second', {
        params: { ip: req.ip },
        req: req
      });
  }
});

// This endpoint verifies user code with his unique secret.
router.route('/mfa/verify')
  .options((req, res) => { res.sendStatus(200); })
  .post(
    verifyMfaRateLimit,
    auth.verifyUserOrLoginJWT,
    async (req, res, next) => {
      if (!req.body.token) {
        return next(createError(401, 'Token is required'));
      }

      let secrets = [];

      // Check with which secret we need to verify the code.
      if (req.user.mfa.secret) {
        // if user already enabled and verified 2fa, verify code with this verified secret.
        secrets.push(req.user.mfa.secret);
      } else if (req.user.mfa.unverifiedSecrets.length > 0) {
        // if user didn't enabled 2fa and wants to verify it on first time,
        // verify code with this unverifiedSecrets secrets code.
        secrets = req.user.mfa.unverifiedSecrets;
      } else {
        return next(createError(401, 'Multi-Factor is not configured'));
      }

      let validated = null;
      for (const secret of secrets) {
        const isValid = verifyCode(req.body.token, secret);
        if (isValid) {
          validated = secret;
          break;
        }
      }

      if (!validated) {
        return next(createError(403, 'Invalid Code'));
      }

      const updateQuery = { $set: {} };
      if (!req.user.mfa.secret) {
        updateQuery.$set['mfa.secret'] = validated;
      }

      if (!req.user.mfa.enabled) {
        updateQuery.$set['mfa.enabled'] = true;
      }

      if (req.user.mfa.unverifiedSecrets.length > 0) {
        updateQuery.$set['mfa.unverifiedSecrets'] = [];
      }

      if (Object.keys(updateQuery.$set).length > 0) {
        // save secret for the user
        await User.findOneAndUpdate(
          { _id: req.user._id },
          updateQuery,
          { upsert: false }
        );
      }

      return await sendJwtToken(req, res, validated !== null);
    });

// This function generates the JWT after the authentication process is complete.
// With this token, the user can access and receive the organization's information.
const sendJwtToken = async (req, res, mfaVerified) => {
  const token = await getToken(req, { mfaVerified });
  const refreshToken = await getRefreshToken(req, { mfaVerified });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Refresh-JWT', token);
  res.setHeader('refresh-token', refreshToken);
  res.json({ name: req.user.name, status: 'logged in' });
};

router.route('/mfa/generateRecoveryCodes')
  .options((req, res) => { res.sendStatus(200); })
  .get(auth.verifyUserJWT, async (req, res, next) => {
    if (!req?.user?.mfa?.enabled) {
      return next(createError(403, 'Two-Factor authentication is not configured'));
    }

    const codes = []; // send to user as clear text
    const hashed = []; // store hashed in DB

    if (req?.user?.mfa?.recoveryCodes?.length > 0 && req.query.regenerate !== 'true') {
      res.json({ codes });
    }

    for (let i = 0; i < 10; i++) {
      const code = randomKey(40);
      codes.push(code);
      hashed.push({ code: SHA256(code).toString(), usedTime: null });
    };

    await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: { 'mfa.recoveryCodes': hashed } },
      { upsert: false }
    );

    res.json({ codes });
  });

router.route('/mfa/verifyRecoveryCode')
  .options((req, res) => { res.sendStatus(200); })
  .post(auth.verifyUserOrLoginJWT, async (req, res, next) => {
    const userRecoveryCodes = req.user?.mfa?.recoveryCodes ?? [];
    if (userRecoveryCodes.length === 0) {
      return next(createError(401, 'Recovery codes are not generated for the user'));
    }

    const requestedCode = req.body?.recoveryCode;
    if (!requestedCode) {
      return next(createError(403, 'Recovery codes are missing'));
    }

    let validated = false;

    const hashedRequestedCode = SHA256(requestedCode).toString();
    for (const userRecoveryCode of userRecoveryCodes) {
      const { code, usedTime } = userRecoveryCode;

      // recovery code can be used once
      if (usedTime) {
        return next(createError(403, 'This recovery code is already used'));
      };

      if (hashedRequestedCode === code) {
        // mark recovery code as used
        await User.findOneAndUpdate(
          {
            _id: req.user._id,
            'mfa.recoveryCodes.code': code
          },
          { $set: { 'mfa.recoveryCodes.$.usedTime': new Date() } },
          { upsert: false }
        );

        validated = true;
        break;
      }
    }

    if (!validated) {
      return next(createError(403, 'Recovery code is invalid'));
    }

    return await sendJwtToken(req, res, validated);
  });

// Default exports
module.exports = router;
