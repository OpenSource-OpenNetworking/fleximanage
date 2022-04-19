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

class OrganizationsController {
  constructor (Service) {
    this.service = Service;
  }

  async organizationsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsGET);
  }

  async organizationsIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsIdGET);
  }

  async organizationsIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsIdDELETE);
  }

  async organizationsIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsIdPUT);
  }

  async organizationsSummaryGET (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsSummaryGET);
  }

  async organizationsSelectPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsSelectPOST);
  }

  async organizationsPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.organizationsPOST);
  }
}

module.exports = OrganizationsController;
