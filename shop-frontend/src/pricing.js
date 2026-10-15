// Basket pricing shown in the app and at the till. MIRRORS src/services/units.js
// on the server (the server's numbers always win at checkout) — keep in step.

const LOOSE_UNITS = ['kg', 'g', 'l', 'ml'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const isLoose = (p) => !!(p && (p.soldLoose || LOOSE_UNITS.includes(p.unit)));
export const qtyStepOf = (p) => (isLoose(p) ? (parseFloat(p.qtyStep) > 0 ? parseFloat(p.qtyStep) : 0.25) : 1);
export const unitLabel = (p) => (p && p.unit && p.unit !== 'pcs' ? p.unit : '');

// "1.5 kg", "3"
export const formatQty = (p, q) => {
  const n = round2(q);
  const u = unitLabel(p);
  return u ? `${n} ${u}` : String(n);
};

export const snapQty = (p, raw) => {
  const step = qtyStepOf(p);
  const n = Math.abs(parseFloat(raw));
  if (!isLoose(p)) return Math.max(1, Math.round(n) || 1);
  return round2(Math.max(step, Math.round((n > 0 ? n : step) / step) * step));
};

// Cheapest price for qty units using any mix of the product's deals.
export function bestLineTotal(unitPrice, qty, deals) {
  const price = Math.max(0, Number(unitPrice) || 0);
  const useful = (Array.isArray(deals) ? deals : []).filter(d => d && d.qty >= 2 && d.price > 0 && d.price < price * d.qty);
  const whole = Math.round(qty);
  if (!useful.length || whole !== qty || whole < 2 || whole > 99) return round2(price * qty);
  const best = new Array(whole + 1).fill(Infinity);
  best[0] = 0;
  for (let n = 1; n <= whole; n++) {
    best[n] = best[n - 1] + price;
    for (const d of useful) if (n >= d.qty) best[n] = Math.min(best[n], best[n - d.qty] + d.price);
  }
  return round2(best[whole]);
}

export const lineTotalFor = (p, qty) => (isLoose(p) ? round2((Number(p.price) || 0) * qty) : bestLineTotal(p.price, qty, p.bulkDeals));
export const dealSavingsFor = (p, qty) => round2((Number(p.price) || 0) * qty - lineTotalFor(p, qty));
export const dealLabels = (p) => (Array.isArray(p && p.bulkDeals) ? p.bulkDeals : []).map(d => `${d.qty} for KES ${d.price}`);
