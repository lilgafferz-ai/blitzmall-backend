// Tax invoices for KRA eTIMS.
//
// What this does today: when Tax is switched on (Admin → Tax), every till sale
// and every delivered online order gets a sequentially numbered tax invoice
// with a VAT breakdown per tax category, and refunds/voids get a credit note.
// Invoices wait in a queue (status "pending") until they are accepted by KRA.
//
// What still needs the shop's KRA onboarding: actually transmitting the
// invoices. eTIMS works through a KRA-certified VSCU/OSCU integration that is
// issued to the business (TIN + branch + device serial) during onboarding.
// Once you have it, set ETIMS_VSCU_URL (and ETIMS_VSCU_KEY if your integrator
// uses one) and check `toVscuPayload` against the field spec KRA/your
// integrator gives you — the mapping below follows the published VSCU sales
// fields but must be verified before going live.
const { ObjectId } = require('mongodb');
const { col } = require('./db');
const { getSetting } = require('./settings');

// KRA eTIMS tax type codes.
const TAX_CATEGORIES = {
  A: { label: 'Exempt', rate: 0 },
  B: { label: 'VAT 16%', rate: 16 },
  C: { label: 'Zero-rated', rate: 0 },
  D: { label: 'Non-VAT', rate: 0 },
  E: { label: 'VAT 8%', rate: 8 }
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const vscuUrl = () => process.env.ETIMS_VSCU_URL || '';

async function nextInvoiceNo() {
  const r = await col.counters.findOneAndUpdate({ _id: 'tax_invoice' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const doc = r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
  return doc.seq;
}

// Split each line into taxable amount + tax for its category. Shelf prices
// in Kenya include VAT, so by default tax is carved out of the price.
function taxLines(items, productsById, settings) {
  return items.map(it => {
    const p = productsById.get(String(it.productId || it._id || it.id)) || {};
    const cat = TAX_CATEGORIES[p.taxCategory] ? p.taxCategory : (TAX_CATEGORIES[settings.defaultCategory] ? settings.defaultCategory : 'B');
    const rate = TAX_CATEGORIES[cat].rate;
    const qty = Number(it.qty ?? it.quantity) || 0;
    const total = round2(typeof it.lineTotal === 'number' ? it.lineTotal : (Number(it.price) || 0) * qty);
    const taxable = settings.pricesIncludeVat ? round2(total / (1 + rate / 100)) : total;
    const tax = settings.pricesIncludeVat ? round2(total - taxable) : round2(total * rate / 100);
    return { name: String(it.name || 'Item').slice(0, 120), qty, unitPrice: round2(it.price), total: round2(settings.pricesIncludeVat ? total : total + tax), taxCategory: cat, taxRate: rate, taxable, tax };
  });
}

function totalsByCategory(lines) {
  const t = { gross: 0, totalTaxable: 0, totalTax: 0, byCategory: {} };
  for (const l of lines) {
    const c = t.byCategory[l.taxCategory] || (t.byCategory[l.taxCategory] = { taxable: 0, tax: 0, rate: l.taxRate });
    c.taxable = round2(c.taxable + l.taxable); c.tax = round2(c.tax + l.tax);
    t.gross = round2(t.gross + l.total); t.totalTaxable = round2(t.totalTaxable + l.taxable); t.totalTax = round2(t.totalTax + l.tax);
  }
  return t;
}

// Issue (once) the invoice or credit note for a sale/order. Safe to call
// repeatedly — an existing document for the same source+type is returned.
async function issueInvoice({ source, sourceId, items, paymentMethod, customerPhone, type = 'invoice', originalInvoiceNo = null }) {
  const settings = await getSetting('tax');
  if (!settings.enabled || !col.tax_invoices) return null;
  const existing = await col.tax_invoices.findOne({ source, sourceId: String(sourceId), type });
  if (existing) return existing;
  const ids = (items || []).map(i => i.productId || i._id || i.id).filter(id => id && ObjectId.isValid(id)).map(id => new ObjectId(String(id)));
  const products = ids.length ? await col.products.find({ _id: { $in: ids } }).toArray() : [];
  const productsById = new Map(products.map(p => [String(p._id), p]));
  const lines = taxLines(items || [], productsById, settings);
  const sign = type === 'credit_note' ? -1 : 1;
  const totals = totalsByCategory(lines);
  const doc = {
    invoiceNo: await nextInvoiceNo(),
    type, source, sourceId: String(sourceId), originalInvoiceNo,
    kraPin: settings.kraPin || '', branchId: settings.branchId || '00', businessName: settings.businessName || '',
    customerPhone: customerPhone || '', paymentMethod: paymentMethod || 'cash',
    lines, sign, ...totals,
    status: vscuUrl() ? 'pending' : 'not_connected',
    attempts: 0, lastError: null, createdAt: new Date()
  };
  await col.tax_invoices.insertOne(doc);
  if (vscuUrl()) submitInvoice(doc).catch(() => {});
  return doc;
}

// Credit note for a refunded/voided sale or a cancelled order that already
// had an invoice.
async function issueCreditNote(source, sourceId) {
  if (!col.tax_invoices) return null;
  const original = await col.tax_invoices.findOne({ source, sourceId: String(sourceId), type: 'invoice' });
  if (!original) return null;
  return issueInvoice({
    source, sourceId, type: 'credit_note', originalInvoiceNo: original.invoiceNo,
    items: original.lines.map(l => ({ name: l.name, qty: l.qty, price: l.unitPrice, lineTotal: l.total })),
    paymentMethod: original.paymentMethod, customerPhone: original.customerPhone
  });
}

const PAYMENT_CODES = { cash: '01', credit: '02', card: '05', mpesa: '06', split: '07' };
const ymdhms = (d) => new Date(d).toISOString().replace(/[-:T]/g, '').slice(0, 14);

// VSCU sales payload. VERIFY against the spec you receive at onboarding.
function toVscuPayload(inv) {
  const cat = (c, k) => (inv.byCategory[c] ? inv.byCategory[c][k] : 0);
  return {
    tin: inv.kraPin, bhfId: inv.branchId,
    invcNo: inv.invoiceNo, orgInvcNo: inv.originalInvoiceNo || 0,
    salesTyCd: 'N', rcptTyCd: inv.type === 'credit_note' ? 'R' : 'S',
    pmtTyCd: PAYMENT_CODES[inv.paymentMethod] || '01', salesSttsCd: '02',
    cfmDt: ymdhms(inv.createdAt), salesDt: ymdhms(inv.createdAt).slice(0, 8),
    totItemCnt: inv.lines.length,
    taxblAmtA: cat('A', 'taxable'), taxblAmtB: cat('B', 'taxable'), taxblAmtC: cat('C', 'taxable'), taxblAmtD: cat('D', 'taxable'), taxblAmtE: cat('E', 'taxable'),
    taxRtA: 0, taxRtB: 16, taxRtC: 0, taxRtD: 0, taxRtE: 8,
    taxAmtA: cat('A', 'tax'), taxAmtB: cat('B', 'tax'), taxAmtC: cat('C', 'tax'), taxAmtD: cat('D', 'tax'), taxAmtE: cat('E', 'tax'),
    totTaxblAmt: inv.totalTaxable, totTaxAmt: inv.totalTax, totAmt: inv.gross,
    custTin: '', custNm: inv.customerPhone || '',
    itemList: inv.lines.map((l, i) => ({
      itemSeq: i + 1, itemNm: l.name, qty: l.qty, prc: l.unitPrice, splyAmt: l.total,
      dcRt: 0, dcAmt: 0, taxTyCd: l.taxCategory, taxblAmt: l.taxable, taxAmt: l.tax, totAmt: l.total
    }))
  };
}

async function submitInvoice(inv) {
  if (!vscuUrl()) return inv;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.ETIMS_VSCU_KEY) headers['x-api-key'] = process.env.ETIMS_VSCU_KEY;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(vscuUrl(), { method: 'POST', headers, body: JSON.stringify(toVscuPayload(inv)), signal: ctrl.signal }).finally(() => clearTimeout(t));
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && (data.resultCd === '000' || data.resultCd === 0 || data.success === true);
    await col.tax_invoices.updateOne({ invoiceNo: inv.invoiceNo }, {
      $set: ok
        ? { status: 'submitted', submittedAt: new Date(), kraReceipt: data.data || data, lastError: null }
        : { status: 'failed', lastError: String(data.resultMsg || data.error || `HTTP ${res.status}`).slice(0, 300) },
      $inc: { attempts: 1 }
    });
  } catch (e) {
    await col.tax_invoices.updateOne({ invoiceNo: inv.invoiceNo }, { $set: { status: 'failed', lastError: e.message.slice(0, 300) }, $inc: { attempts: 1 } });
  }
  return col.tax_invoices.findOne({ invoiceNo: inv.invoiceNo });
}

// Retry queue (every few minutes once a VSCU is configured).
async function submitPendingInvoices(limit = 20) {
  if (!vscuUrl() || !col.tax_invoices) return 0;
  const queue = await col.tax_invoices.find({ status: { $in: ['pending', 'failed', 'not_connected'] }, attempts: { $lt: 10 } }).sort({ invoiceNo: 1 }).limit(limit).toArray();
  for (const inv of queue) await submitInvoice(inv);
  return queue.length;
}

// Fire-and-forget wrappers used by the sale/order hooks.
const invoiceSale = (sale) => issueInvoice({ source: 'sale', sourceId: sale._id, items: sale.items, paymentMethod: sale.paymentMethod, customerPhone: sale.customerPhone })
  .catch(e => console.error('Tax invoice (sale) failed:', e.message));
const invoiceOrder = (order) => issueInvoice({ source: 'order', sourceId: order._id, items: order.items, paymentMethod: order.paymentMethod, customerPhone: order.customerId })
  .catch(e => console.error('Tax invoice (order) failed:', e.message));
const creditNoteFor = (source, id) => issueCreditNote(source, id).catch(e => console.error('Credit note failed:', e.message));

module.exports = { TAX_CATEGORIES, taxLines, totalsByCategory, issueInvoice, issueCreditNote, toVscuPayload, submitInvoice, submitPendingInvoices, invoiceSale, invoiceOrder, creditNoteFor, vscuUrl };
