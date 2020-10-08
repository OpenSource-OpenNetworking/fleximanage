/**
 * This module verifies google recaptcha
 */
const fetch = require('fetch-with-proxy').default;
const verifyURL = 'https://www.google.com/recaptcha/api/siteverify';

class ReCaptcha {
  constructor (secretKey) {
    this.verifyReCaptcha = this.verifyReCaptcha.bind(this);
    this.secretKey = secretKey;
  }

  /**
     * Verifies a captcha.
     * @async
     * @param  {string}         token captcha to verify
     * @return {boolean|Object}       false if verification failed, verification result otherwise
     */
  async verifyReCaptcha (token) {
    // For an empty key (development), return true
    if (this.secretKey === '') return Promise.resolve(true);

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'flexiWAN reCapcha checker'
    };
    const params = { secret: this.secretKey, response: token };
    const encodedParams = Object.keys(params).map((key) => {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }).join('&');

    return fetch(verifyURL, {
      method: 'POST',
      headers: headers,
      body: encodedParams
    })
      .then(response => {
        return response.json()
          .then(json => {
            response.message = json;
            return response;
          },
          error => {
            throw error;
          });
      },
      error => {
        throw error;
      })
      .then(response => {
        if (response.ok) {
          // Success handling
          if (response.message.success === true) return true;
          return false;
        } else return false;
      })
      .catch((error) => {
        // General error handling
        return false;
      });
  }
}

let reCaptchaHandler = null;
module.exports = function (secretKey) {
  if (reCaptchaHandler) return reCaptchaHandler;
  else {
    reCaptchaHandler = new ReCaptcha(secretKey);
    return reCaptchaHandler;
  }
};
