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

/**
 * This module allows to send email from the webserver
 * It users sendMail as mail server connected as SMTP
 */
const nodemailer = require('nodemailer');
const logger = require('../logging/logging')({ module: module.filename, type: 'req' });

class Mailer {
  /**
     * Initialize mailer class
     * @param {string} host               smtp hostname
     * @param {number} port               smtp port
     * @param {boolean} bypassCertificate true = bypass, false = don't bypass (default: false)
     *                                    Sometimes need to disable certificate validation for
     *                                    some anti-virus with MITM
     */
  constructor (host, port, bypassCertificate = false) {
    this.sendMailHTML = this.sendMailHTML.bind(this);

    const transportOptions = {
      service: 'local',
      host: host,
      port: port,
      logger: logger,
      debug: true
    };
    if (bypassCertificate) transportOptions.tls = { rejectUnauthorized: false };
    this.smtpTransport = nodemailer.createTransport(transportOptions);
  }

  /**
     * Sends email with html body.
     * @param  {string}  from    From user
     * @param  {string}  to      To users
     * @param  {string}  subject Subject of email
     * @param  {string}  html    HTML to embed in the mail
     * @return {Promise}
     */
  sendMailHTML (from, to, subject, html) {
    const mailOptions = {
      // Envelop is needed for adding the sender in the mail envelop
      // This fix the SPF failure as the sender is from flexiwan.com
      // DKIM is also signed per from domain as part of the SMTP server
      // This will send the mail as to <dest> from <from> via <noreply@flexiwan.com>
      // To remove the via, we need to add SPF record to the customer email and
      // use the <from> address in the envelop
      envelope: {
        from: 'flexiWAN <noreply@flexiwan.com>',
        to: to
      },
      from: from,
      to: to,
      subject: subject,
      generateTextFromHTML: true,
      html: html + `<p style='color:#bbbbbb;'>You are receiving this email because 
      you are registered on flexiWAN. 
      If you wish to delete your account on flexiWAN, 
      please open a support ticket by sending an email to
      <a href="mailto:yourfriends@flexiwan.com">yourfriends@flexiwan.com</a> and put in 
      the subject "Request to delete my account".
      The request must be sent from the email of the account owner 
      that opened the account on flexiWAN..</p>`
    };

    const p = new Promise((resolve, reject) => {
      this.smtpTransport.sendMail(mailOptions, (error, response) => {
        let success = true;
        if (error) {
          logger.error('Send mail error', { params: { mailOptions: mailOptions, error: error } });
          success = false;
        }
        this.smtpTransport.close();
        if (success) resolve();
        else reject(error);
      });
    });
    return p;
  }
}

let mailerHandler = null;
module.exports = function (host, port, bypassCertificate) {
  if (mailerHandler) return mailerHandler;
  else {
    mailerHandler = new Mailer(host, port, bypassCertificate);
    return mailerHandler;
  }
};
