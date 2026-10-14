// Delivery time slots ("Today 4–6pm"). Each slot has a capacity so riders can
// batch trips; a booking is any live (not cancelled) order holding the slot.
const { col } = require('./db');
const { getSetting } = require('./settings');

const pad = (n) => String(n).padStart(2, '0');
// Calendar date in shop time (the process TZ is pinned to Africa/Nairobi).
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const atTime = (day, hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(x => parseInt(x, 10) || 0);
  const d = new Date(day); d.setHours(h, m, 0, 0); return d;
};
const dayLabel = (offset, d) => (offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow'
  : d.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'short' }));

function sanitizeDeliverySettings(input = {}, current = {}) {
  const out = { ...current };
  if (input.slotsEnabled !== undefined) out.slotsEnabled = !!input.slotsEnabled;
  if (input.daysAhead !== undefined) out.daysAhead = Math.max(0, Math.min(7, parseInt(input.daysAhead, 10) || 0));
  if (input.cutoffMinutes !== undefined) out.cutoffMinutes = Math.max(0, Math.min(24 * 60, parseInt(input.cutoffMinutes, 10) || 0));
  if (Array.isArray(input.slots)) {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
    out.slots = input.slots
      .filter(s => s && valid.test(s.start) && valid.test(s.end) && s.start < s.end)
      .slice(0, 12)
      .map((s, i) => ({
        id: String(s.id || `slot${i + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || `slot${i + 1}`,
        label: String(s.label || `${s.start} – ${s.end}`).slice(0, 40),
        start: s.start, end: s.end,
        capacity: Math.max(0, Math.min(1000, parseInt(s.capacity, 10) || 0)) // 0 = unlimited
      }));
  }
  return out;
}

async function bookedCounts(dates) {
  const counts = {};
  const live = await col.orders.find({ 'deliverySlot.date': { $in: dates }, status: { $ne: 'cancelled' } }).toArray();
  for (const o of live) {
    const k = `${o.deliverySlot.date}|${o.deliverySlot.id}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

// The bookable slots from now until `daysAhead` days out.
async function listSlots(now = new Date()) {
  const s = await getSetting('delivery');
  if (!s.slotsEnabled || !Array.isArray(s.slots) || !s.slots.length) return { enabled: false, days: [] };
  const days = [];
  for (let offset = 0; offset <= (s.daysAhead || 0); offset++) {
    const day = new Date(now); day.setDate(now.getDate() + offset); day.setHours(0, 0, 0, 0);
    days.push({ offset, day, date: dateKey(day) });
  }
  const counts = await bookedCounts(days.map(d => d.date));
  return {
    enabled: true,
    days: days.map(({ offset, day, date }) => ({
      date,
      label: dayLabel(offset, day),
      slots: s.slots.map(slot => {
        const booked = counts[`${date}|${slot.id}`] || 0;
        const closesAt = new Date(atTime(day, slot.start).getTime() - (s.cutoffMinutes || 0) * 60000);
        const full = slot.capacity > 0 && booked >= slot.capacity;
        return {
          id: slot.id, label: slot.label, start: slot.start, end: slot.end,
          remaining: slot.capacity > 0 ? Math.max(0, slot.capacity - booked) : null,
          available: now < closesAt && !full,
          reason: now >= closesAt ? 'closed' : full ? 'full' : null
        };
      })
    })).filter(d => d.slots.some(x => x.available))
  };
}

// Validate a slot chosen at checkout; returns the stored form or throws.
async function resolveSlot(choice, now = new Date()) {
  if (!choice || !choice.date || !choice.id) return null;
  const { enabled, days } = await listSlots(now);
  if (!enabled) return null;
  const day = days.find(d => d.date === String(choice.date));
  const slot = day && day.slots.find(x => x.id === String(choice.id));
  if (!slot || !slot.available) {
    const e = new Error(slot && slot.reason === 'full' ? 'That delivery slot just filled up — please pick another.' : 'That delivery slot is no longer available — please pick another.');
    e.slotError = true;
    throw e;
  }
  return { date: day.date, id: slot.id, label: `${day.label} ${slot.label}`, start: slot.start, end: slot.end };
}

module.exports = { sanitizeDeliverySettings, listSlots, resolveSlot, dateKey };
