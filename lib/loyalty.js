// Loyalty points, redemption tiers and the spin/scratch promos.
const crypto = require('crypto');
const { col } = require('./db');
const { sendPushToPhone } = require('./notifications');

// ===== LOYALTY & REWARDS =====
// Referral rewards — a shopper who brings a friend earns bonus loyalty points
// for BOTH of them, once per new friend (see /api/auth).
const REFERRER_BONUS_POINTS = 100;
const REFEREE_BONUS_POINTS = 50;

// ===== LOYALTY ENGINE (business-first, settings-driven) =====
// Every rate/threshold/probability below lives in col.loyalty_settings so the
// owner can retune the economics from the Admin → Loyalty Controls tab without
// a code change. Defaults match the owner's spec:
//   - 1 point per KES 200 of NET paid spend, floored (KES 199 = 0 pts)
//   - 100 points redeem for KES 100 (higher tiers slightly better value)
//   - Tiers by points: Bronze 0-199 / Silver 200-599 / Gold 600-1499 / Platinum 1500+
//   - Spin: 2 paid orders gate, 1 spin / 24h; Scratch: 2 orders, 1 / 48h
const LOYALTY_SETTINGS_DEFAULTS = {
  earnRate: 200, // KES spent per 1 point
  tierThresholds: { silver: 200, gold: 600, platinum: 1500 },
  // Owner currency: 5 points = KES 1 (100 PTS = KES 20 cashback). These are
  // editable in Admin → Loyalty Controls and drive BOTH the customer Points
  // Redemption Store and the counter redemption.
  redeemTiers: [
    { points: 100, value: 20 },
    { points: 250, value: 50 },
    { points: 500, value: 100 },
    { points: 1000, value: 200 }
  ],
  jackpotEnabled: true,
  spinCooldownHours: 24,
  scratchCooldownHours: 48,
  minOrdersForPromo: 2,
  seasonalEvents: [] // { name, pointsMultiplier, active }
};

let loyaltySettingsCache = null;
async function getLoyaltySettings() {
  if (loyaltySettingsCache) return loyaltySettingsCache;
  try {
    const doc = col.loyalty_settings ? await col.loyalty_settings.findOne({ key: 'default' }) : null;
    const stored = (doc && doc.value) || {};
    loyaltySettingsCache = {
      ...LOYALTY_SETTINGS_DEFAULTS,
      ...stored,
      // Probabilities are owner-editable: fall back to the code constants when
      // the stored settings don't carry a weight table yet.
      spinWeights: Array.isArray(stored.spinWeights) ? stored.spinWeights : WHEEL_SECTORS.map(o => ({ prize: o.prize, weight: o.weight })),
      scratchWeights: Array.isArray(stored.scratchWeights) ? stored.scratchWeights : SCRATCH_OUTCOMES.map(o => ({ prize: o.prize, weight: o.weight }))
    };
  } catch (e) { loyaltySettingsCache = { ...LOYALTY_SETTINGS_DEFAULTS }; }
  return loyaltySettingsCache;
}
const saveLoyaltySettings = async (value) => {
  loyaltySettingsCache = null;
  if (!col.loyalty_settings) return;
  // findOne → insertOne fallback keeps saves working even in offline mock mode,
  // where updateOne's upsert option is not supported (silent no-op otherwise).
  const existing = await col.loyalty_settings.findOne({ key: 'default' });
  if (existing) await col.loyalty_settings.updateOne({ key: 'default' }, { $set: { value, updatedAt: new Date() } });
  else await col.loyalty_settings.insertOne({ key: 'default', value, updatedAt: new Date() });
};
const seedLoyaltySettings = async () => {
  try {
    if (!col.loyalty_settings) return;
    const exists = await col.loyalty_settings.findOne({ key: 'default' });
    if (!exists) {
      await col.loyalty_settings.insertOne({ key: 'default', value: LOYALTY_SETTINGS_DEFAULTS, updatedAt: new Date() });
      return;
    }
    // Migration: shops on the OLD default tables (100 PTS = KES 100 / KES 500)
    // are moved to the owner's currency (5 pts = KES 1). Custom tiers the
    // owner saved themselves are NEVER touched.
    try {
      const stored = exists.value || {};
      const rt = stored.redeemTiers;
      const tables = [
        [[100, 100], [250, 250], [500, 600], [1000, 1300]], // legacy 1pt=KES1
        [[100, 500], [250, 1250], [500, 2500], [1000, 5000]] // interim 1pt=KES5
      ];
      const matches = (t) => Array.isArray(rt) && rt.length === 4 &&
        tables.some(tbl => tbl.every(([p, v], i) => rt[i] && rt[i].points === p && rt[i].value === v));
      if (matches()) {
        await col.loyalty_settings.updateOne({ key: 'default' }, { $set: { value: { ...stored, redeemTiers: LOYALTY_SETTINGS_DEFAULTS.redeemTiers }, updatedAt: new Date() } });
        loyaltySettingsCache = null;
        console.log('💰 Migrated loyalty currency to 5 pts = KES 1 (owner default)');
      }
    } catch (e) { console.error('Loyalty currency migration failed:', e.message); }
  } catch (e) { console.error('Failed to seed loyalty settings:', e); }
};

// Tier is driven by the POINTS balance (never by spend, so tiers can't be
// gamed by high-value single orders). Kept as a named export for the tests.
const tierFromPoints = (points) => {
  const p = points || 0;
  if (p >= 1500) return 'Platinum';
  if (p >= 600) return 'Gold';
  if (p >= 200) return 'Silver';
  return 'Bronze';
};
const customerTier = tierFromPoints;

// Core award — 1 point per earnRate KES of NET paid spend, floored.
// ONLY call for completed + paid transactions (delivered orders, POS sales).
// Cancelled/refunded orders never reach here, and refunds call reversePoints.
async function earnPoints(phone, netSpent) {
  if (!phone || !netSpent || netSpent <= 0) return 0;
  try {
    const s = await getLoyaltySettings();
    let pts = Math.floor(netSpent / (s.earnRate || 200));
    // Seasonal event multiplier (e.g. 2x promo weekend) — off by default.
    const events = (s.seasonalEvents || []).filter(e => e && e.active && parseFloat(e.pointsMultiplier) > 1);
    for (const ev of events) pts = Math.floor(pts * parseFloat(ev.pointsMultiplier));
    if (pts <= 0) return 0;
    const existing = await col.loyalty.findOne({ phone });
    if (existing) {
      const newTotal = (existing.totalSpent || 0) + netSpent;
      const newPoints = (existing.points || 0) + pts;
      await col.loyalty.updateOne({ phone }, { $set: { totalSpent: newTotal, points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
    } else {
      await col.loyalty.insertOne({ phone, customerName: '', totalSpent: netSpent, points: pts, tier: tierFromPoints(pts), createdAt: new Date(), updatedAt: new Date() });
    }
    return pts;
  } catch (e) { console.error('Loyalty error:', e); return 0; }
}

// Reverse points earned on a refund/void (never below zero — no farming).
async function reversePoints(phone, netSpent) {
  if (!phone || !netSpent || netSpent <= 0) return;
  try {
    const s = await getLoyaltySettings();
    const pts = Math.floor(netSpent / (s.earnRate || 200));
    if (pts <= 0) return;
    const existing = await col.loyalty.findOne({ phone });
    if (!existing) return;
    const newPoints = Math.max(0, (existing.points || 0) - pts);
    await col.loyalty.updateOne({ phone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
  } catch (e) { console.error('Reverse loyalty error:', e); }
}

// Spends points atomically: the update only matches while the member still
// holds enough points, so two simultaneous redemptions can't overdraw.
async function spendPoints(phone, points, extraInc = {}) {
  const r = await col.loyalty.updateOne(
    { phone, points: { $gte: points } },
    { $inc: { points: -points, ...extraInc }, $set: { updatedAt: new Date() } }
  );
  if (!r.matchedCount) return null;
  const after = await col.loyalty.findOne({ phone });
  const remaining = Math.max(0, (after && after.points) || 0);
  await col.loyalty.updateOne({ phone }, { $set: { tier: tierFromPoints(remaining) } });
  return after;
}

// ===== PROMOS: SPIN WHEEL + SCRATCH CARD =====
// Everything is decided server-side so the odds can't be cheated, discounts
// are only handed to real shoppers (tier is derived from the phone-number
// shopping record), and every voucher is bound to the winning phone, valid for
// a single use. Codes issued here therefore ALWAYS work at checkout.
// "Once per day" follows the shop's local day (Africa/Nairobi), matching the
// messages the app shows customers (kept for display; cooldowns are now a
// rolling 24h/48h window, not calendar days).
const promoDayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

// 12 wheel outcomes — the prize table from the owner spec. `weight` is the
// probability out of 100. sectorIndex maps each outcome to a wheel slice for
// the spin animation (the client renders 12 slices from the same array).
const WHEEL_SECTORS = [
  { label: 'TRY AGAIN', color: '#3a3a46', prize: 'again', title: 'So Close!', message: 'No luck today — come back in 24h for another spin.', sectorIndex: 0, weight: 45 },
  { label: 'TRY AGAIN', color: '#3a3a46', prize: 'again', title: 'So Close!', message: 'No luck today — come back in 24h for another spin.', sectorIndex: 1, weight: 20 },
  { label: '1 POINT', color: '#30d158', prize: 'points1', points: 1, title: '1 Loyalty Point!', message: 'You won 1 loyalty point — it was added to your account.', sectorIndex: 2, weight: 10 },
  { label: '2 POINTS', color: '#30d158', prize: 'points2', points: 2, title: '2 Loyalty Points!', message: 'You won 2 loyalty points — they were added to your account.', sectorIndex: 3, weight: 8 },
  { label: '3 POINTS', color: '#30d158', prize: 'points3', points: 3, title: '3 Loyalty Points!', message: 'You won 3 loyalty points — they were added to your account.', sectorIndex: 4, weight: 5 },
  { label: '5 POINTS', color: '#30d158', prize: 'points5', points: 5, title: '5 Loyalty Points!', message: 'You won 5 loyalty points — they were added to your account.', sectorIndex: 5, weight: 4 },
  { label: 'KES 50 OFF', color: '#bf5af2', prize: 'fixed50', type: 'fixed', value: 50, minPurchase: 300, title: 'KES 50 Off Unlocked!', message: 'You won KES 50 off! Valid on orders over KES 300.', sectorIndex: 6, weight: 3 },
  { label: '10 POINTS', color: '#ffd60a', prize: 'points10', points: 10, title: '10 Loyalty Points!', message: 'You won 10 loyalty points — they were added to your account.', sectorIndex: 7, weight: 2 },
  { label: 'FREE DELIVERY', color: '#64d2ff', prize: 'delivery', type: 'free_delivery', value: 0, minPurchase: 300, title: 'Free Delivery!', message: 'You won free delivery on your next order (over KES 300).', sectorIndex: 8, weight: 1.5 },
  { label: 'KES 100 OFF', color: '#ff9f0a', prize: 'fixed100', type: 'fixed', value: 100, minPurchase: 500, title: 'KES 100 Off Unlocked!', message: 'You won KES 100 off! Valid on orders over KES 500.', sectorIndex: 9, weight: 1 },
  { label: '25 POINTS', color: '#30d158', prize: 'points25', points: 25, title: '25 Loyalty Points!', message: 'You won 25 loyalty points — they were added to your account.', sectorIndex: 10, weight: 0.4 },
  { label: 'JACKPOT', color: '#ff2d55', prize: 'jackpot', points: 100, title: '🎰 JACKPOT — 100 Points!', message: 'You hit the jackpot! 100 loyalty points were added.', sectorIndex: 11, weight: 0.1, jackpot: true },
];

// Scratch card outcomes (server decides what's under the foil). Mostly a miss,
// small points, rare coupons, very rare jackpot.
const SCRATCH_OUTCOMES = [
  { prize: 'lose', label: 'TRY AGAIN', title: 'Better Luck Tomorrow!', message: 'No prize this time — scratch again in 48h.', weight: 64 },
  { prize: 'points1', points: 1, title: '1 Loyalty Point!', message: 'You won 1 loyalty point!', weight: 10 },
  { prize: 'points2', points: 2, title: '2 Loyalty Points!', message: 'You won 2 loyalty points!', weight: 8 },
  { prize: 'points3', points: 3, title: '3 Loyalty Points!', message: 'You won 3 loyalty points!', weight: 6 },
  { prize: 'points4', points: 4, title: '4 Loyalty Points!', message: 'You won 4 loyalty points!', weight: 5 },
  { prize: 'points5', points: 5, title: '5 Loyalty Points!', message: 'You won 5 loyalty points!', weight: 3 },
  { prize: 'fixed50', type: 'fixed', value: 50, minPurchase: 300, title: 'KES 50 Discount Unlocked!', message: 'You won KES 50 off! Valid on orders over KES 300.', weight: 1.5 },
  { prize: 'fixed100', type: 'fixed', value: 100, minPurchase: 500, title: 'KES 100 Discount Unlocked!', message: 'You won KES 100 off! Valid on orders over KES 500.', weight: 1 },
  { prize: 'delivery', type: 'free_delivery', value: 0, minPurchase: 300, title: 'Free Delivery Unlocked!', message: 'You won free delivery on your next order (over KES 300).', weight: 1 },
  { prize: 'jackpot', points: 100, title: '🎰 JACKPOT — 100 Points!', message: 'Jackpot! 100 loyalty points were added.', weight: 0.5, jackpot: true },
];

function pickWeighted(list, tier, jackpotEnabled = true) {
  // Higher tiers get slightly better odds: the two "nothing" outcomes shrink
  // and the weight is gifted to small-point outcomes (never increases the
  // normal point earning rate). Jackpots can be switched off in settings.
  const shift = tier === 'Platinum' ? 10 : tier === 'Gold' ? 6 : tier === 'Silver' ? 3 : 0;
  const weighted = list
    .map((item) => {
      let w = item.weight || 0;
      if (item.jackpot && !jackpotEnabled) w = 0;
      else if ((item.prize === 'again' || item.prize === 'lose') && shift > 0) w = Math.max(0, w - shift);
      else if (item.points && !item.jackpot && shift > 0) w = w + shift / 3;
      return { item, w };
    })
    .filter(x => x.w > 0);
  const total = weighted.reduce((s, x) => s + x.w, 0);
  if (!total) return list[0];
  let roll = Math.random() * total;
  for (const x of weighted) {
    roll -= x.w;
    if (roll <= 0) return x.item;
  }
  return weighted[weighted.length - 1].item;
}

async function addLoyaltyPoints(phone, points) {
  if (!points) return;
  try {
    const existing = await col.loyalty.findOne({ phone });
    if (existing) {
      const newPoints = (existing.points || 0) + points;
      await col.loyalty.updateOne({ phone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
    } else {
      await col.loyalty.insertOne({ phone, customerName: '', totalSpent: 0, points, tier: tierFromPoints(points), createdAt: new Date(), updatedAt: new Date() });
    }
  } catch (e) { console.error('Failed to add loyalty points:', e); }
}

async function issueVoucher({ phone, type, value, minPurchase, prefix }) {
  const code = (prefix || 'PROMO') + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await col.coupons.insertOne({
    code,
    type: type || 'fixed',
    value: value || 0,
    minPurchase: minPurchase || 0,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    maxUses: 1,
    usedCount: 0,
    usedBy: [],
    ownerPhone: String(phone).replace(/[^0-9]/g, ''),
    active: true,
    createdAt: new Date(),
    source: 'promo'
  });
  return code;
}

// Atomic promo cooldown slot — the single source of truth for "has this phone
// claimed this promo recently". The findOneAndUpdate upsert (cutoff inside the
// filter) is atomic on MongoDB: two simultaneous spins can never both pass —
// one insert wins, the loser is refused. This closes the double-spin race that
// could otherwise farm points/coupons.
async function claimPromoSlot(phone, type, cooldownMs) {
  const key = `${phone}:${type}`;
  const now = new Date();
  const cutoff = new Date(now.getTime() - cooldownMs);
  const readSlot = async () => {
    const existing = await col.promo_cooldowns.findOne({ _id: key });
    return existing ? new Date(new Date(existing.at).getTime() + cooldownMs) : null;
  };
  try {
    const r = await col.promo_cooldowns.findOneAndUpdate(
      { _id: key, at: { $lte: cutoff } },
      { $set: { phone, type, at: now, updatedAt: now } },
      { upsert: true, returnDocument: 'after' }
    );
    const doc = r && typeof r === 'object' && r.value !== undefined ? r.value : r;
    if (doc && doc._id === key) return { granted: true, nextAt: null };
    return { granted: false, nextAt: await readSlot() };
  } catch (e) {
    // Upsert race — a concurrent claim already won this slot.
    if (e && (e.code === 11000 || /duplicate/i.test(e.message || ''))) {
      return { granted: false, nextAt: await readSlot() };
    }
    // Storage hiccup — never hard-fail the promo; degrade to a plain check.
    const existing = await col.promo_cooldowns.findOne({ _id: key });
    return {
      granted: !existing || new Date(existing.at) <= cutoff,
      nextAt: existing ? new Date(new Date(existing.at).getTime() + cooldownMs) : null
    };
  }
}

const alreadyUsedPromoResponse = (claimed, cooldownHours, day) => ({
  success: false, alreadyUsed: true, day, nextAt: new Date(new Date(claimed.at).getTime() + cooldownHours * 3600 * 1000),
  tier: claimed.tier || 'Bronze',
  prizeName: claimed.prizeName || 'again',
  title: claimed.title || '', message: claimed.message || `Already claimed — come back in ${cooldownHours}h!`,
  code: claimed.code || '', pointsAdded: claimed.pointsAdded || 0,
  sectorIndex: claimed.sectorIndex !== undefined ? claimed.sectorIndex : 1
});

// Money prizes (cash coupons + free delivery) are only ever granted when the
// shopper's own shopping record is worth MORE than the reward being handed
// out — the shop never gives away more than the customer has spent. Cash
// coupons also need ≥ 5 completed orders (genuinely loyal shoppers); free
// delivery is worth the standard KES 150 transport fee it saves the customer.
const FREE_DELIVERY_REWARD_VALUE = 150;
const promoMoneyPrizeValue = (outcome) => {
  if (outcome && outcome.type === 'fixed') return outcome.value || 0;
  if (outcome && outcome.type === 'free_delivery') return FREE_DELIVERY_REWARD_VALUE;
  return 0;
};
const moneyPrizeUnlocked = ({ orderCount, totalSpent, rewardValue }) =>
  rewardValue > 0 && orderCount >= 5 && totalSpent > rewardValue;

async function runPromo({ phone, name, type }) {
  const phoneClean = String(phone || '').replace(/[^0-9]/g, '');
  if (!phoneClean) return { success: false, error: 'Phone required' };
  const s = await getLoyaltySettings();
  const cooldownHours = type === 'spin' ? (s.spinCooldownHours || 24) : (s.scratchCooldownHours || 48);
  const cooldownMs = cooldownHours * 3600 * 1000;
  const day = promoDayKey();
  const cutoff = new Date(Date.now() - cooldownMs);

  // Read-only check purely for the friendly "come back later" response (the
  // authoritative gate is the atomic slot claimed below).
  const claimed = await col.promo_claims.findOne({ phone: phoneClean, type, at: { $gt: cutoff } });
  if (claimed) return alreadyUsedPromoResponse(claimed, cooldownHours, day);

  // Anti-abuse gate: at least two completed (non-cancelled) orders required.
  const orders = await col.orders.find({ customerId: phoneClean }).toArray();
  const completed = orders.filter(o => o.status !== 'cancelled');
  if (completed.length < (s.minOrdersForPromo || 2)) {
    return {
      success: false,
      error: type === 'spin' ? 'Complete two purchases to unlock Lucky Spin.' : 'Complete two purchases to unlock the Scratch Card.',
      orderCount: completed.length, minOrders: s.minOrdersForPromo || 2
    };
  }

  // ===== ATOMIC SLOT CLAIM — consumed BEFORE any prize is awarded, so two
  // concurrent spins can never both win.
  const slot = await claimPromoSlot(phoneClean, type, cooldownMs);
  if (!slot.granted) {
    const hist = await col.promo_claims.findOne({ phone: phoneClean, type, at: { $gt: cutoff } });
    if (hist) return alreadyUsedPromoResponse(hist, cooldownHours, day);
    return {
      success: false, alreadyUsed: true, day, nextAt: slot.nextAt,
      tier: 'Bronze', prizeName: 'again', title: 'Already Claimed!',
      message: `Come back in ${cooldownHours}h for another go.`
    };
  }

  const loyalty = await col.loyalty.findOne({ phone: phoneClean });
  const tier = tierFromPoints(loyalty ? loyalty.points : 0);

  // Build the outcome table from the owner-editable settings weights.
  const table = type === 'spin' ? WHEEL_SECTORS : SCRATCH_OUTCOMES;
  const weightList = type === 'spin' ? (s.spinWeights || []) : (s.scratchWeights || []);
  const list = table.map(o => {
    const w = (weightList.find(x => x && x.prize === o.prize) || {}).weight;
    return { ...o, weight: typeof w === 'number' ? w : o.weight };
  });
  const picked = pickWeighted(list, tier, s.jackpotEnabled !== false);
  let finalPicked = { ...picked };

  // Anti-abuse spending logic for money prizes (cash coupons + free delivery).
  // A money reward is only ever granted to a shopper whose own shopping record
  // is worth MORE than the reward (plus ≥ 5 completed orders) — the shop never
  // gives away more than the customer has spent. Everyone else is ALWAYS
  // rerolled to a small non-cash consolation (points / try-again) — no leak —
  // and the message says exactly why, so nothing feels rigged.
  const rewardValue = promoMoneyPrizeValue(finalPicked);
  if (rewardValue > 0 && !moneyPrizeUnlocked({ orderCount: completed.length, totalSpent: completed.reduce((sum, o) => sum + (o.totalPrice || 0), 0), rewardValue })) {
    const safeOutcomes = list.filter(o => o.prize === 'again' || o.prize === 'lose' || (o.points && o.points <= 5));
    const consolation = safeOutcomes.filter(o => o.points && o.points > 0);
    const fallback = consolation.length ? consolation : safeOutcomes;
    if (fallback.length > 0) {
      finalPicked = { ...fallback[Math.floor(Math.random() * fallback.length)] };
      if (finalPicked.prize === 'again' || finalPicked.prize === 'lose') {
        finalPicked.title = 'So Close!';
        finalPicked.message = `Money prizes unlock after 5+ orders and more than KES ${rewardValue} in total shopping — try again after your next order!`;
      } else {
        // Keep the win message, then explain why the bigger money prize was not granted.
        finalPicked.message = `${finalPicked.message} Money prizes unlock after 5+ orders and more than KES ${rewardValue} in total shopping.`;
      }
    }
  }

  let code = '', pointsAdded = 0;
  let title = finalPicked.title || '', message = finalPicked.message || '';

  if (finalPicked.prize === 'again' || finalPicked.prize === 'lose') {
    // nothing — intentionally. Most players should win nothing or very little.
  } else if (finalPicked.points) {
    pointsAdded = finalPicked.points;
    await addLoyaltyPoints(phoneClean, pointsAdded);
  } else {
    code = await issueVoucher({ phone: phoneClean, type: finalPicked.type, value: finalPicked.value, minPurchase: finalPicked.minPurchase, prefix: type === 'spin' ? 'SPIN' : 'SCR' });
  }

  try {
    await col.promo_claims.insertOne({
      phone: phoneClean, name: (name || '').trim(), type, day, tier, at: new Date(),
      prizeName: finalPicked.prize, title, message, code, pointsAdded,
      sectorIndex: finalPicked.sectorIndex !== undefined ? finalPicked.sectorIndex : null,
      createdAt: new Date()
    });
  } catch (e) { console.error('Failed to record promo claim:', e); }

  // Pop the win straight to the customer's device (order confirmations and
  // promo wins are the moments shoppers care about most).
  if (finalPicked.prize !== 'again' && finalPicked.prize !== 'lose') {
    const winTitle = title || 'You won!';
    const winBody = [message, code ? `Use code: ${code}` : '', pointsAdded ? `+${pointsAdded} loyalty ${pointsAdded === 1 ? 'point' : 'points'} added!` : ''].filter(Boolean).join(' ');
    sendPushToPhone(phoneClean, '🎉 ' + winTitle, winBody || 'Check the promo screen for your prize.');
  }

  return {
    success: true, alreadyUsed: false, day, tier,
    prizeName: finalPicked.prize, title, message,
    code, type: finalPicked.type || '', value: finalPicked.value || 0,
    minPurchase: finalPicked.minPurchase || 0, pointsAdded, sectorIndex: finalPicked.sectorIndex
  };
}

// Seed the legacy col.loyalty_rewards collection from the OWNER'S currency so even
// old clients that read it directly see the same tiers as the settings-driven
// /api/loyalty/rewards endpoint. Must run AFTER seedLoyaltySettings (which
// migrates legacy default currencies).
const seedRewards = async () => {
  try {
    if (!col.loyalty_rewards) return;
    const s = await getLoyaltySettings();
    const tiers = (s.redeemTiers || [])
      .filter(t => t && parseFloat(t.points) > 0)
      .sort((a, b) => parseFloat(a.points) - parseFloat(b.points))
      .map(t => ({
        name: `KES ${Math.round(parseFloat(t.value))} Discount Coupon`,
        pointsCost: Math.floor(parseFloat(t.points)),
        rewardType: 'coupon',
        rewardValue: Math.round(parseFloat(t.value) * 100) / 100,
        active: true
      }));
    for (const t of tiers) {
      await col.loyalty_rewards.updateOne({ pointsCost: t.pointsCost }, { $set: t }, { upsert: true });
    }
    // Deactivate stale tiers no longer in the owner's table.
    await col.loyalty_rewards.updateMany({ pointsCost: { $nin: tiers.map(t => t.pointsCost) } }, { $set: { active: false } });
    console.log('✅ Seeded loyalty rewards from owner currency');
  } catch (err) {
    console.error('Failed to seed loyalty rewards:', err);
  }
};

module.exports = { REFERRER_BONUS_POINTS, REFEREE_BONUS_POINTS, LOYALTY_SETTINGS_DEFAULTS, loyaltySettingsCache, getLoyaltySettings, saveLoyaltySettings, seedLoyaltySettings, tierFromPoints, customerTier, earnPoints, reversePoints, spendPoints, promoDayKey, WHEEL_SECTORS, SCRATCH_OUTCOMES, pickWeighted, addLoyaltyPoints, issueVoucher, claimPromoSlot, alreadyUsedPromoResponse, FREE_DELIVERY_REWARD_VALUE, promoMoneyPrizeValue, moneyPrizeUnlocked, runPromo, seedRewards };
