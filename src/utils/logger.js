// Advanced Logger Configuration
// Author: iluminat1scode
// Purpose: Centralized logging with multiple transports

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Custom log format
const customFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${message} ${
            Object.keys(meta).length ? JSON.stringify(meta) : ''
        }`;
    })
);

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: customFormat,
    defaultMeta: { 
        service: 'voice-automation-platform',
        version: '3.0.0'
    },
    transports: [
        // Error logs
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        // Combined logs
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true
        }),
        // Console output
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
    exitOnError: false
});

// Stream for Morgan HTTP logger
logger.stream = {
    write: (message) => {
        logger.info(message.trim());
    }
};

// Helper methods
logger.logApiCall = (method, endpoint, status, duration) => {
    logger.info('API Call', {
        method,
        endpoint,
        status,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
    });
};

logger.logTwilioEvent = (event, callSid, data) => {
    logger.info('Twilio Event', {
        event,
        callSid,
        data,
        timestamp: new Date().toISOString()
    });
};

logger.logError = (error, context) => {
    logger.error('Application Error', {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString()
    });
};

module.exports = logger;
