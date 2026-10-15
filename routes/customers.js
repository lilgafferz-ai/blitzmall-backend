// Customer profile, saved baskets and reviews.
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authenticateCustomer, authorize, optionalCustomer, requirePermission } = require('../lib/auth');
const { requireReauth } = require('../lib/mfa');
const { ensureReferralCode } = require('../lib/customers');
const { col } = require('../lib/db');
const { reviewLimiter } = require('../lib/limiters');
const { getLoyaltySettings, incPoints, tierFromPoints } = require('../lib/loyalty');
const { cleanPhone, samePhone } = require('../lib/util');

// Escape a user-typed search string so it is matched literally (never as a regex).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OWNER_BOOST_POINTS = 1000000;            // owner account's one-time starter boost
const WIPE_CONFIRM = 'DELETE ALL CUSTOMERS';    // phrase the owner types to wipe customers

// Everything that belongs to a customer account, as [collection, filter] pairs.
// `phoneMatch` selects by phone (a value or an operator object); `voucherMatch`
// selects personal vouchers by ownerPhone. Staff push tokens have no phone, so
// they never match.
const customerDataTargets = (phoneMatch, voucherMatch) => [
  ['customers', { phone: phoneMatch }],
  ['loyalty', { phone: phoneMatch }],
  ['wallet_transactions', { phone: phoneMatch }],
  ['ai_chats', { phone: phoneMatch }],
  ['promo_claims', { phone: phoneMatch }],
  ['promo_cooldowns', { phone: phoneMatch }],
  ['notification_tokens', { phone: phoneMatch }],
  ['notifications_feed', { audience: 'customer', phone: phoneMatch }],
  ['saved_baskets', { customerId: phoneMatch }],
  ['redemptions', { customerId: phoneMatch }],
  ['coupons', { ownerPhone: voucherMatch }]
].filter(([name]) => col[name]);

// Copy every matching doc to customer_wipe_archive (so it can be restored), then
// delete exactly those docs. Returns { collection: deletedCount }.
async function archiveAndDelete(targets, wipeId) {
  const archivedAt = new Date();
  const deleted = {};
  for (const [name, filter] of targets) {
    const docs = await col[name].find(filter).toArray();
    if (!docs.length) { deleted[name] = 0; continue; }
    await col.customer_wipe_archive.insertMany(docs.map(doc => ({ wipeId, collection: name, doc, archivedAt })));
    const r = await col[name].deleteMany({ _id: { $in: docs.map(d => d._id) } });
    deleted[name] = r.deletedCount || 0;
  }
  return deleted;
}

module.exports = function register(app) {
  app.post('/api/reviews', reviewLimiter, optionalCustomer, async (req, res) => {
    const { customerName, rating, message } = req.body;
    if (!rating) return res.status(400).json({ error: 'Rating required' });
    try { const r = await col.reviews.insertOne({ customerId: req.customerPhone || '', customerName: String(customerName || 'Customer').slice(0, 60), rating: Math.max(1, Math.min(5, parseInt(rating, 10) || 0)), message: String(message || '').trim().slice(0, 1000), createdAt: new Date() }); res.json({ success: true, reviewId: r.insertedId }); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });
  app.get('/api/reviews/summary', async (req, res) => {
    try { const all = await col.reviews.find().toArray(); const count = all.length; const avg = count ? all.reduce((s, r) => s + (r.rating || 0), 0) / count : 0; res.json({ count, average: Math.round(avg * 10) / 10 }); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });
  app.get('/api/admin/reviews', authenticate, requirePermission('reviews'), async (req, res) => { try { res.json(await col.reviews.find().sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.delete('/api/admin/reviews/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await col.reviews.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

  app.get('/api/customers/:phone', authenticateCustomer, async (req, res) => {
    if (!samePhone(req.params.phone, req.customerPhone)) return res.status(403).json({ error: 'Not your account' });
    try {
      const phone = req.customerPhone;
      const cust = await col.customers.findOne({ phone });
      const myReferralCode = await ensureReferralCode(cust);
      const orders = await col.orders.find({ customerId: phone }).toArray();
      const active = orders.filter(o => o.status !== 'cancelled');
      const totalSpent = active.reduce((s, o) => s + (o.totalPrice || 0), 0);
      const credits = await col.credit.find({ phone }).toArray();
      const outstandingDebt = credits.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0);
      const loyalty = await col.loyalty.findOne({ phone });
      const vouchers = await col.coupons.find({ ownerPhone: phone, active: true }).toArray();
      const tier = loyalty ? tierFromPoints(loyalty.points) : 'Bronze';
      // Effective redemption tiers (owner-tunable in Admin → Loyalty Controls) so
      // the app's "best coupon" display always matches what the store redeems.
      const loyaltySettings = await getLoyaltySettings();
      const redeemTiers = (loyaltySettings && Array.isArray(loyaltySettings.redeemTiers)) ? loyaltySettings.redeemTiers : null;
      res.json({
        exists: !!cust || active.length > 0,
        phone,
        isOwner: !!(cust && cust.isOwner),
        redeemTiers,
        referralCode: myReferralCode,
        referralCount: cust ? cust.referralCount || 0 : 0,
        referredBy: cust ? cust.referredBy || null : null,
        name: (cust && cust.name) || (active.length ? active[active.length - 1].customerName : '') || '',
        memberSince: cust && cust.createdAt ? cust.createdAt : null,
        orderCount: active.length,
        totalSpent: Math.round(totalSpent * 100) / 100,
        outstandingDebt: Math.round(outstandingDebt * 100) / 100,
        loyaltyPoints: loyalty ? loyalty.points || 0 : 0,
        loyaltyTier: loyalty ? loyalty.tier : tier,
        tier,
        walletBalance: loyalty ? loyalty.walletBalance || 0 : 0,
        // Virtual-wallet conversion rate (5 loyalty points = KES 1 wallet cash).
        walletRatePointsPerKsh: 5,
        vouchers: vouchers.map(v => ({
          code: v.code, type: v.type, value: v.value, minPurchase: v.minPurchase || 0,
          used: (Array.isArray(v.usedBy) && v.usedBy.includes(phone)),
          expiresAt: v.expiresAt || null
        }))
      });
    } catch (e) { console.error('Failed to load customer profile:', e); res.status(500).json({ error: 'Failed to load profile' }); }
  });

  // Saved Shopping Baskets — private to the signed-in customer.
  app.get('/api/customer/baskets/:customerId', authenticateCustomer, async (req, res) => {
    if (!samePhone(req.params.customerId, req.customerPhone)) return res.status(403).json({ error: 'Not your account' });
    try {
      res.json(await col.saved_baskets.find({ customerId: req.customerPhone }).toArray());
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  app.post('/api/customer/baskets', authenticateCustomer, async (req, res) => {
    const { basketName, items } = req.body;
    if (!basketName || !Array.isArray(items) || !items.length || items.length > 100) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
    try {
      const count = await col.saved_baskets.countDocuments({ customerId: req.customerPhone });
      if (count >= 50) return res.status(400).json({ error: 'You have too many saved baskets — delete one first.' });
      await col.saved_baskets.insertOne({
        customerId: req.customerPhone,
        basketName: String(basketName).slice(0, 60),
        // Only what is needed to refill the cart — prices are re-read at checkout.
        items: items.filter(i => i && typeof i === 'object').map(i => ({
          _id: String(i._id || i.id || ''), name: String(i.name || '').slice(0, 120),
          price: parseFloat(i.price) || 0, quantity: Math.max(1, Math.min(99, parseInt(i.quantity, 10) || 1)),
          ...(i.image ? { image: Array.isArray(i.image) ? i.image.slice(0, 1) : String(i.image).slice(0, 2000) } : {}),
          ...(i.category ? { category: String(i.category).slice(0, 60) } : {})
        })),
        createdAt: new Date()
      });
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  app.delete('/api/customer/baskets/:id', authenticateCustomer, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid basket' });
      const r = await col.saved_baskets.deleteOne({ _id: new ObjectId(req.params.id), customerId: req.customerPhone });
      if (!r.deletedCount) return res.status(404).json({ error: 'Basket not found' });
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // ===== ADMIN: CUSTOMERS DASHBOARD =====
  // Owner-only. Shows every customer with their money and points so the owner can
  // identify a locked-out shopper and reset their access. PIN and security-answer
  // hashes are NEVER returned — recovery is a reset, not a reveal.

  // List every customer (joined with their loyalty card for points + wallet cash).
  app.get('/api/admin/customers', authenticate, authorize('owner'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      let filter = {};
      if (q) { const rx = new RegExp(escapeRegex(q), 'i'); filter = { $or: [{ phone: rx }, { name: rx }] }; }
      const [customers, loyaltyDocs] = await Promise.all([
        col.customers.find(filter).limit(1000).toArray(),
        col.loyalty.find({}).toArray()
      ]);
      const loyaltyByPhone = {};
      for (const l of loyaltyDocs) loyaltyByPhone[l.phone] = l;
      const now = Date.now();
      const rows = customers.map(c => {
        const l = loyaltyByPhone[c.phone] || {};
        return {
          phone: c.phone,
          name: c.name || l.customerName || '',
          isOwner: !!c.isOwner,
          points: l.points || 0,
          tier: l.tier || 'Bronze',
          walletBalance: l.walletBalance || 0,
          orderCount: c.orderCount || 0,
          totalSpent: c.totalSpent || l.totalSpent || 0,
          createdAt: c.createdAt || null,
          lastLoginAt: c.lastLoginAt || null,
          hasPin: !!c.pinHash,
          hasSecurityQuestion: !!c.securityQuestion,
          locked: !!(c.lockedUntil && new Date(c.lockedUntil).getTime() > now),
          referralCount: c.referralCount || 0
        };
      }).sort((a, b) => (b.isOwner - a.isOwner) || (b.walletBalance - a.walletBalance) || (new Date(b.lastLoginAt || 0) - new Date(a.lastLoginAt || 0)));
      res.json({ count: rows.length, customers: rows });
    } catch (e) { console.error('admin customers list error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Full profile of one customer: identity, money, orders, wallet ledger, AI chats,
  // and account/security status (question shown, never the answer or PIN).
  app.get('/api/admin/customers/:phone', authenticate, authorize('owner'), async (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const [cust, orders, loyalty, credits, walletLedger, aiChats] = await Promise.all([
        col.customers.findOne({ phone }),
        col.orders.find({ customerId: phone }).sort({ createdAt: -1 }).toArray(),
        col.loyalty.findOne({ phone }),
        col.credit.find({ phone }).toArray(),
        col.wallet_transactions.find({ phone }).sort({ createdAt: -1 }).limit(50).toArray(),
        col.ai_chats ? col.ai_chats.find({ phone }).sort({ createdAt: -1 }).limit(100).toArray() : []
      ]);
      if (!cust && !orders.length && !loyalty) return res.status(404).json({ error: 'Customer not found' });
      const active = orders.filter(o => o.status !== 'cancelled');
      const outstandingDebt = credits.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0);
      const lastWithAddr = orders.find(o => o.deliveryLocation || o.deliveryArea);
      const now = Date.now();
      res.json({
        phone,
        name: (cust && cust.name) || (active.length ? active[0].customerName : '') || '',
        isOwner: !!(cust && cust.isOwner),
        createdAt: (cust && cust.createdAt) || null,
        lastLoginAt: (cust && cust.lastLoginAt) || null,
        orderCount: active.length,
        totalSpent: Math.round(active.reduce((s, o) => s + (o.totalPrice || 0), 0) * 100) / 100,
        outstandingDebt: Math.round(outstandingDebt * 100) / 100,
        points: loyalty ? loyalty.points || 0 : 0,
        tier: loyalty ? loyalty.tier : 'Bronze',
        walletBalance: loyalty ? loyalty.walletBalance || 0 : 0,
        referralCode: (cust && cust.referralCode) || null,
        referralCount: (cust && cust.referralCount) || 0,
        referredBy: (cust && cust.referredBy) || null,
        lastAddress: lastWithAddr ? { location: lastWithAddr.deliveryLocation || '', area: lastWithAddr.deliveryArea || '' } : null,
        security: {
          hasPin: !!(cust && cust.pinHash),
          pinSetAt: (cust && cust.pinSetAt) || null,
          securityQuestion: (cust && cust.securityQuestion) || null,
          hasSecurityQuestion: !!(cust && cust.securityQuestion),
          locked: !!(cust && cust.lockedUntil && new Date(cust.lockedUntil).getTime() > now),
          lockedUntil: (cust && cust.lockedUntil) || null,
          failedPinAttempts: (cust && cust.failedPinAttempts) || 0
        },
        orders: orders.slice(0, 20).map(o => ({ id: String(o._id), status: o.status, total: o.totalPrice || 0, createdAt: o.createdAt, items: (o.items || []).length })),
        walletLedger: walletLedger.map(w => ({ type: w.type, amount: w.amount, balanceAfter: w.balanceAfter, note: w.note || '', createdAt: w.createdAt })),
        aiChats: aiChats.map(a => ({ message: a.message, response: a.response, createdAt: a.createdAt }))
      });
    } catch (e) { console.error('admin customer detail error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Reset a customer's PIN (account recovery). Clears the PIN + any lock and bumps
  // tokenVersion so old/stolen sessions are signed out; the customer sets a fresh
  // PIN on their next sign-in. Wallet money, points and orders are untouched.
  app.post('/api/admin/customers/:phone/reset-pin', authenticate, authorize('owner'), requireReauth, async (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const cust = await col.customers.findOne({ phone });
      if (!cust) return res.status(404).json({ error: 'Customer not found' });
      // Clear the PIN + any lock and rotate tokenVersion (signs out old/stolen
      // sessions). The security question is kept, so the customer sets a new PIN
      // via "Forgot PIN" — not a fresh enroll a stranger could race. updateMany
      // covers any duplicate customer docs for the same phone.
      await col.customers.updateMany(
        { phone },
        { $unset: { pinHash: '', lockedUntil: '' }, $set: { failedPinAttempts: 0 }, $inc: { tokenVersion: 1 } }
      );
      auditLog(req, 'customer_pin_reset', `Reset PIN for ${phone} (${cust.name || 'no name'})`);
      res.json({ success: true, message: 'PIN cleared. The customer sets a new PIN with "Forgot PIN" + their security question.' });
    } catch (e) { console.error('admin reset-pin error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // The shop owner's own shopping account: labelled "Owner" everywhere and given a
  // one-time 1,000,000-point starter boost (→ Platinum). Only one account carries
  // the label; the boost is paid once per account, so re-clicking can't stack it.
  app.post('/api/admin/customers/:phone/make-owner', authenticate, authorize('owner'), async (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const cust = await col.customers.findOne({ phone });
      if (!cust) return res.status(404).json({ error: 'Customer not found — sign up in the app with this number first.' });
      await col.customers.updateMany({ isOwner: true, phone: { $ne: phone } }, { $unset: { isOwner: '' } });
      await col.customers.updateMany({ phone }, { $set: { isOwner: true } });
      const existing = await col.loyalty.findOne({ phone });
      let points = existing ? existing.points || 0 : 0;
      // Claim the one-time boost atomically BEFORE paying it, so two quick
      // clicks can never pay it twice.
      const claim = await col.customers.updateOne({ phone, ownerBoostGiven: { $ne: true } }, { $set: { ownerBoostGiven: true } });
      const boosted = claim.matchedCount > 0;
      if (boosted) {
        await col.customers.updateMany({ phone }, { $set: { ownerBoostGiven: true } });
        if (existing) {
          points = await incPoints(phone, OWNER_BOOST_POINTS);
        } else {
          points = OWNER_BOOST_POINTS;
          await col.loyalty.insertOne({ phone, customerName: cust.name || '', totalSpent: 0, points, tier: tierFromPoints(points), createdAt: new Date(), updatedAt: new Date() });
        }
        await col.redemptions.insertOne({ customerId: phone, rewardName: 'Manual bonus — owner starter boost', pointsSpent: 0, rewardValue: 0, manualPoints: OWNER_BOOST_POINTS, reason: 'owner starter boost', redeemedAt: new Date() });
      }
      auditLog(req, 'customer_make_owner', `Marked ${phone} (${cust.name || 'no name'}) as the owner's account${boosted ? ` + ${OWNER_BOOST_POINTS} pts` : ''}`);
      res.json({ success: true, boosted, points, tier: tierFromPoints(points) });
    } catch (e) { console.error('admin make-owner error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // "Delete all customers" — clears every shopper account and its points, wallet,
  // chats, baskets, promo history and personal vouchers. The owner's own account
  // (isOwner) is kept. Orders, sales, tax invoices and credit debts are NOT touched
  // (they're the shop's books). Every removed document is copied to
  // customer_wipe_archive first, so a wipe can be restored. { dryRun: true }
  // returns the counts only; the real wipe needs confirm === WIPE_CONFIRM plus
  // the owner's password (and authenticator code) — see requireReauth.
  const reauthUnlessDryRun = (req, res, next) => (req.body && req.body.dryRun ? next() : requireReauth(req, res, next));
  app.post('/api/admin/customers/wipe', authenticate, authorize('owner'), reauthUnlessDryRun, async (req, res) => {
    try {
      const keep = (await col.customers.find({ isOwner: true }).toArray()).map(c => c.phone);
      const targets = customerDataTargets(
        { $exists: true, ...(keep.length ? { $nin: keep } : {}) },
        { $exists: true, $nin: [null, ...keep] }
      );

      const counts = {};
      for (const [name, filter] of targets) counts[name] = await col[name].countDocuments(filter);
      const walletDocs = await col.loyalty.find(targets.find(t => t[0] === 'loyalty')[1]).toArray();
      const walletMoney = Math.round(walletDocs.reduce((s, l) => s + (l.walletBalance || 0), 0) * 100) / 100;
      if (req.body && req.body.dryRun) return res.json({ success: true, dryRun: true, counts, walletMoney, keptOwnerAccounts: keep.length });

      if (!req.body || req.body.confirm !== WIPE_CONFIRM) return res.status(400).json({ error: `Type ${WIPE_CONFIRM} to confirm.` });
      const wipeId = `wipe-${Date.now()}`;
      const deleted = await archiveAndDelete(targets, wipeId);
      auditLog(req, 'customers_wiped', `Deleted all customers (${deleted.customers || 0} accounts, KES ${walletMoney} wallet money) — archive ${wipeId}`);
      res.json({ success: true, wipeId, deleted, walletMoney, keptOwnerAccounts: keep.length });
    } catch (e) { console.error('admin customers wipe error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Delete ONE customer account (owner's own included) with the same data and the
  // same archive as "Delete all customers". Orders and the shop's books stay. The
  // number can then sign up fresh.
  app.post('/api/admin/customers/:phone/delete', authenticate, authorize('owner'), requireReauth, async (req, res) => {
    try {
      const phone = cleanPhone(req.params.phone);
      const cust = await col.customers.findOne({ phone });
      if (!cust) return res.status(404).json({ error: 'Customer not found' });
      const wipeId = `delete-${phone}-${Date.now()}`;
      const deleted = await archiveAndDelete(customerDataTargets(phone, phone), wipeId);
      auditLog(req, 'customer_deleted', `Deleted customer ${phone} (${cust.name || 'no name'}) — archive ${wipeId}`);
      res.json({ success: true, wipeId, deleted });
    } catch (e) { console.error('admin customer delete error:', e); res.status(500).json({ error: 'Failed' }); }
  });

};
