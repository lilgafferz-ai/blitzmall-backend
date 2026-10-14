// Selling units: loose goods sold by weight/volume (sugar by the kg, cooking
// oil by the litre) and multi-buy deals ("6 for KES 300").
//
// The SAME rules run in the customer app and the till (shop-frontend/src/
// pricing.js mirrors bestLineTotal) — keep the two in step.

const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'pack', 'bunch'];
const LOOSE_UNITS = ['kg', 'g', 'l', 'ml'];
const MAX_PACKED_QTY = 99;
const MAX_LOOSE_QTY = 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Clean the owner's product settings (Inventory form) into a safe shape.
function sanitizeUnitFields(input = {}) {
  const out = {};
  if (input.unit !== undefined) out.unit = UNITS.includes(input.unit) ? input.unit : 'pcs';
  if (input.soldLoose !== undefined) out.soldLoose = !!input.soldLoose;
  if (input.qtyStep !== undefined) {
    const step = parseFloat(input.qtyStep);
    out.qtyStep = step > 0 && step <= 100 ? round2(step) : 0.25;
  }
  if (input.bulkDeals !== undefined) {
    out.bulkDeals = (Array.isArray(input.bulkDeals) ? input.bulkDeals : [])
      .map(d => ({ qty: parseInt(d && d.qty, 10), price: round2(parseFloat(d && d.price)) }))
      .filter(d => d.qty >= 2 && d.qty <= 99 && d.price > 0)
      .sort((a, b) => a.qty - b.qty)
      .slice(0, 5);
  }
  return out;
}

const isLoose = (p) => !!(p && (p.soldLoose || LOOSE_UNITS.includes(p.unit)));
const qtyStepOf = (p) => (isLoose(p) ? (parseFloat(p.qtyStep) > 0 ? parseFloat(p.qtyStep) : 0.25) : 1);

// Snap a requested quantity to what the product can be sold in: whole units
// (1–99) for packed goods, multiples of the step (e.g. 0.25 kg) for loose ones.
function normalizeQty(p, raw) {
  const n = Math.abs(parseFloat(raw));
  if (!isLoose(p)) return Math.max(1, Math.min(MAX_PACKED_QTY, Math.round(n) || 1));
  const step = qtyStepOf(p);
  const snapped = Math.round((Number.isFinite(n) && n > 0 ? n : step) / step) * step;
  return round2(Math.max(step, Math.min(MAX_LOOSE_QTY, snapped)));
}

// Cheapest price for `qty` units at `unitPrice`, using any mix of the
// product's multi-buy deals (a deal is only used when it actually saves money).
function bestLineTotal(unitPrice, qty, deals) {
  const price = Math.max(0, Number(unitPrice) || 0);
  const useful = (Array.isArray(deals) ? deals : []).filter(d => d && d.qty >= 2 && d.price > 0 && d.price < price * d.qty);
  const whole = Math.round(qty);
  if (!useful.length || whole !== qty || whole < 2 || whole > MAX_PACKED_QTY) return round2(price * qty);
  const best = new Array(whole + 1).fill(Infinity);
  best[0] = 0;
  for (let n = 1; n <= whole; n++) {
    best[n] = best[n - 1] + price;
    for (const d of useful) if (n >= d.qty) best[n] = Math.min(best[n], best[n - d.qty] + d.price);
  }
  return round2(best[whole]);
}

// Total for one basket line, plus what the deals saved.
function priceLine(product, unitPrice, qty) {
  const plain = round2((Number(unitPrice) || 0) * qty);
  const total = isLoose(product) ? plain : bestLineTotal(unitPrice, qty, product && product.bulkDeals);
  return { lineTotal: total, dealSavings: round2(plain - total) };
}

// Line total of a stored order/sale line (older lines have no lineTotal).
const storedLineTotal = (it) => (it && typeof it.lineTotal === 'number'
  ? it.lineTotal
  : round2((Number(it && it.price) || 0) * (Number(it && (it.quantity ?? it.qty)) || 0)));

module.exports = { UNITS, LOOSE_UNITS, sanitizeUnitFields, isLoose, qtyStepOf, normalizeQty, bestLineTotal, priceLine, storedLineTotal };
