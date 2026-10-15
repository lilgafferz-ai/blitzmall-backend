// Dashboard summary, predictions, export, audit log and record cleanup.
const { auditLog, authenticate, authorize, branchFilter, hasPermission, requirePermission } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { costMap, generatePredictions, liveSales, orderProfit } = require('../lib/reports');

module.exports = function register(app) {
  app.get('/api/admin/summary', authenticate, async (req, res) => {
    try {
      const filter = branchFilter(req);
      const [allSales, orders, expenses, products] = await Promise.all([
        col.sales.find(filter).toArray(), col.orders.find(filter).toArray(),
        col.expenses.find(filter).toArray(), col.products.find(filter).toArray()
      ]);
      const sales = liveSales(allSales);
      const costById = costMap(await col.products.find().toArray());
      const now = new Date();
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dow = now.getDay(); const mondayOffset = dow === 0 ? 6 : dow - 1;
      const startWeek = new Date(startToday); startWeek.setDate(startToday.getDate() - mondayOffset);
      const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startYear = new Date(now.getFullYear(), 0, 1);
      const periods = { today: startToday, week: startWeek, month: startMonth, year: startYear, all: new Date(0) };
      const inP = (d, s) => new Date(d) >= s;
      const calc = (start) => {
        let revenue = 0, profit = 0, cash = 0, mpesa = 0, count = 0;
        for (const s of sales) { if (!inP(s.createdAt, start)) continue; count++; revenue += s.total || 0; profit += s.profit || 0; if (s.paymentMethod === 'cash') cash += s.total || 0; else if (s.paymentMethod === 'mpesa') mpesa += s.total || 0; else if (s.paymentMethod === 'split') { cash += s.cashPart || 0; mpesa += s.mpesaPart || 0; } }
        for (const o of orders) {
          if (o.status === 'cancelled') continue;
          if (!inP(o.createdAt, start)) continue;
          count++;
          revenue += o.totalPrice || 0;
          profit += orderProfit(o, costById);
          if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0;
          else cash += o.totalPrice || 0;
        }
        let exp = 0; for (const e of expenses) if (inP(e.createdAt, start)) exp += e.amount || 0;
        return { revenue, profit, expenses: exp, net: profit - exp, cash, mpesa, count };
      };
      const summary = {}; for (const k in periods) summary[k] = calc(periods[k]);
      const tally = {};
      for (const s of sales) for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0);
      for (const o of orders) {
        if (o.status === 'cancelled') continue;
        for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0);
      }
      const best = Object.entries(tally).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 6);
      const low = products.filter(p => p.stock !== undefined && p.stock > 0 && p.stock < 2).map(p => ({ name: p.name, stock: p.stock }));
      const out = products.filter(p => p.stock !== undefined && p.stock <= 0).map(p => ({ name: p.name }));
      const soon = new Date(now.getTime() + 7 * 86400000);
      const expiringSoon = products.filter(p => p.expiryDate && new Date(p.expiryDate) >= now && new Date(p.expiryDate) <= soon).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
      const expired = products.filter(p => p.expiryDate && new Date(p.expiryDate) < now).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
      // Predictions: AI-powered insights
      const predictions = generatePredictions(sales, orders.filter(o => o.status !== 'cancelled'), products, tally);
      // Every signed-in staff member gets the stock alerts (the till's out-of-stock
      // alarm polls this); revenue, profit and predictions need Records access.
      if (!hasPermission(req.user, 'records', 'expenses')) return res.json({ low, out, expiringSoon, expired });
      res.json({ summary, best, low, out, expiringSoon, expired, predictions });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to build summary' }); }
  });

  // Standalone predictions endpoint
  app.get('/api/admin/predictions', authenticate, requirePermission('records'), async (req, res) => {
    try {
      const filter = branchFilter(req);
      const [allSales, orders, products] = await Promise.all([
        col.sales.find(filter).toArray(), col.orders.find(filter).toArray(), col.products.find(filter).toArray()
      ]);
      const sales = liveSales(allSales);
      const tally = {};
      for (const s of sales) for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0);
      for (const o of orders) { if (o.status === 'cancelled') continue; for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0); }
      res.json(generatePredictions(sales, orders.filter(o => o.status !== 'cancelled'), products, tally));
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
  });

  // ===== EXPORT =====
  app.get('/api/admin/export', authenticate, authorize('owner'), async (req, res) => {
    try {
      const [products, orders, sales, expenses, credit, reviews, staff] = await Promise.all([
        col.products.find().toArray(), col.orders.find().toArray(), col.sales.find().toArray(),
        col.expenses.find().toArray(), col.credit.find().toArray(), col.reviews.find().toArray(), col.staff.find().toArray(),
      ]);
      res.json({ shop: 'Brilliant / Blitz Mall', exportedAt: new Date(), products, orders, sales, expenses, credit, reviews, staff });
    } catch (e) { console.error('Failed to export:', e); res.status(500).json({ error: 'Failed to export' }); }
  });

  // Audit Logs fetch
  app.get('/api/admin/audit-logs', authenticate, authorize('owner'), async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
      const logs = await col.audit_logs.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
      res.json(logs);
    } catch (e) {
      console.error('Failed to fetch audit logs:', e);
      res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  });

  // ===== RECORD MANAGEMENT (owner only) — select & delete records =====
  // Data cleanup tool: lets the owner wipe records by type (sales, expenses, …)
  // or everything at once. User accounts (login) and branches are deliberately
  // excluded so nobody can lock themselves out of the app.
  //
  // IMPORTANT: this must be a FUNCTION, not a plain object literal. The
  // collection variables (col.sales, col.orders, …) are only assigned when connectDb()
  // runs — which happens AFTER this module is loaded. A literal here would
  // capture `undefined` for every collection, so every count came back 0 and
  // every delete silently no-op'd.
  const getRecordColls = () => ({
    sales: col.sales,
    orders: col.orders,
    expenses: col.expenses,
    credit: col.credit,
    reviews: col.reviews,
    coupons: col.coupons,
    customers: col.customers,
    products: col.products,
    banners: col.banners,
    loyalty: col.loyalty,
    promo_claims: col.promo_claims,
    promo_cooldowns: col.promo_cooldowns, // wiping this resets every shopper's spin/scratch cooldowns
    saved_baskets: col.saved_baskets,
    stock_transfers: col.stock_transfers,
    shifts: col.shifts,
    // audit_logs are deliberately NOT wipeable: an audit trail the account it
    // records can erase proves nothing (a stolen owner session could cover its tracks).
  });

  app.get('/api/admin/records/counts', authenticate, authorize('owner'), async (req, res) => {
    try {
      const counts = {};
      for (const [key, coll] of Object.entries(getRecordColls())) {
        try { counts[key] = await coll.countDocuments({}); } catch (e) { counts[key] = 0; }
      }
      res.json({ success: true, counts });
    } catch (e) {
      console.error('records/counts error:', e);
      res.status(500).json({ error: 'Failed to load record counts' });
    }
  });

  app.delete('/api/admin/records', authenticate, authorize('owner'), async (req, res) => {
    const types = Array.isArray(req.body && req.body.types) ? req.body.types : [];
    if (!types.length) return res.status(400).json({ error: 'Select at least one record type to delete' });
    try {
      // Loyalty cards hold customers' wallet cash (some of it paid in by
      // M-Pesa). Bulk-wiping it would erase money the shop owes, with its
      // ledger — use Customers → Delete (archived, per account) instead.
      if (types.includes('loyalty')) {
        const held = (await col.loyalty.find({ walletBalance: { $gt: 0 } }).toArray())
          .reduce((s, l) => s + (l.walletBalance || 0), 0);
        if (held > 0) {
          auditLog(req, 'records_delete_refused', `Refused to wipe loyalty cards holding KES ${Math.round(held * 100) / 100} of customer wallet cash`);
          return res.status(409).json({ error: `Customers still hold KES ${Math.round(held * 100) / 100} of wallet cash on their loyalty cards. That money is owed to them — remove accounts one by one from Customers (archived) instead.` });
        }
      }
      let deleted = 0;
      const done = [];
      for (const t of types) {
        const coll = getRecordColls()[t];
        if (!coll) continue;
        try {
          const r = await coll.deleteMany({});
          deleted += (r.deletedCount || 0);
          done.push(t);
          if (t === 'products') productCache.del('all_products'); // never serve wiped inventory from cache
          // Wallet cash lives on the loyalty cards — wiping them wipes the
          // balances, so their ledger goes too (or every account would show up
          // as a reconciliation mismatch).
          if (t === 'loyalty' && col.wallet_transactions) deleted += (await col.wallet_transactions.deleteMany({})).deletedCount || 0;
        } catch (e) { console.error('Failed to wipe collection:', t, e); }
      }
      auditLog(req, 'records_deleted', `Wiped ${deleted} record(s) from: ${done.join(', ')}`);
      res.json({ success: true, deleted, types: done });
    } catch (e) {
      console.error('records delete error:', e);
      res.status(500).json({ error: 'Failed to delete records' });
    }
  });

};
