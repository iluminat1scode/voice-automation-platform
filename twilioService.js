// Twilio Voice Service
const twilio = require('twilio');
const logger = require('./logger');
const config = require('./config');

class TwilioService {
    constructor() {
        this.client = twilio(config.twilio.accountSid, config.twilio.authToken);
        this.phoneNumbers = config.twilio.phoneNumbers;
    }

    async makeCall(to, webhookUrl) {
        try {
            const call = await this.client.calls.create({
                url: webhookUrl,
                to: to,
                from: this.phoneNumbers[0]
            });
            logger.info(`Call initiated: ${call.sid}`);
            return call;
        } catch (error) {
            logger.error('Call failed:', error);
            throw error;
        }
    }
}

module.exports = new TwilioService();
