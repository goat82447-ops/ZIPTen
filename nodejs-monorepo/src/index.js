const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load environment
dotenv.config();

const port = Number(process.env.PORT || 3000);
const authOnlyMode = String(process.env.AUTH_ONLY_MODE || '0') === '1';
const mongoUri = process.env.MONGODB_URI;
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const otpDebugMode = process.env.OTP_DEBUG_MODE === '1';

// Validate required env vars
if (!mongoUri) {
  console.error('ERROR: MONGODB_URI environment variable is not set');
  process.exit(1);
}

// ============================================================================
// SERVICES SETUP
// ============================================================================

// Email Services
const sendgridApiKey = process.env.SENDGRID_API_KEY || '';
const sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || '';
const gmailUser = process.env.GMAIL_USER || '';
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || '';
const gmailFromEmail = process.env.GMAIL_FROM_EMAIL || gmailUser;

// SMS Service
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER || '';

// APIs
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
const openWeatherApiKey = process.env.OPENWEATHER_API_KEY || '';

let twilioClient = null;
let gmailTransporter = null;

if (sendgridApiKey) {
  sgMail.setApiKey(sendgridApiKey);
}

if (twilioAccountSid && twilioAuthToken) {
  twilioClient = twilio(twilioAccountSid, twilioAuthToken);
}

if (gmailUser && gmailAppPassword) {
  gmailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailAppPassword
    }
  });
}

// Redis for job queue
let redisConnection = null;
let orderQueue = null;

if (!authOnlyMode) {
  redisConnection = new IORedis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null
  });
  orderQueue = new Queue('order-fulfillment', { connection: redisConnection });
}

// ============================================================================
// DATABASE MODELS
// ============================================================================

const userSchema = new mongoose.Schema({
  _id: String,
  username: String,
  password: String,
  email: String,
  mobile: String,
  role: String,
  customer_otp_completed: Number,
  captain_vehicle: String,
  profile_image: String,
  created_at: String,
  updated_at: String
});

const otpCodeSchema = new mongoose.Schema({
  _id: String,
  session_token: String,
  channel: String,
  code: String,
  consumed: Number,
  created_at: String,
  expires_at: String
});

const authSessionSchema = new mongoose.Schema({
  token: String,
  user_id: String,
  username: String,
  role: String,
  mfa_verified: Number,
  voice_verified: Number,
  created_at: String,
  expires_at: String
});

const User = mongoose.model('User', userSchema);
const OtpCode = mongoose.model('OtpCode', otpCodeSchema);
const AuthSession = mongoose.model('AuthSession', authSessionSchema);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function nowIso() {
  return new Date().toISOString();
}

function genOtp() {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}

async function seedDatabase() {
  const existing = await User.findOne({ username: 'user' });
  if (!existing) {
    const hashedPassword = await bcrypt.hash('user123', 10);
    await User.create({
      _id: uuidv4(),
      username: 'user',
      password: hashedPassword,
      email: 'user@ekart.local',
      mobile: '9876543210',
      role: 'customer',
      customer_otp_completed: 1,
      created_at: nowIso(),
      updated_at: nowIso()
    });
    console.log('Seeded default user: user / user123');
  }
}

async function issueSessionToken(userId) {
  const token = uuidv4();
  const user = await User.findById(userId);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  
  await AuthSession.create({
    token,
    user_id: userId,
    username: user.username,
    role: user.role,
    mfa_verified: 0,
    voice_verified: 0,
    created_at: nowIso(),
    expires_at: expiresAt
  });
  
  return token;
}

async function getSession(token) {
  return AuthSession.findOne({ token, expires_at: { $gt: nowIso() } });
}

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const app = express();

const allowedOrigins = [
  'http://localhost:4200',
  'https://enterprise-lunchbox-lms-prod.vercel.app'
];

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header) and known frontend origins.
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json());

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (_req, res) => {
  res.json({
    service: 'ekart-backend',
    status: 'ok',
    version: '1.0.0',
    mode: authOnlyMode ? 'auth-only' : 'full',
    endpoints: authOnlyMode
      ? ['/health', '/api/auth/login', '/api/auth/verify-otp']
      : ['/health', '/api/auth/*', '/api/menu', '/api/orders', '/api/jobs']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'ekart-backend',
    status: 'ok',
    mode: authOnlyMode ? 'auth-only' : 'full',
    timestamp: new Date().toISOString()
  });
});

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Generate OTP
    const tempToken = uuidv4();
    const emailOtp = genOtp();
    const mobileOtp = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await OtpCode.create({
      _id: uuidv4(),
      session_token: tempToken,
      channel: 'email',
      code: emailOtp,
      consumed: 0,
      created_at: nowIso(),
      expires_at: expiresAt
    });

    await OtpCode.create({
      _id: uuidv4(),
      session_token: tempToken,
      channel: 'mobile',
      code: mobileOtp,
      consumed: 0,
      created_at: nowIso(),
      expires_at: expiresAt
    });

    if (otpDebugMode) {
      console.log(`OTP for ${username}: Email=${emailOtp}, Mobile=${mobileOtp}`);
    }

    return res.json({
      tempToken,
      message: 'Login successful.',
      channels: { email: user.email, mobile: user.mobile }
    });
  } catch (error) {
    console.error('Login error', error);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { tempToken, emailOtp, mobileOtp } = req.body || {};
    const session = await AuthSession.findOne({ token: tempToken });
    
    if (!session) {
      const authSession = await mongoose.connection.collection('authsessions').findOne({ token: tempToken });
      if (!authSession) {
        return res.status(401).json({ error: 'Invalid or expired temporary token.' });
      }
    }

    const emailCode = await OtpCode.findOne({
      session_token: tempToken,
      channel: 'email',
      consumed: 0,
      expires_at: { $gt: nowIso() }
    });

    const mobileCode = await OtpCode.findOne({
      session_token: tempToken,
      channel: 'mobile',
      consumed: 0,
      expires_at: { $gt: nowIso() }
    });

    if (!emailCode || !mobileCode || emailCode.code !== String(emailOtp).trim() || mobileCode.code !== String(mobileOtp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP values.' });
    }

    await OtpCode.updateMany({ session_token: tempToken }, { $set: { consumed: 1 } });

    const userId = session ? session.user_id : (await User.findOne({ username: 'user' }))._id;
    const sessionToken = await issueSessionToken(userId);

    return res.json({
      sessionToken,
      message: 'OTP verification successful.'
    });
  } catch (error) {
    console.error('Verify OTP error', error);
    return res.status(500).json({ error: 'OTP verification failed.' });
  }
});

// Menu Routes
if (!authOnlyMode) {
  const menuItems = [
    { id: '1', name: 'Pepperoni Pizza', price: 12.99, description: 'Classic pizza' },
    { id: '2', name: 'Veggie Burger', price: 8.99, description: 'Fresh vegetables' },
    { id: '3', name: 'Pasta Alfredo', price: 10.99, description: 'Creamy pasta' }
  ];

  app.get('/api/menu', (_req, res) => {
    res.json(menuItems);
  });

  // Order Routes
  app.post('/api/orders', async (req, res) => {
    try {
      const { userId, items, deliveryAddress } = req.body || {};
      if (!userId || !Array.isArray(items) || items.length === 0 || !deliveryAddress) {
        return res.status(400).json({ error: 'Required fields missing.' });
      }

      const orderId = uuidv4();
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

      // Queue job
      const job = await orderQueue.add('fulfill-order', { orderId }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });

      return res.status(201).json({
        id: orderId,
        userId,
        items,
        totalPrice: total,
        status: 'received',
        jobId: job.id,
        createdAt: nowIso()
      });
    } catch (error) {
      console.error('Create order error', error);
      return res.status(500).json({ error: 'Failed to create order.' });
    }
  });

  app.get('/api/orders/:orderId', async (req, res) => {
    res.json({ id: req.params.orderId, status: 'received', totalPrice: 0 });
  });
}

// Error handling
app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('MongoDB connected successfully!');

    await seedDatabase();

    app.listen(port, () => {
      console.log(`ekart-backend listening on :${port}`);
      console.log(`mode: ${authOnlyMode ? 'auth-only' : 'full'}`);
    });

    // Start worker
    if (!authOnlyMode && orderQueue) {
      const worker = new Worker('order-fulfillment', async (job) => {
        console.log(`Processing job ${job.id}: ${JSON.stringify(job.data)}`);
        // Simulate order fulfillment
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log(`Job ${job.id} completed`);
        return { success: true };
      }, { connection: redisConnection });

      worker.on('failed', (job, err) => {
        console.error(`Job ${job.id} failed:`, err.message);
      });

      console.log('Order fulfillment worker started');
    }
  } catch (error) {
    console.error('Failed to start backend', error);
    process.exit(1);
  }
}

start();
