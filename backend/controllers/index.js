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

const AccessTokensController = require('./AccessTokensController');
const AccountsController = require('./AccountsController');
const ConfigurationController = require('./ConfigurationController');
const DevicesController = require('./DevicesController');
const JobsController = require('./JobsController');
const MembersController = require('./MembersController');
const NotificationsController = require('./NotificationsController');
const OrganizationsController = require('./OrganizationsController');
const TokensController = require('./TokensController');
const AppIdentificationsController = require('./AppIdentificationsController');
const TunnelsController = require('./TunnelsController');
const UsersController = require('./UsersController');
const BillingController = require('./BillingController');
const PathLabelsController = require('./PathLabelsController');
const MLPoliciesController = require('./MultiLinkPoliciesController');
const ApplicationsController = require('./ApplicationsController');
const FirewallPoliciesController = require('./FirewallPoliciesController');
const QOSPoliciesController = require('./QOSPoliciesController');
const PeersController = require('./PeersController');
const VrrpController = require('./VrrpController');
const AiController = require('./AiController');

module.exports = {
  AccessTokensController,
  AccountsController,
  ConfigurationController,
  DevicesController,
  JobsController,
  MembersController,
  NotificationsController,
  OrganizationsController,
  TokensController,
  AppIdentificationsController,
  TunnelsController,
  UsersController,
  BillingController,
  PathLabelsController,
  MLPoliciesController,
  ApplicationsController,
  FirewallPoliciesController,
  QOSPoliciesController,
  PeersController,
  VrrpController,
  AiController
};
