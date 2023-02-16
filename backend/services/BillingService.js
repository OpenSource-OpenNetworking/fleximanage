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

const Service = require('./Service');
const flexibilling = require('../flexibilling');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class BillingService {
  /**
   * Get all Invoices
   *
   * offset Integer The number of items to skip before starting to collect the result set
   * limit Integer The numbers of items to return (optional)
   * returns List
   **/
  static async invoicesGET ({ offsetPos, limit }, { user }) {
    try {
      const customerId = user.defaultAccount.billingCustomerId;

      if (!customerId) {
        logger.error('Account does not have link to billing system', { params: {} });
        return Service.rejectResponse('Account does not have link to billing system', 500);
      }

      const invoices = await flexibilling.retrieveInvoices({
        customer_id: customerId,
        offset: offsetPos,
        limit: limit
      });

      const _invoices = invoices.list.map(value => {
        return {
          id: value.invoice.id,
          type: 'card',
          payment_method: 'card',
          amount: value.invoice.total,
          base_currency_code: value.invoice.base_currency_code,
          status: value.invoice.status,
          date: value.invoice.date
        };
      });

      for (let idx = 0; idx < _invoices.length; idx++) {
        _invoices[idx].download_url = await flexibilling.retrieveInvoiceDownloadLink({
          invoice_id: _invoices[idx].id
        });
      }

      const summary = await flexibilling.getMaxDevicesRegisteredSummmary(user.defaultAccount.id);
      const status = await flexibilling.getSubscriptionStatus({ customer_id: customerId });
      const filteredSummary = (summary) ? {
        _id: summary._id.toString(),
        current: summary.current,
        max: summary.max,
        account: summary.account.toString()
      } : null;

      return Service.successResponse({
        invoices: _invoices,
        ...invoices.next_offset && { nextOffset: invoices.next_offset },
        summary: filteredSummary,
        subscription: status
      });
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }

  /**
   * Apply a coupon
   *
   * no response value expected for this operation
   **/
  static async couponsPOST ({ couponRequest }, { user }) {
    try {
      const customerId = user.defaultAccount.billingCustomerId;
      const code = couponRequest.name;

      const result = await flexibilling.applyCoupon({ customer_id: customerId, code });

      if (result) {
        return Service.successResponse({ name: code }, 201);
      } else {
        return Service.rejectResponse('Failed to apply coupon', 400);
      }
    } catch (e) {
      return Service.rejectResponse(
        e.message || 'Internal Server Error',
        e.status || 500
      );
    }
  }
}

module.exports = BillingService;
