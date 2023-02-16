/**
 * This module sends info to web hooks
 */
const fetch = require('fetch-with-proxy').default;

class WebHooks {
  constructor () {
    this.sendToWebHook = this.sendToWebHook.bind(this);
  }

  /**
     * Sends a POST request to web hooks.
     * @async
     * @param  {string}         url     url to send the message to
     * @param  {Object}         message JSON object to send in body
     * @param  {string}         secret  secret key to send in the message (secret field)
     * @return {boolean|Object}         false if send failed, response object otherwise
     */
  async sendToWebHook (url, message, secret) {
    // For an empty url (development), return true
    if (url === '') return Promise.resolve(true);

    const data = JSON.stringify({ ...message, secret: secret });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'User-Agent': 'flexiWAN webhook plugin'
    };

    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: data
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
        // console.log(JSON.stringify(response));
        if (response.ok) {
          // Success handling
          if (response.message.status === 'success') return true;
          return false;
        } else return false;
      })
      .catch((error) => {
        // General error handling
        return false;
      });
  }
}

let webHooksHandler = null;
module.exports = function (secretKey) {
  if (webHooksHandler) return webHooksHandler;
  else {
    webHooksHandler = new WebHooks();
    return webHooksHandler;
  }
};
