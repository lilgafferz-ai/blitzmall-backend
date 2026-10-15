// BlitzMall backend entry point.
//
//   server.js        app wiring: middleware, route registration, boot
//   lib/*.js         shared logic (db, auth, orders, loyalty, M-Pesa, push…)
//   routes/*.js      HTTP endpoints, one file per area of the shop
//
// `node server.js` connects to MongoDB, runs the idempotent seeds in
// lib/seed.js and starts listening. Tests require this file and call connectDb().
require('dotenv').config();
// The shop runs on Nairobi time. Render's containers default to UTC, which made
// "today" on the dashboard start at 03:00 EAT, happy-hour pricing fire three
// hours late and the M-Pesa request timestamp drift from East Africa Time. Pin
// the process clock to the shop's zone unless the host explicitly set TZ.
process.env.TZ = process.env.TZ || 'Africa/Nairobi';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { signCustomerToken } = require('./lib/auth');
const { PORT, ROOT } = require('./lib/config');
const { client, col, connectDatabase } = require('./lib/db');
const { prepareShop } = require('./lib/seed');
const { globalLimiter } = require('./lib/limiters');
const { LOYALTY_SETTINGS_DEFAULTS, SCRATCH_OUTCOMES, WHEEL_SECTORS, customerTier, earnPoints, getLoyaltySettings, issueVoucher, moneyPrizeUnlocked, pickWeighted, promoDayKey, reversePoints, tierFromPoints } = require('./lib/loyalty');
const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, getMpesaToken, verifyMpesaRequest } = require('./lib/mpesa');
const { ALERT_SWEEP_MS, LOW_STOCK_THRESHOLD, notifyPaymentConfirmed, notifyStaffAlerts, parseServiceAccount, scheduleAlertSweep, sendPushToStaffUser } = require('./lib/notifications');
const { cancelOrderAndRestore, placeOrder, provisionalDeliveryFee } = require('./lib/orders');
const { applyPricingRules } = require('./lib/pricing');
const { orderProfit } = require('./lib/reports');
const { otpScreenFallback, otpStore } = require('./lib/sms');
const { dailyReportTick } = require('./lib/dailyReport');
const { submitPendingInvoices } = require('./lib/etims');

const app = express();
app.set('trust proxy', 1);

// Security headers go first so the web app's own pages (index.html, sw.js…)
// carry them too, not just the API. The CSP's job is script-src: only our own
// bundle (and Firebase's service-worker scripts) may run, so an injected
// <script> or inline handler can't steal the staff token from localStorage.
// Styles stay 'unsafe-inline' (the splash screen and React style props use
// them); images and API calls may go to any https host (product photos come
// from all over the web, and the API base is configurable).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://www.gstatic.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  // Product photos and the OTA zip are fetched by the native app from
  // https://localhost — let other origins load them.
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS: only our own apps may call the API from a browser.
//  - same origin (the web app served by this server, any domain it's on)
//  - the Android app (Capacitor serves the bundle from https://localhost)
//  - the PC app (Electron loads index.html from disk → Origin "null")
//  - local development (localhost / 127.0.0.1 on any port)
//  - anything listed in CORS_ORIGINS (comma-separated, e.g. a custom domain)
// Requests without an Origin (Safaricom callbacks, curl, server-to-server) are
// not browser cross-origin calls and pass through untouched. Auth is a bearer
// token, never a cookie, so this is defence in depth, not the lock itself.
const EXTRA_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const LOCAL_ORIGIN = /^(https?|capacitor|ionic):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
function corsOriginAllowed(origin, req) {
  if (!origin) return true;
  if (origin === 'null' || LOCAL_ORIGIN.test(origin) || EXTRA_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).host === req.get('host'); } catch (e) { return false; }
}
app.use(cors((req, cb) => cb(null, {
  origin: corsOriginAllowed(req.get('origin'), req),
  exposedHeaders: ['X-Renewed-Token']
})));

// Downloadable APK(s) live OUTSIDE the web build so they aren't bundled into the
// app itself. Still served at the same /apk/... URL the Share screen/QR use.
app.use('/apk', express.static(path.join(ROOT, 'shop-frontend/downloads')));
// Self-hosted over-the-air web bundles for the native app (see /api/native-update)
app.use('/updates', express.static(path.join(ROOT, 'shop-frontend/ota')));
// Serve React frontend
app.use(express.static(path.join(ROOT, 'shop-frontend/build')));

// Request bodies: 1 MB everywhere (a 100-line order or till sale is ~20 KB),
// except the staff routes that upload product/banner photos as base64 data
// URLs — those get 15 MB, enough for one full-size phone photo. A body parsed
// by the first parser is skipped by the second.
const PHOTO_UPLOAD_ROUTES = ['/api/admin/products', '/api/admin/banners'];
app.use(PHOTO_UPLOAD_ROUTES, express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  next(err);
});

// NoSQL-injection sanitizer (Express 5-safe). Runs AFTER the JSON parser so the
// body actually exists when it is cleaned. Strips dangerous keys ($-prefixed
// or containing ".") from request data in place, and re-pins a sanitized
// req.query via defineProperty (assignment to req.query throws in Express 5).
function stripKeys(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      stripKeys(obj[key], depth + 1);
    }
  }
  return obj;
}
app.use((req, res, next) => {
  try { if (req.body) stripKeys(req.body); } catch (e) {}
  try { if (req.params) stripKeys(req.params); } catch (e) {}
  try {
    const q = req.query;
    if (q && typeof q === 'object') {
      stripKeys(q);
      Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
    }
  } catch (e) {}
  next();
});
app.use(globalLimiter);
// API answers carry personal and financial data: never let a browser, proxy or
// shared PC keep a copy (the apps always ask the server fresh).
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });


// Connect, migrate/seed, and (when run directly) start listening.
async function connectDb() {
  await connectDatabase();
  await prepareShop();
  if (require.main === module) startServer();
}

// ===== BOOT =====
function startServer() {
  app.listen(PORT, () => {
    console.log(`🚀 Shop backend running on http://localhost:${PORT}`);
    console.log(`📦 Database initialization complete`);

    // Pre-warm the M-Pesa OAuth token so the FIRST payment doesn't pay an extra
    // ~1-2s for the token round-trip, then refresh every 50 min (cache lasts 55)
    // so a live sale never hits a cold token.
    const mpesaConfigured = MPESA_CONSUMER_KEY && !MPESA_CONSUMER_KEY.startsWith('your_') &&
                            MPESA_CONSUMER_SECRET && !MPESA_CONSUMER_SECRET.startsWith('your_');
    if (mpesaConfigured && process.env.MPESA_MOCK_ENABLED !== 'true') {
      const warm = () => getMpesaToken()
        .then(() => console.log('🔥 M-Pesa token pre-warmed'))
        .catch(e => console.warn('M-Pesa token pre-warm failed:', e.message));
      warm();
      setInterval(warm, 50 * 60 * 1000);
    }

    // Background stock/expiry alert sweep — catches whatever the order/sale/
    // product hooks miss (manual edits, bulk imports) every 30 minutes, with a
    // first pass a minute after boot so existing problem items alert promptly.
    setTimeout(() => scheduleAlertSweep(), 60 * 1000);
    setInterval(scheduleAlertSweep, ALERT_SWEEP_MS);

    // Nightly closing report to the owner (at the time set in HQ → Records),
    // and the eTIMS retry queue (only does anything once ETIMS_VSCU_URL is set).
    setInterval(dailyReportTick, 60 * 1000);
    setInterval(() => submitPendingInvoices().catch(() => {}), 5 * 60 * 1000);
  });
}

if (require.main === module) {
  connectDb().catch(err => {
    console.error('Fatal database setup error:', err);
    setTimeout(() => process.exit(1), 500);
  });
}

// ===== ROUTES =====
require('./routes/catalog')(app);
require('./routes/auth')(app);
require('./routes/orders')(app);
require('./routes/staff')(app);
require('./routes/pos')(app);
require('./routes/customers')(app);
require('./routes/reports')(app);
require('./routes/loyalty')(app);
require('./routes/mpesa')(app);
require('./routes/ai')(app);
require('./routes/system')(app);
require('./routes/notifications')(app);
require('./routes/wallet')(app);
require('./routes/delivery')(app);
require('./routes/inventoryOps')(app);
require('./routes/taxReports')(app);
require('./routes/productReviews')(app);

// Serve React frontend for any non-API route (React Router support)
app.get('/*path', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/apk') || req.path.startsWith('/updates')) {
    return next();
  }
  res.sendFile(path.join(ROOT, 'shop-frontend/build', 'index.html'));
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = { app, connectDb, client, _test: { placeOrder, cancelOrderAndRestore, signCustomerToken, applyPricingRules, orderProfit, provisionalDeliveryFee, otpScreenFallback, verifyMpesaRequest, customerTier, tierFromPoints, earnPoints, reversePoints, issueVoucher, pickWeighted, WHEEL_SECTORS, SCRATCH_OUTCOMES, promoDayKey, getLoyaltySettings, LOYALTY_SETTINGS_DEFAULTS, mockDb: () => col.db, otpStore, moneyPrizeUnlocked, parseServiceAccount, notifyStaffAlerts, notifyPaymentConfirmed, sendPushToStaffUser, LOW_STOCK_THRESHOLD } };
