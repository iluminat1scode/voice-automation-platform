// Twilio Voice Service Layer
// Author: iluminat1scode
// Purpose: Centralized Twilio operations management

const twilio = require('twilio');
const logger = require('../utils/logger');

class TwilioVoiceService {
    constructor() {
        this.client = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN,
            {
                lazyLoading: true,
                edge: process.env.TWILIO_EDGE || 'sydney',
                region: process.env.TWILIO_REGION || 'au1'
            }
        );
        
        this.phoneNumbers = process.env.TWILIO_PHONE_NUMBERS?.split(',') || [];
        this.currentNumberIndex = 0;
    }

    // Get next phone number (round-robin load balancing)
    getNextPhoneNumber() {
        const number = this.phoneNumbers[this.currentNumberIndex];
        this.currentNumberIndex = (this.currentNumberIndex + 1) % this.phoneNumbers.length;
        return number || process.env.TWILIO_PHONE_NUMBER;
    }

    // Make outbound call
    async makeCall(to, campaignId, callId) {
        try {
            const fromNumber = this.getNextPhoneNumber();
            
            const call = await this.client.calls.create({
                url: `${process.env.BASE_URL}/voice/campaign/${campaignId}/flow`,
                to: to,
                from: fromNumber,
                statusCallback: `${process.env.BASE_URL}/voice/status/${callId}`,
                statusCallbackMethod: 'POST',
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                machineDetection: 'DetectMessageEnd',
                machineDetectionTimeout: 3000,
                asyncAmd: true,
                asyncAmdStatusCallback: `${process.env.BASE_URL}/voice/amd/${callId}`,
                asyncAmdStatusCallbackMethod: 'POST',
                timeout: 60,
                record: process.env.RECORDING_ENABLED === 'true',
                trim: 'trim-silence'
            });

            logger.logTwilioEvent('CALL_INITIATED', call.sid, {
                to,
                from: fromNumber,
                campaignId
            });

            return {
                success: true,
                callSid: call.sid,
                status: call.status,
                direction: call.direction,
                fromNumber
            };
            
        } catch (error) {
            logger.logError(error, {
                operation: 'makeCall',
                to,
                campaignId
            });
            
            throw {
                code: error.code || 'UNKNOWN_ERROR',
                message: error.message,
                moreInfo: error.moreInfo
            };
        }
    }

    // Get call details
    async getCallDetails(callSid) {
        try {
            const call = await this.client.calls(callSid).fetch();
            return {
                sid: call.sid,
                status: call.status,
                direction: call.direction,
                duration: call.duration,
                price: call.price,
                priceUnit: call.priceUnit,
                from: call.from,
                to: call.to,
                startTime: call.startTime,
                endTime: call.endTime
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'getCallDetails',
                callSid
            });
            throw error;
        }
    }

    // Update call (hold, mute, etc.)
    async updateCall(callSid, options) {
        try {
            const call = await this.client.calls(callSid).update(options);
            
            logger.logTwilioEvent('CALL_UPDATED', callSid, options);
            
            return {
                success: true,
                status: call.status
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'updateCall',
                callSid,
                options
            });
            throw error;
        }
    }

    // End call
    async endCall(callSid) {
        return this.updateCall(callSid, { status: 'completed' });
    }

    // Get recordings for a call
    async getRecordings(callSid) {
        try {
            const recordings = await this.client.recordings.list({
                callSid: callSid,
                limit: 20
            });

            return recordings.map(rec => ({
                sid: rec.sid,
                duration: rec.duration,
                url: `https://api.twilio.com${rec.uri.replace('.json', '.mp3')}`,
                dateCreated: rec.dateCreated,
                status: rec.status
            }));
        } catch (error) {
            logger.logError(error, {
                operation: 'getRecordings',
                callSid
            });
            throw error;
        }
    }

    // Validate webhook signature
    validateWebhookSignature(authToken, twilioSignature, url, params) {
        return twilio.validateRequest(
            authToken,
            twilioSignature,
            url,
            params
        );
    }

    // Get account usage
    async getAccountUsage(startDate, endDate) {
        try {
            const usage = await this.client.usage.records.list({
                category: 'calls',
                startDate,
                endDate
            });

            return usage.map(record => ({
                category: record.category,
                description: record.description,
                usage: record.usage,
                usageUnit: record.usageUnit,
                price: record.price,
                priceUnit: record.priceUnit,
                count: record.count,
                countUnit: record.countUnit
            }));
        } catch (error) {
            logger.logError(error, {
                operation: 'getAccountUsage',
                startDate,
                endDate
            });
            throw error;
        }
    }

    // Check service health
    async checkHealth() {
        try {
            const account = await this.client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
            return {
                status: 'operational',
                accountStatus: account.status,
                accountName: account.friendlyName,
                dateCreated: account.dateCreated
            };
        } catch (error) {
            logger.logError(error, { operation: 'checkHealth' });
            return {
                status: 'unavailable',
                error: error.message
            };
        }
    }
}

module.exports = new TwilioVoiceService();
