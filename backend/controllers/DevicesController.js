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

class DevicesController {
  constructor (Service) {
    this.service = Service;
  }

  async devicesExecutePOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesExecutePOST);
  }

  async devicesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesGET);
  }

  async devicesApplyPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesApplyPOST);
  }

  async devicesLatestVersionsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesLatestVersionsGET);
  }

  async devicesIdUpgdSchedPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdUpgdSchedPOST);
  }

  async devicesUpgdSchedPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesUpgdSchedPOST);
  }

  async devicesIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdGET);
  }

  async devicesIdConfigurationGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdConfigurationGET);
  }

  async devicesIdLogsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdLogsGET);
  }

  async devicesIdPacketTracesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdPacketTracesGET);
  }

  async devicesIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDELETE);
  }

  async devicesDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesDELETE);
  }

  async devicesIdExecutePOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdExecutePOST);
  }

  async devicesRegisterPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesRegisterPOST);
  }

  async devicesIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdPUT);
  }

  async devicesIdApplyPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdApplyPOST);
  }

  async devicesIdRoutesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdRoutesGET);
  }

  async devicesIdTunnelsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdTunnelsGET);
  }

  async devicesIdStaticroutesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdStaticroutesGET);
  }

  async devicesIdStaticroutesRouteDELETE (request, response) {
    await Controller.handleRequest(request, response,
      this.service.devicesIdStaticroutesRouteDELETE);
  }

  async devicesIdStaticroutesPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdStaticroutesPOST);
  }

  async devicesIdStaticroutesRoutePATCH (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdStaticroutesRoutePATCH);
  }

  async devicesStatisticsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesStatisticsGET);
  }

  async devicesIdStatisticsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdStatisticsGET);
  }

  async devicesIdTunnelStatisticsGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdTunnelStatisticsGET);
  }

  async devicesIdHealthGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdHealthGET);
  }

  async devicesIdDhcpDhcpIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpDhcpIdDELETE);
  }

  async devicesIdDhcpDhcpIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpDhcpIdGET);
  }

  async devicesIdDhcpDhcpIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpDhcpIdPUT);
  }

  async devicesIdDhcpDhcpIdPATCH (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpDhcpIdPATCH);
  }

  async devicesIdDhcpGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpGET);
  }

  async devicesIdDhcpPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdDhcpPOST);
  }

  async devicesIdInterfacesIdStatusGET (request, response) {
    await Controller.handleRequest(
      request, response, this.service.devicesIdInterfacesIdStatusGET
    );
  }

  async devicesIdStatusGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdStatusGET);
  }

  async devicesIdInterfacesIdActionPOST (request, response) {
    await Controller.handleRequest(
      request, response, this.service.devicesIdInterfacesIdActionPOST
    );
  }

  async devicesIdSendPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdSendPOST);
  };

  async devicesIdRoutingOSPFGET (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdRoutingOSPFGET);
  };

  async devicesIdRoutingOSPFPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdRoutingOSPFPUT);
  };

  async devicesIdCoordsPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.devicesIdCoordsPUT);
  };
}

module.exports = DevicesController;
