// M-Pesa STK push, Safaricom callbacks and payment status.
const { ObjectId } = require('mongodb');
const { CUSTOMER_AUTH_ERROR, auditLog, authenticate, authenticateCustomer, customerFromRequest, staffFromRequest } = require('../lib/auth');
const { col } = require('../lib/db');
const { mpesaPushLimiter, mpesaStatusLimiter } = require('../lib/limiters');
const { finalizePosSale, requestStkPush, verifyMpesaRequest, verifySoon } = require('../lib/mpesa');
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
      let staff = await staffFromRequest(req);
      // Riders only collect on orders assigned to them (and never ring up till sales).
      if (staff && staff.role === 'rider' && (saleDraft || !orderId)) return res.status(403).json({ success: false, error: 'Riders can only request payment for their deliveries' });
      const customerPhone = staff ? null : await customerFromRequest(req);
      if (!staff && !customerPhone) return res.status(401).json({ success: false, ...CUSTOMER_AUTH_ERROR });

      let amount = 0;
      let order = null;
      let cleanDraft = null;
      if (orderId) {
        if (!ObjectId.isValid(orderId)) return res.status(400).json({ success: false, error: 'Invalid order' });
        order = await col.orders.findOne({ _id: new ObjectId(orderId) });
        if (!order || (!staff && order.customerId !== customerPhone)) return res.status(404).json({ success: false, error: 'Order not found' });
        if (staff && staff.role === 'rider' && !(order.rider && order.rider.userId === staff.userId)) return res.status(403).json({ success: false, error: 'This delivery is assigned to another rider' });
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
          // Only the owner may book a till sale to another branch.
          branchId: staff.role === 'owner' ? (saleDraft.branchId || null) : (staff.branchId || saleDraft.branchId || null)
        };
        const overrides = items.filter(i => i.priceOverride);
        if (overrides.length) {
          auditLog({ ...req, user: staff }, 'sale_price_override', `M-Pesa till sale: ${overrides.map(i => `${i.name} at KES ${i.price} (shelf ${i.priceOverride.catalogPrice})`).join('; ').slice(0, 300)}`);
        }
      } else {
        return res.status(400).json({ success: false, error: 'Nothing to pay for — an order or a till sale is required.' });
      }

      const payPhone = phone || (order && order.customerId) || customerPhone;
      if (!payPhone) return res.status(400).json({ success: false, error: 'Phone required' });
      const result = await requestStkPush({
        phone: payPhone, amount, orderId: orderId ? String(orderId) : null, saleDraft: cleanDraft,
        purpose: cleanDraft ? 'till' : 'order',
        requestedBy: staff ? `staff:${staff.username}` : `customer:${customerPhone}`
      }, { reference: cleanDraft ? 'BlitzPOS' : 'BlitzMall' });
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      return res.json({ success: true, checkoutRequestId: result.checkoutRequestId, amount: result.amount, message: result.message });
    } catch (err) { console.error('STK Push error:', err); res.status(500).json({ success: false, error: 'Failed to initiate M-Pesa payment' }); }
  });

  // Wallet top-up: load cash into the BlitzMall wallet by M-Pesa. The amount
  // is credited only after Safaricom confirms (see applyMpesaResult). The app
  // polls /api/mpesa/status/:checkoutRequestId like any other payment.
  const TOPUP_MIN = 10, TOPUP_MAX = 20000;
  app.post('/api/wallet/topup', mpesaPushLimiter, authenticateCustomer, async (req, res) => {
    const amount = Math.round(parseFloat(req.body && req.body.amount));
    if (!(amount >= TOPUP_MIN && amount <= TOPUP_MAX)) {
      return res.status(400).json({ success: false, error: `Top up between KES ${TOPUP_MIN} and KES ${TOPUP_MAX.toLocaleString('en-KE')}` });
    }
    try {
      const phone = req.customerPhone;
      const recent = await col.db.collection('mpesa_requests').findOne({ purpose: 'wallet_topup', walletPhone: phone, status: 'pending', createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) } });
      if (recent) return res.status(400).json({ success: false, error: 'A top-up request is already waiting on your phone. Enter your PIN or wait a moment.' });
      const result = await requestStkPush({
        phone: cleanPhone(req.body.phone) || phone, amount, orderId: null, saleDraft: null,
        purpose: 'wallet_topup', walletPhone: phone, requestedBy: `customer:${phone}`
      }, { reference: 'BlitzWallet' });
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      res.json({ success: true, checkoutRequestId: result.checkoutRequestId, amount: result.amount, message: result.message });
    } catch (e) { console.error('Wallet top-up failed:', e); res.status(500).json({ success: false, error: 'Could not start the top-up' }); }
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
        // Keep Safaricom's receipt details for reconciliation against the M-Pesa
        // statement. They're unverified hints (the STK query below decides the
        // result), but an amount that doesn't match what we asked for is flagged.
        const meta = {};
        for (const it of ((callback.CallbackMetadata && callback.CallbackMetadata.Item) || [])) {
          if (it && ['Amount', 'MpesaReceiptNumber', 'TransactionDate', 'PhoneNumber'].includes(it.Name)) meta[it.Name] = String(it.Value).slice(0, 40);
        }
        const set = { callbackAt: new Date(), callbackResultCode: callback.ResultCode, callbackMeta: meta };
        if (meta.Amount !== undefined && Math.abs(parseFloat(meta.Amount) - (reqDoc.amount || 0)) >= 1) {
          set.amountMismatch = true;
          console.warn('⚠️ M-Pesa callback amount differs from the request:', checkoutRequestId, meta.Amount, 'vs', reqDoc.amount);
        }
        await col.db.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: set });
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
