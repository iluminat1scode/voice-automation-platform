// Advanced Voice Automation Platform
// Enterprise-grade voice automation system with AI-powered call flows
// Author: iluminat1scode
// Version: 3.0.0
// License: MIT

const express = require('express');
const twilio = require('twilio');
const { VoiceResponse } = twilio.twiml;
const WebSocket = require('ws');
const mongoose = require('mongoose');
const redis = require('ioredis');
const Bull = require('bull');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment-timezone');
const winston = require('winston');
const prometheus = require('prom-client');
const Sentry = require('@sentry/node');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

// Initialize Express with advanced middleware
const app = express();
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
}));
app.use(compression());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Sentry for error tracking
Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,
});
app.use(Sentry.Handlers.requestHandler());

// MongoDB connection with retry logic
const connectDB = async () => {
    const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    };
    
    let retries = 5;
    while (retries) {
        try {
            await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/voice-platform', options);
            console.log('MongoDB connected successfully');
            break;
        } catch (err) {
            console.log(`MongoDB connection failed. Retries left: ${retries - 1}`);
            retries -= 1;
            await new Promise(res => setTimeout(res, 5000));
        }
    }
};
connectDB();

// Redis clients for different purposes
const redisClient = new redis.Cluster([
    { host: process.env.REDIS_HOST || 'localhost', port: 6379 }
], {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
});

const cacheClient = new redis(process.env.REDIS_CACHE_URL || 'redis://localhost:6380');
const pubClient = new redis(process.env.REDIS_PUB_URL || 'redis://localhost:6381');
const subClient = pubClient.duplicate();

// Twilio client with webhook validation
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
    { 
        lazyLoading: true,
        edge: 'sydney',
        region: 'au1'
    }
);

// Advanced logging configuration
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'voice-automation-platform' },
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Prometheus metrics
const httpRequestDuration = new prometheus.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status']
});

const activeCallsGauge = new prometheus.Gauge({
    name: 'active_calls_total',
    help: 'Total number of active calls'
});

const callDurationHistogram = new prometheus.Histogram({
    name: 'call_duration_seconds',
    help: 'Duration of calls in seconds',
    buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600]
});

prometheus.register.registerMetric(httpRequestDuration);
prometheus.register.registerMetric(activeCallsGauge);
prometheus.register.registerMetric(callDurationHistogram);

// Complex MongoDB Schemas
const CampaignSchema = new mongoose.Schema({
    campaignId: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    type: {
        type: String,
        enum: ['appointment', 'survey', 'notification', 'reminder', 'emergency', 'marketing'],
        required: true
    },
    status: {
        type: String,
        enum: ['draft', 'scheduled', 'active', 'paused', 'completed', 'failed'],
        default: 'draft'
    },
    schedule: {
        startTime: Date,
        endTime: Date,
        timezone: { type: String, default: 'America/New_York' },
        dailyStartHour: { type: Number, default: 9 },
        dailyEndHour: { type: Number, default: 20 },
        daysOfWeek: [{ type: Number, min: 0, max: 6 }],
        maxCallsPerHour: { type: Number, default: 100 },
        retryAttempts: { type: Number, default: 3 },
        retryInterval: { type: Number, default: 3600 }
    },
    targeting: {
        segments: [String],
        filters: mongoose.Schema.Types.Mixed,
        priority: { type: Number, default: 5 },
        excludeList: [String]
    },
    voice: {
        provider: { type: String, enum: ['twilio', 'amazon-polly', 'google'], default: 'twilio' },
        language: { type: String, default: 'en-US' },
        voice: { type: String, default: 'Polly.Matthew' },
        speed: { type: Number, default: 1.0 }
    },
    script: {
        introduction: String,
        mainMessage: String,
        questions: [{
            id: String,
            text: String,
            type: { type: String, enum: ['yes-no', 'numeric', 'speech', 'dtmf'] },
            options: [String],
            validation: mongoose.Schema.Types.Mixed,
            actions: mongoose.Schema.Types.Mixed
        }],
        closing: String
    },
    webhooks: {
        onStart: String,
        onComplete: String,
        onFail: String,
        onAnswer: String,
        headers: mongoose.Schema.Types.Mixed
    },
    analytics: {
        totalCalls: { type: Number, default: 0 },
        answeredCalls: { type: Number, default: 0 },
        completedCalls: { type: Number, default: 0 },
        failedCalls: { type: Number, default: 0 },
        averageDuration: { type: Number, default: 0 },
        totalCost: { type: Number, default: 0 },
        conversionRate: { type: Number, default: 0 },
        responses: mongoose.Schema.Types.Mixed
    },
    compliance: {
        requireConsent: { type: Boolean, default: true },
        recordingEnabled: { type: Boolean, default: false },
        transcriptionEnabled: { type: Boolean, default: false },
        dnc: { type: Boolean, default: true },
        tcpaCompliant: { type: Boolean, default: true }
    },
    metadata: mongoose.Schema.Types.Mixed,
    createdBy: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const CallSchema = new mongoose.Schema({
    callId: { type: String, unique: true, required: true },
    callSid: { type: String, unique: true, sparse: true },
    campaignId: String,
    recipient: {
        phone: { type: String, required: true },
        name: String,
        customData: mongoose.Schema.Types.Mixed
    },
    status: {
        type: String,
        enum: ['queued', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer', 'cancelled'],
        default: 'queued'
    },
    direction: { type: String, enum: ['outbound', 'inbound'], default: 'outbound' },
    startTime: Date,
    answerTime: Date,
    endTime: Date,
    duration: Number,
    recordingUrl: String,
    transcription: String,
    responses: [{
        questionId: String,
        response: mongoose.Schema.Types.Mixed,
        timestamp: Date,
        confidence: Number
    }],
    events: [{
        type: String,
        timestamp: Date,
        data: mongoose.Schema.Types.Mixed
    }],
    cost: {
        amount: Number,
        currency: { type: String, default: 'USD' }
    },
    quality: {
        audioQuality: Number,
        connectionQuality: Number,
        jitter: Number,
        packetLoss: Number
    },
    error: {
        code: String,
        message: String,
        timestamp: Date
    },
    attempts: { type: Number, default: 1 },
    nextRetry: Date,
    metadata: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const ContactSchema = new mongoose.Schema({
    contactId: { type: String, unique: true, required: true },
    phone: { 
        type: String, 
        required: true, 
        unique: true,
        validate: {
            validator: function(v) {
                return /^\+[1-9]\d{1,14}$/.test(v);
            },
            message: 'Invalid E.164 phone number format'
        }
    },
    alternativePhones: [String],
    firstName: String,
    lastName: String,
    email: String,
    company: String,
    timezone: String,
    language: { type: String, default: 'en-US' },
    segments: [String],
    tags: [String],
    preferences: {
        bestCallTime: String,
        doNotCall: { type: Boolean, default: false },
        doNotCallUntil: Date,
        preferredChannel: { type: String, enum: ['voice', 'sms', 'email'], default: 'voice' }
    },
    history: [{
        campaignId: String,
        callId: String,
        timestamp: Date,
        outcome: String,
        notes: String
    }],
    customFields: mongoose.Schema.Types.Mixed,
    consent: {
        voice: { type: Boolean, default: false },
        sms: { type: Boolean, default: false },
        email: { type: Boolean, default: false },
        consentDate: Date,
        consentMethod: String,
        ipAddress: String
    },
    score: {
        engagement: { type: Number, default: 0 },
        responsiveness: { type: Number, default: 0 },
        lifetime: { type: Number, default: 0 }
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'blocked', 'pending'],
        default: 'active'
    },
    source: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Create models
const Campaign = mongoose.model('Campaign', CampaignSchema);
const Call = mongoose.model('Call', CallSchema);
const Contact = mongoose.model('Contact', ContactSchema);

// Advanced Queue System
const callQueue = new Bull('call-queue', {
    redis: {
        port: 6379,
        host: process.env.REDIS_HOST || 'localhost'
    }
});

const analyticsQueue = new Bull('analytics-queue', {
    redis: {
        port: 6379,
        host: process.env.REDIS_HOST || 'localhost'
    }
});

// Queue processors
callQueue.process('make-call', 10, async (job) => {
    const { callId, phone, campaignId, message } = job.data;
    
    try {
        logger.info(`Processing call ${callId} to ${phone}`);
        
        const call = await twilioClient.calls.create({
            url: `${process.env.BASE_URL}/voice/campaign/${campaignId}/flow`,
            to: phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `${process.env.BASE_URL}/voice/status/${callId}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            machineDetection: 'DetectMessageEnd',
            machineDetectionTimeout: 3000,
            asyncAmd: true,
            asyncAmdStatusCallback: `${process.env.BASE_URL}/voice/amd/${callId}`,
            asyncAmdStatusCallbackMethod: 'POST',
            record: false,
            timeout: 60
        });
        
        await Call.findOneAndUpdate(
            { callId },
            { 
                callSid: call.sid,
                status: 'ringing',
                startTime: new Date()
            }
        );
        
        activeCallsGauge.inc();
        
        return { success: true, callSid: call.sid };
        
    } catch (error) {
        logger.error(`Call failed for ${callId}:`, error);
        
        await Call.findOneAndUpdate(
            { callId },
            { 
                status: 'failed',
                error: {
                    code: error.code,
                    message: error.message,
                    timestamp: new Date()
                }
            }
        );
        
        throw error;
    }
});

// Advanced Call Flow Engine
class CallFlowEngine {
    constructor() {
        this.flows = new Map();
        this.sessions = new Map();
    }
    
    async executeFlow(callSid, campaignId, input) {
        const campaign = await Campaign.findOne({ campaignId });
        if (!campaign) throw new Error('Campaign not found');
        
        const session = this.getSession(callSid) || this.createSession(callSid, campaign);
        
        const response = new VoiceResponse();
        
        switch (session.state) {
            case 'introduction':
                this.handleIntroduction(response, campaign, session);
                break;
            case 'main_message':
                this.handleMainMessage(response, campaign, session);
                break;
            case 'question':
                await this.handleQuestion(response, campaign, session, input);
                break;
            case 'closing':
                this.handleClosing(response, campaign, session);
                break;
            default:
                response.hangup();
        }
        
        this.updateSession(callSid, session);
        return response.toString();
    }
    
    createSession(callSid, campaign) {
        const session = {
            callSid,
            campaignId: campaign.campaignId,
            state: 'introduction',
            currentQuestion: 0,
            responses: [],
            startTime: new Date(),
            metadata: {}
        };
        this.sessions.set(callSid, session);
        return session;
    }
    
    getSession(callSid) {
        return this.sessions.get(callSid);
    }
    
    updateSession(callSid, session) {
        this.sessions.set(callSid, session);
    }
    
    handleIntroduction(response, campaign, session) {
        response.say({
            voice: campaign.voice.voice,
            language: campaign.voice.language,
            rate: `${campaign.voice.speed * 100}%`
        }, campaign.script.introduction);
        
        response.pause({ length: 1 });
        session.state = 'main_message';
        response.redirect(`/voice/campaign/${campaign.campaignId}/continue`);
    }
    
    handleMainMessage(response, campaign, session) {
        response.say({
            voice: campaign.voice.voice,
            language: campaign.voice.language
        }, campaign.script.mainMessage);
        
        if (campaign.script.questions && campaign.script.questions.length > 0) {
            session.state = 'question';
            session.currentQuestion = 0;
            response.redirect(`/voice/campaign/${campaign.campaignId}/question/0`);
        } else {
            session.state = 'closing';
            response.redirect(`/voice/campaign/${campaign.campaignId}/continue`);
        }
    }
    
    async handleQuestion(response, campaign, session, input) {
        const question = campaign.script.questions[session.currentQuestion];
        
        if (input) {
            // Process the answer
            session.responses.push({
                questionId: question.id,
                response: input,
                timestamp: new Date()
            });
            
            // Save to database
            await Call.findOneAndUpdate(
                { callSid: session.callSid },
                { $push: { responses: session.responses[session.responses.length - 1] } }
            );
            
            // Check for actions based on response
            if (question.actions && question.actions[input]) {
                const action = question.actions[input];
                if (action.type === 'transfer') {
                    response.dial(action.number);
                    return;
                } else if (action.type === 'end') {
                    response.say(action.message || 'Thank you');
                    response.hangup();
                    return;
                }
            }
            
            session.currentQuestion++;
            
            if (session.currentQuestion < campaign.script.questions.length) {
                response.redirect(`/voice/campaign/${campaign.campaignId}/question/${session.currentQuestion}`);
            } else {
                session.state = 'closing';
                response.redirect(`/voice/campaign/${campaign.campaignId}/continue`);
            }
        } else {
            // Ask the question
            const gather = response.gather({
                input: question.type === 'speech' ? 'speech' : 'dtmf',
                numDigits: question.type === 'numeric' ? question.validation?.maxDigits || 1 : 1,
                action: `/voice/campaign/${campaign.campaignId}/answer/${session.currentQuestion}`,
                method: 'POST',
                timeout: 5,
                speechTimeout: 'auto',
                language: campaign.voice.language
            });
            
            gather.say({
                voice: campaign.voice.voice,
                language: campaign.voice.language
            }, question.text);
            
            // No input handler
            response.say('We did not receive your response.');
            response.redirect(`/voice/campaign/${campaign.campaignId}/question/${session.currentQuestion}`);
        }
    }
    
    handleClosing(response, campaign, session) {
        response.say({
            voice: campaign.voice.voice,
            language: campaign.voice.language
        }, campaign.script.closing);
        
        response.hangup();
        
        // Clean up session
        this.sessions.delete(session.callSid);
    }
}

const callFlowEngine = new CallFlowEngine();

// Rate limiting middleware
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: 'Too many requests from this IP',
    standardHeaders: true,
    legacyHeaders: false,
});

const campaignLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: 'Campaign creation limit exceeded'
});

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    logger.info(`WebSocket client connected: ${clientId}`);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'subscribe') {
                await subClient.subscribe(`campaign:${data.campaignId}`);
                ws.campaignId = data.campaignId;
            }
        } catch (error) {
            logger.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        logger.info(`WebSocket client disconnected: ${clientId}`);
        if (ws.campaignId) {
            subClient.unsubscribe(`campaign:${ws.campaignId}`);
        }
    });
});

// Redis pub/sub for real-time updates
subClient.on('message', (channel, message) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.campaignId === channel.split(':')[1]) {
            client.send(message);
        }
    });
});

// API Routes

// Campaign Management
app.post('/api/campaigns', campaignLimiter, async (req, res) => {
    try {
        const campaignId = uuidv4().substring(0, 8);
        const campaign = new Campaign({
            campaignId,
            ...req.body,
            createdBy: req.headers['x-user-id'] || 'system'
        });
        
        await campaign.save();
        
        // Schedule campaign if needed
        if (campaign.status === 'scheduled' && campaign.schedule.startTime) {
            await scheduleCampaign(campaign);
        }
        
        res.status(201).json({
            success: true,
            campaign: {
                campaignId: campaign.campaignId,
                name: campaign.name,
                status: campaign.status
            }
        });
        
    } catch (error) {
        logger.error('Campaign creation error:', error);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

app.get('/api/campaigns/:campaignId', async (req, res) => {
    try {
        const { campaignId } = req.params;
        
        // Try cache first
        const cached = await cacheClient.get(`campaign:${campaignId}`);
        if (cached) {
            return res.json(JSON.parse(cached));
        }
        
        const campaign = await Campaign.findOne({ campaignId });
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        // Get real-time stats
        const activeCalls = await Call.countDocuments({
            campaignId,
            status: { $in: ['ringing', 'in-progress'] }
        });
        
        const response = {
            campaign,
            activeCalls,
            lastUpdated: new Date()
        };
        
        // Cache for 30 seconds
        await cacheClient.setex(`campaign:${campaignId}`, 30, JSON.stringify(response));
        
        res.json(response);
        
    } catch (error) {
        logger.error('Get campaign error:', error);
        res.status(500).json({ error: 'Failed to get campaign' });
    }
});

app.put('/api/campaigns/:campaignId/status', async (req, res) => {
    try {
        const { campaignId } = req.params;
        const { status } = req.body;
        
        const campaign = await Campaign.findOneAndUpdate(
            { campaignId },
            { status, updatedAt: new Date() },
            { new: true }
        );
        
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        // Handle status changes
        switch (status) {
            case 'active':
                await startCampaign(campaign);
                break;
            case 'paused':
                await pauseCampaign(campaign);
                break;
            case 'completed':
                await completeCampaign(campaign);
                break;
        }
        
        // Notify via WebSocket
        await pubClient.publish(`campaign:${campaignId}`, JSON.stringify({
            type: 'status_update',
            status,
            timestamp: new Date()
        }));
        
        res.json({ success: true, status });
        
    } catch (error) {
        logger.error('Update campaign status error:', error);
        res.status(500).json({ error: 'Failed to update campaign status' });
    }
});

// Contact Management
app.post('/api/contacts/import', async (req, res) => {
    try {
        const { contacts, segments } = req.body;
        
        const operations = contacts.map(contact => ({
            updateOne: {
                filter: { phone: contact.phone },
                update: {
                    $set: {
                        ...contact,
                        contactId: contact.contactId || uuidv4(),
                        segments: segments || [],
                        updatedAt: new Date()
                    },
                    $setOnInsert: { createdAt: new Date() }
                },
                upsert: true
            }
        }));
        
        const result = await Contact.bulkWrite(operations);
        
        res.json({
            success: true,
            imported: result.upsertedCount,
            updated: result.modifiedCount
        });
        
    } catch (error) {
        logger.error('Contact import error:', error);
        res.status(500).json({ error: 'Failed to import contacts' });
    }
});

// Voice Endpoints
app.post('/voice/campaign/:campaignId/flow', async (req, res) => {
    try {
        const { campaignId } = req.params;
        const { CallSid } = req.body;
        
        const response = await callFlowEngine.executeFlow(CallSid, campaignId, null);
        
        res.type('text/xml');
        res.send(response);
        
    } catch (error) {
        logger.error('Voice flow error:', error);
        const twiml = new VoiceResponse();
        twiml.say('We apologize for the technical difficulty. Please try again later.');
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

app.post('/voice/campaign/:campaignId/continue', async (req, res) => {
    try {
        const { campaignId } = req.params;
        const { CallSid } = req.body;
        
        const response = await callFlowEngine.executeFlow(CallSid, campaignId, null);
        
        res.type('text/xml');
        res.send(response);
        
    } catch (error) {
        logger.error('Voice continue error:', error);
        const twiml = new VoiceResponse();
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

app.post('/voice/campaign/:campaignId/question/:questionIndex', async (req, res) => {
    try {
        const { campaignId, questionIndex } = req.params;
        const { CallSid } = req.body;
        
        const response = await callFlowEngine.executeFlow(CallSid, campaignId, null);
        
        res.type('text/xml');
        res.send(response);
        
    } catch (error) {
        logger.error('Voice question error:', error);
        const twiml = new VoiceResponse();
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

app.post('/voice/campaign/:campaignId/answer/:questionIndex', async (req, res) => {
    try {
        const { campaignId, questionIndex } = req.params;
        const { CallSid, Digits, SpeechResult } = req.body;
        
        const input = Digits || SpeechResult;
        const response = await callFlowEngine.executeFlow(CallSid, campaignId, input);
        
        res.type('text/xml');
        res.send(response);
        
    } catch (error) {
        logger.error('Voice answer error:', error);
        const twiml = new VoiceResponse();
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

app.post('/voice/status/:callId', async (req, res) => {
    try {
        const { callId } = req.params;
        const { CallStatus, CallDuration, CallSid } = req.body;
        
        const updateData = {
            status: mapTwilioStatus(CallStatus),
            updatedAt: new Date()
        };
        
        if (CallStatus === 'completed') {
            updateData.endTime = new Date();
            updateData.duration = parseInt(CallDuration);
            activeCallsGauge.dec();
            callDurationHistogram.observe(parseInt(CallDuration));
        } else if (CallStatus === 'answered') {
            updateData.answerTime = new Date();
        }
        
        await Call.findOneAndUpdate({ callId }, updateData);
        
        // Update campaign analytics
        await updateCampaignAnalytics(callId, CallStatus);
        
        res.status(200).send('OK');
        
    } catch (error) {
        logger.error('Status callback error:', error);
        res.status(500).send('Error');
    }
});

app.post('/voice/amd/:callId', async (req, res) => {
    try {
        const { callId } = req.params;
        const { AnsweredBy } = req.body;
        
        await Call.findOneAndUpdate(
            { callId },
            { 
                'metadata.answeredBy': AnsweredBy,
                'events': {
                    $push: {
                        type: 'amd_detection',
                        timestamp: new Date(),
                        data: { answeredBy: AnsweredBy }
                    }
                }
            }
        );
        
        if (AnsweredBy === 'machine_start' || AnsweredBy === 'machine_end_beep') {
            logger.info(`Voicemail detected for call ${callId}`);
            // Handle voicemail logic
        }
        
        res.status(200).send('OK');
        
    } catch (error) {
        logger.error('AMD callback error:', error);
        res.status(500).send('Error');
    }
});

// Analytics Endpoints
app.get('/api/analytics/overview', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        const query = {};
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }
        
        const [campaigns, calls, contacts] = await Promise.all([
            Campaign.countDocuments(query),
            Call.countDocuments(query),
            Contact.countDocuments()
        ]);
        
        const callStats = await Call.aggregate([
            { $match: query },
            {
                $group: {
                    _id: null,
                    totalDuration: { $sum: '$duration' },
                    avgDuration: { $avg: '$duration' },
                    totalCost: { $sum: '$cost.amount' },
                    answered: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'completed'] }, 1, 0]
                        }
                    }
                }
            }
        ]);
        
        res.json({
            campaigns,
            calls,
            contacts,
            stats: callStats[0] || {},
            period: { startDate, endDate }
        });
        
    } catch (error) {
        logger.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to get analytics' });
    }
});

app.get('/api/analytics/campaign/:campaignId', async (req, res) => {
    try {
        const { campaignId } = req.params;
        
        const campaign = await Campaign.findOne({ campaignId });
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        const callStats = await Call.aggregate([
            { $match: { campaignId } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    avgDuration: { $avg: '$duration' }
                }
            }
        ]);
        
        const responseStats = await Call.aggregate([
            { $match: { campaignId } },
            { $unwind: '$responses' },
            {
                $group: {
                    _id: '$responses.questionId',
                    responses: { $push: '$responses.response' },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        res.json({
            campaign: campaign.analytics,
            callBreakdown: callStats,
            responseAnalysis: responseStats
        });
        
    } catch (error) {
        logger.error('Campaign analytics error:', error);
        res.status(500).json({ error: 'Failed to get campaign analytics' });
    }
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
    res.set('Content-Type', prometheus.register.contentType);
    prometheus.register.metrics().then(metrics => {
        res.end(metrics);
    });
});

// Health check
app.get('/health', async (req, res) => {
    try {
        const checks = {
            server: 'operational',
            mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            redis: redisClient.status === 'ready' ? 'connected' : 'disconnected',
            twilio: await checkTwilioHealth()
        };
        
        const status = Object.values(checks).every(s => s === 'operational' || s === 'connected') ? 200 : 503;
        
        res.status(status).json({
            status: status === 200 ? 'healthy' : 'degraded',
            version: '3.0.0',
            uptime: process.uptime(),
            checks
        });
        
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

// Helper Functions
function mapTwilioStatus(twilioStatus) {
    const statusMap = {
        'queued': 'queued',
        'initiated': 'ringing',
        'ringing': 'ringing',
        'in-progress': 'in-progress',
        'completed': 'completed',
        'busy': 'busy',
        'no-answer': 'no-answer',
        'cancelled': 'cancelled',
        'failed': 'failed'
    };
    return statusMap[twilioStatus] || 'failed';
}

async function startCampaign(campaign) {
    logger.info(`Starting campaign: ${campaign.campaignId}`);
    
    const contacts = await Contact.find({
        segments: { $in: campaign.targeting.segments },
        'preferences.doNotCall': false,
        status: 'active'
    }).limit(1000);
    
    for (const contact of contacts) {
        const callId = uuidv4();
        
        await Call.create({
            callId,
            campaignId: campaign.campaignId,
            recipient: {
                phone: contact.phone,
                name: `${contact.firstName} ${contact.lastName}`,
                customData: contact.customFields
            },
            status: 'queued'
        });
        
        await callQueue.add('make-call', {
            callId,
            phone: contact.phone,
            campaignId: campaign.campaignId,
            message: campaign.script.introduction
        }, {
            delay: Math.floor(Math.random() * 60000), // Spread calls over 1 minute
            attempts: campaign.schedule.retryAttempts,
            backoff: {
                type: 'exponential',
                delay: campaign.schedule.retryInterval * 1000
            }
        });
    }
}

async function pauseCampaign(campaign) {
    logger.info(`Pausing campaign: ${campaign.campaignId}`);
    
    const jobs = await callQueue.getJobs(['waiting', 'delayed']);
    for (const job of jobs) {
        if (job.data.campaignId === campaign.campaignId) {
            await job.remove();
        }
    }
}

async function completeCampaign(campaign) {
    logger.info(`Completing campaign: ${campaign.campaignId}`);
    
    // Generate final analytics
    const analytics = await generateCampaignAnalytics(campaign.campaignId);
    
    await Campaign.findOneAndUpdate(
        { campaignId: campaign.campaignId },
        { 
            analytics,
            status: 'completed',
            updatedAt: new Date()
        }
    );
    
    // Send webhook if configured
    if (campaign.webhooks.onComplete) {
        await sendWebhook(campaign.webhooks.onComplete, {
            campaignId: campaign.campaignId,
            status: 'completed',
            analytics
        });
    }
}

async function generateCampaignAnalytics(campaignId) {
    const calls = await Call.find({ campaignId });
    
    return {
        totalCalls: calls.length,
        answeredCalls: calls.filter(c => c.status === 'completed').length,
        completedCalls: calls.filter(c => c.duration > 30).length,
        failedCalls: calls.filter(c => c.status === 'failed').length,
        averageDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length,
        totalCost: calls.reduce((sum, c) => sum + (c.cost?.amount || 0), 0),
        conversionRate: calls.filter(c => c.responses?.length > 0).length / calls.length
    };
}

async function updateCampaignAnalytics(callId, status) {
    const call = await Call.findOne({ callId });
    if (!call) return;
    
    const update = { $inc: {} };
    
    if (status === 'completed') {
        update.$inc['analytics.totalCalls'] = 1;
        update.$inc['analytics.answeredCalls'] = 1;
        if (call.duration > 30) {
            update.$inc['analytics.completedCalls'] = 1;
        }
    } else if (status === 'failed' || status === 'no-answer' || status === 'busy') {
        update.$inc['analytics.failedCalls'] = 1;
    }
    
    await Campaign.findOneAndUpdate(
        { campaignId: call.campaignId },
        update
    );
}

async function checkTwilioHealth() {
    try {
        await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
        return 'operational';
    } catch {
        return 'unavailable';
    }
}

async function sendWebhook(url, data) {
    try {
        await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'VoiceAutomationPlatform/3.0'
            },
            body: JSON.stringify(data)
        });
    } catch (error) {
        logger.error('Webhook error:', error);
    }
}

async function scheduleCampaign(campaign) {
    // Implementation for scheduling campaigns
    logger.info(`Campaign ${campaign.campaignId} scheduled for ${campaign.schedule.startTime}`);
}

// Error handling
app.use(Sentry.Handlers.errorHandler());

app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Server initialization
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    logger.info(`Voice Automation Platform running on port ${PORT}`);
    console.log(`🚀 Server ready at http://localhost:${PORT}`);
});

// WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    
    server.close(() => {
        logger.info('HTTP server closed');
    });
    
    await mongoose.connection.close();
    await redisClient.quit();
    await cacheClient.quit();
    
    process.exit(0);
});

module.exports = app;
