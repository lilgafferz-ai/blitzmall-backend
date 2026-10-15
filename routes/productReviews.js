// Reviews on individual products. Only shoppers who actually bought the
// product (a delivered or paid order) can review it — one review each,
// editable. Ratings show on the product page and in the catalogue.
const { ObjectId } = require('mongodb');
const { col } = require('../lib/db');
const { authenticate, authorize, authenticateCustomer, optionalCustomer, auditLog, requirePermission } = require('../lib/auth');
const { reviewLimiter } = require('../lib/limiters');
const { productCache } = require('../lib/cache');

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(String(id)) : null);
// "Jane Wanjiku" → "Jane W." — reviews never show full names or phones.
const shortName = (name) => {
  const parts = String(name || 'Customer').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0] || 'Customer';
};

async function hasBought(phone, productId) {
  const orders = await col.orders.find({ customerId: phone, status: { $ne: 'cancelled' } }).toArray();
  return orders.some(o => (o.status === 'delivered' || o.paymentStatus === 'paid') && (o.items || []).some(i => String(i._id || i.id) === productId));
}

module.exports = function register(app) {
  app.get('/api/products/:id/reviews', optionalCustomer, async (req, res) => {
    const pid = String(req.params.id);
    if (!oid(pid)) return res.status(400).json({ error: 'Invalid product' });
    try {
      const all = await col.product_reviews.find({ productId: pid, hidden: { $ne: true } }).sort({ createdAt: -1 }).toArray();
      const count = all.length;
      const average = count ? Math.round((all.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
      const mine = req.customerPhone ? all.find(r => r.phone === req.customerPhone) : null;
      res.json({
        average, count,
        breakdown: [5, 4, 3, 2, 1].map(n => ({ stars: n, count: all.filter(r => r.rating === n).length })),
        reviews: all.slice(0, 50).map(r => ({ _id: r._id, name: r.name, rating: r.rating, comment: r.comment, createdAt: r.updatedAt || r.createdAt, verified: true, mine: !!(mine && String(mine._id) === String(r._id)) })),
        canReview: req.customerPhone ? await hasBought(req.customerPhone, pid) : false,
        myReview: mine ? { rating: mine.rating, comment: mine.comment } : null
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load reviews' }); }
  });

  app.post('/api/products/:id/reviews', authenticateCustomer, reviewLimiter, async (req, res) => {
    const pid = String(req.params.id);
    const rating = parseInt(req.body.rating, 10);
    if (!oid(pid)) return res.status(400).json({ error: 'Invalid product' });
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars' });
    try {
      const product = await col.products.findOne({ _id: oid(pid) });
      if (!product) return res.status(404).json({ error: 'Product not found' });
      if (!(await hasBought(req.customerPhone, pid))) {
        return res.status(403).json({ error: 'You can review this product once you\'ve received it in an order.' });
      }
      const cust = await col.customers.findOne({ phone: req.customerPhone });
      const fields = {
        rating,
        comment: String(req.body.comment || '').trim().slice(0, 500),
        name: shortName((cust && cust.name) || req.body.name),
        updatedAt: new Date()
      };
      const r = await col.product_reviews.updateOne({ productId: pid, phone: req.customerPhone }, { $set: fields });
      if (!r.matchedCount) {
        await col.product_reviews.insertOne({ productId: pid, productName: product.name, phone: req.customerPhone, ...fields, createdAt: new Date() });
      }
      productCache.del('all_products'); // refresh the catalogue's star ratings
      res.json({ success: true, updated: !!r.matchedCount });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to save review' }); }
  });

  // ===== ADMIN MODERATION =====
  app.get('/api/admin/product-reviews', authenticate, requirePermission('reviews'), async (req, res) => {
    try {
      const list = await col.product_reviews.find().sort({ createdAt: -1 }).limit(300).toArray();
      res.json(list.map(({ phone, ...r }) => ({ ...r, phoneTail: phone ? '…' + String(phone).slice(-3) : '' })));
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });
  app.put('/api/admin/product-reviews/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review' });
    const r = await col.product_reviews.updateOne({ _id: id }, { $set: { hidden: !!req.body.hidden } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Review not found' });
    productCache.del('all_products');
    auditLog(req, 'product_review_moderated', `${req.body.hidden ? 'Hid' : 'Showed'} review ${req.params.id}`);
    res.json({ success: true });
  });
  app.delete('/api/admin/product-reviews/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review' });
    const r = await col.product_reviews.deleteOne({ _id: id });
    if (!r.deletedCount) return res.status(404).json({ error: 'Review not found' });
    productCache.del('all_products');
    res.json({ success: true });
  });
};
