// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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

'use strict';

const config = require('./flexibillingconfig.json');

/**
 * flexiBillingStub class used only for development
 */
class FlexiBilling {
  async getMaxDevicesRegisteredSummmary (account) {
    return null;
  }

  async getMaxDevicesRegisteredSummmaryByAccounts (accounts) {
    return [];
  }

  async getMaxDevicesAllowed (id) {
    return config.billing.subscription.max_devices;
  }

  /**
   * Registers device
   * @param {Object} device Device object
   * @async
   */
  async registerDevice (device) {
    return true;
  }

  /**
   * Unregister device
   * @param {Object} device Device object
   */
  async unregisterDevice (device) {
    return true;
  }

  /**
   * Create customer in a billing system
   * @param {Object} options Options
   */
  async createCustomer (options) {
    return '';
  }

  /**
   * Delete customer from a billing system
   * @param {Object} options Options
   */
  async removeCustomer (options) {
    return true;
  }

  /**
   * Generates a customer self-serving portal
   * @param {Object} options Options
   * @returns URL
   * @async
   */
  async createPortalSession (options) {
    return '';
  }

  /**
   * Retrieve a list of invloices
   * @param {Object} options Options
   * @returns List of invoices
   * @async
   */
  async retrieveInvoices (options) {
    return { list: [] };
  }

  /**
   * Generate downloadable invoices in PDF format
   * @param {Object} options Options
   */
  async retrieveInvoiceDownloadLink (options) {
    return '';
  }

  /**
   * Apply coupons (discounts)
   * @param {Object} options Options
   */
  async applyCoupon (options) {
    return true;
  }

  /**
   * Return current device usage
   * @param {Object} options Options
   */
  async getCurrentUsage (options) {
    return { amount: 0, quantity: 0 };
  }

  /**
   * Validate subscription by device ID
   * @param {string} machineId Unique device ID
   */
  async validateSubscription (machineId) {
    return true;
  }

  /**
   * Get Subscription status
   * @param {Object} options Options
   */
  async getSubscriptionStatus (options) {
    return 'active';
  }

  /**
   * Singleton-like implementaion in js
   */
  static GetInstance () {
    if (!this.Instance) {
      this.Instance = new FlexiBilling();
    }
    return this.Instance;
  }

  async getBillingAccountsSummary () {
    return [];
  }

  async updateAccountOrganizations (id, organizations) {
    return null;
  }

  async getFeatureMax (account, feature, org = null) {
    return config.billing.features[feature];
  }

  async updateFeature (account, org, feature, count, orgCount) {
    return true;
  }

  async getFeaturesSummaryByAccounts (accounts) {
    return [];
  }

  async getAllSubscriptionsForQuery (query) {
    return [];
  }
}

// check if flexibilling is required
let billing;
const useFlexiBilling = require('./configs')().get('useFlexiBilling', 'boolean');

if (useFlexiBilling) {
  billing = require('./billing');
} else {
  billing = FlexiBilling.GetInstance();
}

// Conditional exports
module.exports = billing;
