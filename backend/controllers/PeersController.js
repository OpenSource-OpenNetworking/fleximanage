const Controller = require('./Controller');

class PeersController {
  constructor (Service) {
    this.service = Service;
  }

  async peersGET (request, response) {
    await Controller.handleRequest(request, response, this.service.peersGET);
  }

  async peersPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.peersPOST);
  }

  async peersIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.peersIdPUT);
  }

  async peersIdDelete (request, response) {
    await Controller.handleRequest(request, response, this.service.peersIdDelete);
  }
}

module.exports = PeersController;
