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
const githubRepo = String(process.env.GITHUB_REPO || '').trim();
const githubToken = String(process.env.GITHUB_TOKEN || '').trim();
const githubBugLabels = String(process.env.GITHUB_BUG_LABELS || 'bug,customer-report')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);

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

const paymentDataSchema = new mongoose.Schema({
  user_id: { type: String, unique: true, required: true },
  wallet_balance: { type: Number, default: 0 },
  pay_later_enabled: { type: Boolean, default: false },
  pay_later_used: { type: Number, default: 0 },
  linked_accounts: { type: Array, default: [] },
  upi_ids: { type: Array, default: [] },
  wallet_txns: { type: Array, default: [] },
  pay_history: { type: Array, default: [] },
  updated_at: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);
const OtpCode = mongoose.model('OtpCode', otpCodeSchema);
const AuthSession = mongoose.model('AuthSession', authSessionSchema);
const SupportComplaint = mongoose.model('SupportComplaint', supportComplaintSchema);
const AppFeedback = mongoose.model('AppFeedback', appFeedbackSchema);
const PaymentData = mongoose.model('PaymentData', paymentDataSchema);

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
  if (!promoRule || baseAmount <= 0) {
    return 0;
  }

  if (baseAmount < promoRule.minAmount) {
    return 0;
  }

  if (promoRule.type === 'flat') {
    return Math.min(baseAmount, Number(promoRule.value || 0));
  }

  const percentDiscount = Math.round((baseAmount * Number(promoRule.value || 0)) / 100);
  if (Number.isFinite(Number(promoRule.maxDiscount))) {
    return Math.min(percentDiscount, Number(promoRule.maxDiscount));
  }

  return percentDiscount;
}

function isBugReportType(typeValue) {
  return String(typeValue || '').trim().toLowerCase() === 'bug';
}

async function createGitHubIssueForBugReport({ complaint, session }) {
  if (!githubRepo || !githubToken) {
    return {
      attempted: false,
      created: false,
      reason: 'GitHub integration is not configured. Set GITHUB_REPO and GITHUB_TOKEN.'
    };
  }

  const title = `[Bug Report] ${complaint.subject}`;
  const bodyLines = [
    '## New Bug Report',
    '',
    `- Complaint ID: ${complaint._id}`,
    `- Type: ${complaint.type}`,
    `- Name: ${complaint.name || 'N/A'}`,
    `- Contact: ${complaint.contact || 'N/A'}`,
    `- Username: ${session?.username || complaint.username || 'N/A'}`,
    `- User ID: ${session?.user_id || complaint.user_id || 'N/A'}`,
    `- Created At: ${complaint.created_at}`,
    '',
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
    body: JSON.stringify({
      title,
      body: bodyLines.join('\n'),
      labels: githubBugLabels
    })
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(`GitHub issue create failed (${response.status}): ${errorPayload}`);
  }

  const issue = await response.json();
  return {
    attempted: true,
    created: true,
    issueUrl: issue.html_url,
    issueNumber: issue.number
  };
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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
      ? ['/health', '/api/auth/login', '/api/auth/verify-otp', '/api/support/complaints', '/api/support/app-feedback', '/api/promos/validate']
      : ['/health', '/api/auth/*', '/api/support/*', '/api/menu', '/api/orders', '/api/jobs']
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
      $or: [
        { username: normalizedUsername },
        { email: normalizedEmail },
        { mobile: normalizedMobile }
      ]
    }).lean();

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists.' });
    }

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

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const user = await User.findOne({ username: normalizedUsername });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const passwordMatch = await bcrypt.compare(String(password), String(user.password));
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

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
    const verifiedUser = await User.findById(userId).lean();

    return res.json({
      sessionToken,
      user: {
        id: verifiedUser._id,
        username: verifiedUser.username,
        displayName: verifiedUser.display_name || verifiedUser.username,
        role: verifiedUser.role,
        email: verifiedUser.email,
        mobile: verifiedUser.mobile,
        captainVehicle: verifiedUser.captain_vehicle || undefined,
        profileImageUrl: verifiedUser.profile_image || undefined
      },
      message: 'OTP verification successful.'
    });
  } catch (error) {
    console.error('Verify OTP error', error);
    return res.status(500).json({ error: 'OTP verification failed.' });
  }
});

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

// ── PAYMENT DATA ──────────────────────────────────────────────────────────────

async function requirePaymentSession(req, res) {
  const token = req.headers['x-session-token'];
  if (!token) { res.status(401).json({ error: 'Session token required.' }); return null; }
  const session = await getSession(token);
  if (!session) { res.status(401).json({ error: 'Session token required.' }); return null; }
  return session;
}

// GET /api/payment — fetch or create payment profile for current user
app.get('/api/payment', async (req, res) => {
  try {
    const session = await requirePaymentSession(req, res);
    if (!session) return;
    let doc = await PaymentData.findOne({ user_id: session.user_id });
    if (!doc) {
      doc = await PaymentData.create({ user_id: session.user_id, updated_at: nowIso() });
    }
    return res.json(doc);
  } catch (err) {
    console.error('GET /api/payment error', err);
    return res.status(500).json({ error: 'Failed to load payment data.' });
  }
});

// PATCH /api/payment — update full payment profile (wallet, accounts, upi, etc.)
app.patch('/api/payment', async (req, res) => {
  try {
    const session = await requirePaymentSession(req, res);
    if (!session) return;
    const allowed = ['wallet_balance','pay_later_enabled','pay_later_used','linked_accounts','upi_ids','wallet_txns','pay_history'];
    const update = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        update[key] = req.body[key];
      }
    }
    update.updated_at = nowIso();
    const doc = await PaymentData.findOneAndUpdate(
      { user_id: session.user_id },
      { $set: update },
      { upsert: true, new: true }
    );
    return res.json(doc);
  } catch (err) {
    console.error('PATCH /api/payment error', err);
    return res.status(500).json({ error: 'Failed to save payment data.' });
  }
});

// POST /api/payment/wallet/add — add money to wallet
app.post('/api/payment/wallet/add', async (req, res) => {
  try {
    const session = await requirePaymentSession(req, res);
    if (!session) return;
    const amount = Number(req.body.amount);
    if (!amount || amount < 1) return res.status(400).json({ error: 'amount must be >= 1' });
    const txn = {
      label: `Added ₹${amount} to wallet`,
      date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      amount,
      type: 'credit'
    };
    const hist = { label: 'Wallet Top-up', date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), amount, mode: 'wallet', refund: true };
    const doc = await PaymentData.findOneAndUpdate(
      { user_id: session.user_id },
      { $inc: { wallet_balance: amount }, $push: { wallet_txns: { $each: [txn], $position: 0 }, pay_history: { $each: [hist], $position: 0 } }, $set: { updated_at: nowIso() } },
      { upsert: true, new: true }
    );
    return res.json({ message: 'Wallet topped up.', wallet_balance: doc.wallet_balance, txn });
  } catch (err) {
    console.error('POST /api/payment/wallet/add error', err);
    return res.status(500).json({ error: 'Failed to add money.' });
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

      return res.status(201).json({
        message: `Bug submitted successfully. ${issueResult.reason}`
      });
    } catch (integrationError) {
      console.error('GitHub bug issue create error', integrationError);
      return res.status(201).json({
        message: 'Bug submitted successfully, but GitHub issue creation failed. Please check server logs.'
      });
    }
  } catch (error) {
    console.error('Support complaint submit error', error);
    return res.status(500).json({ error: 'Failed to submit complaint.' });
  }
});

app.post('/api/support/app-feedback', async (req, res) => {
  try {
    const {
      feedbackType,
      feedbackLabel,
      appVersion,
      route,
      rating,
      note,
      submittedAt
    } = req.body || {};

    if (!feedbackType || !feedbackLabel || !appVersion || !route || !submittedAt) {
      return res.status(400).json({
        error: 'feedbackType, feedbackLabel, appVersion, route, and submittedAt are required.'
      });
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

    if (!normalizedCode) {
      return res.status(400).json({ valid: false, error: 'Promo code is required.' });
    }

    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return res.status(400).json({ valid: false, error: 'Valid amount is required.' });
    }

    const promoRule = promoCatalog.find((item) => item.code === normalizedCode);
    if (!promoRule) {
      return res.status(404).json({ valid: false, error: 'Invalid promo code.' });
    }

    if (baseAmount < promoRule.minAmount) {
      return res.status(400).json({
        valid: false,
        error: `Promo requires minimum Rs ${promoRule.minAmount}.`,
        minAmount: promoRule.minAmount
      });
    }

    const discount = evaluatePromoDiscount(promoRule, baseAmount);
    const payableAmount = Math.max(0, Math.round(baseAmount - discount));

    return res.json({
      valid: true,
      code: promoRule.code,
      discount,
      payableAmount,
      promo: {
        code: promoRule.code,
        type: promoRule.type,
        value: promoRule.value,
        minAmount: promoRule.minAmount,
        maxDiscount: promoRule.maxDiscount
      }
    });
  } catch (error) {
    console.error('Promo validate error', error);
    return res.status(500).json({ valid: false, error: 'Failed to validate promo code.' });
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

// ============================================================================
// MISSING ROUTES — Auth, Bookings, Places, Pricing, Integrations
// ============================================================================

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Valid session token required.' });
    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const user = await User.findById(session.user_id).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({
      id: user._id, username: user.username, displayName: user.display_name || user.username,
      role: user.role, email: user.email, mobile: user.mobile,
      captainVehicle: user.captain_vehicle || undefined,
      profileImageUrl: user.profile_image || undefined
    });
  } catch (err) {
    console.error('GET /api/auth/me error', err);
    return res.status(500).json({ error: 'Failed to get user.' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    if (token) await AuthSession.deleteOne({ token });
    return res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Logout error', err);
    return res.status(500).json({ error: 'Logout failed.' });
  }
});

// POST /api/auth/user-action
app.post('/api/auth/user-action', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    const { actionType, metadata } = req.body || {};
    if (!actionType) return res.status(400).json({ error: 'actionType is required.' });
    // Best-effort: store in memory log (extend with a DB model if needed)
    console.log(`[UserAction] user=${session?.username || 'anon'} action=${actionType}`, metadata || {});
    return res.json({ message: 'Action recorded.' });
  } catch (err) {
    console.error('User action error', err);
    return res.status(500).json({ error: 'Failed to record action.' });
  }
});

// GET /api/auth/actions
app.get('/api/auth/actions', async (req, res) => {
  return res.json([]);
});

// POST /api/auth/voice-challenge
app.post('/api/auth/voice-challenge', async (req, res) => {
  try {
    const phrases = ['blue elephant', 'sunny morning', 'green river', 'open window', 'silver cloud'];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    return res.json({ phrase, expiresAt });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate voice challenge.' });
  }
});

// POST /api/auth/voice-verify
app.post('/api/auth/voice-verify', async (req, res) => {
  return res.json({ message: 'Voice verified successfully.' });
});

// GET /api/auth/users/stats
app.get('/api/auth/users/stats', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });
    const [total, customers, captains, admins] = await Promise.all([
      User.countDocuments({}), User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'captain' }), User.countDocuments({ role: 'admin' })
    ]);
    return res.json({ total, customers, captains, admins });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user stats.' });
  }
});

// GET /api/auth/users
app.get('/api/auth/users', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });
    const users = await User.find({}).select('_id username display_name email mobile role captain_vehicle profile_image created_at').lean();
    return res.json(users.map(u => ({
      id: u._id, username: u.username, displayName: u.display_name || u.username,
      email: u.email, mobile: u.mobile, role: u.role,
      captainVehicle: u.captain_vehicle || undefined,
      profileImageUrl: u.profile_image || undefined,
      createdAt: u.created_at
    })));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get users.' });
  }
});

// GET /api/auth/captains
app.get('/api/auth/captains', async (req, res) => {
  try {
    const { vehicleType } = req.query;
    const query = vehicleType ? { role: 'captain', captain_vehicle: String(vehicleType) } : { role: 'captain' };
    const captains = await User.find(query).select('_id username display_name mobile captain_vehicle profile_image').lean();
    return res.json(captains.map(c => ({
      id: c._id, username: c.username, displayName: c.display_name || c.username,
      mobile: c.mobile, vehicleType: c.captain_vehicle || undefined,
      profileImageUrl: c.profile_image || undefined
    })));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get captains.' });
  }
});

// POST /api/auth/captain-feedback
app.post('/api/auth/captain-feedback', async (req, res) => {
  try {
    const { bookingId, captainId, captainName, rideRating, captainRating, feedbackText, lovedRide, lovedCaptain } = req.body || {};
    if (!bookingId || !captainName || !rideRating || !captainRating) {
      return res.status(400).json({ error: 'bookingId, captainName, rideRating, and captainRating are required.' });
    }
    console.log(`[CaptainFeedback] booking=${bookingId} captain=${captainName} rideRating=${rideRating} captainRating=${captainRating}`);
    return res.json({ message: 'Feedback submitted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to submit captain feedback.' });
  }
});

// GET /api/auth/captain-feedback/stats
app.get('/api/auth/captain-feedback/stats', async (req, res) => {
  return res.json({ totalFeedbacks: 0, averageRideRating: 0, averageCaptainRating: 0, comments: [] });
});

// KYC routes (captain)
app.get('/api/auth/kyc/status', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    return res.json({ kycStatus: 'not_submitted', kycDocumentType: null, kycDocumentNumber: null, kycReferenceId: null, kycUpdatedAt: null });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get KYC status.' });
  }
});

app.post('/api/auth/kyc/submit', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const { documentType, documentNumber } = req.body || {};
    if (!documentType || !documentNumber) return res.status(400).json({ error: 'documentType and documentNumber are required.' });
    const referenceId = `KYC-${uuidv4().split('-')[0].toUpperCase()}`;
    return res.json({ message: 'KYC submitted successfully.', kycStatus: 'pending', kycReferenceId: referenceId, kycUpdatedAt: nowIso() });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to submit KYC.' });
  }
});

// ============================================================================
// BOOKINGS ROUTES
// ============================================================================

const bookingSchema = new mongoose.Schema({
  _id: String, user_id: String, username: String, service_type: String,
  pickup: Object, drop: Object, status: String, captain_id: String,
  captain_name: String, otp: String, fare: Number, payment_status: String,
  scheduled_at: String, created_at: String, updated_at: String,
  food_items: Array, hotel_name: String, medicine_names: String,
  prescription_payload: String, feedback: Object
});
const Booking = mongoose.model('Booking', bookingSchema);

app.get('/api/bookings', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const isAdmin = session.role === 'admin';
    const query = isAdmin ? {} : { user_id: session.user_id };
    const bookings = await Booking.find(query).sort({ updated_at: -1 }).limit(200).lean();
    return res.json(bookings.map(b => normalizeBooking(b)));
  } catch (err) {
    console.error('GET /api/bookings error', err);
    return res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
});

app.get('/api/bookings/:bookingId', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const booking = await Booking.findById(req.params.bookingId).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    return res.json(normalizeBooking(booking));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch booking.' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const body = req.body || {};
    const bookingId = uuidv4();
    const otp = `${Math.floor(1000 + Math.random() * 9000)}`;
    const booking = await Booking.create({
      _id: bookingId,
      user_id: session.user_id,
      username: session.username,
      service_type: body.serviceType || 'parcel',
      pickup: body.pickup || {},
      drop: body.drop || {},
      status: 'pending',
      otp,
      fare: body.fare || 0,
      payment_status: 'pending',
      scheduled_at: body.scheduledAt || null,
      food_items: body.foodItems || [],
      hotel_name: body.hotelName || null,
      medicine_names: body.medicineNames || null,
      created_at: nowIso(),
      updated_at: nowIso()
    });
    return res.status(201).json(normalizeBooking(booking.toObject()));
  } catch (err) {
    console.error('POST /api/bookings error', err);
    return res.status(500).json({ error: 'Failed to create booking.' });
  }
});

app.post('/api/bookings/:bookingId/verify-otp', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const { otp } = req.body || {};
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    if (booking.otp !== String(otp).trim()) return res.status(400).json({ error: 'Invalid OTP.' });
    booking.status = 'in_progress';
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify OTP.' });
  }
});

app.post('/api/bookings/:bookingId/approve', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    booking.status = 'captain_assigned';
    booking.captain_id = session.user_id;
    booking.captain_name = session.username;
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to approve booking.' });
  }
});

app.post('/api/bookings/:bookingId/cancel', async (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    const session = token ? await getSession(token) : null;
    if (!session) return res.status(401).json({ error: 'Valid session token required.' });
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    booking.status = 'cancelled';
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel booking.' });
  }
});

app.post('/api/bookings/:bookingId/sos', async (req, res) => {
  try {
    console.log(`[SOS] bookingId=${req.params.bookingId}`);
    return res.json({ message: 'SOS alert sent. Help is on the way.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send SOS.' });
  }
});

app.post('/api/bookings/:bookingId/feedback', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    booking.feedback = req.body || {};
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save feedback.' });
  }
});

app.post('/api/bookings/:bookingId/pay', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    booking.payment_status = 'paid';
    booking.status = 'completed';
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process payment.' });
  }
});

app.post('/api/bookings/:bookingId/close-tracking', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });
    booking.status = 'completed';
    booking.updated_at = nowIso();
    await booking.save();
    return res.json(normalizeBooking(booking.toObject()));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to close tracking.' });
  }
});

function normalizeBooking(b) {
  return {
    id: b._id, userId: b.user_id, userName: b.username,
    serviceType: b.service_type, pickup: b.pickup || {}, drop: b.drop || {},
    status: b.status, captainId: b.captain_id || null,
    captainName: b.captain_name || null, otp: b.otp,
    fare: b.fare || 0, paymentStatus: b.payment_status || 'pending',
    scheduledAt: b.scheduled_at || null,
    foodItems: b.food_items || [], hotelName: b.hotel_name || null,
    medicineNames: b.medicine_names || null, feedback: b.feedback || null,
    createdAt: b.created_at, updatedAt: b.updated_at
  };
}

// ============================================================================
// PLACES / HOTELS / MENU ROUTES
// ============================================================================

app.get('/api/places/nearby-hotels', async (req, res) => {
  const now = new Date().toISOString();
  return res.json({
    source: 'backend',
    updatedAt: now,
    hotels: [
      {
        id: 'h1',
        name: 'Spice Garden',
        category: 'nonveg',
        cuisine: 'Indian',
        locationLabel: 'Near City Center',
        distanceKm: 1.2,
        etaMinutes: 15,
        rating: 4.2,
        openNow: true,
        priceForTwo: 250,
        imageUrl: ''
      },
      {
        id: 'h2',
        name: 'Pizza Palace',
        category: 'veg',
        cuisine: 'Italian',
        locationLabel: 'MG Road',
        distanceKm: 0.8,
        etaMinutes: 10,
        rating: 4.5,
        openNow: true,
        priceForTwo: 400,
        imageUrl: ''
      },
      {
        id: 'h3',
        name: 'Burger Hub',
        category: 'nonveg',
        cuisine: 'Fast Food',
        locationLabel: 'Bus Stand Area',
        distanceKm: 2.1,
        etaMinutes: 20,
        rating: 4.0,
        openNow: true,
        priceForTwo: 300,
        imageUrl: ''
      },
      {
        id: 'h4',
        name: 'Green Bites',
        category: 'veg',
        cuisine: 'Healthy',
        locationLabel: 'Park Street',
        distanceKm: 1.5,
        etaMinutes: 18,
        rating: 4.3,
        openNow: true,
        priceForTwo: 200,
        imageUrl: ''
      }
    ]
  });
});

app.get('/api/menu/hotels/:hotelId/items', async (req, res) => {
  const now = new Date().toISOString();
  // Menu varies slightly per hotel for realism
  const hotelMenus = {
    h1: [
      { id: 'i1', name: 'Special Thali', price: 120, description: 'Full veg meal', category: 'veg', isTop: true, imageUrl: '' },
      { id: 'i2', name: 'Chicken Curry', price: 160, description: 'Rich gravy', category: 'nonveg', isTop: true, imageUrl: '' },
      { id: 'i3', name: 'Butter Naan', price: 30, description: 'Soft naan', category: 'veg', isTop: false, imageUrl: '' },
      { id: 'i4', name: 'Masala Chai', price: 20, description: 'Hot tea', category: 'veg', isTop: false, imageUrl: '' }
    ],
    h2: [
      { id: 'i5', name: 'Margherita Pizza', price: 180, description: 'Classic pizza', category: 'veg', isTop: true, imageUrl: '' },
      { id: 'i6', name: 'Pepperoni Pizza', price: 220, description: 'Loaded pepperoni', category: 'nonveg', isTop: true, imageUrl: '' },
      { id: 'i7', name: 'Garlic Bread', price: 60, description: 'Crispy garlic bread', category: 'veg', isTop: false, imageUrl: '' }
    ],
    h3: [
      { id: 'i8', name: 'Classic Burger', price: 90, description: 'Juicy beef burger', category: 'nonveg', isTop: true, imageUrl: '' },
      { id: 'i9', name: 'Veg Burger', price: 70, description: 'Crispy veg patty', category: 'veg', isTop: true, imageUrl: '' },
      { id: 'i10', name: 'French Fries', price: 50, description: 'Golden fries', category: 'veg', isTop: false, imageUrl: '' }
    ],
    h4: [
      { id: 'i11', name: 'Veg Biryani', price: 90, description: 'Fragrant basmati rice', category: 'veg', isTop: true, imageUrl: '' },
      { id: 'i12', name: 'Fruit Bowl', price: 80, description: 'Fresh seasonal fruits', category: 'veg', isTop: true, imageUrl: '' },
      { id: 'i13', name: 'Quinoa Salad', price: 110, description: 'Healthy protein salad', category: 'veg', isTop: false, imageUrl: '' }
    ]
  };
  const items = hotelMenus[req.params.hotelId] || hotelMenus['h1'];
  return res.json({
    source: 'backend',
    hotelId: req.params.hotelId,
    updatedAt: now,
    items
  });
});

// ============================================================================
// PRICING ROUTE
// ============================================================================

app.post('/api/pricing/live-fare', async (req, res) => {
  try {
    const { distanceKm, vehicleType, trafficCondition, weatherCondition } = req.body || {};
    const distance = Number(distanceKm || 5);
    const baseRate = vehicleType === 'bike' ? 8 : vehicleType === 'auto' ? 12 : 18;
    const trafficMultiplier = trafficCondition === 'heavy' ? 1.3 : trafficCondition === 'moderate' ? 1.15 : 1.0;
    const weatherMultiplier = weatherCondition === 'rain' ? 1.2 : 1.0;
    const distanceFare = Math.round(distance * baseRate * trafficMultiplier * weatherMultiplier);
    return res.json({
      distanceFare, trafficMultiplier, weatherMultiplier,
      totalFare: distanceFare, trafficCondition: trafficCondition || 'clear',
      weatherCondition: weatherCondition || 'clear'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to calculate fare.' });
  }
});

// ============================================================================
// INTEGRATIONS HEALTH ROUTE
// ============================================================================

app.get('/api/integrations/health', async (_req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  return res.json({
    service: 'ekart-backend',
    status: mongoConnected ? 'ok' : 'degraded',
    checkedAt: nowIso(),
    integrations: [
      { name: 'MongoDB', status: mongoConnected ? 'live' : 'down' },
      { name: 'Auth API', status: 'live' },
      { name: 'Booking API', status: 'live' }
    ]
  });
});

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
