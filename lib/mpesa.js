// M-Pesa STK push, Safaricom verification and payment settlement.
const { ObjectId } = require('mongodb');
const { productCache } = require('./cache');
const { col } = require('./db');
const { earnPoints } = require('./loyalty');
const { notifyPaymentConfirmed, scheduleAlertSweep, sendPushToStaff } = require('./notifications');
const { paymentStatusFor, saleTotals } = require('./orders');

// ===== M-PESA STK PUSH =====
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const MPESA_BASE = MPESA_ENV === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const getMpesaCallbackUrl = () => process.env.CALLBACK_URL || 'https://your-deployed-url.com/api/mpesa/callback'; // ⚠️ SET CALLBACK_URL env var!
const mpesaMock = () => process.env.MPESA_MOCK_ENABLED === 'true';

async function safaricomRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });

    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Safaricom returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(
        data.errorMessage ||
        data.error_description ||
        data.message ||
        `Safaricom HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// Token cache (valid for ~55 minutes out of 60)
let _mpesaTokenCache = { token: null, expiresAt: 0 };

async function getMpesaToken() {
  if (_mpesaTokenCache.token && Date.now() < _mpesaTokenCache.expiresAt) {
    return _mpesaTokenCache.token;
  }
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  try {
    const data = await safaricomRequest(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!data.access_token) {
      throw new Error(data.errorMessage || 'No access_token in response');
    }
    _mpesaTokenCache = { token: data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
    return data.access_token;
  } catch (e) {
    throw new Error(`M-Pesa token request failed: ${e.message}`);
  }
}

// Daraja expects East Africa Time — the process clock is pinned to
// Africa/Nairobi at the top of this file.
function mpesaTimestamp() {
  const d = new Date();
  return d.getFullYear().toString() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + String(d.getSeconds()).padStart(2,'0');
}

function formatPhone(phone) {
  let p = (phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

const mpesaCredentialsReady = () =>
  MPESA_CONSUMER_KEY && !MPESA_CONSUMER_KEY.startsWith('your_') &&
  MPESA_CONSUMER_SECRET && !MPESA_CONSUMER_SECRET.startsWith('your_') &&
  MPESA_SHORTCODE && !MPESA_SHORTCODE.startsWith('your_') &&
  MPESA_PASSKEY && !MPESA_PASSKEY.startsWith('your_');

// ---------------------------------------------------------------------------
// Idempotently record a POS sale from a stored M-Pesa draft once payment is
// confirmed. Safe to call from every confirm point (callback, status query,
// mock) — the atomic `saleCreated` flag guarantees the sale is written AT MOST
// ONCE, even if the cashier's browser disconnects between PIN entry and the
// sale being saved. This is what stops "money taken, no sale recorded". The
// draft was cleaned and priced on the server when the prompt was sent, by an
// authenticated staff member — never accepted raw from an anonymous client.
// ---------------------------------------------------------------------------
async function finalizePosSale(checkoutRequestId) {
  if (!col.db) return;
  let claimed;
  try {
    // Atomic claim: only the FIRST caller flips saleCreated false->true and
    // gets the document back. Any later/racing caller matches nothing -> null.
    claimed = await col.db.collection('mpesa_requests').findOneAndUpdate(
      { checkoutRequestId, status: 'confirmed', 'saleDraft.items.0': { $exists: true }, saleCreated: { $ne: true } },
      { $set: { saleCreated: true } }
    );
  } catch (e) { console.error('finalizePosSale claim error:', e.message); return; }

  // mongodb driver v6+ returns the matched doc directly; older returns {value}.
  const reqDoc = claimed && claimed.value !== undefined ? claimed.value : claimed;
  if (!reqDoc || !reqDoc.saleDraft || !Array.isArray(reqDoc.saleDraft.items) || !reqDoc.saleDraft.items.length) return;

  const draft = reqDoc.saleDraft;
  try {
    const items = draft.items;
    const { total, profit } = saleTotals(items);
    const sale = {
      items, total, profit,
      paymentMethod: 'mpesa', amountGiven: 0, cashPart: 0, mpesaPart: total, change: 0,
      staff: draft.staff || 'Owner',
      cashierUserId: draft.cashierUserId || null,
      customerPhone: draft.customerPhone || '',
      channel: 'pos',
      branchId: draft.branchId || null,
      createdAt: new Date(),
      mpesaCheckoutId: checkoutRequestId,
    };
    const result = await col.sales.insertOne(sale);
    for (const it of items) {
      if (it.productId && ObjectId.isValid(it.productId)) {
        await col.products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: -Math.abs(it.qty) } });
      }
    }
    productCache.del('all_products');
    scheduleAlertSweep(); // stock just changed — check for out-of-stock / low / expiry alerts
    await col.db.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: { saleId: result.insertedId } });
    if (sale.customerPhone) earnPoints(sale.customerPhone, total);
    console.log('🧾 POS SALE auto-recorded from M-Pesa:', checkoutRequestId, '| KES', total, '| by', sale.staff);
  } catch (e) {
    console.error('finalizePosSale create error:', e.message);
    // Creation failed after claiming — release the flag so another confirm
    // point (or the next status poll) can retry instead of losing the sale.
    try { await col.db.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: { saleCreated: false } }); } catch (_) {}
  }
}

// Moves a payment request from pending to its FINAL state exactly once and
// applies the side effects: the order's paid amount, the till sale, and the
// notifications. Only ever called with a result that came from Safaricom's
// own STK query (or the development mock) — never straight from a callback.
async function applyMpesaResult(checkoutRequestId, { status, resultCode, resultDesc }) {
  const coll = col.db.collection('mpesa_requests');
  const flip = await coll.updateOne(
    { checkoutRequestId, status: 'pending' },
    { $set: { status, resultCode, resultDesc, completedAt: new Date(), verified: true } }
  );
  const reqDoc = await coll.findOne({ checkoutRequestId });
  if (!reqDoc) return null;
  if (flip.matchedCount && status === 'confirmed' && reqDoc.orderId && ObjectId.isValid(reqDoc.orderId)) {
    const oid = new ObjectId(reqDoc.orderId);
    await col.orders.updateOne({ _id: oid }, { $inc: { amountPaid: reqDoc.amount || 0 }, $set: { paymentMethod: 'mpesa', lastPaymentAt: new Date() } });
    const order = await col.orders.findOne({ _id: oid });
    if (order) {
      const paymentStatus = paymentStatusFor(order.amountPaid || 0, order.totalPrice || 0);
      const set = { paymentStatus };
      // Paid after the customer had already cancelled → the money is owed back.
      if (order.status === 'cancelled') { set.refundDue = order.amountPaid || 0; set.refundStatus = 'due'; }
      await col.orders.updateOne({ _id: oid }, { $set: set });
      if (order.status === 'cancelled') sendPushToStaff('↩️ Refund due', `A cancelled order was paid KES ${reqDoc.amount} by M-Pesa — refund the customer.`);
    }
  }
  if (reqDoc.status === 'confirmed') {
    await finalizePosSale(checkoutRequestId);
    await notifyPaymentConfirmed(reqDoc);
  }
  return reqDoc;
}

const MPESA_RESULT_TEXT = {
  '0': '✅ Transaction Complete — Payment Received!',
  '1032': '❌ Payment Cancelled by Customer',
  '1': '❌ Insufficient M-Pesa Balance',
  '2001': '❌ Wrong PIN Entered',
  '1037': '⏱️ Payment Timed Out — Customer took too long'
};

// Asks Safaricom for the truth about a payment request. Returns the final
// status ('confirmed' | 'failed') once Safaricom has one, or 'pending'.
async function verifyMpesaRequest(checkoutRequestId) {
  const reqDoc = await col.db.collection('mpesa_requests').findOne({ checkoutRequestId });
  if (!reqDoc) return { status: 'missing' };
  if (reqDoc.status !== 'pending') return { status: reqDoc.status, resultDesc: reqDoc.resultDesc || '' };
  if (reqDoc.mock || mpesaMock() || !mpesaCredentialsReady()) return { status: 'pending', resultDesc: '' };
  const token = await getMpesaToken();
  const timestamp = mpesaTimestamp();
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
  const data = await safaricomRequest(`${MPESA_BASE}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
  });
  if (data.ResultCode === undefined) return { status: 'pending', resultDesc: '' };
  const desc = String(data.ResultDesc || '');
  // "Still processing" means Safaricom hasn't finalised — keep waiting.
  if (/still/i.test(desc) && /process/i.test(desc)) return { status: 'pending', resultDesc: '' };
  const rc = String(data.ResultCode);
  const status = rc === '0' ? 'confirmed' : 'failed';
  const resultDesc = MPESA_RESULT_TEXT[rc] || `❌ Payment Declined (Code: ${rc})`;
  await applyMpesaResult(checkoutRequestId, { status, resultCode: data.ResultCode, resultDesc });
  console.log(status === 'confirmed' ? '✅ Payment confirmed via Safaricom query' : `❌ Payment failed: ${resultDesc}`);
  return { status, resultDesc };
}

// Re-check a few times after a callback: Safaricom's query endpoint can lag
// the callback by a few seconds ("still processing").
function verifySoon(checkoutRequestId, delays = [3000, 10000, 30000, 90000]) {
  const [first, ...rest] = delays;
  if (first === undefined) return;
  setTimeout(async () => {
    try {
      const r = await verifyMpesaRequest(checkoutRequestId);
      if (r.status === 'pending') verifySoon(checkoutRequestId, rest);
    } catch (e) {
      console.error('M-Pesa verify retry failed:', e.message);
      verifySoon(checkoutRequestId, rest);
    }
  }, first).unref?.();
}

module.exports = { MPESA_ENV, MPESA_BASE, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, getMpesaCallbackUrl, mpesaMock, safaricomRequest, _mpesaTokenCache, getMpesaToken, mpesaTimestamp, formatPhone, mpesaCredentialsReady, finalizePosSale, applyMpesaResult, MPESA_RESULT_TEXT, verifyMpesaRequest, verifySoon };
