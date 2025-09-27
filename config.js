// Configuration module for all services
// Author: iluminat1scode

module.exports = {
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        phoneNumbers: process.env.TWILIO_PHONE_NUMBERS?.split(',') || []
    },
    mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost/voice-platform',
        options: {
            useNewUrlParser: true,
            useUnifiedTopology: true
        }
    },
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    },
    app: {
        port: process.env.PORT || 3000,
        environment: process.env.NODE_ENV || 'development'
    }
};
