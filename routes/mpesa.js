// M-Pesa STK push, Safaricom callbacks and payment status.
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { CUSTOMER_AUTH_ERROR, authenticate, customerFromRequest, staffFromRequest } = require('../lib/auth');
const { col } = require('../lib/db');
const { mpesaPushLimiter, mpesaStatusLimiter } = require('../lib/limiters');
const { MPESA_BASE, MPESA_PASSKEY, MPESA_SHORTCODE, applyMpesaResult, finalizePosSale, formatPhone, getMpesaCallbackUrl, getMpesaToken, mpesaCredentialsReady, mpesaMock, mpesaTimestamp, safaricomRequest, verifyMpesaRequest, verifySoon } = require('../lib/mpesa');
const { notifyPaymentConfirmed } = require('../lib/notifications');
const { cleanPosItems, saleTotals } = require('../lib/orders');
const { cleanPhone, safeEqual } = require('../lib/util');

module.exports = function register(app) {
  // Who may ask Safaricom to prompt a phone for money, and for how much:
  //  - a signed-in customer, for the unpaid balance of THEIR OWN order;
  //  - signed-in staff, for an order, or for a till sale (saleDraft) whose amount
  //    is recomputed from the cleaned basket.
  // The amount is ALWAYS set by the server — a client-supplied amount is ignored,
  // so nobody can mark an order "paid" with a KES 1 payment any more.
  app.post('/api/mpesa/stk-push', mpesaPushLimiter, async (req, res) => {
    const { phone, orderId, saleDraft } = req.body;
    try {
      const staff = await staffFromRequest(req);
      const customerPhone = staff ? null : await customerFromRequest(req);
      if (!staff && !customerPhone) return res.status(401).json({ success: false, ...CUSTOMER_AUTH_ERROR });

      let amount = 0;
      let order = null;
      let cleanDraft = null;
      if (orderId) {
        if (!ObjectId.isValid(orderId)) return res.status(400).json({ success: false, error: 'Invalid order' });
        order = await col.orders.findOne({ _id: new ObjectId(orderId) });
        if (!order || (!staff && order.customerId !== customerPhone)) return res.status(404).json({ success: false, error: 'Order not found' });
        if (order.status === 'cancelled') return res.status(400).json({ success: false, error: 'This order was cancelled.' });
        amount = Math.round(((order.totalPrice || 0) - (order.amountPaid || 0)) * 100) / 100;
        if (order.paymentStatus === 'paid' || amount <= 0) {
          return res.status(400).json({ success: false, error: 'This order has already been paid and confirmed!' });
        }
        // One prompt at a time per order.
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        const existingPending = await col.db.collection('mpesa_requests').findOne({ orderId: String(orderId), status: 'pending', createdAt: { $gte: twoMinutesAgo } });
        if (existingPending) {
          return res.status(400).json({ success: false, error: 'A payment request has already been sent to your phone. Please wait a moment.' });
        }
      } else if (saleDraft) {
        if (!staff) return res.status(401).json({ success: false, error: 'Staff sign-in required for till payments' });
        const items = await cleanPosItems(saleDraft.items);
        if (!items) return res.status(400).json({ success: false, error: 'No valid items in sale' });
        amount = saleTotals(items).total;
        cleanDraft = {
          items,
          staff: String(saleDraft.staff || staff.name || 'Owner').slice(0, 60),
          cashierUserId: staff.userId,
          customerPhone: cleanPhone(saleDraft.customerPhone),
          branchId: saleDraft.branchId || staff.branchId || null
        };
      } else {
        return res.status(400).json({ success: false, error: 'Nothing to pay for — an order or a till sale is required.' });
      }

      const payPhone = phone || (order && order.customerId) || customerPhone;
      if (!payPhone) return res.status(400).json({ success: false, error: 'Phone required' });
      const formattedPhone = formatPhone(payPhone);
      if (!/^254(7|1)\d{8}$/.test(formattedPhone)) {
        return res.status(400).json({ success: false, error: `Invalid M-Pesa phone number: ${formattedPhone}` });
      }
      const numericAmount = Math.ceil(amount);
      if (!Number.isFinite(numericAmount) || numericAmount < 1) {
        return res.status(400).json({ success: false, error: `Invalid M-Pesa amount: ${amount}` });
      }
      const baseDoc = {
        phone: formattedPhone, amount: numericAmount, orderId: orderId ? String(orderId) : null,
        saleDraft: cleanDraft, saleCreated: false, status: 'pending', createdAt: new Date(),
        requestedBy: staff ? `staff:${staff.username}` : `customer:${customerPhone}`
      };

      if (mpesaMock()) {
        const mockCheckoutId = 'MOCK-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        await col.db.collection('mpesa_requests').insertOne({ ...baseDoc, checkoutRequestId: mockCheckoutId, merchantRequestId: 'MOCK-REQ-' + crypto.randomBytes(5).toString('hex').toUpperCase(), mock: true });
        // Simulated confirmation after 3 seconds (development only — warned at boot).
        setTimeout(() => {
          applyMpesaResult(mockCheckoutId, { status: 'confirmed', resultCode: 0, resultDesc: 'The service request is processed successfully.' })
            .catch(e => console.error('Error in mock M-Pesa confirmation:', e));
        }, 3000);
        return res.json({ success: true, checkoutRequestId: mockCheckoutId, amount: numericAmount, message: 'M-Pesa simulation initiated! Confirming in 3 seconds...' });
      }

      if (!mpesaCredentialsReady()) {
        return res.status(400).json({ success: false, error: 'M-Pesa API credentials are not configured.' });
      }
      const callbackUrl = getMpesaCallbackUrl();
      if (process.env.NODE_ENV === 'production' && (!callbackUrl.startsWith('https://') || callbackUrl.includes('localhost') || callbackUrl.includes('127.0.0.1'))) {
        return res.status(400).json({ success: false, error: `Invalid production M-Pesa callback URL: ${callbackUrl}` });
      }
      let token;
      try {
        token = await getMpesaToken();
      } catch (err) {
        console.error('M-Pesa authentication failed:', err.message);
        return res.status(500).json({ success: false, error: 'M-Pesa authentication failed: ' + err.message });
      }
      try {
        const timestamp = mpesaTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        const body = {
          BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline', Amount: numericAmount,
          PartyA: formattedPhone, PartyB: MPESA_SHORTCODE, PhoneNumber: formattedPhone,
          CallBackURL: callbackUrl, AccountReference: 'BlitzMall', TransactionDesc: 'Payment for goods',
        };
        const mpesaData = await safaricomRequest(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (mpesaData.ResponseCode === '0') {
          await col.db.collection('mpesa_requests').insertOne({ ...baseDoc, checkoutRequestId: mpesaData.CheckoutRequestID, merchantRequestId: mpesaData.MerchantRequestID });
          return res.json({ success: true, checkoutRequestId: mpesaData.CheckoutRequestID, amount: numericAmount, message: 'M-Pesa prompt sent! Ask customer to enter PIN.' });
        }
        return res.status(400).json({ success: false, error: mpesaData.errorMessage || mpesaData.ResultDesc || 'M-Pesa request rejected by Safaricom.' });
      } catch (err) {
        console.error('M-Pesa STK Push request failed:', err.message);
        return res.status(500).json({ success: false, error: 'M-Pesa STK Push request failed: ' + err.message });
      }
    } catch (err) { console.error('STK Push error:', err); res.status(500).json({ error: 'Failed to initiate M-Pesa payment', details: err.message }); }
  });

  // Safaricom's callback is treated as a NUDGE, never as proof: anyone on the
  // internet can POST here, so nothing is marked paid (or failed) until
  // Safaricom's own STK-query endpoint confirms the result. With
  // MPESA_CALLBACK_SECRET set, callbacks without ?secret=<value> are dropped.
  app.post('/api/mpesa/callback', async (req, res) => {
    const ack = () => res.json({ ResultCode: 0, ResultDesc: 'Success' });
    try {
      const secret = process.env.MPESA_CALLBACK_SECRET;
      if (secret && !safeEqual(req.query.secret, secret)) {
        console.warn('⚠️ M-Pesa callback rejected: bad or missing secret');
        return ack();
      }
      const callback = req.body && req.body.Body && req.body.Body.stkCallback;
      if (!callback || !callback.CheckoutRequestID) return ack();
      const checkoutRequestId = String(callback.CheckoutRequestID);
      console.log('📱 M-Pesa callback (unverified):', checkoutRequestId, callback.ResultCode, callback.ResultDesc);
      const reqDoc = col.db ? await col.db.collection('mpesa_requests').findOne({ checkoutRequestId }) : null;
      if (reqDoc && reqDoc.status === 'pending' && !reqDoc.mock) {
        await col.db.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: { callbackAt: new Date(), callbackResultCode: callback.ResultCode } });
        verifySoon(checkoutRequestId, [0, 5000, 15000, 45000, 120000]);
      }
      ack();
    } catch (err) { console.error('Callback error:', err); ack(); }
  });

  app.get('/api/mpesa/status/:checkoutRequestId', mpesaStatusLimiter, async (req, res) => {
    try {
      const req_ = await col.db.collection('mpesa_requests').findOne({ checkoutRequestId: String(req.params.checkoutRequestId) });
      if (!req_) return res.status(404).json({ error: 'Not found' });
      if (req_.status === 'pending') {
        try {
          const r = await verifyMpesaRequest(req_.checkoutRequestId);
          return res.json({ status: r.status, resultDesc: r.resultDesc || '' });
        } catch (e) {
          console.error('Auto-query Safaricom error:', e.message);
        }
      }
      // Belt-and-braces: if the stored status is already confirmed (a prior
      // confirm point set it), make sure the sale + notification happened — the
      // atomic claims inside make these no-ops if they already did.
      if (req_.status === 'confirmed') { await finalizePosSale(req_.checkoutRequestId); await notifyPaymentConfirmed(req_); }
      res.json({ status: req_.status, resultDesc: req_.resultDesc || '' });
    } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/mpesa/query', authenticate, async (req, res) => {
    const { checkoutRequestId } = req.body;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId required' });
    try {
      res.json(await verifyMpesaRequest(String(checkoutRequestId)));
    } catch (err) { console.error('M-Pesa query failed:', err.message); res.status(500).json({ error: 'Failed to query status' }); }
  });

};
