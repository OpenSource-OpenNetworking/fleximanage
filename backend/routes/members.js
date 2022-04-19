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

var configs = require('../configs')();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const User = require('../models/users');
const Account = require('../models/accounts');
const Organization = require('../models/organizations');
const { membership, permissionMasks, preDefinedPermissions } = require('../models/membership');
const { getUserOrganizations } = require('../utils/membershipUtils');
const mongoConns = require('../mongoConns.js')();
const cors = require('./cors');
const { verifyPermission } = require('../authenticate');
const randomKey = require('../utils/random-key');
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const webHooks = require('../utils/webhooks')();
const createError = require('http-errors');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

const membersRouter = express.Router();
membersRouter.use(bodyParser.json());

const pick = (...keys) => obj => keys.reduce((a, e) => {
  const objKeys = e.split('.');
  let val = obj[objKeys[0]];
  for (let i = 1; i < objKeys.length; i++) {
    if (val && val[objKeys[i]]) val = val[objKeys[i]]; else val = null;
  };
  return { ...a, [objKeys.join('_')]: val };
}, {});

// Error formatter
const formatErr = (err, msg) => {
  // Check for unique error
  if (err.name === 'MongoError' && err.code === 11000) {
    return ({ status: 500, error: 'User ' + msg.email + ' already exists' });
  } else {
    return ({ status: 500, error: 'User invitation error' });
  }
};

// check user parameters
const checkMemberParameters = (req) => {
  if (
    !req.user._id ||
    !req.user.defaultAccount ||
    !req.user.defaultOrg ||
    !req.body.userPermissionTo ||
    !req.body.userRole ||
    !req.body.userEntity
  ) { return { status: false, error: 'Invitation Fields Error' }; }
  // Account permissions could be owner, manager or viewer
  // Group and organization permissions could be manager or viewer
  if (req.body.userRole !== 'owner' &&
        req.body.userRole !== 'manager' &&
        req.body.userRole !== 'viewer') return { status: false, error: 'Illegal role' };
  if ((req.body.userPermissionTo === 'group' || req.body.userPermissionTo === 'organization') &&
        req.body.userRole !== 'manager' &&
        req.body.userRole !== 'viewer') {
    return { status: false, error: 'Illegal permission combination' };
  }
  return { status: true, error: '' };
};

// check levels and relationships
const checkMemberLevel = async (
  permissionTo,
  permissionRole,
  permissionEntity,
  userId,
  accountId
) => {
  // make sure user is only allow to define membership under his view
  try {
    let verifyPromise = null;
    // to=account, role=owner => user must be account owner
    // to=account, role=(manager or viewer) => user must be account owner or manager
    if (permissionTo === 'account') {
      verifyPromise = membership.findOne({
        user: userId,
        account: accountId,
        to: 'account',
        ...(permissionRole === 'owner' && { role: 'owner' }),
        ...(permissionRole !== 'owner' && {
          $or: [{ role: 'owner' }, { role: 'manager' }]
        })
      });
    }
    // to=group, role=(manager or viewer) => user must be this
    // group manager or account owner/manager
    if (permissionTo === 'group') {
      verifyPromise = membership.findOne({
        user: userId,
        account: accountId,
        $or: [
          { to: 'group', group: permissionEntity, role: 'manager' },
          { to: 'account', $or: [{ role: 'owner' }, { role: 'manager' }] }
        ]
      });
    }
    // to=organization, role=(manager or viewer) => user must be this organization
    // manager or group manager for that organizatio or account owner/manager
    if (permissionTo === 'organization') {
      const org = await Organization.findOne({
        _id: mongoose.Types.ObjectId(permissionEntity)
      });
      if (!org) return null;
      verifyPromise = membership.findOne({
        user: userId,
        account: accountId,
        $or: [
          {
            to: 'organization',
            organization: permissionEntity,
            role: 'manager'
          },
          { to: 'group', group: org.group, role: 'manager' },
          { to: 'account', $or: [{ role: 'owner' }, { role: 'manager' }] }
        ]
      });
    }

    if (!verifyPromise) return null;
    const verified = await verifyPromise;
    if (!verified) return null;
    return true;
  } catch (err) {
    return null;
  }
};

// Retireves the list of users
membersRouter.route('/')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, verifyPermission('members', 'get'), async (req, res, next) => {
    let userPromise = null;
    // Check the user permission:
    // Account owners or members should be able to see all account users + groups +
    // all organizations users. Organization members should be
    // able to see all organization users
    if (req.user.perms.accounts & permissionMasks.get) {
      userPromise = membership.find({ account: req.user.defaultAccount._id });
    } else if (req.user.perms.organizations & permissionMasks.get) {
      userPromise = membership.find({
        account: req.user.defaultAccount._id,
        $or: [
          { to: 'organization', organization: req.user.defaultOrg._id },
          { to: 'group', group: req.user.defaultOrg.group }
        ]
      });
    }

    if (userPromise) {
      userPromise
        .populate('user')
        .populate('account')
        .populate('organization')
        .then((memList) => {
          const response = memList.map(mem =>
            pick(
              '_id',
              'user._id',
              'user.name',
              'user.email',
              'to',
              'account.name',
              'account._id',
              'group',
              'organization.name',
              'organization._id',
              'role'
            )(mem)
          );
          return res.status(200).json(response);
        })
        .catch((err) => {
          logger.error('Error getting members', { params: { reason: err.message } });
          return next(createError(500, 'Error getting members'));
        });
    } else {
      return res.status(200).json([]);
    }
  })

// create a new user
  .post(cors.corsWithOptions, verifyPermission('members', 'post'), async (req, res, next) => {
    // Check that input parameters are OK
    const checkParams = checkMemberParameters(req);
    if (checkParams.status === false) return next(createError(400, checkParams.error));

    // Check if user don't add itself
    if (req.user.email === req.body.email) {
      return next(createError(500, 'You can not add yourself'));
    }

    // make sure user is only allow to define membership under his view
    const verified = await checkMemberLevel(
      req.body.userPermissionTo,
      req.body.userRole,
      req.body.userEntity,
      req.user._id,
      req.user.defaultAccount._id
    );
    if (!verified) return next(createError(400, 'No sufficient permissions for this operation'));

    // Add user
    let session = null;
    let registerUser = null;
    let existingUser = null;
    const resetPWKey = randomKey(30);
    mongoConns.getMainDB().startSession()
      .then((_session) => {
        session = _session;
        return session.startTransaction();
      })
    // Create a new unverified user
    // Associate to account and current organization
      .then(async () => {
        // Check if user exists
        existingUser = await User.findOne({ username: req.body.email });
        if (!existingUser) {
          registerUser = new User({
            username: req.body.email,
            name: req.body.userFirstName,
            lastName: req.body.userLastName,
            email: req.body.email,
            jobTitle: req.body.userJobTitle,
            phoneNumber: '',
            admin: false,
            state: 'unverified',
            emailTokens: { verify: '', invite: '', resetPassword: resetPWKey },
            defaultAccount: req.user.defaultAccount._id,
            defaultOrg: req.body.userPermissionTo === 'organization' ? req.body.userEntity : null
            // null will try to find a valid organization on login
          });
          return registerUser.validate();
        }
        return Promise.resolve();
      })
    // Set random password for that user
      .then(() => {
        if (registerUser) {
          const randomPass = randomKey(10);
          return registerUser.setPassword(randomPass);
        } else return Promise.resolve();
      })
      .then(() => {
        return membership.create([{
          user: (existingUser) ? existingUser._id : registerUser._id,
          account: req.user.defaultAccount._id,
          group: req.body.userPermissionTo === 'group' ? req.body.userEntity : '',
          organization: req.body.userPermissionTo === 'organization' ? req.body.userEntity : null,
          to: req.body.userPermissionTo,
          role: req.body.userRole,
          perms: preDefinedPermissions[req.body.userPermissionTo + '_' + req.body.userRole]
        }], { session: session });
      })
      .then(() => {
        if (registerUser) {
          registerUser.$session(session);
          return registerUser.save();
        } else return Promise.resolve();
      })
    // Send email
      .then(() => {
        const p = mailer.sendMailHTML(
          configs.get('mailerEnvelopeFromAddress'),
          configs.get('mailerFromAddress'),
          req.body.email,
          `You are invited to a ${configs.get('companyName')} Account`,
          (`<h2>${configs.get('companyName')} Account Invitation</h2>
          <b>You have been invited to a ${configs.get('companyName')}
          ${req.body.userPermissionTo}. </b>`) + ((registerUser)
            ? `<b>Click below to set your password</b>
          <p><a href="${configs.get('uiServerUrl', 'list')[0]}/reset-password?email=${
            req.body.email
          }&t=${resetPWKey}">
            <button style="color:#fff;background-color:#F99E5B;
            border-color:#F99E5B;font-weight:400;text-align:center;
            vertical-align:middle;border:1px solid transparent;
            padding:.375rem .75rem;font-size:1rem;
            line-height:1.5;border-radius:.25rem;
            cursor:pointer">Set Password</button></a></p>`
            : '<b>You can use your current account credentials to access it</b>') +
        (`<p>Your friends @ ${configs.get('companyName')}</p>`));
        return p;
      })
      .then(() => {
        return session.commitTransaction();
      })
      .then(async () => {
        // Session committed, set to null
        session = null;
        // Send webhooks only for users invited as account owners
        // changing the user role later will not send another hook
        if (req.body.userPermissionTo === 'account' && req.body.userRole === 'owner') {
          // Trigger web hook
          const webHookMessage = {
            account: req.user.defaultAccount.name,
            firstName: (existingUser) ? existingUser.name : req.body.userFirstName,
            lastName: (existingUser) ? existingUser.lastName : req.body.userLastName,
            email: req.body.email,
            country: req.user.defaultAccount.country,
            jobTitle: (existingUser) ? existingUser.jobTitle : req.body.userJobTitle,
            phoneNumber: (existingUser) ? existingUser.phoneNumber : '',
            companySize: req.user.defaultAccount.companySize,
            usageType: req.user.defaultAccount.serviceType,
            numSites: req.user.defaultAccount.numSites,
            companyType: '',
            companyDesc: '',
            state: (existingUser) ? existingUser.state : 'unverified'
          };
          if (!await webHooks.sendToWebHook(configs.get('webHookAddUserUrl'),
            webHookMessage,
            configs.get('webHookAddUserSecret'))) {
            logger.error('Web hook call failed', { params: { message: webHookMessage } });
          }
        } else {
          logger.info('New invited user, webhook not sent - not account owner', {
            params: {
              email: req.body.email,
              to: req.body.userPermissionTo,
              role: req.body.userRole
            }
          });
        }
        // Always resolve
        return Promise.resolve(true);
      })
      .then(() => {
        return res
          .status(200)
          .json({
            name: req.body.userFirstName,
            email: req.body.email,
            status: 'user invited'
          });
      })
      .catch((err) => {
        if (session) session.abortTransaction();
        logger.error('User Invitation Failure', { params: { reason: err.message } });
        const fErr = formatErr(err, req.body);
        return next(createError(fErr.status, fErr.error));
      });
  });

membersRouter.route('/options/:optionsType')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, verifyPermission('members', 'get'), async (req, res, next) => {
    if (req.params.optionsType === 'account') {
      return res.status(200).json([{
        id: req.user.defaultAccount._id,
        value: req.user.defaultAccount.name
      }]);
    }

    let optionFiled = '';
    if (req.params.optionsType === 'group') optionFiled = 'group';
    else if (req.params.optionsType === 'organization') optionFiled = 'name';

    // TBD:
    // Show only organizations valid for user

    Account
      .find({ _id: req.user.defaultAccount._id })
      .populate('organizations')
      .then((account) => {
        const uniques = {};
        account[0].organizations.forEach((org) => {
          uniques[req.params.optionsType === 'organization' ? org._id : org[optionFiled]] =
            org[optionFiled];
        });
        const result = Object.keys(uniques).map((key) => {
          return {
            id: key,
            value: uniques[key]
          };
        });
        return res.status(200).json(result);
      })
      .catch((err) => {
        logger.error('Error getting member options', { params: { reason: err.message } });
        return next(createError(500, 'Error getting member options'));
      });
  });

// Retrieves user information
membersRouter.route('/:memberId')
  .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
  .get(cors.corsWithOptions, verifyPermission('members', 'get'), async (req, res, next) => {
    let userPromise = null;
    // Check the user permission:
    // Account owners or members should be able to see all account users
    // + groups + all organizations users. Organization members should
    //  be able to see all organization users
    if (req.user.perms.accounts & permissionMasks.get) {
      userPromise = membership.find({
        _id: req.params.memberId,
        account: req.user.defaultAccount._id
      });
    } else if (req.user.perms.organizations & permissionMasks.get) {
      userPromise = membership.find({
        _id: req.params.memberId,
        account: req.user.defaultAccount._id,
        $or: [{
          to: 'organization',
          organization: req.user.defaultOrg._id
        }, {
          to: 'group',
          group: req.user.defaultOrg.group
        }]
      });
    }

    if (userPromise) {
      userPromise
        .populate('user')
        .populate('account')
        .populate('organization')
        .then((memList) => {
          const response = memList.map(mem =>
            pick(
              '_id',
              'user._id',
              'user.name',
              'user.email',
              'to',
              'account.name',
              'account._id',
              'group',
              'organization.name',
              'organization._id',
              'role'
            )(mem)
          );
          return res.status(200).json(response);
        })
        .catch((err) => {
          logger.error('Error getting member', { params: { reason: err.message } });
          return next(createError(500, 'Error getting member'));
        });
    } else {
      return res.status(200).json([]);
    }
  })
// delete user
  .delete(cors.corsWithOptions, verifyPermission('members', 'del'), async (req, res, next) => {
    try {
      // Find member id data
      const membershipData = await membership.findOne({
        _id: req.params.memberId,
        account: req.user.defaultAccount._id
      });

      // Don't allow to delete self
      if (req.user._id.toString() === membershipData.user.toString()) {
        return next(createError(400, 'User cannot delete itself'));
      }

      // Check that current user is allowed to delete member
      const verified = await checkMemberLevel(membershipData.to, membershipData.role,
        (membershipData.to === 'organization') ? membershipData.organization : membershipData.group,
        req.user._id, req.user.defaultAccount._id);
      if (!verified) return next(createError(400, 'No sufficient permissions for this operation'));

      // Check that the account have at least one owner
      if (membershipData.to === 'account' && membershipData.role === 'owner') {
        const numAccountOwners = await membership.countDocuments({
          account: req.user.defaultAccount._id,
          to: 'account',
          role: 'owner'
        });
        if (numAccountOwners < 2) {
          return next(createError(400, 'Account must have at least one owner'));
        }
      }

      // TBD: Should we also remove defaultAccount and defaultOrg?

      // Delete member
      await membership.deleteOne({
        _id: req.params.memberId,
        account: req.user.defaultAccount._id
      });

      return res.status(200).json({ ok: 1 });
    } catch (err) {
      logger.error('Error deleting member', { params: { reason: err.message } });
      return next(createError(500, 'Error deleting member'));
    };
  })
// update user
  .put(cors.corsWithOptions, verifyPermission('members', 'put'), async (req, res, next) => {
    try {
      // Check that input parameters are OK
      const checkParams = checkMemberParameters(req);
      if (checkParams.status === false) return next(createError(400, checkParams.error));

      // make sure user is only allow to define membership under his view
      const verified = await checkMemberLevel(
        req.body.userPermissionTo,
        req.body.userRole,
        req.body.userEntity,
        req.user._id,
        req.user.defaultAccount._id
      );
      if (!verified) return next(createError(400, 'No sufficient permissions for this operation'));

      // Update
      const member = await membership.findOneAndUpdate(
        { _id: req.params.memberId, account: req.user.defaultAccount._id },
        {
          $set: {
            group: req.body.userPermissionTo === 'group' ? req.body.userEntity : '',
            organization: req.body.userPermissionTo === 'organization' ? req.body.userEntity : null,
            to: req.body.userPermissionTo,
            role: req.body.userRole,
            perms: preDefinedPermissions[req.body.userPermissionTo + '_' + req.body.userRole]
          }
        },
        { upsert: false, new: true, runValidators: true })
        .populate('user')
        .populate('account')
        .populate('organization');

      // Verify if default organization still accessible by the
      // user after the change, if not switch to another org
      const user = await User.findOne({ _id: req.body.userId }).populate('defaultAccount');
      if (user.defaultAccount._id.toString() === req.user.defaultAccount._id.toString()) {
        const orgs = await getUserOrganizations(user);
        const org = orgs[user.defaultOrg];
        if (!org) {
          // Get the first org available for this user
          const org0 = orgs[Object.keys(orgs)[0]] || null;
          await User.updateOne({ _id: req.body.userId }, { defaultOrg: org0._id });
        }
      }

      return res
        .status(200)
        .json(
          pick(
            '_id',
            'user._id',
            'user.name',
            'user.email',
            'to',
            'account.name',
            'account._id',
            'group',
            'organization.name',
            'organization._id',
            'role'
          )(member)
        );
    } catch (err) {
      logger.error('Error updating user', {
        params: {
          memberId: req.params.memberId,
          reason: err.message
        }
      });
      return next(createError(400, err.message));
    }
  });

// Default exports
module.exports = membersRouter;
