// Database configuration module
// Author: iluminat1scode
// Purpose: MongoDB connection handler with retry logic

const mongoose = require('mongoose');
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Database configuration class
class DatabaseConnection {
    constructor() {
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = 5;
    }

    async connect() {
        const options = {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        };

        while (this.retryCount < this.maxRetries) {
            try {
                await mongoose.connect(
                    process.env.MONGODB_URI || 'mongodb://localhost/voice-platform',
                    options
                );
                
                this.isConnected = true;
                logger.info('✅ MongoDB connected successfully');
                
                // Connection event handlers
                mongoose.connection.on('error', (err) => {
                    logger.error('MongoDB connection error:', err);
                    this.isConnected = false;
                });

                mongoose.connection.on('disconnected', () => {
                    logger.warn('MongoDB disconnected');
                    this.isConnected = false;
                });

                break;
            } catch (error) {
                this.retryCount++;
                logger.error(`MongoDB connection attempt ${this.retryCount} failed:`, error.message);
                
                if (this.retryCount >= this.maxRetries) {
                    throw new Error('Failed to connect to MongoDB after maximum retries');
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async disconnect() {
        if (this.isConnected) {
            await mongoose.connection.close();
            logger.info('MongoDB connection closed');
            this.isConnected = false;
        }
    }

    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            readyState: mongoose.connection.readyState,
            host: mongoose.connection.host,
            name: mongoose.connection.name
        };
    }
}

module.exports = new DatabaseConnection();
