// Till sales, shifts, expenses, credit and the staff roster.
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authorize, branchFilter, logAction, requirePermission } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { earnPoints, reversePoints } = require('../lib/loyalty');
const { scheduleAlertSweep } = require('../lib/notifications');
const { cleanPosItems, saleTotals } = require('../lib/orders');
const { liveSales } = require('../lib/reports');
const { invoiceSale, creditNoteFor } = require('../lib/etims');
const { cleanPhone } = require('../lib/util');

module.exports = function register(app) {
  app.post('/api/admin/sales', authenticate, requirePermission('sales'), async (req, res) => {
    const { paymentMethod, amountGiven, cashPart, mpesaPart, staff, customerPhone, branchId } = req.body;
    try {
      const items = await cleanPosItems(req.body.items);
      if (!items) return res.status(400).json({ error: 'No valid items in sale' });
      const { total, profit } = saleTotals(items);
      const given = parseFloat(amountGiven) || 0;
      const method = ['cash', 'mpesa', 'split', 'card', 'credit'].includes(paymentMethod) ? paymentMethod : 'cash';
      const sale = {
        items, total, profit, paymentMethod: method, amountGiven: given,
        cashPart: Math.max(0, parseFloat(cashPart) || 0), mpesaPart: Math.max(0, parseFloat(mpesaPart) || 0),
        change: method === 'cash' && given > total ? +(given - total).toFixed(2) : 0,
        staff: String(staff || req.user.name || 'Owner').slice(0, 60),
        cashierUserId: req.user.userId,
        cashierUsername: req.user.username,
        customerPhone: cleanPhone(customerPhone), channel: 'pos',
        // Only the owner may book a sale to another branch.
        branchId: req.user.role === 'owner' ? (branchId || null) : (req.user.branchId || branchId || null),
        createdAt: new Date(),
      };
      const overrides = items.filter(i => i.priceOverride);
      if (overrides.length) sale.priceOverrides = overrides.length;
      const result = await col.sales.insertOne(sale);
      // Selling below the shelf price is allowed at the till (haggling, damaged
      // stock) but every such line is flagged on the sale and audit-logged, so
      // the owner can spot a cashier "selling" to friends at KES 1.
      if (overrides.length) {
        auditLog(req, 'sale_price_override', `Sale ${result.insertedId}: ${overrides.map(i => `${i.name} at KES ${i.price} (shelf ${i.priceOverride.catalogPrice})`).join('; ').slice(0, 300)}`);
      }
      invoiceSale({ ...sale, _id: result.insertedId });
      for (const it of items) if (it.productId) await col.products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: -Math.abs(it.qty) } });
      productCache.del('all_products');
      scheduleAlertSweep(); // stock just changed — check for out-of-stock / low / expiry alerts
      console.log('🧾 SALE: KES', total, '| by', sale.staff);
      if (sale.customerPhone) {
        earnPoints(sale.customerPhone, total)
          .then(pts => pts > 0 && col.sales.updateOne({ _id: result.insertedId }, { $set: { pointsAwarded: pts } }))
          .catch(() => {});
      }
      res.json({ success: true, saleId: result.insertedId, change: sale.change, total });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to record sale' }); }
  });

  app.get('/api/admin/sales', authenticate, requirePermission('sales', 'records'), async (req, res) => {
    try { const l = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 20)); const filter = branchFilter(req); res.json(await col.sales.find(filter).sort({ createdAt: -1 }).limit(l).toArray()); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });
  app.delete('/api/admin/sales/:saleId', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.saleId)) return res.status(400).json({ error: 'Invalid sale' });
      const sale = await col.sales.findOne({ _id: new ObjectId(req.params.saleId) });
      if (!sale) return res.status(404).json({ error: 'Sale not found' });
      // Delete first and only undo stock/points if THIS request removed it, so a
      // double-click (or two managers) can't restore the stock twice.
      const del = await col.sales.deleteOne({ _id: sale._id });
      if (!del.deletedCount) return res.status(404).json({ error: 'Sale not found' });
      // Keep the voided sale (who, when, what) — voiding a cash sale and keeping
      // the cash is the classic till fraud, so the evidence must survive.
      try { await col.voided_sales.insertOne({ sale, voidedBy: req.user.username, voidedByRole: req.user.role, voidedAt: new Date() }); }
      catch (e) { console.error('voided_sales archive failed:', e.message); }
      for (const it of (sale.items || [])) if (it.productId && ObjectId.isValid(it.productId)) await col.products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty) } });
      productCache.del('all_products');
      // Voiding a sale reverses any loyalty points it earned (anti-abuse).
      if (sale.customerPhone && sale.total) reversePoints(sale.customerPhone, sale.total, sale.pointsAwarded);
      creditNoteFor('sale', sale._id);
      auditLog(req, 'sale_voided', `Voided sale ${sale._id} — KES ${sale.total} ${sale.paymentMethod || ''} by ${sale.staff || '?'} on ${new Date(sale.createdAt).toISOString()}`);
      res.json({ success: true });
    } catch (e) { console.error('Failed to void sale:', e); res.status(500).json({ error: 'Failed to void sale' }); }
  });

  // ===== EXPENSES =====
  app.post('/api/admin/expenses', authenticate, requirePermission('expenses'), async (req, res) => {
    const { description, amount, branchId } = req.body;
    if (!description || amount === undefined || amount === '') return res.status(400).json({ error: 'Description and amount required' });
    const amt = parseFloat(amount); if (!(amt >= 0 && amt <= 10000000)) return res.status(400).json({ error: 'Enter a valid amount' }); try { const r = await col.expenses.insertOne({ description: String(description).slice(0, 200), amount: amt, createdBy: req.user.name, branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, expenseId: r.insertedId });} catch (e) { console.error('Failed to add expense:', e); res.status(500).json({ error: 'Failed to add expense' }); }
  });
  app.get('/api/admin/expenses', authenticate, requirePermission('expenses', 'records'), async (req, res) => { try { const filter = branchFilter(req); res.json(await col.expenses.find(filter).sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.delete('/api/admin/expenses/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' }); const exp = await col.expenses.findOne({ _id: new ObjectId(req.params.id) }); const r = await col.expenses.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); auditLog(req, 'expense_deleted', `Deleted expense "${exp ? String(exp.description).slice(0, 60) : req.params.id}" KES ${exp ? exp.amount : '?'}`); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

  // ===== CREDIT =====
  app.post('/api/admin/credit', authenticate, requirePermission('credit'), async (req, res) => {
    const { customerName, phone, amount, note, branchId } = req.body;
    if (!customerName || amount === undefined || amount === '') return res.status(400).json({ error: 'Name and amount required' });
    const amt = parseFloat(amount);
    if (!(amt > 0 && amt <= 10000000)) return res.status(400).json({ error: 'Enter a valid amount' });
    try {
      const r = await col.credit.insertOne({ customerName: String(customerName).slice(0, 80), phone: cleanPhone(phone), amount: amt, note: String(note || '').slice(0, 300), paid: false, branchId: branchId || req.user.branchId || null, createdBy: req.user.username, createdAt: new Date(), paidAt: null });
      auditLog(req, 'credit_added', `${String(customerName).slice(0, 40)} owes KES ${amt}`);
      res.json({ success: true, creditId: r.insertedId });
    }
    catch { res.status(500).json({ error: 'Failed' }); }
  });
  app.get('/api/admin/credit', authenticate, requirePermission('credit', 'records'), async (req, res) => { try { const filter = branchFilter(req); res.json(await col.credit.find(filter).sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.put('/api/admin/credit/:id/pay', authenticate, requirePermission('credit'), async (req, res) => { try { if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' }); const r = await col.credit.updateOne({ _id: new ObjectId(req.params.id), paid: { $ne: true } }, { $set: { paid: true, paidAt: new Date(), paidMarkedBy: req.user.username } }); if (!r.matchedCount) return res.status(404).json({ error: 'Not found or already paid' }); auditLog(req, 'credit_paid', `Credit ${req.params.id} marked paid`); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.delete('/api/admin/credit/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' }); const c = await col.credit.findOne({ _id: new ObjectId(req.params.id) }); const r = await col.credit.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); auditLog(req, 'credit_deleted', `Deleted credit of KES ${c ? c.amount : '?'} for ${c ? String(c.customerName).slice(0, 40) : req.params.id}${c && c.paid ? ' (paid)' : ' (UNPAID)'}`); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

  // ===== STAFF =====
  app.post('/api/admin/staff', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const { name, role, branchId } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    try { const r = await col.staff.insertOne({ name: name.trim(), role: role || 'Cashier', branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, staffId: r.insertedId }); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });
  app.get('/api/admin/staff', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await col.staff.find(filter).sort({ createdAt: 1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.delete('/api/admin/staff/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await col.staff.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

  // Shift Management: Start Shift
  app.post('/api/admin/shifts/start', authenticate, async (req, res) => {
    const { startingCash } = req.body;
    if (startingCash === undefined || startingCash === null) return res.status(400).json({ error: 'Starting cash balance is required' });
    if (!(parseFloat(startingCash) >= 0 && parseFloat(startingCash) <= 10000000)) return res.status(400).json({ error: 'Enter a valid starting cash amount' });
    try {
      const active = await col.shifts.findOne({ cashierId: req.user.userId, status: 'open' });
      if (active) return res.status(400).json({ error: 'You already have an open shift. Close it first.' });

      const shift = {
        cashierId: req.user.userId,
        cashierName: req.user.name || req.user.username,
        branchId: req.user.branchId || null,
        startTime: new Date(),
        startingCash: parseFloat(startingCash),
        status: 'open'
      };
      const r = await col.shifts.insertOne(shift);
      await logAction(req.user.userId, req.user.username, 'SHIFT_START', `Started shift with KES ${startingCash}`, req.user.branchId);
      res.json({ success: true, shiftId: r.insertedId });
    } catch (e) {
      console.error('Failed to start shift:', e);
      res.status(500).json({ error: 'Failed to start shift' });
    }
  });

  // Shift Management: End Shift
  app.post('/api/admin/shifts/end', authenticate, async (req, res) => {
    const { closingCash } = req.body;
    if (closingCash === undefined || closingCash === null) return res.status(400).json({ error: 'Closing cash balance is required' });
    if (!(parseFloat(closingCash) >= 0 && parseFloat(closingCash) <= 10000000)) return res.status(400).json({ error: 'Enter a valid closing cash amount' });
    try {
      const active = await col.shifts.findOne({ cashierId: req.user.userId, status: 'open' });
      if (!active) return res.status(400).json({ error: 'No active shift found.' });

      const filter = {
        cashierUserId: active.cashierId,
        createdAt: { $gte: active.startTime },
        ...(active.branchId ? { branchId: active.branchId } : {})
      };

      const salesList = liveSales(await col.sales.find(filter).toArray());
      const cashSalesTotal = salesList.reduce((acc, sale) => {
        if (sale.paymentMethod === 'cash') return acc + (sale.totalPrice || sale.total || 0);
        if (sale.paymentMethod === 'split') return acc + (parseFloat(sale.cashPart) || 0);
        return acc;
      }, 0);

      const mpesaSalesTotal = salesList.reduce((acc, sale) => {
        if (sale.paymentMethod === 'mpesa') return acc + (sale.totalPrice || sale.total || 0);
        if (sale.paymentMethod === 'split') return acc + (parseFloat(sale.mpesaPart) || 0);
        return acc;
      }, 0);

      const expectedCash = active.startingCash + cashSalesTotal;
      const difference = parseFloat(closingCash) - expectedCash;

      await col.shifts.updateOne(
        { _id: active._id },
        {
          $set: {
            endTime: new Date(),
            closingCash: parseFloat(closingCash),
            expectedCash,
            cashSales: cashSalesTotal,
            mpesaSales: mpesaSalesTotal,
            salesCount: salesList.length,
            difference,
            status: 'closed'
          }
        }
      );

      await logAction(
        req.user.userId,
        req.user.username,
        'SHIFT_CLOSE',
        `Closed shift. Expected KES ${expectedCash}, Actual KES ${closingCash}. Diff KES ${difference}`,
        req.user.branchId
      );

      res.json({
        success: true,
        summary: {
          startingCash: active.startingCash,
          cashSales: cashSalesTotal,
          mpesaSales: mpesaSalesTotal,
          expectedCash,
          closingCash: parseFloat(closingCash),
          difference,
          salesCount: salesList.length
        }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to close shift' });
    }
  });

  // Shift Management: Check active shift status
  app.get('/api/admin/shifts/active', authenticate, async (req, res) => {
    try {
      const active = await col.shifts.findOne({ cashierId: req.user.userId, status: 'open' });
      res.json({ active: !!active, shift: active });
    } catch (e) {
      console.error('Failed to check active shift:', e);
      res.status(500).json({ error: 'Failed to check active shift' });
    }
  });

  // Shift Management: Fetch shifts list
  app.get('/api/admin/shifts', authenticate, requirePermission('records'), async (req, res) => {
    try {
      const filter = branchFilter(req);
      const list = await col.shifts.find(filter).sort({ startTime: -1 }).limit(100).toArray();
      res.json(list);
    } catch (e) {
      console.error('Failed to fetch shifts:', e);
      res.status(500).json({ error: 'Failed to fetch shifts' });
    }
  });

  // Dispatch Audit Log for Automated Receipts
  app.post('/api/admin/receipt-delivery/log', authenticate, async (req, res) => {
    const { phone, details } = req.body;
    try {
      await logAction(
        req.user.userId,
        req.user.username,
        'RECEIPT_DISPATCH',
        `Auto-dispatched WhatsApp/SMS receipt to …${cleanPhone(phone).slice(-3)}: ${String(details || '').replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
        req.user.branchId
      );
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

};
