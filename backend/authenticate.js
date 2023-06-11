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

var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var JwtStrategy = require('passport-jwt').Strategy;
var ExtractJwt = require('passport-jwt').ExtractJwt;
var User = require('./models/users');
const Accounts = require('./models/accounts');
const Accesstoken = require('./models/accesstokens');
const { verifyToken, getToken } = require('./tokens');
const { permissionMasks } = require('./models/membership');
const { orgUpdateFromNull, getUserOrgByID } = require('./utils/membershipUtils');
var configs = require('./configs')();
const createError = require('http-errors');
const reCaptcha = require('./utils/recaptcha')(configs.get('captchaKey'));
const logger = require('./logging/logging')({ module: module.filename, type: 'req' });
var jwt = require('jsonwebtoken');

// Choose whether to add the username or ID for logging purposes
const useUserName = configs.get('logUserName') || false;

// Serialize username and password to the user model
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

// Define local authentication strategy
exports.localPassport = passport.use(new LocalStrategy(User.authenticate()));

// Define JWT authentication strategy
var opts = {};
opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
opts.secretOrKey = configs.get('userTokenSecretKey');
exports.jwtPassport = passport.use('jwt', new JwtStrategy(opts, async (jwtPayload, done) => {
  // prevent access sensitive resources with login token
  if (jwtPayload.type === 'login') {
    return done(null, false, { message: 'A login token is unauthorized to access this resource' });
  }

  // check if account exists on payload
  if (!jwtPayload.account) return done(null, false, { message: 'Account not found' });

  // check if token exists
  let token = null;
  if (jwtPayload.type === 'app_access_token' || jwtPayload.type === 'app_access_key') {
    try {
      token = await Accesstoken.findOne({ _id: jwtPayload.id });
      if (!token) {
        return done(null, false, { message: 'Invalid token used' });
      }
    } catch (error) {
      return done(new Error(error.message), false);
    }
  }

  User
    .findOne({ _id: jwtPayload._id })
    .populate('defaultOrg')
    .populate('defaultAccount')
    .exec(async (err, user) => {
      if (err) {
        return done(err, false);
      } else if (user) {
        const res = await setUserPerms(user, jwtPayload, token);
        return res === true
          ? done(null, user)
          : done(null, false, { message: 'Invalid Token' });
      } else {
        done(null, false, { message: 'Invalid Token' });
      }
    });
}));

passport.use('jwt-login', new JwtStrategy(opts, async (jwtPayload, done) => {
  // prevent access sensitive resources with login token
  if (jwtPayload.type !== 'login') {
    return done(null, false, { message: 'The JWT token is unauthorized to access this resource' });
  }

  User
    .findOne({ _id: jwtPayload.userId })
    .populate('defaultOrg')
    .populate('defaultAccount')
    .exec(async (err, user) => {
      if (err) {
        return done(err, false);
      } else if (user) {
        return done(null, user);
      } else {
        done(null, false, { message: 'Invalid Token' });
      }
    });
}));

const setUserPerms = async (user, jwtPayload, token = null) => {
  const isAccessToken = ['app_access_key', 'app_access_token'].includes(jwtPayload.type);
  const isValidAccount = user.defaultAccount &&
    user.defaultAccount._id.toString() === jwtPayload.account;

  if (!isAccessToken && !isValidAccount) return false;

  user.accessToken = isAccessToken;
  user.jwtAccount = jwtPayload.account;
  user.perms = jwtPayload.perms;

  // override user default account with account stored on jwtPayload
  if (isAccessToken) {
    const userAccount = await Accounts.findOne({ _id: jwtPayload.account });

    if (!userAccount) {
      logger.warn('Could not find account by jwt payload', {
        params: { jwtPayload: jwtPayload }
      });

      return false;
    }

    user.defaultAccount = userAccount;

    // retrieve permissions from token
    if (jwtPayload.type === 'app_access_key') {
      user.perms = token.permissions;
    }
  }

  // save if user passed mfa to login
  user.isLoggedInWithMfa = jwtPayload.mfaVerified ?? true;

  return true;
};

// const extractUserFromToken = (req) => {
//     if (!req.headers || !req.headers.authorization) return "";

//     try {
//         const decoded = jwt.verify(req.headers.authorization, secret.secretToken);
//         return decoded.id;
//     } catch (err) {
//         return "";
//     }
// };

// Authentication verification for local and JWT strategy, and populate req.user
exports.verifyUserLocal = async function (req, res, next) {
  // Verify captcha
  if (!await reCaptcha.verifyReCaptcha(req.body.captcha)) {
    return next(createError(401, 'Wrong Captcha'));
  }

  // Continue with verifying password
  passport.authenticate('local', { session: false }, async (err, user, info) => {
    if (err || !user) {
      const [errMsg, status, responseMsg] = err
        ? [err.message, 500, 'Internal server error']
        : [info.message, 401, info.message];

      logger.warn('User authentication failed', {
        params: {
          user: req.body.username,
          err: (err || info).name,
          message: errMsg
        },
        req: req
      });
      return next(createError(status, responseMsg));
    } else {
      if (user.state !== 'verified') {
        return next(createError(401, 'Account not verified, check your e-mail and verify'));
      } else {
        try {
          await user.populate('defaultOrg').populate('defaultAccount').execPopulate();
          // If user has no permission for organization set to null
          if (user.defaultOrg) {
            const org = await getUserOrgByID(user, user.defaultOrg._id);
            if (org.length === 0) {
              user.defaultOrg = null;
            }
          }
        } catch (err) {
          logger.error('Could not get user info', {
            params: { user: req.body.username, message: err.message },
            req: req
          });
          return next(createError(500, 'Could not get user info'));
        }
        req.user = user;
        // Try to update organization if null
        await orgUpdateFromNull(req, res);
        // If there's no account found after login generate an error
        if (!req.user.defaultAccount) return next(createError(401, 'Account not found'));
        // Add userId to the request for logging purposes.
        req.userId = useUserName ? user.username : user.id;
        return next();
      }
    }
  })(req, res, next);
};

exports.verifyUserJWT = function (req, res, next) {
  // Allow options to pass through without verification for preflight options requests
  if (req.method === 'OPTIONS') {
    logger.debug('verifyUserJWT: OPTIONS request');
    return next();
    // Check if an API call
  } else if (req.url.startsWith('/api') || req.url.includes('/mfa')) {
    passport.authenticate('jwt', { session: false }, async (err, user, info) => {
      if (err || !user) {
        // If the JWT token has expired, but the request
        // contains a valid refresh token, accept the request
        // and attach a new token to the response.
        // TBD: Maintain refresh tokens in database and add
        // check also if the refresh token hasn't been revoked.
        if (info && info.name === 'TokenExpiredError' &&
                    req.headers['refresh-token']) {
          try {
            const refreshToken = req.headers['refresh-token'];
            await verifyToken(refreshToken);
            const decodedToken = jwt.decode(refreshToken);
            const userDetails = await User
              .findOne({ _id: decodedToken._id })
              .populate('defaultOrg')
              .populate('defaultAccount');

            // Don't return a token if user was deleted
            // since the refresh token has been issued.
            if (!userDetails) return next(createError(401));

            // If user has no permission for organization set to null
            if (userDetails.defaultOrg) {
              const org = await getUserOrgByID(userDetails, userDetails.defaultOrg._id);
              if (org.length === 0) {
                userDetails.defaultOrg = null;
              }
            }

            // Attach the token to the headers and let
            // the request continue to the next middleware.
            req.user = userDetails;
            const token = await getToken(req, { mfaVerified: decodedToken.mfaVerified ?? false });
            res.setHeader('Refresh-JWT', token);

            // Manually set the user details and permissions
            // since passport's JWT strategy callback will not
            // be called.
            const jwtPayload = jwt.decode(token);
            await setUserPerms(userDetails, jwtPayload);
            user = userDetails;
          } catch (err) {
            if (req.header('Origin') !== undefined) {
              res.setHeader('Access-Control-Allow-Origin', req.header('Origin'));
            }
            if (err.name === 'TokenExpiredError') {
              logger.info('User refresh token expired', { params: { err: err.message }, req: req });
              return next(createError(401, 'session expired'));
            }
            logger.warn('User token refresh failed', { params: { err: err.message }, req: req });
            return err.name === 'MongoError'
              ? next(createError(500))
              : next(createError(401));
          }
        } else {
          if (req.header('Origin') !== undefined) {
            res.setHeader('Access-Control-Allow-Origin', req.header('Origin'));
          }
          const [errMsg, status, responseMsg] = err
            ? [err.message, 500, 'Internal server error']
            : [info.message, 401, info.message];

          logger.warn('JWT verification failed', { params: { err: errMsg }, req: req });
          return next(createError(status, responseMsg));
        }
      }
      // Set refresh JWT to empty if a new token was not generated,
      // update later if necessary. If not set Firefox bug uses garbage value.
      if (!res.getHeaders()['refresh-jwt']) res.setHeader('Refresh-JWT', '');
      req.user = user;
      // Try to update organization if null
      await orgUpdateFromNull(req, res);
      // Add userId to the request for logging purposes.
      req.userId = useUserName ? user.username : user.id;

      return next();
    })(req, res, next);
  } else {
    // For non API calls, continue
    return next();
  }
};

exports.verifyAdmin = function (req, res, next) {
  // Allow access to admin users only
  return !req.user.admin
    ? next(createError(403, 'You are not authorized for this operation')) : next();
};

/**
 * Function to verify access permission
 * @param {Object} accessType - what is accessed (billing, account, organization, ...)
 * @param {Object} restCommand - string of get, post, put, del
 * Return middleware to check permissions for that type
 */
exports.verifyPermission = function (accessType, restCommand) {
  return function (req, res, next) {
    if (req.user.perms[accessType] & permissionMasks[restCommand]) return next();
    next(createError(403, "You don't have permission to perform this operation"));
  };
};

exports.verifyPermissionEx = function (serviceName, { method, user, openapi }) {
  const accessType = serviceName.replace('Service', '').toLowerCase();
  let restCommand = method.toLowerCase();

  // below is a hotfix for membership permissions
  switch (restCommand) {
    case 'delete':
      restCommand = 'del';
      break;
    case 'patch':
      restCommand = 'post';
      break;
  }

  if (restCommand === 'delete') {
    restCommand = 'del';
  }
  if (restCommand === 'patch') {}

  // Override permission check for certain APIs
  switch (openapi.schema.operationId) {
    case 'accountsSelectPOST':
    case 'accountsGET':
    case 'accountsIdSubscriptionStatusGET':
    case 'organizationsSelectPOST':
    case 'configurationRestServersGET':
      return true;
  }

  return (user.perms[accessType] & permissionMasks[restCommand]);
};

exports.validatePassword = function (password) {
  return (password !== null && password !== undefined && password.length >= 8);
};

exports.verifyUserOrLoginJWT = function (req, res, next) {
  // Allow options to pass through without verification for preflight options requests
  if (!req.originalUrl.startsWith('/api/users')) {
    return next(createError(403, "You don't have permission to perform this operation"));
  }

  passport.authenticate(['jwt-login', 'jwt'], { session: false }, async (err, user, info) => {
    if (err || !user) {
      logger.warn('JWT verification failed', { params: { err: err?.message }, req: req });
      return next(createError(401));
    }
    req.user = user;
    return next();
  })(req, res, next);
};
