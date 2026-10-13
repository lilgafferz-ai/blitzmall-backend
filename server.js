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

const app = express();
app.set('trust proxy', 1);
// Downloadable APK(s) live OUTSIDE the web build so they aren't bundled into the
// app itself. Still served at the same /apk/... URL the Share screen/QR use.
app.use('/apk', express.static(path.join(ROOT, 'shop-frontend/downloads')));
// Self-hosted over-the-air web bundles for the native app (see /api/native-update)
app.use('/updates', express.static(path.join(ROOT, 'shop-frontend/ota')));
// Serve React frontend
app.use(express.static(path.join(ROOT, 'shop-frontend/build')));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
// Product photos are uploaded as base64 data URLs, so the body limit has to fit
// one full-size phone photo — 15 MB does, without letting a client push 50 MB
// JSON blobs at the server.
app.use(express.json({ limit: '15mb' }));

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
