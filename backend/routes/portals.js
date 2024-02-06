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

const express = require('express');
const bodyParser = require('body-parser');
const { verifyPermission } = require('../authenticate');
const flexibilling = require('../flexibilling');
const createError = require('http-errors');
const router = express.Router();

router.use(bodyParser.json());

// returns a customer self-service portal session URL used for billing
router.route('/')
  .options((req, res) => { res.sendStatus(200); })
  .get(verifyPermission('billing', 'get'), async (req, res, next) => {
    const customerId = req.user.defaultAccount.billingCustomerId;
    try {
      const result = await flexibilling.createPortalSession({
        customer: {
          id: customerId
        }
      });

      if (result.error) {
        return next(createError(500, result.error));
      }

      // save portal session
      return res.status(200).json({ access_url: result.access_url });
    } catch (error) {
      console.error(error);
    }
  });

// Default exports
module.exports = router;
