const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

dotenv.config();

const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI;
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const otpDebugMode = process.env.OTP_DEBUG_MODE === '1';

if (!mongoUri) {
  console.error('ERROR: MONGODB_URI environment variable is not set');
  process.exit(1);
}

const sendgridApiKey = process.env.SENDGRID_API_KEY || '';
const sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || '';
const gmailUser = process.env.GMAIL_USER || '';
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || '';
const gmailFromEmail = process.env.GMAIL_FROM_EMAIL || gmailUser;
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || '';
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER || '';
const githubToken = process.env.GITHUB_TOKEN || '';
const githubIssuesRepo = process.env.GITHUB_ISSUES_REPO || 'goat82447-ops/enterprise-lunchbox-lms-prod';

let twilioClient = null;
let gmailTransporter = null;

if (sendgridApiKey) sgMail.setApiKey(sendgridApiKey);
if (twilioAccountSid && twilioAuthToken) twilioClient = twilio(twilioAccountSid, twilioAuthToken);
if (gmailUser && gmailAppPassword) {
  gmailTransporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailAppPassword } });
}

// ============================================================================
// DATABASE SCHEMAS
// ============================================================================

const userSchema = new mongoose.Schema({
  _id: String, username: String, display_name: String, password: String,
  email: String, mobile: String, role: String, customer_otp_completed: Number,
  captain_vehicle: String, profile_image: String, created_at: String, updated_at: String
});

const otpCodeSchema = new mongoose.Schema({
  _id: String, user_id: String, session_token: String, channel: String,
  code: String, consumed: Number, created_at: String, expires_at: String
});

const authSessionSchema = new mongoose.Schema({
  _id: String, token: String, user_id: String, type: { type: String, default: 'session' },
  mfa_verified: Number, voice_verified: Number, created_at: String, expires_at: String
});

// ── BOOKING SCHEMA — full fields matching frontend Booking interface ──
const bookingSchema = new mongoose.Schema({
  _id: String,
  user_id: String, user_name: String,
  booking_for: String,
  recipient_name: String, recipient_phone: String,
  is_scheduled: Number, scheduled_at: String,
  service_type: String, payment_method: String, vehicle_type: String,
  pickup_json: String, drop_json: String, current_location_json: String,
  status: String,                     // 'created' | 'assigned' | 'in_transit' | 'completed' | 'cancelled'
  otp: String, otp_verified: Number,
  driver_name: String, driver_phone: String,
  captain_id: String,
  notification_target: String,        // 'all' | 'preferred'  — CRITICAL for captain visibility
  preferred_captain_id: String, preferred_captain_name: String,
  notification: String,
  estimated_fare: Number,
  ride_notes: String,
  sos_triggered: Number, sos_by_role: String,
  feedback_submitted: Number, feedback_submitted_at: String,
  feedback_text: String, ride_rating: Number, captain_rating: Number,
  loved_ride: Number, loved_captain: Number,
  final_amount: Number, payment_done: Number, payment_done_at: String,
  tracking_closed: Number, tracking_closed_at: String,
  created_at: String, updated_at: String
});

const captainFeedbackSchema = new mongoose.Schema({
  _id: String, booking_id: String, captain_user_id: String, captain_name: String,
  submitted_by_user_id: String, submitted_by_name: String,
  ride_rating: Number, captain_rating: Number, feedback_text: String,
  loved_ride: Number, loved_captain: Number, created_at: String, updated_at: String
});

const userActionSchema = new mongoose.Schema({
  _id: String, user_id: String, action_type: String,
  metadata_json: String, created_at: String
});

const User = mongoose.model('User', userSchema);
const OtpCode = mongoose.model('OtpCode', otpCodeSchema);
const AuthSession = mongoose.model('AuthSession', authSessionSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const CaptainFeedback = mongoose.model('CaptainFeedback', captainFeedbackSchema);
const UserAction = mongoose.model('UserAction', userActionSchema);

// ============================================================================
// UTILITIES
// ============================================================================

function nowIso() { return new Date().toISOString(); }
function genOtp() { return `${Math.floor(100000 + Math.random() * 900000)}`; }
function toBool(v) { return Number(v || 0) === 1; }
function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

async function createGithubIssueForBugReport({ type, subject, name, contact, description, requestMeta }) {
  if (String(type || '').toLowerCase() !== 'bug') {
    return null;
  }

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is not configured on backend.');
  }

  const lines = [
    '## Bug Details',
    String(description || '').trim(),
    '',
    '## Reporter',
    `- Name: ${name ? String(name).trim() : 'Not provided'}`,
    `- Contact: ${contact ? String(contact).trim() : 'Not provided'}`,
    '',
    '## Source',
    '- Raised from app: Contact > Complaint / Bug Report',
    `- Raised at: ${nowIso()}`,
    `- Client IP: ${requestMeta.ip || 'unknown'}`,
    `- User Agent: ${requestMeta.userAgent || 'unknown'}`
  ];

  const response = await fetch(`https://api.github.com/repos/${githubIssuesRepo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      title: `[Bug] ${String(subject || '').trim()}`,
      body: lines.join('\n'),
      labels: ['bug']
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || `GitHub issue creation failed with status ${response.status}`);
  }

  return {
    issueNumber: payload.number,
    issueUrl: payload.html_url
  };
}

function mapBookingRow(row) {
  return {
    id: row._id,
    userId: row.user_id,
    userName: row.user_name,
    bookingFor: row.booking_for,
    recipientName: row.recipient_name || undefined,
    recipientPhone: row.recipient_phone || undefined,
    isScheduled: toBool(row.is_scheduled),
    scheduledAt: row.scheduled_at || undefined,
    serviceType: row.service_type,
    paymentMethod: row.payment_method,
    vehicleType: row.vehicle_type,
    pickup: safeJson(row.pickup_json, { lat: 0, lng: 0, address: '' }),
    drop: safeJson(row.drop_json, { lat: 0, lng: 0, address: '' }),
    currentLocation: safeJson(row.current_location_json, { lat: 0, lng: 0, address: '' }),
    status: row.status,
    otp: row.otp,
    otpVerified: toBool(row.otp_verified),
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    captainId: row.captain_id || undefined,
    notificationTarget: row.notification_target || 'all',   // ← DEFAULT 'all' so captains always see it
    preferredCaptainId: row.preferred_captain_id || undefined,
    preferredCaptainName: row.preferred_captain_name || undefined,
    notification: row.notification,
    estimatedFare: row.estimated_fare != null ? Number(row.estimated_fare) : undefined,
    rideNotes: row.ride_notes || undefined,
    sosTriggered: toBool(row.sos_triggered),
    sosByRole: row.sos_by_role || undefined,
    feedbackSubmitted: toBool(row.feedback_submitted),
    feedbackSubmittedAt: row.feedback_submitted_at || undefined,
    feedbackText: row.feedback_text || undefined,
    rideRating: row.ride_rating != null ? Number(row.ride_rating) : undefined,
    captainRating: row.captain_rating != null ? Number(row.captain_rating) : undefined,
    lovedRide: toBool(row.loved_ride),
    lovedCaptain: toBool(row.loved_captain),
    finalAmount: row.final_amount != null ? Number(row.final_amount) : undefined,
    paymentDone: toBool(row.payment_done),
    paymentDoneAt: row.payment_done_at || undefined,
    trackingClosed: toBool(row.tracking_closed),
    trackingClosedAt: row.tracking_closed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ── Captain can see booking if notificationTarget='all' OR they are assigned ──
function isCaptainAssignedToBooking(session, row) {
  const target = String(row.notification_target || 'all').trim().toLowerCase();
  if (target === 'all') return true;   // ← BROADCAST: every captain sees it
  const cId   = String(session.user_id || '').toLowerCase();
  const cUser = String(session.username || '').toLowerCase();
  const cName = String(session.display_name || '').toLowerCase();
  return (
    (row.captain_id && String(row.captain_id).toLowerCase() === cId) ||
    (row.preferred_captain_id && String(row.preferred_captain_id).toLowerCase() === cId) ||
    (row.driver_name && String(row.driver_name).toLowerCase() === cUser) ||
    (row.preferred_captain_name && String(row.preferred_captain_name).toLowerCase() === cName)
  );
}

function canAccessBooking(session, row) {
  const role = String(session.role || '').toLowerCase();
  if (role === 'admin') return true;
  if (role === 'customer') return String(row.user_id || '') === String(session.user_id || '');
  if (role === 'captain') return isCaptainAssignedToBooking(session, row);
  return false;
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

async function issueTempToken(userId) {
  const token = `tmp_${uuidv4()}`;
  await AuthSession.create({ _id: uuidv4(), user_id: userId, token, type: 'temp', mfa_verified: 0, voice_verified: 0, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), created_at: nowIso() });
  return token;
}

async function issueSessionToken(userId) {
  const token = `sess_${uuidv4()}`;
  await AuthSession.create({ _id: uuidv4(), user_id: userId, token, type: 'session', mfa_verified: 1, voice_verified: 0, expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), created_at: nowIso() });
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const session = await AuthSession.findOne({ token, expires_at: { $gt: nowIso() } }).lean();
  if (!session) return null;
  const user = await User.findById(session.user_id).lean();
  if (!user) return null;
  return { ...session, id: session._id, username: user.username, display_name: user.display_name, role: user.role, email: user.email, mobile: user.mobile, captain_vehicle: user.captain_vehicle, profile_image: user.profile_image };
}

async function requireSession(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.sessionToken;
  const session = await getSession(token);
  if (!session || session.type !== 'session') return res.status(401).json({ error: 'Valid session token required.' });
  req.session = session;
  return next();
}

async function sendEmailOtp(email, otp) {
  if (gmailTransporter && gmailFromEmail) {
    await gmailTransporter.sendMail({ from: gmailFromEmail, to: email, subject: 'Your RouteX OTP', text: `Your OTP is ${otp}. Valid for 10 minutes.`, html: `<p>Your OTP is <strong>${otp}</strong>. Valid for 10 minutes.</p>` });
    return;
  }
  if (sendgridApiKey && sendgridFromEmail) {
    await sgMail.send({ to: email, from: sendgridFromEmail, subject: 'Your RouteX OTP', text: `Your OTP is ${otp}. Valid for 10 minutes.` });
    return;
  }
  if (!otpDebugMode) throw new Error('No email provider configured.');
  console.log(`[DEV OTP] ${email}: ${otp}`);
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

const allowedOrigins = [
  'http://localhost:4200',
  'https://enterprise-lunchbox-lms-prod.vercel.app',
  'https://ekart-backend-buwi.onrender.com',
  'capacitor://localhost',
  'http://localhost'
];

function isPrivateNetworkHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const [a, b] = hostname.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith('.vercel.app')) return true;
  try {
    const parsed = new URL(origin);
    return isPrivateNetworkHost(parsed.hostname);
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, cb) { if (isAllowedOrigin(origin)) cb(null, true); else cb(new Error('CORS not allowed')); },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-session-token'],
  optionsSuccessStatus: 204
}));
app.options('*', cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (_req, res) => res.json({ service: 'routex-backend', status: 'ok', version: '1.0.0' }));

app.get('/health', (_req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  res.json({ service: 'routex-backend', status: mongoOk ? 'ok' : 'degraded', database: mongoOk ? 'connected' : 'disconnected', timestamp: nowIso() });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, email, mobile, password, role, captainVehicle, profileImageUrl } = req.body || {};
    if (!username || !displayName || !email || !mobile || !password || !role) return res.status(400).json({ error: 'All fields are required.' });
    const normalizedRole = String(role).trim().toLowerCase();
    if (!['customer','admin','captain'].includes(normalizedRole)) return res.status(400).json({ error: 'Invalid role.' });
    if (normalizedRole === 'captain' && !captainVehicle) return res.status(400).json({ error: 'captainVehicle is required for captains.' });
    const exists = await User.findOne({ $or: [{ username: username.trim().toLowerCase() }, { email: email.trim().toLowerCase() }] });
    if (exists) return res.status(409).json({ error: 'User already exists.' });
    const userId = uuidv4();
    await User.create({
      _id: userId, username: username.trim().toLowerCase(), display_name: displayName.trim(),
      email: email.trim().toLowerCase(), mobile: mobile.trim(),
      password: bcrypt.hashSync(password, 10), role: normalizedRole,
      captain_vehicle: normalizedRole === 'captain' ? String(captainVehicle).trim() : null,
      profile_image: profileImageUrl || null,
      customer_otp_completed: normalizedRole === 'customer' ? 0 : 1,
      created_at: nowIso(), updated_at: nowIso()
    });
    if (normalizedRole !== 'customer') return res.status(201).json({ message: 'Registered successfully.' });
    const tempToken = await issueTempToken(userId);
    const emailOtp = genOtp();
    await OtpCode.create({ _id: uuidv4(), user_id: userId, session_token: tempToken, channel: 'email', code: emailOtp, consumed: 0, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), created_at: nowIso() });
    try { await sendEmailOtp(email.trim().toLowerCase(), emailOtp); } catch (e) {
      await User.deleteOne({ _id: userId });
      return res.status(502).json({ error: 'Could not send OTP email.' });
    }
    const payload = { message: 'OTP sent to email. Verify to complete registration.', requiresOtp: true, tempToken, channels: { email: email.trim().toLowerCase() } };
    if (otpDebugMode) payload.devOtps = { emailOtp };
    return res.status(201).json(payload);
  } catch (err) { console.error('Register error', err); return res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const user = await User.findOne({ username: (username || '').trim().toLowerCase() }).lean();
    if (!user || !bcrypt.compareSync(String(password || ''), String(user.password || ''))) return res.status(401).json({ error: 'Invalid username or password.' });
    const requestedRole = String(role || '').trim().toLowerCase();
    if (requestedRole && requestedRole !== String(user.role || '').toLowerCase()) return res.status(401).json({ error: 'Selected login mode does not match your account role.' });
    if (user.role === 'customer' && Number(user.customer_otp_completed) !== 1) return res.status(403).json({ error: 'Complete OTP verification first.' });
    const sessionToken = await issueSessionToken(user._id);
    return res.json({
      requiresOtp: false, tempToken: '', sessionToken,
      user: { id: user._id, username: user.username, displayName: user.display_name, role: user.role, email: user.email, mobile: user.mobile, captainVehicle: user.captain_vehicle || undefined, profileImageUrl: user.profile_image || undefined },
      message: 'Login successful.', channels: { email: user.email, mobile: user.mobile }
    });
  } catch (err) { console.error('Login error', err); return res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { tempToken, emailOtp } = req.body || {};
    const session = await getSession(tempToken);
    if (!session || session.type !== 'temp') return res.status(401).json({ error: 'Invalid or expired temp token.' });
    const code = await OtpCode.findOne({ session_token: tempToken, channel: 'email', consumed: 0, expires_at: { $gt: nowIso() } }).lean();
    if (!code || code.code !== String(emailOtp || '').trim()) return res.status(400).json({ error: 'Invalid or expired OTP.' });
    await OtpCode.updateMany({ session_token: tempToken }, { $set: { consumed: 1 } });
    await User.updateOne({ _id: session.user_id }, { $set: { customer_otp_completed: 1 } });
    const sessionToken = await issueSessionToken(session.user_id);
    const user = await User.findById(session.user_id).lean();
    return res.json({ sessionToken, user: { id: user._id, username: user.username, displayName: user.display_name, role: user.role, email: user.email, mobile: user.mobile, captainVehicle: user.captain_vehicle || undefined }, message: 'Verified successfully!' });
  } catch (err) { console.error('Verify OTP error', err); return res.status(500).json({ error: 'OTP verification failed.' }); }
});

app.post('/api/auth/logout', requireSession, async (req, res) => {
  await AuthSession.deleteOne({ token: req.session.token });
  return res.json({ message: 'Logged out successfully.' });
});

app.get('/api/auth/me', requireSession, (req, res) => {
  return res.json({ id: req.session.user_id, username: req.session.username, displayName: req.session.display_name, role: req.session.role, email: req.session.email, mobile: req.session.mobile, captainVehicle: req.session.captain_vehicle || undefined, profileImageUrl: req.session.profile_image || undefined });
});

app.post('/api/auth/profile-image', requireSession, async (req, res) => {
  const { profileImageUrl } = req.body || {};
  if (!profileImageUrl) return res.status(400).json({ error: 'profileImageUrl is required.' });
  await User.updateOne({ _id: req.session.user_id }, { $set: { profile_image: String(profileImageUrl).trim() } });
  return res.json({ message: 'Profile image updated successfully.', profileImageUrl: String(profileImageUrl).trim() });
});

app.delete('/api/auth/account', requireSession, async (req, res) => {
  await Promise.all([User.deleteOne({ _id: req.session.user_id }), AuthSession.deleteMany({ user_id: req.session.user_id }), OtpCode.deleteMany({ user_id: req.session.user_id })]);
  return res.json({ message: 'Account deleted successfully.' });
});

app.post('/api/auth/user-action', requireSession, async (req, res) => {
  const { actionType, metadata } = req.body || {};
  if (!actionType) return res.status(400).json({ error: 'actionType is required.' });
  await UserAction.create({ _id: uuidv4(), user_id: req.session.user_id, action_type: actionType, metadata_json: JSON.stringify(metadata || {}), created_at: nowIso() });
  return res.json({ message: 'Action recorded.' });
});

app.get('/api/auth/actions', requireSession, async (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const query = isAdmin ? {} : { user_id: req.session.user_id };
  const rows = await UserAction.find(query).sort({ created_at: -1 }).limit(100).lean();
  return res.json(rows.map(r => ({ actionType: r.action_type, metadata: safeJson(r.metadata_json, {}), createdAt: r.created_at, userId: r.user_id })));
});

app.get('/api/auth/captains', requireSession, async (req, res) => {
  const { vehicleType } = req.query;
  const query = vehicleType ? { role: 'captain', captain_vehicle: String(vehicleType) } : { role: 'captain' };
  const captains = await User.find(query).select('_id username display_name mobile captain_vehicle profile_image').lean();
  return res.json(captains.map(c => ({ id: c._id, username: c.username, displayName: c.display_name, phone: c.mobile, vehicleType: c.captain_vehicle || undefined, profileImageUrl: c.profile_image || undefined, availability: 'available' })));
});

app.get('/api/auth/users', requireSession, async (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });
  const users = await User.find({}).select('_id username display_name email mobile role captain_vehicle created_at').sort({ created_at: -1 }).lean();
  return res.json(users.map(u => ({ id: u._id, username: u.username, displayName: u.display_name, email: u.email, mobile: u.mobile, role: u.role, captainVehicle: u.captain_vehicle || undefined, createdAt: u.created_at })));
});

app.get('/api/auth/users/stats', requireSession, async (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });
  const [total, customers, captains, admins] = await Promise.all([User.countDocuments(), User.countDocuments({ role: 'customer' }), User.countDocuments({ role: 'captain' }), User.countDocuments({ role: 'admin' })]);
  return res.json({ totalUsers: total, totalCustomers: customers, totalCaptains: captains, totalAdmins: admins });
});

app.post('/api/auth/captain-feedback', requireSession, async (req, res) => {
  const { bookingId, captainId, captainName, rideRating, captainRating, feedbackText, lovedRide, lovedCaptain } = req.body || {};
  if (!bookingId || !captainName || !rideRating || !captainRating) return res.status(400).json({ error: 'bookingId, captainName, rideRating, captainRating are required.' });
  const now = nowIso();
  const existing = await CaptainFeedback.findOne({ booking_id: String(bookingId) });
  const data = { captain_user_id: captainId || null, captain_name: String(captainName).trim(), submitted_by_user_id: req.session.user_id, submitted_by_name: req.session.display_name || req.session.username, ride_rating: Number(rideRating), captain_rating: Number(captainRating), feedback_text: feedbackText || null, loved_ride: lovedRide ? 1 : 0, loved_captain: lovedCaptain ? 1 : 0, updated_at: now };
  if (existing) { await CaptainFeedback.updateOne({ booking_id: String(bookingId) }, { $set: data }); }
  else { await CaptainFeedback.create({ _id: uuidv4(), booking_id: String(bookingId), ...data, created_at: now }); }
  return res.json({ message: 'Feedback submitted.' });
});

app.get('/api/auth/captain-feedback/stats', requireSession, async (req, res) => {
  if (!['captain','admin'].includes(req.session.role)) return res.status(403).json({ error: 'Captain or admin role required.' });
  const captainUserId = req.session.role === 'admin' ? (req.query.captainId || '') : req.session.user_id;
  const allFeedback = await CaptainFeedback.find({ captain_user_id: captainUserId }).lean();
  const feedbackCount = allFeedback.length;
  const avgCaptainRating = feedbackCount ? Number((allFeedback.reduce((s,f) => s + Number(f.captain_rating||0), 0) / feedbackCount).toFixed(1)) : 0;
  const avgRideRating = feedbackCount ? Number((allFeedback.reduce((s,f) => s + Number(f.ride_rating||0), 0) / feedbackCount).toFixed(1)) : 0;
  const totalHearts = allFeedback.reduce((s,f) => s + Number(f.loved_captain||0) + Number(f.loved_ride||0), 0);
  const recentComments = await CaptainFeedback.find({ captain_user_id: captainUserId, feedback_text: { $nin: [null,''] } }).sort({ created_at: -1 }).limit(8).lean();
  return res.json({ feedbackCount, avgCaptainRating, avgRideRating, totalHearts, recentComments: recentComments.map(r => ({ bookingId: r.booking_id, userName: r.submitted_by_name, rideRating: r.ride_rating, captainRating: r.captain_rating, feedbackText: r.feedback_text, lovedRide: toBool(r.loved_ride), lovedCaptain: toBool(r.loved_captain), createdAt: r.created_at })) });
});

app.post('/api/auth/voice-challenge', requireSession, async (_req, res) => {
  const phrases = ['confirm secure delivery now', 'my parcel is ready to drop', 'verify identity for delivery'];
  return res.json({ phrase: phrases[Math.floor(Math.random() * phrases.length)], expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString() });
});

app.post('/api/auth/voice-verify', requireSession, async (_req, res) => {
  return res.json({ message: 'Voice verified successfully.' });
});

// ── BOOKINGS ─────────────────────────────────────────────────────────────────

// SSE client registry: clientId → { res, role, userId }
const sseClients = new Map();

function notifyCaptains(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of sseClients) {
    if (client.role === 'captain') {
      try { client.res.write(payload); } catch { sseClients.delete(id); }
    }
  }
}

function notifyRideAudience(eventName, data, customerUserId) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const customerId = String(customerUserId || '').trim();
  for (const [id, client] of sseClients) {
    const isCaptain = client.role === 'captain';
    const isBookingCustomer = customerId.length > 0 && String(client.userId || '') === customerId;
    if (!isCaptain && !isBookingCustomer) continue;
    try { client.res.write(payload); } catch { sseClients.delete(id); }
  }
}

app.get('/api/events', async (req, res) => {
  const token = req.headers['x-session-token'] || req.query.sessionToken;
  const session = await getSession(token);
  if (!session || session.type !== 'session') return res.status(401).json({ error: 'Valid session token required.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = `${session.user_id}_${Date.now()}`;
  sseClients.set(clientId, { res, role: session.role, userId: session.user_id });

  res.write(`event: connected\ndata: ${JSON.stringify({ userId: session.user_id, role: session.role })}\n\n`);

  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); sseClients.delete(clientId); } }, 25000);

  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(clientId); });
});

app.get('/api/bookings', requireSession, async (req, res) => {
  try {
    const includeCompleted = String(req.query.includeCompleted || '').toLowerCase() === 'true';
    const maxItems = Math.min(500, Number(req.query.limit || 200));
    const allRows = await Booking.find({}).sort({ updated_at: -1 }).limit(maxItems).lean();
    // canAccessBooking: admin=all, customer=own, captain=notificationTarget='all' OR assigned
    const visible = allRows.filter(row => canAccessBooking(req.session, row));
    const filtered = visible.filter(row => {
      if (!includeCompleted && row.status !== 'completed' && row.status !== 'cancelled') return true;
      if (!includeCompleted && (row.status === 'completed' || row.status === 'cancelled')) return false;
      return true;
    });
    return res.json(filtered.map(mapBookingRow));
  } catch (err) { console.error('GET /api/bookings error', err); return res.status(500).json({ error: 'Failed to fetch bookings.' }); }
});

app.get('/api/bookings/:bookingId', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!canAccessBooking(req.session, booking)) return res.status(403).json({ error: 'Access denied.' });
  return res.json(mapBookingRow(booking));
});

app.post('/api/bookings', requireSession, async (req, res) => {
  try {
    const body = req.body || {};
    const now = nowIso();
    const pickup = body.pickup || {};
    const drop = body.drop || {};
    if (!pickup.address || !drop.address) return res.status(400).json({ error: 'pickup and drop addresses are required.' });
    const otp = genOtp();
    const bookingId = String(body.clientRequestId || `BK-${Date.now().toString().slice(-8)}`).trim();
    if (!bookingId) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }
    const existing = await Booking.findById(bookingId).lean();
    if (existing) {
      return res.status(200).json(mapBookingRow(existing));
    }

    // Force broadcast so every captain receives booking notifications.
    const notificationTarget = 'all';
    await Booking.create({
      _id: bookingId,
      user_id: req.session.user_id,
      user_name: req.session.display_name || req.session.username || 'Customer',
      booking_for: body.bookingFor || 'self',
      recipient_name: body.recipientName || null, recipient_phone: body.recipientPhone || null,
      is_scheduled: 0, scheduled_at: body.scheduledAt || null,
      service_type: body.serviceType || 'parcel',
      payment_method: body.paymentMethod || 'cash',
      vehicle_type: body.vehicleType || 'bike',
      pickup_json: JSON.stringify({ address: String(pickup.address), lat: Number(pickup.lat||0), lng: Number(pickup.lng||0) }),
      drop_json: JSON.stringify({ address: String(drop.address), lat: Number(drop.lat||0), lng: Number(drop.lng||0) }),
      current_location_json: JSON.stringify({ address: String(pickup.address), lat: Number(pickup.lat||0), lng: Number(pickup.lng||0) }),
      status: 'created',   // ← 'created' so captain alert fires
      otp, otp_verified: 0,
      driver_name: body.captainName || 'Ravi Kumar',
      driver_phone: body.captainPhone || '+91-90000-12345',
      captain_id: body.captainId || null,
      notification_target: notificationTarget,  // ← 'all' = every captain receives alert
      preferred_captain_id: body.preferredCaptainId || null,
      preferred_captain_name: body.preferredCaptainName || null,
      notification: notificationTarget === 'all' ? `Booking confirmed. OTP ${otp}. Broadcast to all captains.` : `Booking confirmed. OTP ${otp}. Preferred captain notified.`,
      estimated_fare: body.estimatedFare != null ? Number(body.estimatedFare) : null,
      ride_notes: body.rideNotes || null,
      sos_triggered: 0, sos_by_role: null, feedback_submitted: 0, feedback_submitted_at: null,
      feedback_text: null, ride_rating: null, captain_rating: null,
      loved_ride: 0, loved_captain: 0, final_amount: null, payment_done: 0, payment_done_at: null,
      tracking_closed: 0, tracking_closed_at: null,
      created_at: now, updated_at: now
    });
    const created = await Booking.findById(bookingId).lean();
    const mapped = mapBookingRow(created);
    notifyRideAudience('new_booking', mapped, created?.user_id);
    return res.status(201).json(mapped);
  } catch (err) { console.error('POST /api/bookings error', err); return res.status(500).json({ error: 'Failed to create booking.' }); }
});

app.post('/api/bookings/:bookingId/approve', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!canAccessBooking(req.session, booking)) return res.status(403).json({ error: 'Access denied.' });
  if (booking.status !== 'created') return res.status(400).json({ error: 'Booking is no longer available.' });
  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'assigned', notification: 'Captain accepted the ride and is on the way.', updated_at: nowIso() } });
  const updated = mapBookingRow(await Booking.findById(booking._id).lean());
  notifyCaptains('booking_updated', updated);
  return res.json(updated);
});

app.post('/api/bookings/:bookingId/verify-otp', requireSession, async (req, res) => {
  const { otp } = req.body || {};
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!canAccessBooking(req.session, booking)) return res.status(403).json({ error: 'Access denied.' });
  if (String(booking.otp).trim() !== String(otp||'').trim()) return res.status(400).json({ error: 'Invalid OTP.' });
  await Booking.updateOne({ _id: booking._id }, { $set: { otp_verified: 1, status: 'assigned', notification: 'OTP verified. Ride started.', updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

app.post('/api/bookings/:bookingId/cancel', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!canAccessBooking(req.session, booking)) return res.status(403).json({ error: 'Access denied.' });
  if (['completed','cancelled'].includes(booking.status)) return res.status(400).json({ error: 'Cannot cancel this booking.' });
  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'cancelled', notification: `Ride cancelled by ${req.body.role || 'user'}.`, updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

app.post('/api/bookings/:bookingId/sos', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  await Booking.updateOne({ _id: booking._id }, { $set: { sos_triggered: 1, sos_by_role: req.body.role || 'customer', notification: 'SOS triggered. Emergency help alerted.', updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

app.post('/api/bookings/:bookingId/feedback', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  const { rideRating, captainRating, feedbackText, lovedRide, lovedCaptain } = req.body || {};
  await Booking.updateOne({ _id: booking._id }, { $set: { feedback_submitted: 1, feedback_submitted_at: nowIso(), ride_rating: Number(rideRating||0), captain_rating: Number(captainRating||0), feedback_text: feedbackText || null, loved_ride: lovedRide ? 1 : 0, loved_captain: lovedCaptain ? 1 : 0, notification: 'Feedback submitted. Thank you!', updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

app.post('/api/bookings/:bookingId/pay', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  const finalAmount = Number(req.body.amount || booking.estimated_fare || 0);
  await Booking.updateOne({ _id: booking._id }, { $set: { final_amount: finalAmount, payment_done: 1, payment_done_at: nowIso(), notification: `Payment of Rs ${finalAmount} completed.`, updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

app.post('/api/bookings/:bookingId/close-tracking', requireSession, async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId).lean();
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  await Booking.updateOne({ _id: booking._id }, { $set: { tracking_closed: 1, tracking_closed_at: nowIso(), status: 'completed', notification: 'Tracking closed. Trip completed.', updated_at: nowIso() } });
  return res.json(mapBookingRow(await Booking.findById(booking._id).lean()));
});

// ── MISC ─────────────────────────────────────────────────────────────────────

app.get('/api/integrations/health', async (_req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  return res.json({ service: 'routex-backend', status: mongoOk ? 'ok' : 'degraded', checkedAt: nowIso(), integrations: [{ name: 'MongoDB', status: mongoOk ? 'live' : 'down' }, { name: 'Auth API', status: 'live' }, { name: 'Booking API', status: 'live' }] });
});

app.get('/api/places/nearby-hotels', (_req, res) => {
  return res.json({ source: 'backend', updatedAt: nowIso(), hotels: [
    { id: 'h1', name: 'Spice Garden', category: 'nonveg', cuisine: 'Indian', locationLabel: 'City Center', distanceKm: 1.2, etaMinutes: 15, rating: 4.2, openNow: true, priceForTwo: 250 },
    { id: 'h2', name: 'Pizza Palace', category: 'veg', cuisine: 'Italian', locationLabel: 'MG Road', distanceKm: 0.8, etaMinutes: 10, rating: 4.5, openNow: true, priceForTwo: 400 },
    { id: 'h3', name: 'Burger Hub', category: 'nonveg', cuisine: 'Fast Food', locationLabel: 'Bus Stand', distanceKm: 2.1, etaMinutes: 20, rating: 4.0, openNow: true, priceForTwo: 300 }
  ]});
});

app.get('/api/menu/hotels/:hotelId/items', (req, res) => {
  const menus = {
    h1: [{ id:'i1', name:'Special Thali', price:120, description:'Full meal', category:'veg', isTop:true }, { id:'i2', name:'Chicken Curry', price:160, description:'Rich gravy', category:'nonveg', isTop:true }],
    h2: [{ id:'i5', name:'Margherita Pizza', price:180, description:'Classic', category:'veg', isTop:true }, { id:'i6', name:'Pepperoni Pizza', price:220, description:'Loaded', category:'nonveg', isTop:true }],
    h3: [{ id:'i8', name:'Classic Burger', price:90, description:'Juicy', category:'nonveg', isTop:true }, { id:'i9', name:'Veg Burger', price:70, description:'Crispy', category:'veg', isTop:true }]
  };
  return res.json({ source:'backend', hotelId: req.params.hotelId, updatedAt: nowIso(), items: menus[req.params.hotelId] || menus.h1 });
});

app.post('/api/pricing/live-fare', async (req, res) => {
  const { vehicleType } = req.body || {};
  const rates = { bike:8, auto:12, scooter:10, car:18, van:22, truck:28 };
  const rate = rates[vehicleType] || 12;
  return res.json({ distanceKm: 5, durationInTrafficMinutes: 20, trafficCondition: 'medium', weatherCondition: 'clear', breakdown: { baseFare: 55, distanceFare: rate*5, total: 55 + rate*5 } });
});

app.post('/api/promos/validate', (req, res) => {
  const catalog = [{ code:'SAVE10', type:'percent', value:10, minAmount:120 }, { code:'FLAT50', type:'flat', value:50, minAmount:250 }, { code:'FIRST100', type:'flat', value:100, minAmount:500 }];
  const promo = catalog.find(p => p.code === String(req.body.code||'').toUpperCase());
  if (!promo) return res.status(404).json({ valid: false, error: 'Invalid promo code.' });
  const amount = Number(req.body.amount || 0);
  if (amount < promo.minAmount) return res.status(400).json({ valid: false, error: `Minimum Rs ${promo.minAmount} required.` });
  const discount = promo.type === 'flat' ? promo.value : Math.round(amount * promo.value / 100);
  return res.json({ valid: true, code: promo.code, discount, payableAmount: Math.max(0, amount - discount) });
});

app.post('/api/support/complaints', async (req, res) => {
  const { type, subject, name, contact, description } = req.body || {};
  if (!type || !subject || !description) return res.status(400).json({ error: 'type, subject, description required.' });

  const requestMeta = {
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    userAgent: req.headers['user-agent'] || ''
  };

  try {
    const githubIssue = await createGithubIssueForBugReport({ type, subject, name, contact, description, requestMeta });
    console.log(`[Support] type=${type} subject=${subject}${githubIssue ? ` issue=#${githubIssue.issueNumber}` : ''}`);

    if (githubIssue) {
      return res.status(201).json({
        message: 'Bug submitted and GitHub issue created successfully.',
        issueNumber: githubIssue.issueNumber,
        issueUrl: githubIssue.issueUrl
      });
    }

    return res.status(201).json({ message: 'Complaint submitted successfully.' });
  } catch (error) {
    console.error('Support complaint error', error);
    return res.status(502).json({ error: `Failed to raise bug in GitHub: ${error.message}` });
  }
});

app.post('/api/support/app-feedback', async (req, res) => {
  console.log('[AppFeedback]', req.body);
  return res.status(201).json({ message: 'App feedback submitted successfully.' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ============================================================================
// START
// ============================================================================

async function start() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('MongoDB connected!');
    app.listen(port, () => {
      console.log(`routex-backend listening on :${port}`);
    });
  } catch (err) {
    console.error('Failed to start', err);
    process.exit(1);
  }
}

start();
