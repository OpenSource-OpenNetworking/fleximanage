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

const { membership, permissionMasks, preDefinedPermissions } = require('../models/membership');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });
const mongoose = require('mongoose');
const configs = require('../configs')();
const randomKey = require('../utils/random-key');
const mailer = require('../utils/mailer')(
  configs.get('mailerHost'),
  configs.get('mailerPort'),
  configs.get('mailerBypassCert', 'boolean')
);
const webHooks = require('../utils/webhooks')();

const Users = require('../models/users');
const Accounts = require('../models/accounts');
const Organizations = require('../models/organizations');
const { getUserOrganizations } = require('../utils/membershipUtils');
const mongoConns = require('../mongoConns.js')();

class MembersService {
  /**
   * Select the API fields from mongo member Object list
   * @param {Object} items - mongodb members object
   */
  static selectMembersParams (items) {
    const pick = (...keys) => obj => keys.reduce((a, e) => {
      const objKeys = e.split('.');
      let val = obj[objKeys[0]];
      for (let i = 1; i < objKeys.length; i++) {
        if (val && val[objKeys[i]]) val = val[objKeys[i]]; else val = null;
      };
      return { ...a, [objKeys.join('_')]: val };
    }, {});

    const response = items.map(mem => {
      const memItem = pick(
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
      )(mem);

      memItem._id = memItem._id.toString();
      memItem.user__id = memItem.user__id.toString();
      memItem.account__id = memItem.account__id.toString();
      memItem.organization__id = (memItem.organization__id)
        ? memItem.organization__id.toString() : null;

      return memItem;
    });

    return response;
  }

  // check user parameters
  static checkMemberParameters (memberRequest, user) {
    if (
      !user._id ||
      !user.defaultAccount ||
      !user.defaultOrg ||
      !memberRequest.userPermissionTo ||
      !memberRequest.userRole ||
      !memberRequest.userEntity
    ) { return { status: false, error: 'Invitation Fields Error' }; }

    // Account permissions could be owner, manager or viewer
    // Group and organization permissions could be manager or viewer
    if (memberRequest.userRole !== 'owner' &&
      memberRequest.userRole !== 'manager' &&
      memberRequest.userRole !== 'viewer') {
      return { status: false, error: 'Illegal role' };
    }

    if ((memberRequest.userPermissionTo === 'group' ||
      memberRequest.userPermissionTo === 'organization') &&
      memberRequest.userRole !== 'manager' &&
      memberRequest.userRole !== 'viewer') {
      return { status: false, error: 'Illegal permission combination' };
    }
    return { status: true, error: '' };
  };

  // check levels and relationships
  static async checkMemberLevel (
    permissionTo,
    permissionRole,
    permissionEntity,
    userId,
    accountId
  ) {
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
        const org = await Organizations.findOne({
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

  /**
   * Get all Members
   *
   * offset Integer The number of items to skip before starting to collect the result set
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async membersGET ({ offset, limit }, { user }) {
    try {
      let userPromise = null;
      // Check the user permission:
      // Account owners or members should be able to see all account users + groups +
      // all organizations users. Organization members should be
      // able to see all organization users
      if (user.perms.accounts & permissionMasks.get) {
        userPromise = membership.find({ account: user.defaultAccount._id });
      } else if (user.perms.organizations & permissionMasks.get) {
        userPromise = membership.find({
          account: user.defaultAccount._id,
          $or: [
            { to: 'organization', organization: user.defaultOrg._id },
            { to: 'group', group: user.defaultOrg.group }
          ]
        });
      }

      if (userPromise) {
        const memList = await userPromise
          .populate('user')
          .populate('account')
          .populate('organization');

        const response = MembersService.selectMembersParams(memList);

        return Service.successResponse(response);
      } else {
        return Service.successResponse([]);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Modify member
   *
   * id String Numeric ID of the account to modify
   * memberRequest MemberRequest  (optional)
   * returns Member
   **/
  static async membersIdPUT ({ id, memberRequest }, { user }) {
    try {
      // Check that input parameters are OK
      const checkParams = MembersService.checkMemberParameters(memberRequest, user);
      if (checkParams.status === false) return Service.rejectResponse(checkParams.error, 400);

      // make sure user is only allow to define membership under his view
      const verified = await MembersService.checkMemberLevel(
        memberRequest.userPermissionTo,
        memberRequest.userRole,
        memberRequest.userEntity,
        user._id,
        user.defaultAccount._id
      );

      if (!verified) {
        return Service.rejectResponse(
          'No sufficient permissions for this operation', 400);
      }

      // Update
      const member = await membership.findOneAndUpdate(
        { _id: memberRequest._id, account: user.defaultAccount._id },
        {
          $set: {
            group: memberRequest.userPermissionTo === 'group' ? memberRequest.userEntity : '',
            organization: memberRequest.userPermissionTo === 'organization'
              ? memberRequest.userEntity : null,
            to: memberRequest.userPermissionTo,
            role: memberRequest.userRole,
            perms: preDefinedPermissions[
              memberRequest.userPermissionTo + '_' + memberRequest.userRole
            ]
          }
        },
        { upsert: false, new: true, runValidators: true })
        .populate('user')
        .populate('account')
        .populate('organization');

      // Verify if default organization still accessible by the
      // user after the change, if not switch to another org
      const _user = await Users.findOne({ _id: memberRequest.userId })
        .populate('defaultAccount');

      if (_user.defaultAccount._id.toString() === user.defaultAccount._id.toString()) {
        const orgs = await getUserOrganizations(_user);
        const org = orgs[_user.defaultOrg];
        if (!org) {
          // Get the first org available for this user
          const org0 = orgs[Object.keys(orgs)[0]] || null;
          await Users.updateOne({ _id: memberRequest.userId }, { defaultOrg: org0._id });
        }
      }

      const response = MembersService.selectMembersParams([member]);

      return Service.successResponse(response[0]);
    } catch (err) {
      logger.error('Error updating user', {
        params: {
          memberId: id,
          reason: err.message
        }
      });
      return Service.rejectResponse(err, 400);
    }
  }

  /**
   * Retrieve Member
   * id String numeric ID of the account to modify
   * returns Member
   */
  static async membersIdGET ({ id }, { user }) {
    let userPromise = null;
    // Check the user permission:
    // Account owners or members should be able to see all account users
    // + groups + all organizations users. Organization members should
    //  be able to see all organization users
    if (user.perms.accounts & permissionMasks.get) {
      userPromise = membership.find({
        _id: id,
        account: user.defaultAccount._id
      });
    } else if (user.perms.organizations & permissionMasks.get) {
      userPromise = membership.find({
        _id: id,
        account: user.defaultAccount._id,
        $or: [{
          to: 'organization',
          organization: user.defaultOrg._id
        }, {
          to: 'group',
          group: user.defaultOrg.group
        }]
      });
    }

    if (userPromise) {
      const memList = await userPromise.populate('user')
        .populate('account')
        .populate('organization');

      const response = MembersService.selectMembersParams(memList);

      return Service.successResponse(response, 200);
    } else {
      return Service.successResponse([]);
    }
  }

  /**
   * Delete member
   *
   * id String Numeric ID of the account to delete
   * returns Member
   **/
  static async membersIdDELETE ({ id }, { user }) {
    try {
      // Find member id data
      const membershipData = await membership.findOne({
        _id: id,
        account: user.defaultAccount._id
      });

      // Don't allow to delete self
      if (user._id.toString() === membershipData.user.toString()) {
        return Service.rejectResponse('User cannot delete itself', 400);
      }

      // Check that current user is allowed to delete member
      const verified = await MembersService.checkMemberLevel(membershipData.to, membershipData.role,
        (membershipData.to === 'organization')
          ? membershipData.organization : membershipData.group,
        user._id, user.defaultAccount._id);
      if (!verified) {
        return Service.rejectResponse(
          'No sufficient permissions for this operation', 400);
      }

      // Check that the account have at least one owner
      if (membershipData.to === 'account' && membershipData.role === 'owner') {
        const numAccountOwners = await membership.countDocuments({
          account: user.defaultAccount._id,
          to: 'account',
          role: 'owner'
        });
        if (numAccountOwners < 2) {
          return Service.rejectResponse('Account must have at least one owner', 400);
        }
      }

      // TBD: Should we also remove defaultAccount and defaultOrg?

      // Delete member
      await membership.deleteOne({
        _id: id,
        account: user.defaultAccount._id
      });

      return Service.successResponse(null, 204);
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Create new member
   *
   * memberRequest MemberRequest  (optional)
   * returns Member
   **/
  static async membersPOST ({ memberRequest }, { user }) {
    let session;
    try {
      // Check that input parameters are OK
      const checkParams = MembersService.checkMemberParameters(memberRequest, user);
      if (checkParams.status === false) return Service.rejectResponse(checkParams.error, 400);

      // Check if user don't add itself
      if (user.email === memberRequest.email) {
        return Service.rejectResponse('You can not add yourself', 500);
      }

      // make sure user is only allow to define membership under his view
      const verified = await MembersService.checkMemberLevel(
        memberRequest.userPermissionTo,
        memberRequest.userRole,
        memberRequest.userEntity,
        user._id,
        user.defaultAccount._id
      );
      if (!verified) {
        return Service.rejectResponse(
          'No sufficient permissions for this operation', 400);
      }

      // Add user
      let registerUser = null;
      const resetPWKey = randomKey(30);

      session = await mongoConns.getMainDB().startSession();
      await session.startTransaction();

      // Create a new unverified user
      // Associate to account and current organization
      const existingUser = await Users.findOne({ username: memberRequest.email }).session(session);
      if (!existingUser) {
        registerUser = new Users({
          username: memberRequest.email,
          name: memberRequest.userFirstName,
          lastName: memberRequest.userLastName,
          email: memberRequest.email,
          jobTitle: memberRequest.userJobTitle,
          phoneNumber: '',
          admin: false,
          state: 'unverified',
          emailTokens: { verify: '', invite: '', resetPassword: resetPWKey },
          defaultAccount: user.defaultAccount._id,
          defaultOrg: memberRequest.userPermissionTo === 'organization'
            ? memberRequest.userEntity : null
          // null will try to find a valid organization on login
        });
        registerUser.validate();

        // Set random password for that user
        if (registerUser) {
          await registerUser.setPassword(randomKey(10));
        }
      }

      const registeredMember = await membership.create([{
        user: (existingUser) ? existingUser._id : registerUser._id,
        account: user.defaultAccount._id,
        group: memberRequest.userPermissionTo === 'group' ? memberRequest.userEntity : '',
        organization: memberRequest.userPermissionTo === 'organization'
          ? memberRequest.userEntity : null,
        to: memberRequest.userPermissionTo,
        role: memberRequest.userRole,
        perms: preDefinedPermissions[
          memberRequest.userPermissionTo + '_' + memberRequest.userRole
        ]
      }], { session: session });

      if (registerUser) {
        registerUser.$session(session);
        registerUser.save();
      };

      const populatedMember = await registeredMember[0]
        .populate('account')
        .populate('organization')
        .execPopulate();
      populatedMember.user = existingUser || registerUser;

      // Send email
      await mailer.sendMailHTML(
        configs.get('mailerFromAddress'),
        memberRequest.email,
        `You are invited to a ${configs.get('companyName')} Account`,
        (`<h2>${configs.get('companyName')} Account Invitation</h2>
        <b>You have been invited to a ${configs.get('companyName')}
        ${memberRequest.userPermissionTo}. </b>`) + ((registerUser)
          ? `<b>Click below to set your password</b>
        <p><a href="${configs.get('uiServerUrl')}/reset-password?id=${
          registerUser._id
        }&t=${resetPWKey}">
          <button style="color:#fff;background-color:#F99E5B;
          border-color:#F99E5B;font-weight:400;text-align:center;
          vertical-align:middle;border:1px solid transparent;
          padding:.375rem .75rem;font-size:1rem;
          line-height:1.5;border-radius:.25rem;
          cursor:pointer">Set Password</button></a></p>`
          : '<b>You can use your current account credentials to access it</b>') +
      (`<p>Your friends @ ${configs.get('companyName')}</p>`));

      await session.commitTransaction();
      session = null;

      // Send webhooks only for users invited as account owners
      // changing the user role later will not send another hook
      if (memberRequest.userPermissionTo === 'account' &&
        memberRequest.userRole === 'owner') {
        // Trigger web hook
        const webHookMessage = {
          account: user.defaultAccount.name,
          firstName: (existingUser) ? existingUser.name : memberRequest.userFirstName,
          lastName: (existingUser) ? existingUser.lastName : memberRequest.userLastName,
          email: memberRequest.email,
          country: user.defaultAccount.country,
          jobTitle: (existingUser) ? existingUser.jobTitle : memberRequest.userJobTitle,
          phoneNumber: (existingUser) ? existingUser.phoneNumber : '',
          companySize: user.defaultAccount.companySize,
          usageType: user.defaultAccount.serviceType,
          numSites: user.defaultAccount.numSites,
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
            email: memberRequest.email,
            to: memberRequest.userPermissionTo,
            role: memberRequest.userRole
          }
        });
      }
      const response = MembersService.selectMembersParams([populatedMember]);
      const response0 = response[0];
      return Service.successResponse(response0, 201);
    } catch (e) {
      if (session) session.abortTransaction();
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  static async membersOptionsTypeGET ({ type }, { user }) {
    if (type === 'account') {
      return Service.successResponse([{
        id: user.defaultAccount._id,
        value: user.defaultAccount.name
      }]);
    }

    let optionFiled = '';
    if (type === 'group') optionFiled = 'group';
    else if (type === 'organization') optionFiled = 'name';

    // TBD:
    // Show only organizations valid for user

    const account = await Accounts.find({ _id: user.defaultAccount._id }).populate('organizations');

    const uniques = {};
    account[0].organizations.forEach((org) => {
      uniques[type === 'organization' ? org._id : org[optionFiled]] =
        org[optionFiled];
    });
    const result = Object.keys(uniques).map((key) => {
      return {
        id: key,
        value: uniques[key]
      };
    });
    return Service.successResponse(result);
  }
}

module.exports = MembersService;
