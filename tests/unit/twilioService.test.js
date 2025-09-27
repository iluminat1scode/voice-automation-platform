// Unit Tests for Twilio Service
// Author: iluminat1scode

const twilioService = require('../../src/services/twilioService');

describe('Twilio Voice Service', () => {
    test('should initialize correctly', () => {
        expect(twilioService).toBeDefined();
        expect(twilioService.client).toBeDefined();
    });

    test('should rotate phone numbers', () => {
        const number1 = twilioService.getNextPhoneNumber();
        const number2 = twilioService.getNextPhoneNumber();
        expect(number1).toBeDefined();
        expect(number2).toBeDefined();
    });

    test('should validate webhook signatures', () => {
        const result = twilioService.validateWebhookSignature(
            'test-token',
            'test-signature', 
            'https://test.com',
            {}
        );
        expect(typeof result).toBe('boolean');
    });
});
