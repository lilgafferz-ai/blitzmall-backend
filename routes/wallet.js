// Wallet ledger: a customer's own history, and the owner's audit tools.
const { auditLog, authenticate, authenticateCustomer, authorize } = require('../lib/auth');
const { col } = require('../lib/db');
const { cleanPhone } = require('../lib/util');
const { reconcileWallets, round2, walletHistory } = require('../lib/wallet');

const publicTx = (t) => ({
  id: String(t._id), type: t.type, amount: t.amount, balanceAfter: t.balanceAfter,
  refId: t.refId || null, note: t.note || '', createdAt: t.createdAt
});

module.exports = function register(app) {
  // The signed-in customer's own wallet statement (newest first).
  app.get('/api/customer/wallet/history', authenticateCustomer, async (req, res) => {
    try {
      const card = await col.loyalty.findOne({ phone: req.customerPhone });
      const items = await walletHistory(req.customerPhone, 50);
      res.json({ balance: round2(card && card.walletBalance), transactions: items.map(publicTx) });
    } catch (e) {
      console.error('wallet/history error:', e);
      res.status(500).json({ error: 'Failed to load wallet history' });
    }
  });

  // Owner: does every wallet balance match its ledger?
  app.get('/api/admin/wallet/reconcile', authenticate, authorize('owner'), async (req, res) => {
    try {
      const report = await reconcileWallets();
      auditLog(req, 'wallet_reconciled', report.ok
        ? `All ${report.accounts} wallet(s) match the ledger (KES ${report.totalBalance} held)`
        : `${report.mismatches.length} of ${report.accounts} wallet(s) do NOT match the ledger`);
      res.json(report);
    } catch (e) {
      console.error('wallet/reconcile error:', e);
      res.status(500).json({ error: 'Failed to reconcile wallets' });
    }
  });

  // Owner: one customer's full statement, for disputes.
  app.get('/api/admin/wallet/ledger/:phone', authenticate, authorize('owner'), async (req, res) => {
    const phone = cleanPhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    try {
      const card = await col.loyalty.findOne({ phone });
      const items = await walletHistory(phone, 500);
      res.json({ phone, balance: round2(card && card.walletBalance), transactions: items.map(publicTx) });
    } catch (e) {
      console.error('wallet/ledger error:', e);
      res.status(500).json({ error: 'Failed to load wallet ledger' });
    }
  });
};
