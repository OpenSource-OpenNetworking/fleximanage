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

const Controller = require('./Controller');

class ApplicationsController {
  constructor (Service) {
    this.service = Service;
  }

  async applicationsLibraryGET (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationsLibraryGET);
  }

  async applicationsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationsGET);
  }

  async applicationPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationPOST);
  }

  async applicationDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationDELETE);
  }

  async applicationsConfigurationPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationsConfigurationPUT);
  }

  async applicationGET (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationGET);
  }

  async applicationsUpgradePOST (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationsUpgradePOST);
  }

  async applicationStatusGET (request, response) {
    await Controller.handleRequest(request, response, this.service.applicationStatusGET);
  }
}

module.exports = ApplicationsController;
