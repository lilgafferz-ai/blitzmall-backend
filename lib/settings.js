// Owner-editable shop settings (one document per area: delivery slots, tax /
// eTIMS, daily report). Defaults live here so a fresh shop works out of the
// box; stored values are merged over them. Cached briefly.
const { col } = require('./db');

const DEFAULTS = {
  delivery: {
    slotsEnabled: true,
    daysAhead: 2,          // today + 2 more days
    cutoffMinutes: 60,     // a slot closes this long before it starts
    slots: [
      { id: 'morning', label: '9am – 12pm', start: '09:00', end: '12:00', capacity: 10 },
      { id: 'afternoon', label: '12pm – 4pm', start: '12:00', end: '16:00', capacity: 10 },
      { id: 'evening', label: '4pm – 7pm', start: '16:00', end: '19:00', capacity: 10 }
    ]
  },
  tax: {
    enabled: false,        // issue eTIMS-style tax invoices for every sale/order
    kraPin: '',
    businessName: 'Blitz Mall',
    branchId: '00',
    defaultCategory: 'B',  // KRA tax type B = VAT 16% (see services/etims.js)
    pricesIncludeVat: true
  },
  dailyReport: {
    enabled: true,
    sendAt: '21:00',       // shop time (Africa/Nairobi)
    smsTo: ''              // owner's phone for an SMS copy (needs Africa's Talking)
  }
};

const CACHE_MS = 30 * 1000;
const cache = new Map();

const merge = (base, stored) => {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return stored === undefined ? base : stored;
  const out = { ...base };
  for (const [k, v] of Object.entries(stored)) out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], v) : v;
  return out;
};

async function getSetting(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let stored = null;
  try { stored = col.shop_settings ? await col.shop_settings.findOne({ _id: name }) : null; } catch (e) { stored = null; }
  const value = merge(DEFAULTS[name] || {}, stored ? stored.value : undefined);
  cache.set(name, { value, at: Date.now() });
  return value;
}

async function saveSetting(name, value) {
  cache.delete(name);
  const r = await col.shop_settings.updateOne({ _id: name }, { $set: { value, updatedAt: new Date() } });
  if (!r.matchedCount) await col.shop_settings.insertOne({ _id: name, value, updatedAt: new Date() });
  return getSetting(name);
}

module.exports = { DEFAULTS, getSetting, saveSetting };
