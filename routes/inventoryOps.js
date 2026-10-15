// Back-office inventory: suppliers, purchase orders (built from the restock
// predictions) and stock-takes (count the shelves, fix the numbers).
const { ObjectId } = require('mongodb');
const { col } = require('../lib/db');
const { authenticate, requirePermission, auditLog } = require('../lib/auth');
const { generatePredictions } = require('../lib/reports');
const { LOW_STOCK_THRESHOLD, scheduleAlertSweep } = require('../lib/notifications');
const { productCache } = require('../lib/cache');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(String(id)) : null);
const unwrap = (r) => (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r);
const who = (req) => req.user.name || req.user.username;

async function nextNumber(key) {
  const r = unwrap(await col.counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }));
  return r.seq;
}

const cleanSupplier = (b = {}) => ({
  name: String(b.name || '').trim().slice(0, 80),
  phone: String(b.phone || '').replace(/[^0-9+]/g, '').slice(0, 15),
  email: String(b.email || '').trim().slice(0, 120),
  contactPerson: String(b.contactPerson || '').trim().slice(0, 80),
  notes: String(b.notes || '').slice(0, 500),
  leadTimeDays: Math.max(0, Math.min(60, parseInt(b.leadTimeDays, 10) || 0))
});

module.exports = function register(app) {
  const inv = [authenticate, requirePermission('suppliers', 'inventory')];

  // ===== SUPPLIERS =====
  app.get('/api/admin/suppliers', ...inv, async (req, res) => {
    try {
      const [suppliers, products] = await Promise.all([col.suppliers.find().sort({ name: 1 }).toArray(), col.products.find().toArray()]);
      const count = {};
      for (const p of products) if (p.supplierId) count[p.supplierId] = (count[p.supplierId] || 0) + 1;
      res.json(suppliers.map(s => ({ ...s, productCount: count[String(s._id)] || 0 })));
    } catch (e) { res.status(500).json({ error: 'Failed to load suppliers' }); }
  });
  app.post('/api/admin/suppliers', ...inv, async (req, res) => {
    const s = cleanSupplier(req.body);
    if (!s.name) return res.status(400).json({ error: 'Supplier name required' });
    try { const r = await col.suppliers.insertOne({ ...s, createdAt: new Date() }); res.json({ success: true, supplierId: r.insertedId }); }
    catch (e) { res.status(500).json({ error: 'Failed to add supplier' }); }
  });
  app.put('/api/admin/suppliers/:id', ...inv, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid supplier' });
    const s = cleanSupplier(req.body);
    if (!s.name) return res.status(400).json({ error: 'Supplier name required' });
    try {
      const r = await col.suppliers.updateOne({ _id: id }, { $set: { ...s, updatedAt: new Date() } });
      if (!r.matchedCount) return res.status(404).json({ error: 'Supplier not found' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });
  app.delete('/api/admin/suppliers/:id', ...inv, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid supplier' });
    try {
      const r = await col.suppliers.deleteOne({ _id: id });
      if (!r.deletedCount) return res.status(404).json({ error: 'Supplier not found' });
      await col.products.updateMany({ supplierId: req.params.id }, { $set: { supplierId: null } });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  // ===== PURCHASE ORDERS =====
  // Suggested re-orders: what will run out within `coverDays`, grouped by
  // supplier, with quantities to last that long at the current sales rate.
  app.get('/api/admin/purchase-orders/suggest', ...inv, async (req, res) => {
    try {
      const coverDays = Math.max(3, Math.min(60, parseInt(req.query.coverDays, 10) || 14));
      const [sales, orders, products, suppliers] = await Promise.all([
        col.sales.find({ createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } }).toArray(),
        col.orders.find({ createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } }).toArray(),
        col.products.find().toArray(), col.suppliers.find().toArray()
      ]);
      const pred = generatePredictions(sales.filter(s => !s.refunded), orders.filter(o => o.status !== 'cancelled'), products, {});
      const rateByName = Object.fromEntries(pred.restock.map(r => [r.name, r.dailyRate]));
      const supplierName = Object.fromEntries(suppliers.map(s => [String(s._id), s.name]));
      const groups = {};
      for (const p of products) {
        if (typeof p.stock !== 'number') continue;
        const rate = rateByName[p.name] || 0;
        const runsOut = rate > 0 ? p.stock / rate <= coverDays : p.stock < LOW_STOCK_THRESHOLD;
        if (!runsOut) continue;
        const target = rate > 0 ? Math.ceil(rate * coverDays) : LOW_STOCK_THRESHOLD * 2;
        const qty = Math.max(1, Math.ceil(target - Math.max(0, p.stock)));
        const key = p.supplierId && supplierName[p.supplierId] ? p.supplierId : 'none';
        (groups[key] = groups[key] || { supplierId: key === 'none' ? null : key, supplierName: key === 'none' ? 'No supplier set' : supplierName[key], items: [] })
          .items.push({ productId: String(p._id), name: p.name, unit: p.unit || 'pcs', stock: p.stock, dailyRate: rate, suggestedQty: qty, unitCost: round2(p.buyingPrice) });
      }
      const list = Object.values(groups).map(g => ({ ...g, estimatedCost: round2(g.items.reduce((s, i) => s + i.suggestedQty * i.unitCost, 0)) }));
      res.json({ coverDays, suppliers: list.sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1)) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to build suggestions' }); }
  });

  app.get('/api/admin/purchase-orders', ...inv, async (req, res) => {
    try { res.json(await col.purchase_orders.find().sort({ createdAt: -1 }).limit(200).toArray()); }
    catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/purchase-orders', ...inv, async (req, res) => {
    try {
      const supplier = req.body.supplierId ? await col.suppliers.findOne({ _id: oid(req.body.supplierId) }) : null;
      const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
      const ids = raw.map(i => oid(i && i.productId)).filter(Boolean);
      const products = ids.length ? await col.products.find({ _id: { $in: ids } }).toArray() : [];
      const byId = new Map(products.map(p => [String(p._id), p]));
      const items = raw.map(i => {
        const p = byId.get(String(i && i.productId));
        const qty = round2(parseFloat(i && i.qty));
        if (!p || !(qty > 0)) return null;
        return { productId: String(p._id), name: p.name, unit: p.unit || 'pcs', qty, unitCost: round2(i.unitCost !== undefined ? i.unitCost : p.buyingPrice), receivedQty: 0 };
      }).filter(Boolean);
      if (!items.length) return res.status(400).json({ error: 'Add at least one product with a quantity' });
      const po = {
        poNumber: await nextNumber('purchase_order'),
        supplierId: supplier ? String(supplier._id) : null, supplierName: supplier ? supplier.name : (String(req.body.supplierName || '').slice(0, 80) || 'Unspecified'),
        supplierPhone: supplier ? supplier.phone : '',
        items, total: round2(items.reduce((s, i) => s + i.qty * i.unitCost, 0)),
        note: String(req.body.note || '').slice(0, 500),
        status: 'draft', createdBy: who(req), createdAt: new Date()
      };
      const r = await col.purchase_orders.insertOne(po);
      auditLog(req, 'po_created', `PO #${po.poNumber} for ${po.supplierName} — KES ${po.total}`);
      res.json({ success: true, purchaseOrder: { ...po, _id: r.insertedId } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to create purchase order' }); }
  });

  // Mark as sent (e.g. after sharing on WhatsApp) or cancel a draft.
  app.put('/api/admin/purchase-orders/:id', ...inv, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid purchase order' });
    if (!['sent', 'cancelled'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be sent or cancelled' });
    try {
      const r = await col.purchase_orders.updateOne({ _id: id, status: { $in: ['draft', 'sent'] } }, { $set: { status: req.body.status, [`${req.body.status}At`]: new Date() } });
      if (!r.matchedCount) return res.status(400).json({ error: 'This purchase order can no longer be changed' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  // Goods arrived: add what was received to stock, update cost prices, and
  // (optionally) record the payment as an expense. Atomic — receiving twice
  // can never double the stock.
  app.post('/api/admin/purchase-orders/:id/receive', ...inv, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid purchase order' });
    try {
      const po = unwrap(await col.purchase_orders.findOneAndUpdate(
        { _id: id, status: { $in: ['draft', 'sent'] } },
        { $set: { status: 'receiving' } }
      ));
      if (!po) return res.status(400).json({ error: 'This purchase order was already received or cancelled' });
      const received = Array.isArray(req.body.items) ? req.body.items : [];
      const lines = po.items.map(line => {
        const r = received.find(x => x && String(x.productId) === line.productId);
        const qty = r && r.receivedQty !== undefined ? Math.max(0, round2(parseFloat(r.receivedQty))) : line.qty;
        const unitCost = r && r.unitCost !== undefined ? Math.max(0, round2(parseFloat(r.unitCost))) : line.unitCost;
        return { ...line, receivedQty: qty, unitCost };
      });
      for (const l of lines) {
        if (!(l.receivedQty > 0)) continue;
        const set = l.unitCost > 0 ? { buyingPrice: l.unitCost } : {};
        await col.products.updateOne({ _id: oid(l.productId) }, { $inc: { stock: l.receivedQty }, ...(Object.keys(set).length ? { $set: set } : {}) });
      }
      const total = round2(lines.reduce((s, l) => s + l.receivedQty * l.unitCost, 0));
      if (req.body.recordExpense && total > 0) {
        await col.expenses.insertOne({ description: `Stock purchase — PO #${po.poNumber} (${po.supplierName})`, amount: total, createdBy: who(req), branchId: req.user.branchId || null, purchaseOrderId: String(po._id), createdAt: new Date() });
      }
      await col.purchase_orders.updateOne({ _id: id }, { $set: { status: 'received', items: lines, receivedTotal: total, receivedAt: new Date(), receivedBy: who(req) } });
      productCache.del('all_products');
      scheduleAlertSweep();
      auditLog(req, 'po_received', `PO #${po.poNumber} received — KES ${total}`);
      res.json({ success: true, receivedTotal: total });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to receive purchase order' }); }
  });

  // ===== STOCK-TAKE =====
  const st = [authenticate, requirePermission('stocktake', 'inventory')];

  app.get('/api/admin/stock-takes', ...st, async (req, res) => {
    try { res.json(await col.stock_takes.find().sort({ startedAt: -1 }).limit(30).toArray()); }
    catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/stock-takes', ...st, async (req, res) => {
    try {
      const open = await col.stock_takes.findOne({ status: 'open' });
      if (open) return res.json({ success: true, stockTake: open, resumed: true });
      const doc = { number: await nextNumber('stock_take'), status: 'open', counts: {}, startedBy: who(req), startedAt: new Date(), note: String(req.body.note || '').slice(0, 200) };
      const r = await col.stock_takes.insertOne(doc);
      res.json({ success: true, stockTake: { ...doc, _id: r.insertedId } });
    } catch (e) { res.status(500).json({ error: 'Failed to start stock-take' }); }
  });

  // Record a shelf count. The system stock at the moment of counting is
  // remembered, so sales made while counting are not mistaken for shrinkage.
  app.put('/api/admin/stock-takes/:id/count', ...st, async (req, res) => {
    const id = oid(req.params.id);
    const pid = oid(req.body.productId);
    const counted = round2(parseFloat(req.body.counted));
    if (!id || !pid) return res.status(400).json({ error: 'Invalid product or stock-take' });
    if (!(counted >= 0) || counted > 1000000) return res.status(400).json({ error: 'Enter the counted quantity' });
    try {
      const p = await col.products.findOne({ _id: pid });
      if (!p) return res.status(404).json({ error: 'Product not found' });
      const r = await col.stock_takes.updateOne({ _id: id, status: 'open' }, {
        $set: { [`counts.${String(p._id)}`]: { productId: String(p._id), name: p.name, counted, expected: typeof p.stock === 'number' ? p.stock : 0, unitCost: round2(p.buyingPrice), countedBy: who(req), at: new Date() } }
      });
      if (!r.matchedCount) return res.status(400).json({ error: 'This stock-take is closed' });
      res.json({ success: true, expected: typeof p.stock === 'number' ? p.stock : 0, counted });
    } catch (e) { res.status(500).json({ error: 'Failed to save count' }); }
  });

  // Apply: each counted product's stock moves by (counted − expected-at-count),
  // keeping any sales made since. Variances (and their cost value) are saved.
  app.post('/api/admin/stock-takes/:id/apply', ...st, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid stock-take' });
    try {
      const take = unwrap(await col.stock_takes.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: 'applying' } }));
      if (!take) return res.status(400).json({ error: 'This stock-take was already applied or cancelled' });
      const variances = [];
      for (const c of Object.values(take.counts || {})) {
        const delta = round2(c.counted - c.expected);
        if (delta !== 0) await col.products.updateOne({ _id: oid(c.productId) }, { $inc: { stock: delta } });
        variances.push({ ...c, delta, value: round2(delta * (c.unitCost || 0)) });
      }
      const summary = {
        counted: variances.length,
        matched: variances.filter(v => v.delta === 0).length,
        shortUnits: round2(variances.filter(v => v.delta < 0).reduce((s, v) => s - v.delta, 0)),
        overUnits: round2(variances.filter(v => v.delta > 0).reduce((s, v) => s + v.delta, 0)),
        netValue: round2(variances.reduce((s, v) => s + v.value, 0))
      };
      await col.stock_takes.updateOne({ _id: id }, { $set: { status: 'applied', variances, summary, appliedBy: who(req), appliedAt: new Date() } });
      productCache.del('all_products');
      scheduleAlertSweep();
      auditLog(req, 'stocktake_applied', `Stock-take #${take.number}: ${summary.counted} counted, net KES ${summary.netValue}`);
      res.json({ success: true, summary, variances });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to apply stock-take' }); }
  });

  app.post('/api/admin/stock-takes/:id/cancel', ...st, async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid stock-take' });
    const r = await col.stock_takes.updateOne({ _id: id, status: 'open' }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    if (!r.matchedCount) return res.status(400).json({ error: 'This stock-take is not open' });
    res.json({ success: true });
  });
};
