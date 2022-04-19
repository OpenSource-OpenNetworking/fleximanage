const Controller = require('./Controller');

class FirewallPoliciesController {
  constructor (Service) {
    this.service = Service;
  }

  async firewallPoliciesGET (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesGET);
  }

  async firewallPoliciesIdDELETE (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesIdDELETE);
  }

  async firewallPoliciesIdGET (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesIdGET);
  }

  async firewallPoliciesIdPUT (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesIdPUT);
  }

  async firewallPoliciesListGET (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesListGET);
  }

  async firewallPoliciesPOST (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesPOST);
  }

  async firewallPoliciesMetaGET (request, response) {
    await Controller.handleRequest(request, response, this.service.firewallPoliciesMetaGET);
  }
}

module.exports = FirewallPoliciesController;
