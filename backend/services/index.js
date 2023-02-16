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

const AccessTokensService = require('./AccessTokensService');
const AccountsService = require('./AccountsService');
const ConfigurationService = require('./ConfigurationService');
const DevicesService = require('./DevicesService');
const JobsService = require('./JobsService');
const MembersService = require('./MembersService');
const NotificationsService = require('./NotificationsService');
const OrganizationsService = require('./OrganizationsService');
const TokensService = require('./TokensService');
const AppIdentificationsService = require('./AppIdentificationsService');
const TunnelsService = require('./TunnelsService');
const UsersService = require('./UsersService');
const BillingService = require('./BillingService');
const PathLabelsService = require('./PathLabelsService');
const MLPoliciesService = require('./MultiLinkPoliciesService');
const ApplicationsService = require('./ApplicationsService');
const FirewallPoliciesService = require('./FirewallPoliciesService');
const QOSPoliciesService = require('./QOSPoliciesService');
const PeersService = require('./PeersService');

module.exports = {
  AccessTokensService,
  AccountsService,
  ConfigurationService,
  DevicesService,
  JobsService,
  MembersService,
  NotificationsService,
  OrganizationsService,
  TokensService,
  AppIdentificationsService,
  TunnelsService,
  UsersService,
  BillingService,
  PathLabelsService,
  MLPoliciesService,
  ApplicationsService,
  FirewallPoliciesService,
  QOSPoliciesService,
  PeersService
};
