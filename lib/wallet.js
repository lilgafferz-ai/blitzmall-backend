// Wallet ledger: every change to a customer's wallet cash is written to the
// append-only `wallet_transactions` collection next to the running balance on
// their loyalty card. The balance stays the fast number the app shows; the
// ledger is the proof — it explains every shilling (what, when, which order)
// and reconcileWallets() flags any card whose balance doesn't match its
// history, i.e. a change that bypassed the ledger.
//
// Entry: { phone, type, amount (+credit / −debit), balanceAfter, refId, note, createdAt }
// Types: opening_balance, points_conversion, order_payment, order_refund (the
// wallet part of a cancelled or failed order).
const { col } = require('./db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// The real driver returns the document; the offline mock wraps it in { value }.
const unwrapDoc = (r) => (r && typeof r === 'object' && r.value !== undefined ? r.value : r);

async function recordWalletTx({ phone, type, amount, balanceAfter, refId = null, note = '' }) {
  try {
    if (!col.wallet_transactions) return;
    await col.wallet_transactions.insertOne({
      phone: String(phone), type: String(type), amount: round2(amount),
      balanceAfter: round2(balanceAfter), refId: refId ? String(refId) : null,
      note: String(note || '').slice(0, 200), createdAt: new Date()
    });
  } catch (e) {
    // The money already moved; a missing entry shows up in reconciliation.
    console.error('[wallet-ledger] failed to record', type, phone, amount, e.message);
  }
}

// Moves wallet cash atomically and returns the balance afterwards, or null when
// nothing changed (no loyalty card, or — for a debit — not enough cash).
// Debits only match while the card still holds the full amount, so two
// simultaneous spends can never overdraw.
async function adjustWallet(phone, amount) {
  const delta = round2(amount);
  if (!delta) return null;
  const filter = { phone: String(phone) };
  if (delta < 0) filter.walletBalance = { $gte: -delta };
  const r = await col.loyalty.findOneAndUpdate(
    filter,
    { $inc: { walletBalance: delta }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const doc = unwrapDoc(r);
  return doc ? round2(doc.walletBalance) : null;
}

// adjustWallet + ledger entry in one call.
async function moveWallet(phone, amount, { type, refId, note } = {}) {
  const balanceAfter = await adjustWallet(phone, amount);
  if (balanceAfter === null) return null;
  await recordWalletTx({ phone, type, amount, balanceAfter, refId, note });
  return balanceAfter;
}

async function walletHistory(phone, limit = 50) {
  return col.wallet_transactions.find({ phone: String(phone) }).sort({ createdAt: -1 }).limit(limit).toArray();
}

// Cards that held cash before the ledger existed get one opening_balance entry
// so their history starts from the right number. Idempotent: a card with any
// ledger entry is left alone.
async function seedOpeningBalances() {
  if (!col.wallet_transactions) return 0;
  const cards = await col.loyalty.find({ walletBalance: { $gt: 0 } }).toArray();
  if (!cards.length) return 0;
  const known = new Set((await col.wallet_transactions.find({}).toArray()).map(t => t.phone));
  let seeded = 0;
  for (const c of cards) {
    if (!c.phone || !c.walletBalance || known.has(String(c.phone))) continue;
    await recordWalletTx({ phone: c.phone, type: 'opening_balance', amount: c.walletBalance, balanceAfter: c.walletBalance, note: 'Balance carried over when the wallet ledger was introduced' });
    seeded++;
  }
  return seeded;
}

// Compares every card's balance with the sum of its ledger. A mismatch means
// wallet cash changed without a ledger entry (or an entry without the cash).
async function reconcileWallets() {
  const [cards, txs] = await Promise.all([
    col.loyalty.find({}).toArray(),
    col.wallet_transactions.find({}).toArray()
  ]);
  const ledger = new Map();
  for (const t of txs) ledger.set(t.phone, round2((ledger.get(t.phone) || 0) + (t.amount || 0)));
  const balances = new Map(cards.map(c => [String(c.phone), round2(c.walletBalance)]));
  const phones = new Set([...balances.keys(), ...ledger.keys()]);
  const mismatches = [];
  let totalBalance = 0;
  for (const phone of phones) {
    const balance = balances.has(phone) ? balances.get(phone) : 0;
    const fromLedger = ledger.get(phone) || 0;
    totalBalance = round2(totalBalance + balance);
    if (Math.abs(balance - fromLedger) >= 0.01) {
      mismatches.push({ phone, balance, ledger: fromLedger, difference: round2(balance - fromLedger), cardMissing: !balances.has(phone) });
    }
  }
  return { checkedAt: new Date(), accounts: phones.size, entries: txs.length, totalBalance, ok: mismatches.length === 0, mismatches };
}

module.exports = { round2, recordWalletTx, adjustWallet, moveWallet, walletHistory, seedOpeningBalances, reconcileWallets };
