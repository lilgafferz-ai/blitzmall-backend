// Nightly closing report: the day's sales, payments, profit, orders, stock
// and anything that needs the owner's attention — pushed to the owner's phone
// (and SMS'd if a number is set) at the time chosen in HQ → Records.
const { col } = require('./db');
const { getSetting } = require('./settings');
const { sendPushToOwners } = require('./notifications');
const { sendSms, smsConfigured } = require('./sms');
const { costMap, liveSales, orderProfit } = require('./reports');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LOW_STOCK = 5;
const pad = (n) => String(n).padStart(2, '0');
// Calendar date in shop time (the process TZ is pinned to Africa/Nairobi).
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayBounds = (dateStr) => {
  const start = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  if (!dateStr) start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 1);
  return { start, end };
};

async function buildDailyReport(dateStr) {
  const { start, end } = dayBounds(dateStr);
  const range = { createdAt: { $gte: start, $lt: end } };
  const [allSales, orders, expenses, products, topUps, invoicesWaiting, refundsDue] = await Promise.all([
    col.sales.find(range).toArray(),
    col.orders.find(range).toArray(),
    col.expenses.find(range).toArray(),
    col.products.find().toArray(),
    col.redemptions.find({ type: 'wallet_topup', redeemedAt: { $gte: start, $lt: end } }).toArray(),
    col.tax_invoices ? col.tax_invoices.countDocuments({ status: { $in: ['pending', 'failed', 'not_connected'] } }) : 0,
    col.orders.find({ refundStatus: 'due' }).toArray()
  ]);
  const sales = liveSales(allSales);
  const live = orders.filter(o => o.status !== 'cancelled');
  const costById = costMap(products);
  let revenue = 0, profit = 0, cash = 0, mpesa = 0;
  for (const s of sales) {
    revenue += s.total || 0; profit += s.profit || 0;
    if (s.paymentMethod === 'cash') cash += s.total || 0;
    else if (s.paymentMethod === 'mpesa') mpesa += s.total || 0;
    else if (s.paymentMethod === 'split') { cash += s.cashPart || 0; mpesa += s.mpesaPart || 0; }
  }
  for (const o of live) {
    revenue += o.totalPrice || 0;
    profit += orderProfit(o, costById);
    if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0; else cash += o.totalPrice || 0;
  }
  const expenseTotal = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const units = {};
  for (const s of sales) for (const it of s.items || []) units[it.name] = (units[it.name] || 0) + (it.qty || 0);
  for (const o of live) for (const it of o.items || []) units[it.name] = (units[it.name] || 0) + (it.quantity || 0);
  return {
    date: dateKey(start),
    revenue: round2(revenue), profit: round2(profit), expenses: round2(expenseTotal), net: round2(profit - expenseTotal),
    cash: round2(cash), mpesa: round2(mpesa), count: sales.length + live.length,
    orderCount: live.length,
    pendingOrders: live.filter(o => o.status === 'pending').length,
    cancelledOrders: orders.length - live.length,
    walletTopUps: round2(topUps.reduce((s, r) => s + (r.rewardValue || 0), 0)),
    refundsDue: refundsDue.length,
    refundsDueAmount: round2(refundsDue.reduce((s, o) => s + (o.refundDue || 0), 0)),
    outOfStock: products.filter(p => typeof p.stock === 'number' && p.stock <= 0).length,
    lowStock: products.filter(p => typeof p.stock === 'number' && p.stock > 0 && p.stock < LOW_STOCK).length,
    topItems: Object.entries(units).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty: round2(qty) })),
    taxInvoicesWaiting: invoicesWaiting || 0,
    generatedAt: new Date()
  };
}

const money = (n) => 'KES ' + Math.round(n || 0).toLocaleString('en-KE');
function reportText(r) {
  const lines = [
    `BlitzMall closing report ${r.date}`,
    `Sales: ${money(r.revenue)} (${r.count} txns) — cash ${money(r.cash)}, M-Pesa ${money(r.mpesa)}`,
    `Profit ${money(r.profit)} − expenses ${money(r.expenses)} = net ${money(r.net)}`,
    `Online orders: ${r.orderCount}${r.pendingOrders ? `, ${r.pendingOrders} still pending` : ''}`
  ];
  if (r.walletTopUps) lines.push(`Wallet top-ups: ${money(r.walletTopUps)}`);
  if (r.topItems.length) lines.push('Top: ' + r.topItems.map(t => `${t.name} ×${t.qty}`).join(', '));
  if (r.outOfStock || r.lowStock) lines.push(`Stock: ${r.outOfStock} out, ${r.lowStock} low`);
  if (r.refundsDue) lines.push(`Refunds due: ${r.refundsDue} (${money(r.refundsDueAmount)})`);
  if (r.taxInvoicesWaiting) lines.push(`Tax invoices not yet sent to KRA: ${r.taxInvoicesWaiting}`);
  return lines.join('\n');
}

async function sendDailyReport(dateStr) {
  const report = await buildDailyReport(dateStr);
  const text = reportText(report);
  const r = await col.daily_reports.updateOne({ _id: report.date }, { $set: { ...report, text } });
  if (!r.matchedCount) await col.daily_reports.insertOne({ _id: report.date, ...report, text });
  const push = await sendPushToOwners(`📊 Closing report ${report.date}`, `Sales ${money(report.revenue)} · net ${money(report.net)} · ${report.orderCount} online orders`);
  let sms = false;
  const s = await getSetting('dailyReport');
  if (s.smsTo && smsConfigured()) sms = await sendSms(s.smsTo, text);
  return { report, text, pushed: push.sent || 0, sms };
}

// Called every minute: sends today's report once, at the owner's chosen time.
// The claim is atomic, so two server instances never both send it.
async function dailyReportTick(now = new Date()) {
  try {
    if (!col.shop_settings) return;
    const s = await getSetting('dailyReport');
    if (!s.enabled) return;
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` < (s.sendAt || '21:00')) return;
    const today = dateKey(now);
    let claimed = null;
    try {
      const r = await col.shop_settings.findOneAndUpdate(
        { _id: 'dailyReport_lastSent', date: { $ne: today } },
        { $set: { date: today, at: now } },
        { upsert: true, returnDocument: 'after' }
      );
      claimed = r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
    } catch (e) { if (e && e.code === 11000) return; throw e; }
    if (!claimed || claimed.date !== today) return;
    await sendDailyReport(today);
    console.log('📊 Daily closing report sent for', today);
  } catch (e) { console.error('Daily report failed:', e.message); }
}

module.exports = { buildDailyReport, reportText, sendDailyReport, dailyReportTick, dateKey };
