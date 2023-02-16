const Controller = require('./Controller');

class QOSPoliciesController {
  constructor (Service) {
    this.service = Service;
  }

  async qosPoliciesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesGET);
  }

  async qosPoliciesIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesIdDELETE);
  }

  async qosPoliciesIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesIdGET);
  }

  async qosPoliciesIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesIdPUT);
  }

  async qosPoliciesListGET (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesListGET);
  }

  async qosPoliciesPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesPOST);
  }

  async qosPoliciesMetaGET (request, response) {
    await Controller.handleRequest(request, response, this.service.qosPoliciesMetaGET);
  }

  async qosTrafficMapGET (request, response) {
    await Controller.handleRequest(request, response, this.service.qosTrafficMapGET);
  }

  async qosTrafficMapPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.qosTrafficMapPUT);
  }
}

module.exports = QOSPoliciesController;
