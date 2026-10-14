// Tax (eTIMS) invoices and the nightly closing report.
const { col } = require('../lib/db');
const { authenticate, authorize, requirePermission, auditLog } = require('../lib/auth');
const { getSetting, saveSetting } = require('../lib/settings');
const { TAX_CATEGORIES, submitPendingInvoices, vscuUrl } = require('../lib/etims');
const { buildDailyReport, reportText, sendDailyReport } = require('../lib/dailyReport');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function register(app) {
  // ===== TAX / eTIMS =====
  app.get('/api/admin/tax/settings', authenticate, requirePermission('tax'), async (req, res) => {
    try { res.json({ settings: await getSetting('tax'), categories: TAX_CATEGORIES, connected: !!vscuUrl() }); }
    catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.put('/api/admin/tax/settings', authenticate, authorize('owner'), async (req, res) => {
    try {
      const cur = await getSetting('tax');
      const b = req.body || {};
      const next = {
        ...cur,
        enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
        kraPin: b.kraPin !== undefined ? String(b.kraPin).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) : cur.kraPin,
        businessName: b.businessName !== undefined ? String(b.businessName).slice(0, 80) : cur.businessName,
        branchId: b.branchId !== undefined ? String(b.branchId).replace(/[^0-9]/g, '').slice(0, 3) || '00' : cur.branchId,
        defaultCategory: TAX_CATEGORIES[b.defaultCategory] ? b.defaultCategory : cur.defaultCategory,
        pricesIncludeVat: b.pricesIncludeVat !== undefined ? !!b.pricesIncludeVat : cur.pricesIncludeVat
      };
      if (next.enabled && !/^[AP]\d{9}[A-Z]$/.test(next.kraPin)) return res.status(400).json({ error: 'Enter the shop\'s KRA PIN (e.g. P051234567X) before switching tax invoices on' });
      const saved = await saveSetting('tax', next);
      auditLog(req, 'tax_settings_saved', `Tax invoices ${saved.enabled ? 'ON' : 'OFF'} (PIN ${saved.kraPin || '—'})`);
      res.json({ success: true, settings: saved });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to save tax settings' }); }
  });

  app.get('/api/admin/tax/invoices', authenticate, requirePermission('tax'), async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = String(req.query.status);
      const [list, pending, failed, notConnected, submitted] = await Promise.all([
        col.tax_invoices.find(filter).sort({ invoiceNo: -1 }).limit(Math.min(500, parseInt(req.query.limit, 10) || 100)).toArray(),
        col.tax_invoices.countDocuments({ status: 'pending' }),
        col.tax_invoices.countDocuments({ status: 'failed' }),
        col.tax_invoices.countDocuments({ status: 'not_connected' }),
        col.tax_invoices.countDocuments({ status: 'submitted' })
      ]);
      res.json({ invoices: list, counts: { pending, failed, notConnected, submitted }, connected: !!vscuUrl() });
    } catch (e) { res.status(500).json({ error: 'Failed to load invoices' }); }
  });

  // VAT summary for a month (what goes on the VAT return).
  app.get('/api/admin/tax/summary', authenticate, requirePermission('tax'), async (req, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
      const start = new Date(`${month}-01T00:00:00`);
      const end = new Date(start); end.setMonth(start.getMonth() + 1);
      const invs = await col.tax_invoices.find({ createdAt: { $gte: start, $lt: end } }).toArray();
      const byCategory = {};
      let gross = 0, tax = 0;
      for (const inv of invs) {
        const sign = inv.sign || 1;
        gross += sign * (inv.gross || 0); tax += sign * (inv.totalTax || 0);
        for (const [cat, v] of Object.entries(inv.byCategory || {})) {
          const c = byCategory[cat] || (byCategory[cat] = { taxable: 0, tax: 0, label: (TAX_CATEGORIES[cat] || {}).label });
          c.taxable = Math.round((c.taxable + sign * v.taxable) * 100) / 100;
          c.tax = Math.round((c.tax + sign * v.tax) * 100) / 100;
        }
      }
      res.json({ month, invoices: invs.length, gross: Math.round(gross * 100) / 100, tax: Math.round(tax * 100) / 100, byCategory });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/tax/retry', authenticate, requirePermission('tax'), async (req, res) => {
    if (!vscuUrl()) return res.status(400).json({ error: 'No eTIMS connection is configured yet (ETIMS_VSCU_URL). Invoices are kept and will be sent once it is.' });
    try { res.json({ success: true, attempted: await submitPendingInvoices(50) }); }
    catch (e) { res.status(500).json({ error: 'Retry failed' }); }
  });

  // ===== DAILY CLOSING REPORT =====
  app.get('/api/admin/reports/daily', authenticate, requirePermission('records'), async (req, res) => {
    try {
      const date = DATE.test(String(req.query.date)) ? String(req.query.date) : undefined;
      const report = await buildDailyReport(date);
      res.json({ report, text: reportText(report) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to build report' }); }
  });

  app.get('/api/admin/reports/daily/history', authenticate, requirePermission('records'), async (req, res) => {
    try { res.json(await col.daily_reports.find().sort({ date: -1 }).limit(60).toArray()); }
    catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/reports/daily/send', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      const date = DATE.test(String(req.body.date)) ? String(req.body.date) : undefined;
      const r = await sendDailyReport(date);
      res.json({ success: true, pushed: r.pushed, sms: r.sms, text: r.text });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to send report' }); }
  });

  app.get('/api/admin/reports/settings', authenticate, requirePermission('records'), async (req, res) => {
    try { res.json(await getSetting('dailyReport')); } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });
  app.put('/api/admin/reports/settings', authenticate, authorize('owner'), async (req, res) => {
    try {
      const cur = await getSetting('dailyReport');
      const b = req.body || {};
      const next = {
        enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
        sendAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.sendAt)) ? b.sendAt : cur.sendAt,
        smsTo: b.smsTo !== undefined ? String(b.smsTo).replace(/[^0-9+]/g, '').slice(0, 15) : cur.smsTo
      };
      res.json({ success: true, settings: await saveSetting('dailyReport', next) });
    } catch (e) { res.status(500).json({ error: 'Failed to save report settings' }); }
  });
};
