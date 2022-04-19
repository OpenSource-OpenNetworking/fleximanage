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

  async appstoreGET (request, response) {
    await Controller.handleRequest(request, response, this.service.appstoreGET);
  }

  async appstorePurchasedGET (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedGET);
  }

  async appstorePurchaseIdPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchaseIdPOST);
  }

  async appstorePurchasedIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedIdDELETE);
  }

  async appstorePurchasedIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedIdPUT);
  }

  async appstorePurchasedIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedIdGET);
  }

  async appstorePurchasedIdUpgradePost (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedIdUpgradePost);
  }

  async appstorePurchasedIdStatusGet (request, response) {
    await Controller.handleRequest(request, response, this.service.appstorePurchasedIdStatusGet);
  }
}

module.exports = ApplicationsController;
