// Push notifications (FCM), the PC feed and staff stock alerts.
const { ObjectId } = require('mongodb');
const { col } = require('./db');

// ===== PUSH NOTIFICATIONS (Firebase Cloud Messaging) =====
// Fully config-guarded: everything here no-ops gracefully until the owner adds
// FCM_SERVICE_ACCOUNT_JSON (a Firebase service-account key, pasted as JSON) to
// the server env. The Android app, PC app and website register their device
// tokens with /api/notifications/register; the server sends through the FCM
// HTTP v1 API via firebase-admin.
let fcmApp = null;
let fcmProjectId = null;
let fcmWarned = false;
// Accept the service-account key in the common pasted forms: raw multi-line
// JSON, single-line JSON, JSON wrapped in quotes, or base64-encoded JSON
// (Render/env managers can mangle multi-line values — base64 sidesteps that).
function parseServiceAccount(rawInput) {
  if (!rawInput) return null;
  let text = String(rawInput).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    try { return JSON.parse(Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8')); } catch (e) { /* fall through */ }
  }
  return null;
}
function getFcmApp() {
  if (fcmApp) return fcmApp;
  try {
    const parsed = parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT_JSON);
    if (!parsed) return null; // no key configured yet — stay silent
    if (!parsed.client_email || !parsed.private_key) {
      if (!fcmWarned) { console.error('FCM init failed: FCM_SERVICE_ACCOUNT_JSON is set but not a valid Firebase service-account key (missing client_email/private_key)'); fcmWarned = true; }
      return null;
    }
    const { initializeApp, cert } = require('firebase-admin/app');
    fcmApp = initializeApp({ credential: cert(parsed) }, 'blitzmall');
    fcmProjectId = parsed.project_id || null;
    return fcmApp;
  } catch (e) {
    if (!fcmWarned) { console.error('FCM init failed:', e.message); fcmWarned = true; }
    return null;
  }
}
const fcmConfigured = () => !!getFcmApp();
const fcmProject = () => (getFcmApp(), fcmProjectId);

async function sendToTokens(tokens, title, body, data = {}) {
  const { getMessaging } = require('firebase-admin/messaging');
  let sent = 0;
  for (const token of tokens) {
    try {
      await getMessaging(fcmApp).send({ token, notification: { title: String(title || 'BlitzMall'), body: String(body || '') }, data: { ...data, click_action: 'FCM_PLUGIN_ACTIVITY' } });
      sent++;
    } catch (e) {
      // Dead token (uninstalled/revoked) — drop it so we never retry it.
      if (e && e.code === 'messaging/registration-token-not-registered') await col.notification_tokens.deleteMany({ token });
    }
  }
  return { sent };
}

// ===== PC notification feed (Electron desktop toasts) =====
// Real web push is unavailable inside Electron (no PushManager), so the desktop
// app polls this small event feed and shows native Windows toasts. Events are
// written alongside every FCM push (and for new orders) so the PC bridge works
// even before FCM service-account credentials are configured.
async function addFeedEvent({ audience, phone, title, body }) {
  try {
    if (!col.notifications_feed) return;
    const doc = {
      audience, // 'admin' | 'customer' | 'all'
      phone: phone ? String(phone).replace(/[^0-9]/g, '') : null,
      title: String(title || 'BlitzMall'),
      body: String(body || ''),
      createdAt: new Date()
    };
    await col.notifications_feed.insertOne(doc);
    // Keep the feed small — anything older than 3 days is irrelevant to a poller.
    try {
      await col.notifications_feed.deleteMany({ createdAt: { $lt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    } catch (e) {}
  } catch (e) { console.error('addFeedEvent failed:', e.message); }
}

async function sendPushToPhone(phone, title, body, data = {}) {
  // The PC feed gets the event regardless of FCM setup (fire-and-forget —
  // addFeedEvent catches its own errors).
  if (phone) addFeedEvent({ audience: 'customer', phone, title, body });
  if (!phone || !fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const tokens = await col.notification_tokens.find({ phone }).toArray();
    const uniq = [...new Set(tokens.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToPhone failed:', e.message); return { sent: 0 }; }
}

async function sendPushToAll(title, body, data = {}) {
  await addFeedEvent({ audience: 'all', title, body });
  if (!fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const all = await col.notification_tokens.find().toArray();
    const uniq = [...new Set(all.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToAll failed:', e.message); return { sent: 0 }; }
}

// Real OS-level push to every STAFF device (owner / cashier / manager) that
// logged into the admin section and enabled notifications. Used for NEW ORDERS
// only — staff pop-ups stay about orders, nothing else. The PC feed toast is
// always written too, so the shop PC alerts even before FCM is configured.
async function sendPushToStaff(title, body, data = {}) {
  await addFeedEvent({ audience: 'admin', title, body });
  if (!fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const staff = await col.notification_tokens.find({ role: 'staff' }).toArray();
    const uniq = [...new Set(staff.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToStaff failed:', e.message); return { sent: 0 }; }
}

// Push to the OWNER's devices only (the nightly closing report — figures
// cashiers don't need). No feed event: the PC feed is read without a login.
async function sendPushToOwners(title, body, data = {}) {
  if (!fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const owners = await col.notification_tokens.find({ role: 'staff', staffRole: 'owner' }).toArray();
    const uniq = [...new Set(owners.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToOwners failed:', e.message); return { sent: 0 }; }
}

// Push to ONE staff member's devices only (the "Send test" button in the
// Admin Notify tab). Deliberately writes NO feed event, so a single-device
// test doesn't toast on every shop PC.
async function sendPushToStaffUser(staffUsername, title, body, data = {}) {
  if (!staffUsername || !fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const tokens = await col.notification_tokens.find({ role: 'staff', staffUser: String(staffUsername).toLowerCase().trim() }).toArray();
    const uniq = [...new Set(tokens.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToStaffUser failed:', e.message); return { sent: 0 }; }
}

// ===== STAFF STOCK / EXPIRY ALERTS =====
// The shop owner asked for push notifications when something goes out of
// stock, runs low, or is about to expire. One push per alert TYPE per sweep
// (listing the products involved) keeps it readable; marker fields on each
// product (alertedOutAt / alertedLowAt / alertedExpiryAt / alertedExpiredAt)
// mean an item alerts once per state CHANGE, not every sweep — restocking or
// re-dating clears the marker so it can alert again next time it crosses.
// Note: LOW_STOCK_THRESHOLD (5) is deliberately more proactive than the <2
// threshold the in-dashboard alerts list uses — a push should warn staff well
// before the item actually runs out.
const LOW_STOCK_THRESHOLD = 5; // alert staff when stock falls below this
const EXPIRY_ALERT_DAYS = 7;   // alert staff when a product expires within this window
const ALERT_SWEEP_MS = 30 * 60 * 1000; // background re-check every 30 min
// In-process throttle: hook-triggered sweeps (orders/sales/product edits) run
// at most once every 30s. Keeps a burst of sales at the till from costing a
// full catalogue scan each, and stops overlapping sweeps double-pushing the
// same alert (the interval remains the authoritative catch-all).
const ALERT_SWEEP_MIN_INTERVAL_MS = 30 * 1000;
let lastAlertSweepAt = 0;
let alertSweepBusy = false; // one sweep at a time — stops a slow scan overlapping a new one and double-pushing
const scheduleAlertSweep = () => {
  const now = Date.now();
  if (now - lastAlertSweepAt < ALERT_SWEEP_MIN_INTERVAL_MS) return;
  if (alertSweepBusy) return; // previous sweep still scanning — the per-product markers catch it next time
  lastAlertSweepAt = now;
  alertSweepBusy = true;
  notifyStaffAlerts().finally(() => { alertSweepBusy = false; });
};

const summarizeAlertProducts = (products) => {
  const names = products.slice(0, 5).map(p => String(p.name || 'Product').trim()).filter(Boolean);
  const extra = products.length - names.length;
  return extra > 0 ? `${names.join(', ')} (+${extra} more)` : names.join(', ');
};

// Scan the catalogue and alert staff (real OS push + PC feed) about products
// that are out of stock, running low, or expiring soon. Runs on a timer and
// after every stock change (orders, sales, product edits), so the shop PC and
// staff phones hear about it within seconds — no manual polling.
async function notifyStaffAlerts() {
  try {
    if (!col.products) return;
    const products = await col.products.find().toArray();
    const now = Date.now();
    const expiryCutoff = new Date(now + EXPIRY_ALERT_DAYS * 24 * 3600 * 1000);
    const out = [], low = [], expired = [], expiring = [];

    for (const p of products) {
      const stock = parseInt(p.stock, 10);
      const isOut = !isNaN(stock) && stock <= 0;
      const isLow = !isNaN(stock) && stock > 0 && stock < LOW_STOCK_THRESHOLD;
      const exp = p.expiryDate ? new Date(p.expiryDate) : null;
      const isExpired = !!exp && !isNaN(exp.getTime()) && exp.getTime() < now;
      const isExpiring = !!exp && !isNaN(exp.getTime()) && !isExpired && exp.getTime() <= expiryCutoff.getTime();
      const id = p._id;

      if (isOut && !p.alertedOutAt) { out.push(p); await col.products.updateOne({ _id: id }, { $set: { alertedOutAt: new Date() } }); }
      else if (!isOut && p.alertedOutAt) await col.products.updateOne({ _id: id }, { $set: { alertedOutAt: null } });

      if (isLow && !p.alertedLowAt) { low.push(p); await col.products.updateOne({ _id: id }, { $set: { alertedLowAt: new Date() } }); }
      else if (!isLow && p.alertedLowAt) await col.products.updateOne({ _id: id }, { $set: { alertedLowAt: null } });

      if (isExpired && !p.alertedExpiredAt) { expired.push(p); await col.products.updateOne({ _id: id }, { $set: { alertedExpiredAt: new Date() } }); }
      else if (!isExpired && p.alertedExpiredAt) await col.products.updateOne({ _id: id }, { $set: { alertedExpiredAt: null } });

      if (isExpiring && !p.alertedExpiryAt) { expiring.push(p); await col.products.updateOne({ _id: id }, { $set: { alertedExpiryAt: new Date() } }); }
      else if (!isExpiring && p.alertedExpiryAt) await col.products.updateOne({ _id: id }, { $set: { alertedExpiryAt: null } });
    }

    if (out.length) sendPushToStaff('🚨 Out of stock', `${summarizeAlertProducts(out)} ${out.length === 1 ? 'is' : 'are'} out of stock`);
    if (low.length) sendPushToStaff('⚠️ Low stock', `${summarizeAlertProducts(low)} ${low.length === 1 ? 'has' : 'have'} less than ${LOW_STOCK_THRESHOLD} left in stock`);
    if (expired.length) sendPushToStaff('❌ Product expired', `${summarizeAlertProducts(expired)} ${expired.length === 1 ? 'has' : 'have'} expired`);
    if (expiring.length) sendPushToStaff('⏰ Expiring soon', `${summarizeAlertProducts(expiring)} expire${expiring.length === 1 ? 's' : ''} within ${EXPIRY_ALERT_DAYS} days`);
  } catch (e) { console.error('notifyStaffAlerts failed:', e.message); }
}

// One-time customer + staff notification when an M-Pesa payment is confirmed.
// Atomically claimed per checkout id so the callback, the status-query and the
// mock path can all call it without ever double-pushing the same payment.
async function notifyPaymentConfirmed(reqDoc) {
  try {
    if (!reqDoc || !col.db) return;
    const claimed = await col.db.collection('mpesa_requests').findOneAndUpdate(
      { checkoutRequestId: reqDoc.checkoutRequestId, notifSent: { $ne: true } },
      { $set: { notifSent: true, notifSentAt: new Date() } }
    );
    const doc = claimed && claimed.value !== undefined ? claimed.value : claimed;
    if (!doc) return; // someone else already notified this payment
    const amount = Math.round((doc.amount || 0) * 100) / 100;
    // Staff alert — PII-free, so the unauthenticated PC feed stays safe.
    sendPushToStaff('💵 Payment received', `M-Pesa payment of KES ${amount} confirmed`);
    // Customer alert — keyed off the order's customerId (the same format their
    // device token was registered under), then the POS sale draft, then the
    // M-Pesa number converted back to the local 07... format.
    let customerPhone = null;
    if (doc.orderId && ObjectId.isValid(doc.orderId)) {
      const order = await col.orders.findOne({ _id: new ObjectId(doc.orderId) });
      customerPhone = order ? order.customerId : null;
    }
    if (!customerPhone && doc.saleDraft && doc.saleDraft.customerPhone) {
      customerPhone = String(doc.saleDraft.customerPhone).replace(/[^0-9]/g, '');
    }
    if (!customerPhone && doc.phone) {
      const p = String(doc.phone);
      customerPhone = p.startsWith('254') ? '0' + p.slice(3) : p;
    }
    if (customerPhone) sendPushToPhone(customerPhone, '✅ Payment received', `Your M-Pesa payment of KES ${amount} was received. Thank you!`);
  } catch (e) { console.error('notifyPaymentConfirmed failed:', e.message); }
}

module.exports = { fcmApp, fcmProjectId, fcmWarned, parseServiceAccount, getFcmApp, fcmConfigured, fcmProject, sendToTokens, addFeedEvent, sendPushToPhone, sendPushToAll, sendPushToStaff, sendPushToStaffUser, sendPushToOwners, LOW_STOCK_THRESHOLD, EXPIRY_ALERT_DAYS, ALERT_SWEEP_MS, ALERT_SWEEP_MIN_INTERVAL_MS, lastAlertSweepAt, alertSweepBusy, scheduleAlertSweep, summarizeAlertProducts, notifyStaffAlerts, notifyPaymentConfirmed };
