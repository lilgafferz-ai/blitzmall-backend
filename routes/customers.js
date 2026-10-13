// Customer profile, saved baskets and reviews.
const { ObjectId } = require('mongodb');
const { authenticate, authenticateCustomer, authorize, optionalCustomer } = require('../lib/auth');
const { ensureReferralCode } = require('../lib/customers');
const { col } = require('../lib/db');
const { reviewLimiter } = require('../lib/limiters');
const { getLoyaltySettings, tierFromPoints } = require('../lib/loyalty');
const { samePhone } = require('../lib/util');

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
  app.get('/api/admin/reviews', authenticate, async (req, res) => { try { res.json(await col.reviews.find().sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
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

};
