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

dotenv.config();

const port = Number(process.env.PORT || 3000);
const authOnlyMode = String(process.env.AUTH_ONLY_MODE || '0') === '1';
const mongoUri = process.env.MONGODB_URI;
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const otpDebugMode = process.env.OTP_DEBUG_MODE === '1';
const githubRepo = String(process.env.GITHUB_REPO || '').trim();
const githubToken = String(process.env.GITHUB_TOKEN || '').trim();
const githubBugLabels = String(process.env.GITHUB_BUG_LABELS || 'bug,customer-report')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);

if (!mongoUri) {
  console.error('ERROR: MONGODB_URI environment variable is not set');
  process.exit(1);
}

// ============================================================================
// SERVICES SETUP
// ============================================================================

const sendgridApiKey = process.env.SENDGRID_API_KEY || '';
const sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || '';
const gmailUser = process.env.GMAIL_USER || '';
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || '';
const gmailFromEmail = process.env.GMAIL_FROM_EMAIL || gmailUser;

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER || '';

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
  display_name: String,
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

const supportComplaintSchema = new mongoose.Schema({
  _id: String,
  type: String,
  subject: String,
  name: String,
  contact: String,
  description: String,
  user_id: String,
  username: String,
  created_at: String
});

const appFeedbackSchema = new mongoose.Schema({
  _id: String,
  feedback_type: String,
  feedback_label: String,
  app_version: String,
  route: String,
  rating: Number,
  note: String,
  user_id: String,
  username: String,
  submitted_at: String,
  created_at: String
});

const User = mongoose.model('User', userSchema);
const OtpCode = mongoose.model('OtpCode', otpCodeSchema);
const AuthSession = mongoose.model('AuthSession', authSessionSchema);
const SupportComplaint = mongoose.model('SupportComplaint', supportComplaintSchema);
const AppFeedback = mongoose.model('AppFeedback', appFeedbackSchema);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function nowIso() {
  return new Date().toISOString();
}

function genOtp() {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}

const promoCatalog = [
  { code: 'SAVE10', type: 'percent', value: 10, minAmount: 120, maxDiscount: 80 },
  { code: 'FLAT50', type: 'flat', value: 50, minAmount: 250 },
  { code: 'FIRST100', type: 'flat', value: 100, minAmount: 500 }
];

function evaluatePromoDiscount(promoRule, baseAmount) {
  if (!promoRule || baseAmount <= 0) return 0;
  if (baseAmount < promoRule.minAmount) return 0;
  if (promoRule.type === 'flat') return Math.min(baseAmount, Number(promoRule.value || 0));
  const percentDiscount = Math.round((baseAmount * Number(promoRule.value || 0)) / 100);
  if (Number.isFinite(Number(promoRule.maxDiscount))) return Math.min(percentDiscount, Number(promoRule.maxDiscount));
  return percentDiscount;
}

function isBugReportType(typeValue) {
  return String(typeValue || '').trim().toLowerCase() === 'bug';
}

async function createGitHubIssueForBugReport({ complaint, session }) {
  if (!githubRepo || !githubToken) {
    return { attempted: false, created: false, reason: 'GitHub integration is not configured. Set GITHUB_REPO and GITHUB_TOKEN.' };
  }

  const title = `[Bug Report] ${complaint.subject}`;
  const bodyLines = [
    '## New Bug Report', '',
    `- Complaint ID: ${complaint._id}`,
    `- Type: ${complaint.type}`,
    `- Name: ${complaint.name || 'N/A'}`,
    `- Contact: ${complaint.contact || 'N/A'}`,
    `- Username: ${session?.username || complaint.username || 'N/A'}`,
    `- User ID: ${session?.user_id || complaint.user_id || 'N/A'}`,
    `- Created At: ${complaint.created_at}`, '',
    '## Description',
    complaint.description || 'No description provided.'
  ];

  const response = await fetch(`https://api.github.com/repos/${githubRepo}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'routex-support-bot',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title, body: bodyLines.join('\n'), labels: githubBugLabels })
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(`GitHub issue create failed (${response.status}): ${errorPayload}`);
  }

  const issue = await response.json();
  return { attempted: true, created: true, issueUrl: issue.html_url, issueNumber: issue.number };
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
    if (!origin || allowedOrigins.includes(origin)) { callback(null, true); return; }
    callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));           // ✅ FIX: increased limit for base64 images
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (_req, res) => {
  res.json({
    service: 'ekart-backend', status: 'ok', version: '1.0.0',
    mode: authOnlyMode ? 'auth-only' : 'full',
    endpoints: authOnlyMode
      ? ['/health', '/api/auth/login', '/api/auth/verify-otp', '/api/auth/profile-image', '/api/support/complaints', '/api/support/app-feedback', '/api/promos/validate']
      : ['/health', '/api/auth/*', '/api/support/*', '/api/menu', '/api/orders', '/api/jobs']
  });
});

app.get('/health', (_req, res) => {
  res.json({ service: 'ekart-backend', status: 'ok', mode: authOnlyMode ? 'auth-only' : 'full', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, email, mobile, password, role, captainVehicle, profileImageUrl } = req.body || {};

    if (!username || !displayName || !email || !mobile || !password || !role) {
      return res.status(400).json({ error: 'username, displayName, email, mobile, password, role are required.' });
    }

    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!['customer', 'admin', 'captain'].includes(normalizedRole)) {
      return res.status(400).json({ error: 'role must be customer, admin, or captain.' });
    }

    if (normalizedRole === 'captain' && !captainVehicle) {
      return res.status(400).json({ error: 'captainVehicle is required for captain registration.' });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedMobile = String(mobile).trim();

    const existingUser = await User.findOne({
      $or: [{ username: normalizedUsername }, { email: normalizedEmail }, { mobile: normalizedMobile }]
    }).lean();

    if (existingUser) return res.status(409).json({ error: 'User already exists.' });

    const passwordHash = await bcrypt.hash(String(password), 10);
    await User.create({
      _id: uuidv4(),
      username: normalizedUsername,
      display_name: String(displayName).trim(),
      email: normalizedEmail,
      mobile: normalizedMobile,
      password: passwordHash,
      role: normalizedRole,
      captain_vehicle: normalizedRole === 'captain' ? String(captainVehicle).trim() : null,
      profile_image: profileImageUrl ? String(profileImageUrl).trim() : null,
      customer_otp_completed: 1,
      created_at: nowIso(),
      updated_at: nowIso()
    });

    return res.status(201).json({ message: 'User registered successfully.' });
  } catch (error) {
    console.error('Register error', error);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const normalizedUsername = String(username).trim().toLowerCase();
    const user = await User.findOne({ username: normalizedUsername });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const passwordMatch = await bcrypt.compare(String(password), String(user.password));
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials.' });

    const requestedRole = String(role || '').trim().toLowerCase();
    if (requestedRole && requestedRole !== String(user.role || '').trim().toLowerCase()) {
      return res.status(401).json({ error: 'Selected login mode does not match your account role.' });
    }

    const sessionToken = await issueSessionToken(user._id);

    return res.json({
      requiresOtp: false,
      tempToken: '',
      sessionToken,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.display_name || user.username,
        role: user.role,
        email: user.email,
        mobile: user.mobile,
        captainVehicle: user.captain_vehicle || undefined,
        profileImageUrl: user.profile_image || undefined
      },
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
      if (!authSession) return res.status(401).json({ error: 'Invalid or expired temporary token.' });
    }

    const emailCode = await OtpCode.findOne({ session_token: tempToken, channel: 'email', consumed: 0, expires_at: { $gt: nowIso() } });
    const mobileCode = await OtpCode.findOne({ session_token: tempToken, channel: 'mobile', consumed: 0, expires_at: { $gt: nowIso() } });

    if (!emailCode || !mobileCode || emailCode.code !== String(emailOtp).trim() || mobileCode.code !== String(mobileOtp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP values.' });
    }

    await OtpCode.updateMany({ session_token: tempToken }, { $set: { consumed: 1 } });

    const userId = session ? session.user_id : (await User.findOne({ username: 'user' }))._id;
    const sessionToken = await issueSessionToken(userId);

    return res.json({ sessionToken, message: 'OTP verification successful.' });
  } catch (error) {
    console.error('Verify OTP error', error);
    return res.status(500).json({ error: 'OTP verification failed.' });
  }
});

// ✅ FIX: Added missing profile-image upload route
app.post('/api/auth/profile-image', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Valid session token required.' });
    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });

    const { profileImageUrl } = req.body || {};
    if (!profileImageUrl) return res.status(400).json({ error: 'profileImageUrl is required.' });

    await User.updateOne({ _id: session.user_id }, { $set: { profile_image: String(profileImageUrl).trim() } });
    return res.json({ message: 'Profile image updated successfully.', profileImageUrl: String(profileImageUrl).trim() });
  } catch (error) {
    console.error('Profile image update error', error);
    return res.status(500).json({ error: 'Failed to update profile image.' });
  }
});

app.post('/api/support/complaints', async (req, res) => {
  try {
    const { type, subject, name, contact, description } = req.body || {};

    if (!type || !subject || !description) {
      return res.status(400).json({ error: 'type, subject, and description are required.' });
    }

    const sessionToken = req.headers['x-session-token'];
    const session = typeof sessionToken === 'string' ? await getSession(sessionToken) : null;

    const complaint = await SupportComplaint.create({
      _id: uuidv4(),
      type: String(type).trim(),
      subject: String(subject).trim(),
      name: String(name || '').trim(),
      contact: String(contact || '').trim(),
      description: String(description).trim(),
      user_id: session?.user_id || '',
      username: session?.username || '',
      created_at: nowIso()
    });

    if (!isBugReportType(type)) {
      return res.status(201).json({ message: 'Complaint submitted successfully.' });
    }

    try {
      const issueResult = await createGitHubIssueForBugReport({ complaint, session });
      if (issueResult.created) {
        return res.status(201).json({
          message: `Bug submitted and GitHub issue #${issueResult.issueNumber} created successfully.`,
          issueUrl: issueResult.issueUrl,
          issueNumber: issueResult.issueNumber
        });
      }
      return res.status(201).json({ message: `Bug submitted successfully. ${issueResult.reason}` });
    } catch (integrationError) {
      console.error('GitHub bug issue create error', integrationError);
      return res.status(201).json({ message: 'Bug submitted successfully, but GitHub issue creation failed.' });
    }
  } catch (error) {
    console.error('Support complaint submit error', error);
    return res.status(500).json({ error: 'Failed to submit complaint.' });
  }
});

app.post('/api/support/app-feedback', async (req, res) => {
  try {
    const { feedbackType, feedbackLabel, appVersion, route, rating, note, submittedAt } = req.body || {};

    if (!feedbackType || !feedbackLabel || !appVersion || !route || !submittedAt) {
      return res.status(400).json({ error: 'feedbackType, feedbackLabel, appVersion, route, and submittedAt are required.' });
    }

    const sessionToken = req.headers['x-session-token'];
    const session = typeof sessionToken === 'string' ? await getSession(sessionToken) : null;

    await AppFeedback.create({
      _id: uuidv4(),
      feedback_type: String(feedbackType).trim(),
      feedback_label: String(feedbackLabel).trim(),
      app_version: String(appVersion).trim(),
      route: String(route).trim(),
      rating: Number.isFinite(Number(rating)) ? Number(rating) : 0,
      note: String(note || '').trim(),
      user_id: session?.user_id || '',
      username: session?.username || '',
      submitted_at: String(submittedAt).trim(),
      created_at: nowIso()
    });

    return res.status(201).json({ message: 'App feedback submitted successfully.' });
  } catch (error) {
    console.error('App feedback submit error', error);
    return res.status(500).json({ error: 'Failed to submit app feedback.' });
  }
});

app.post('/api/promos/validate', async (req, res) => {
  try {
    const { code, amount } = req.body || {};
    const normalizedCode = String(code || '').trim().toUpperCase();
    const baseAmount = Number(amount || 0);

    if (!normalizedCode) return res.status(400).json({ valid: false, error: 'Promo code is required.' });
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return res.status(400).json({ valid: false, error: 'Valid amount is required.' });

    const promoRule = promoCatalog.find((item) => item.code === normalizedCode);
    if (!promoRule) return res.status(404).json({ valid: false, error: 'Invalid promo code.' });

    if (baseAmount < promoRule.minAmount) {
      return res.status(400).json({ valid: false, error: `Promo requires minimum Rs ${promoRule.minAmount}.`, minAmount: promoRule.minAmount });
    }

    const discount = evaluatePromoDiscount(promoRule, baseAmount);
    const payableAmount = Math.max(0, Math.round(baseAmount - discount));

    return res.json({
      valid: true,
      code: promoRule.code,
      discount,
      payableAmount,
      promo: { code: promoRule.code, type: promoRule.type, value: promoRule.value, minAmount: promoRule.minAmount, maxDiscount: promoRule.maxDiscount }
    });
  } catch (error) {
    console.error('Promo validate error', error);
    return res.status(500).json({ valid: false, error: 'Failed to validate promo code.' });
  }
});

// Menu & Order Routes
if (!authOnlyMode) {
  const menuItems = [
    { id: '1', name: 'Pepperoni Pizza', price: 12.99, description: 'Classic pizza' },
    { id: '2', name: 'Veggie Burger', price: 8.99, description: 'Fresh vegetables' },
    { id: '3', name: 'Pasta Alfredo', price: 10.99, description: 'Creamy pasta' }
  ];

  app.get('/api/menu', (_req, res) => { res.json(menuItems); });

  app.post('/api/orders', async (req, res) => {
    try {
      const { userId, items, deliveryAddress } = req.body || {};
      if (!userId || !Array.isArray(items) || items.length === 0 || !deliveryAddress) {
        return res.status(400).json({ error: 'Required fields missing.' });
      }

      const orderId = uuidv4();
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

      const job = await orderQueue.add('fulfill-order', { orderId }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });

      return res.status(201).json({ id: orderId, userId, items, totalPrice: total, status: 'received', jobId: job.id, createdAt: nowIso() });
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

    if (!authOnlyMode && orderQueue) {
      const worker = new Worker('order-fulfillment', async (job) => {
        console.log(`Processing job ${job.id}: ${JSON.stringify(job.data)}`);
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
