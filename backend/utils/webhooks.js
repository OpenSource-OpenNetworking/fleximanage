/**
 * This module sends info to web hooks
 */
const fetch = require('fetch-with-proxy').default;
const logger = require('../logging/logging')({
  module: module.filename,
  type: 'req'
});

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
     * @param  {string}         msgTitle A string describing the type of the message,
     * such as notification, user invitation, etc.
     * @return {boolean|Object}         false if send failed, response object otherwise
     */
  async sendToWebHook (url, message, secret = null, msgTitle = null) {
    // For an empty url (development), return true
    if (url === '') return Promise.resolve(true);
    let messageObject;

    // Check if the URL belongs to Slack or MS Teams
    if (url.includes('hooks.slack.com')) {
      // Format the message for Slack
      let formattedMsgForSlack = Object.keys(message).map(
        key => `${key}: ${message[key]}`).join('\n');
      if (msgTitle) {
        formattedMsgForSlack = `*${msgTitle}*\n` + formattedMsgForSlack;
      }
      messageObject = { text: formattedMsgForSlack };
    // TODO identify MS teams in a more specific way since this check is not specific enough
    } else if (url.includes('.office.com')) {
      // Format the message for MS teams
      let formattedMsgForTeams = Object.keys(message).map(
        key => `${key}: ${message[key]}`).join('<br>');
      if (msgTitle) {
        formattedMsgForTeams = `**${msgTitle}**<br>${formattedMsgForTeams}`;
      }
      messageObject = {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        summary: msgTitle || 'FlexiWAN message',
        sections: [{ text: formattedMsgForTeams }]
      };
    } else {
      if (msgTitle) {
        message = { subject: msgTitle, ...message };
      }
      messageObject = message;
    }

    messageObject = { ...messageObject, ...(secret && { secret: secret }) };
    const data = JSON.stringify(messageObject);

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
        if (response.ok) {
          // Success handling
          if (response.message === 1 || response.message.status === 'success') return true;
          return false;
        } else return false;
      })
      .catch((error) => {
        logger.error('Failed to send webhook', { params: { url, error } });
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
