// Loyalty points, wallet, coupons and the spin/scratch promos.
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { CUSTOMER_AUTH_ERROR, auditLog, authenticate, authenticateCustomer, authorize, optionalCustomer, requirePermission } = require('../lib/auth');
const { requireReauth } = require('../lib/mfa');
const { col } = require('../lib/db');
const { couponCheckLimiter, promosLimiter, walletLimiter } = require('../lib/limiters');
const { LOYALTY_SETTINGS_DEFAULTS, WHEEL_SECTORS, getLoyaltySettings, incPoints, promoDayKey, runPromo, saveLoyaltySettings, spendPoints, tierFromPoints } = require('../lib/loyalty');
const { sendPushToPhone } = require('../lib/notifications');
const { couponDiscount, couponProblem } = require('../lib/orders');
const { cleanPhone, samePhone } = require('../lib/util');
const { recordWalletTx } = require('../lib/wallet');

// Points turn into wallet cash (5 pts = KES 1), so hand-typed points are money.
// The owner may award any amount; a manager at most MANAGER_POINTS_CAP per
// adjustment (~KES 200). Every adjustment is audit-logged.
const MANAGER_POINTS_CAP = 1000;
const manualPointsProblem = (req, pts) => (req.user.role !== 'owner' && pts > MANAGER_POINTS_CAP)
  ? `Managers can add at most ${MANAGER_POINTS_CAP} points at a time — ask the owner for more.` : null;
const COUPON_TYPES = ['percent', 'fixed', 'free_delivery'];
// The loyalty settings the owner may edit, and their sane ranges. Anything else
// in the request body is ignored (no mass assignment into the settings doc).
const num = (v, min, max) => { const n = parseFloat(v); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
const SETTINGS_FIELDS = {
  spinCooldownHours: (v) => num(v, 1, 24 * 30),
  scratchCooldownHours: (v) => num(v, 1, 24 * 30),
  minOrdersForPromo: (v) => { const n = num(v, 1, 100); return n === undefined ? undefined : Math.floor(n); }
};

module.exports = function register(app) {
  app.get('/api/admin/loyalty', authenticate, requirePermission('loyalty'), async (req, res) => {
    try { res.json(await col.loyalty.find().sort({ totalSpent: -1 }).toArray()); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/loyalty/redeem', authenticate, requirePermission('loyalty'), async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    try {
      const entry = await col.loyalty.findOne({ phone: cleanPhone(phone) });
      if (!entry) return res.status(404).json({ error: 'Customer not found' });
      const s = await getLoyaltySettings();
      const tiers = (s.redeemTiers || []).slice().sort((a, b) => a.points - b.points);
      // Pick the biggest tier the member's balance covers (min redemption = 100).
      const chosen = [...tiers].reverse().find(t => (entry.points || 0) >= t.points);
      if (!chosen) return res.status(400).json({ error: 'Not enough points — minimum redemption is 100 points' });
      if (!(await spendPoints(entry.phone, chosen.points))) return res.status(409).json({ error: 'Points balance changed — try again' });
      const code = 'LOYALTY_' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await col.coupons.insertOne({
        code, type: 'fixed', value: chosen.value, minPurchase: 0,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        maxUses: 1, usedCount: 0, usedBy: [], ownerPhone: entry.phone,
        active: true, createdAt: new Date(), source: 'loyalty'
      });
      await col.redemptions.insertOne({ customerId: entry.phone, rewardName: `KES ${chosen.value} Discount Coupon`, pointsSpent: chosen.points, rewardValue: chosen.value, redeemedAt: new Date(), by: req.user.username });
      auditLog(req, 'loyalty_redeemed', `Redeemed ${chosen.points} pts for ${entry.phone}`);
      res.json({ success: true, code, pointsSpent: chosen.points, message: `Redeemed ${chosen.points} points for a KES ${chosen.value} coupon!` });
    } catch (e) { console.error('Failed to redeem:', e); res.status(500).json({ error: 'Failed to redeem' }); }
  });

  app.post('/api/loyalty/convert-to-wallet', authenticateCustomer, walletLimiter, async (req, res) => {
    const phoneClean = req.customerPhone;
    const ptsToRedeem = parseInt(req.body.points, 10);
    if (isNaN(ptsToRedeem) || ptsToRedeem <= 0) return res.status(400).json({ error: 'Valid points amount required' });
    if (ptsToRedeem % 5 !== 0) return res.status(400).json({ error: 'Points must be converted in multiples of 5' });

    try {
      const cashAmount = ptsToRedeem / 5; // 5 points = KES 1 (owner currency)
      const after = await spendPoints(phoneClean, ptsToRedeem, { walletBalance: cashAmount });
      if (!after) return res.status(400).json({ error: 'Insufficient loyalty points' });
      await recordWalletTx({ phone: phoneClean, type: 'points_conversion', amount: cashAmount, balanceAfter: after.walletBalance, note: `${ptsToRedeem} points converted` });

      await col.redemptions.insertOne({
        customerId: phoneClean,
        rewardName: `Converted ${ptsToRedeem} points to KES ${cashAmount} Wallet Cash`,
        pointsSpent: ptsToRedeem,
        rewardValue: cashAmount,
        type: 'wallet_conversion',
        redeemedAt: new Date()
      });

      // Tell the customer their wallet cash just landed (feed + OS push).
      sendPushToPhone(phoneClean, '💰 Wallet topped up', `KES ${cashAmount} was added to your wallet — use it on your next order!`);

      res.json({
        success: true,
        points: after.points || 0,
        walletBalance: Math.round((after.walletBalance || 0) * 100) / 100,
        message: `Successfully converted ${ptsToRedeem} points to KES ${cashAmount} wallet cash!`
      });
    } catch (e) {
      console.error('Wallet conversion failed:', e);
      res.status(500).json({ error: 'Failed to convert points' });
    }
  });

  app.post('/api/admin/loyalty/add-points', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const { phone, points } = req.body;
    if (!phone || !points) return res.status(400).json({ error: 'Phone and points required' });
    try {
      // CRITICAL anti-fraud fix: this endpoint used to be open to ANYONE, so a
      // hacker could mint unlimited loyalty points. Now owner/manager only.
      const cleanPhone = String(phone).replace(/[^0-9]/g, '');
      const pts = Math.max(0, parseInt(points, 10) || 0);
      if (!cleanPhone || !pts) return res.status(400).json({ error: 'Phone and a positive number of points required' });
      const capProblem = manualPointsProblem(req, pts);
      if (capProblem) return res.status(403).json({ error: capProblem });
      const existing = await col.loyalty.findOne({ phone: cleanPhone });
      if (existing) {
        // $inc, not read-then-$set, so a points spend landing at the same moment is never undone.
        const newPoints = await incPoints(cleanPhone, pts);
        auditLog(req, 'points_added', `Added ${pts} pts to ${cleanPhone} (new balance ${newPoints})`);
        res.json({ success: true, points: newPoints });
      } else {
        await col.loyalty.insertOne({
          phone: cleanPhone,
          customerName: '',
          totalSpent: 0,
          points: pts,
          tier: tierFromPoints(pts),
          createdAt: new Date(),
          updatedAt: new Date()
        });
        auditLog(req, 'points_added', `Created loyalty record for ${cleanPhone} with ${pts} pts`);
        res.json({ success: true, points: pts });
      }
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add points' }); }
  });

  // ===== COUPONS =====
  app.post('/api/admin/coupons', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const { code, type, value, minPurchase, expiresAt, maxUses } = req.body;
    if (!code || !type || value === undefined) return res.status(400).json({ error: 'Code, type and value required' });
    const cleanCode = String(code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{3,30}$/.test(cleanCode)) return res.status(400).json({ error: 'Coupon codes are 3–30 letters, numbers, - or _' });
    if (!COUPON_TYPES.includes(type)) return res.status(400).json({ error: 'Coupon type must be percent, fixed or free_delivery' });
    const v = parseFloat(value) || 0;
    if (type !== 'free_delivery' && !(v > 0)) return res.status(400).json({ error: 'Coupon value must be more than 0' });
    if (type === 'percent' && v > 90) return res.status(400).json({ error: 'Percent coupons are capped at 90%' });
    if (type === 'fixed' && v > 100000) return res.status(400).json({ error: 'Fixed coupons are capped at KES 100,000' });
    const expiry = expiresAt ? new Date(expiresAt) : null;
    const uses = Math.max(0, parseInt(maxUses, 10) || 0);
    try {
      const existing = await col.coupons.findOne({ code: cleanCode });
      if (existing) return res.status(400).json({ error: 'Coupon code already exists' });
      const r = await col.coupons.insertOne({
        code: cleanCode, type, value: type === 'free_delivery' ? 0 : v,
        minPurchase: Math.max(0, parseFloat(minPurchase) || 0), expiresAt: expiry && !isNaN(expiry.getTime()) ? expiry : null,
        maxUses: uses, usedCount: 0, usedBy: [], active: true, createdAt: new Date(), createdBy: req.user.username
      });
      auditLog(req, 'coupon_created', `Coupon ${cleanCode} (${type} ${v}, max uses ${uses})`);
      res.json({ success: true, couponId: r.insertedId });
    } catch (e) { console.error('Failed to create coupon:', e); res.status(500).json({ error: 'Failed to create coupon' }); }
  });
  app.get('/api/admin/coupons', authenticate, requirePermission('loyalty'), async (req, res) => { try { res.json(await col.coupons.find().sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
  app.put('/api/admin/coupons/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid coupon' });
      const r = await col.coupons.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active: !!req.body.active } });
      if (!r.matchedCount) return res.status(404).json({ error: 'Coupon not found' });
      auditLog(req, 'coupon_toggled', `Coupon ${req.params.id} ${req.body.active ? 'activated' : 'deactivated'}`);
      res.json({ success: true });
    } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
  });
  app.delete('/api/admin/coupons/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid coupon' });
      const coupon = await col.coupons.findOne({ _id: new ObjectId(req.params.id) });
      const r = await col.coupons.deleteOne({ _id: new ObjectId(req.params.id) });
      if (!r.deletedCount) return res.status(404).json({ error: 'Coupon not found' });
      auditLog(req, 'coupon_deleted', `Coupon ${coupon ? coupon.code : req.params.id} deleted`);
      res.json({ success: true });
    } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
  });
  app.post('/api/coupons/validate', couponCheckLimiter, optionalCustomer, async (req, res) => {
    const { code } = req.body;
    const total = parseFloat(req.body.total) || 0;
    if (!code) return res.status(400).json({ error: 'Code required' });
    try {
      // The phone always comes from the signed-in session — personal vouchers
      // (spin wheel / scratch card / loyalty) only validate for their owner.
      const phoneClean = req.customerPhone || '';
      const coupon = await col.coupons.findOne({ code: String(code).toUpperCase(), active: true });
      if (!coupon) return res.status(404).json({ error: 'Invalid coupon code', valid: false });
      if (coupon.ownerPhone && !phoneClean) return res.status(401).json({ valid: false, ...CUSTOMER_AUTH_ERROR });
      const problem = couponProblem(coupon, phoneClean, total);
      if (problem) return res.json({ valid: false, error: problem });
      res.json({ valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount: couponDiscount(coupon, total), campaignId: coupon._id, minPurchase: coupon.minPurchase || 0 });
    } catch (e) { console.error('Failed to validate coupon:', e); res.status(500).json({ error: 'Failed to validate' }); }
  });

  // ===== CUSTOMER ACCOUNT (keyed by phone number) =====
  // A customer's shopping record, debts and vouchers all live under the phone
  // they sign in with — no separate accounts, no way to game the system.
  // ===== LOYALTY ADMIN CONTROLS (owner/manager) =====
  // Owner can retune the whole loyalty economy, award or claw back points, and
  // watch the business maths (reward cost vs sales) without a code deploy.
  app.get('/api/admin/loyalty/settings', authenticate, requirePermission('loyalty'), async (req, res) => {
    try { res.json(await getLoyaltySettings()); }
    catch (e) { console.error('Failed to load loyalty settings:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // The loyalty economy (earn rate, prize odds, redemption values) decides how
  // much wallet cash the shop owes, so only the owner may change it (after
  // re-confirming their password), and only the known fields are taken.
  app.put('/api/admin/loyalty/settings', authenticate, authorize('owner'), requireReauth, async (req, res) => {
    try {
      const current = await getLoyaltySettings();
      const b = req.body || {};
      const next = { ...current };
      // earnRate = KES spent per point; below KES 10/pt would make points nearly free money.
      if (b.earnRate !== undefined) {
        const rate = num(b.earnRate, 10, 1000000);
        if (rate === undefined) return res.status(400).json({ error: 'earnRate must be between 10 and 1,000,000 KES per point' });
        next.earnRate = rate;
      }
      if (b.jackpotEnabled !== undefined) next.jackpotEnabled = !!b.jackpotEnabled;
      for (const [key, check] of Object.entries(SETTINGS_FIELDS)) {
        if (b[key] === undefined) continue;
        const v = check(b[key]);
        if (v === undefined) return res.status(400).json({ error: `${key} is out of range` });
        next[key] = v;
      }
      if (b.tierThresholds !== undefined) {
        const t = b.tierThresholds || {};
        const silver = parseFloat(t.silver), gold = parseFloat(t.gold), platinum = parseFloat(t.platinum);
        if (!(silver > 0 && gold > silver && platinum > gold && platinum <= 1e9)) {
          return res.status(400).json({ error: 'Tier thresholds must be ascending' });
        }
        next.tierThresholds = { silver, gold, platinum };
      }
      if (b.seasonalEvents !== undefined) {
        if (!Array.isArray(b.seasonalEvents)) return res.status(400).json({ error: 'seasonalEvents must be a list' });
        next.seasonalEvents = b.seasonalEvents.slice(0, 10)
          .filter(e => e && typeof e === 'object')
          .map(e => ({ name: String(e.name || '').slice(0, 60), pointsMultiplier: num(e.pointsMultiplier, 1, 5) || 1, active: !!e.active }));
      }
      // Sanitise the owner-editable odds tables (fall back to defaults if broken).
      for (const key of ['spinWeights', 'scratchWeights']) {
        if (Array.isArray(b[key])) {
          next[key] = b[key]
            .filter(x => x && typeof x.weight === 'number' && x.weight >= 0 && x.weight <= 1e6)
            .slice(0, 50)
            .map(x => ({ prize: String(x.prize).slice(0, 40), weight: x.weight }));
        }
      }
      if (b.redeemTiers !== undefined) next.redeemTiers = b.redeemTiers;
      // Sanitise the redemption tiers (the store currency): positive points,
      // non-negative KES value, sorted ascending, never empty.
      if (Array.isArray(next.redeemTiers)) {
        const cleaned = next.redeemTiers
          .filter(x => x && Number.isFinite(parseFloat(x.points)) && parseFloat(x.points) > 0 && Number.isFinite(parseFloat(x.value)) && parseFloat(x.value) >= 0)
          .map(x => ({ points: Math.floor(parseFloat(x.points)), value: Math.round(parseFloat(x.value) * 100) / 100 }))
          .sort((a, b) => a.points - b.points);
        next.redeemTiers = cleaned.length ? cleaned : LOYALTY_SETTINGS_DEFAULTS.redeemTiers;
      } else {
        next.redeemTiers = LOYALTY_SETTINGS_DEFAULTS.redeemTiers;
      }
      await saveLoyaltySettings(next);
      auditLog(req, 'loyalty_settings_saved', `earnRate ${next.earnRate}, cooldowns ${next.spinCooldownHours}h/${next.scratchCooldownHours}h, tiers ${(next.redeemTiers || []).map(t => t.points + 'pts=KES' + t.value).join(' ')}`);
      res.json({ success: true, settings: next });
    } catch (e) { console.error('Failed to save loyalty settings:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Manual bonus points OR claw-back (negative points, e.g. removing fraud).
  app.post('/api/admin/loyalty/manual-points', authenticate, authorize('owner', 'manager'), async (req, res) => {
    const { phone, points, reason } = req.body;
    const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '') : '';
    const pts = parseInt(points, 10);
    if (!cleanPhone || !pts) return res.status(400).json({ error: 'Phone and points (positive or negative) required' });
    if (pts > 0) { const capProblem = manualPointsProblem(req, pts); if (capProblem) return res.status(403).json({ error: capProblem }); }
    try {
      const existing = await col.loyalty.findOne({ phone: cleanPhone });
      if (!existing && pts < 0) return res.status(404).json({ error: 'No loyalty record to claw back from' });
      let newPoints = Math.max(0, pts);
      if (existing) {
        newPoints = await incPoints(cleanPhone, pts);
      } else {
        await col.loyalty.insertOne({ phone: cleanPhone, customerName: '', totalSpent: 0, points: newPoints, tier: tierFromPoints(newPoints), createdAt: new Date(), updatedAt: new Date() });
      }
      await col.redemptions.insertOne({ customerId: cleanPhone, rewardName: `Manual ${pts > 0 ? 'bonus' : 'adjustment'} — ${String(reason || '').slice(0, 120)}`, pointsSpent: 0, rewardValue: 0, manualPoints: pts, reason: String(reason || '').slice(0, 200), redeemedAt: new Date(), by: req.user.username });
      // Points convert to wallet cash, so every manual adjustment is audited.
      auditLog(req, 'points_manual_adjust', `${pts > 0 ? '+' : ''}${pts} pts for ${cleanPhone} (new balance ${newPoints}) — ${String(reason || '').slice(0, 120)}`);
      res.json({ success: true, points: newPoints });
    } catch (e) { console.error('Failed to adjust points:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Loyalty economics: redemption stats, reward cost vs sales, customer LTV.
  app.get('/api/admin/loyalty/stats', authenticate, requirePermission('loyalty'), async (req, res) => {
    try {
      const members = await col.loyalty.find().toArray();
      const redemptions = await col.redemptions.find().sort({ redeemedAt: -1 }).toArray();
      const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const recentRedemptions = redemptions.filter(r => r.redeemedAt && new Date(r.redeemedAt) >= since30);
      const rewardCost30d = recentRedemptions.reduce((s, r) => s + (r.rewardValue || 0), 0);
      const [sales30, orders30] = await Promise.all([
        col.sales.find({ createdAt: { $gte: since30 } }).toArray(),
        col.orders.find({ createdAt: { $gte: since30 } }).toArray()
      ]);
      const salesRevenue30d = sales30.reduce((s, x) => s + (x.total || 0), 0) +
        orders30.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.totalPrice || 0), 0);
      res.json({
        memberCount: members.length,
        totalPointsOut: members.reduce((s, m) => s + (m.points || 0), 0),
        redemptions: redemptions.length,
        redemptionCount30d: recentRedemptions.length,
        rewardCost30d: Math.round(rewardCost30d * 100) / 100,
        salesRevenue30d: Math.round(salesRevenue30d * 100) / 100,
        rewardCostPct: salesRevenue30d > 0 ? Math.round((rewardCost30d / salesRevenue30d) * 10000) / 100 : 0,
        topCustomers: members.slice().sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0)).slice(0, 10)
          .map(m => ({ phone: m.phone, name: m.customerName || '', points: m.points || 0, totalSpent: Math.round((m.totalSpent || 0) * 100) / 100, tier: m.tier })),
        recentRedemptions: recentRedemptions.slice(0, 20).map(r => ({
          customerId: r.customerId, rewardName: r.rewardName, pointsSpent: r.pointsSpent, rewardValue: r.rewardValue,
          manualPoints: r.manualPoints || 0, redeemedAt: r.redeemedAt
        }))
      });
    } catch (e) { console.error('Loyalty stats failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Phone lookups come AFTER the fixed /settings and /stats routes — registered
  // first, /:phone used to swallow them, so Loyalty Controls never loaded or saved.
  app.get('/api/admin/loyalty/:phone', authenticate, requirePermission('loyalty', 'sales'), async (req, res) => {
    try {
      const entry = await col.loyalty.findOne({ phone: req.params.phone });
      if (!entry) return res.json({ exists: false, message: 'No loyalty record found' });
      res.json({ exists: true, phone: entry.phone, customerName: entry.customerName, totalSpent: entry.totalSpent, points: entry.points, tier: entry.tier });
    } catch (e) { console.error('Failed to lookup loyalty:', e); res.status(500).json({ error: 'Failed to lookup loyalty' }); }
  });

  app.put('/api/admin/loyalty/:phone', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      const r = await col.loyalty.updateOne({ phone: String(req.params.phone).replace(/[^0-9]/g, '') }, { $set: { customerName: req.body.customerName || '' } });
      if (!r.matchedCount) return res.status(404).json({ error: 'No loyalty record for that phone' });
      auditLog(req, 'loyalty_name_updated', 'Renamed loyalty customer ' + req.params.phone);
      res.json({ success: true });
    } catch (e) { console.error('Failed to update:', e); res.status(500).json({ error: 'Failed to update' }); }
  });

  app.post('/api/promos/spin', authenticateCustomer, promosLimiter, async (req, res) => {
    try {
      const r = await runPromo({ phone: req.customerPhone, name: req.body.name, type: 'spin' });
      res.json(r);
    } catch (e) { console.error('Spin failed:', e); res.status(500).json({ error: 'Failed to spin' }); }
  });

  app.post('/api/promos/scratch', authenticateCustomer, promosLimiter, async (req, res) => {
    try {
      const r = await runPromo({ phone: req.customerPhone, name: req.body.name, type: 'scratch' });
      res.json(r);
    } catch (e) { console.error('Scratch failed:', e); res.status(500).json({ error: 'Failed to scratch' }); }
  });

  // Today's promo status for a phone — lets the UI show "come back tomorrow"
  // and the prize won even after an app restart.
  app.get('/api/promos/status/:phone', authenticateCustomer, async (req, res) => {
    if (!samePhone(req.params.phone, req.customerPhone)) return res.status(403).json({ error: 'Not your account' });
    try {
      const phone = req.customerPhone;
      const day = promoDayKey();
      const s = await getLoyaltySettings();
      const spinCooldownMs = (s.spinCooldownHours || 24) * 3600 * 1000;
      const scratchCooldownMs = (s.scratchCooldownHours || 48) * 3600 * 1000;
      const [spin, scratch, orders, loyalty] = await Promise.all([
        col.promo_claims.findOne({ phone, type: 'spin', at: { $gt: new Date(Date.now() - spinCooldownMs) } }),
        col.promo_claims.findOne({ phone, type: 'scratch', at: { $gt: new Date(Date.now() - scratchCooldownMs) } }),
        col.orders.find({ customerId: phone }).toArray(),
        col.loyalty.findOne({ phone })
      ]);
      const completed = orders.filter(o => o.status === 'delivered'); // same rule as runPromo
      const totalSpent = completed.reduce((s, o) => s + (o.totalPrice || 0), 0);
      const minOrders = s.minOrdersForPromo || 2;
      const tier = tierFromPoints(loyalty ? loyalty.points : 0);
      const spinInfo = spin ? { used: true, day, at: spin.at, nextAt: new Date(new Date(spin.at).getTime() + spinCooldownMs), prizeName: spin.prizeName, code: spin.code || '', title: spin.title || '', message: spin.message || '' } : { used: false, day };
      const scratchInfo = scratch ? { used: true, day, at: scratch.at, nextAt: new Date(new Date(scratch.at).getTime() + scratchCooldownMs), prizeName: scratch.prizeName, code: scratch.code || '', title: scratch.title || '', message: scratch.message || '' } : { used: false, day };
      // Smallest money-prize unlock threshold (the prize value itself: a prize
      // is only handed to a shopper whose total shopping is worth more than it).
      const cashSectors = WHEEL_SECTORS.filter(o => o.type === 'fixed' && o.value);
      const cashPrizeUnlockSpend = cashSectors.length ? Math.min(...cashSectors.map(o => o.value)) : 0;
      res.json({
        phone,
        tier,
        loyaltyPoints: loyalty ? loyalty.points || 0 : 0,
        orderCount: completed.length,
        minOrders,
        promosLocked: completed.length < minOrders,
        totalSpent: Math.round(totalSpent * 100) / 100,
        cashPrizeUnlockSpend,
        cashPrizeUnlockOrders: 5,
        spin: spinInfo,
        scratch: scratchInfo
      });
    } catch (e) { console.error('Promo status failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Loyalty Program Points Store
  // Customer Points Redemption Store — the catalogue is the OWNER'S redeemTiers
  // from Admin → Loyalty Controls (settings-driven, so whatever currency the
  // owner set is exactly what shoppers see). Stable ids 'tier-<points>' let the
  // app trade without ever depending on internal collection ids.
  app.get('/api/loyalty/rewards', async (req, res) => {
    try {
      const s = await getLoyaltySettings();
      const tiers = (Array.isArray(s.redeemTiers) ? s.redeemTiers : [])
        .filter(t => t && parseFloat(t.points) > 0)
        .sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
      res.json(tiers.map(t => ({
        _id: 'tier-' + Math.floor(parseFloat(t.points)),
        name: `KES ${Math.round(parseFloat(t.value))} Discount Coupon`,
        pointsCost: Math.floor(parseFloat(t.points)),
        rewardType: 'coupon',
        rewardValue: Math.round(parseFloat(t.value) * 100) / 100,
        active: true
      })));
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Loyalty Program: Redeem Points Reward (settings-driven tiers + legacy ids)
  app.post('/api/loyalty/redeem-reward', authenticateCustomer, walletLimiter, async (req, res) => {
    const { rewardId } = req.body;
    if (!rewardId) return res.status(400).json({ error: 'Missing parameters' });
    try {
      const phoneClean = req.customerPhone;

      // Resolve the reward from the OWNER'S settings ('tier-<points>'), falling
      // back to legacy col.loyalty_rewards documents for old clients.
      let reward = null;
      if (String(rewardId).startsWith('tier-')) {
        const points = parseInt(String(rewardId).slice(5), 10);
        const s = await getLoyaltySettings();
        const tier = (s.redeemTiers || []).find(t => t && Math.floor(parseFloat(t.points)) === points);
        if (tier) {
          reward = { name: `KES ${Math.round(parseFloat(tier.value))} Discount Coupon`, pointsCost: Math.floor(parseFloat(tier.points)), rewardType: 'coupon', rewardValue: Math.round(parseFloat(tier.value) * 100) / 100 };
        }
      } else if (ObjectId.isValid(rewardId)) {
        reward = await col.loyalty_rewards.findOne({ _id: new ObjectId(rewardId), active: true });
      }
      if (!reward) return res.status(404).json({ error: 'Reward not found' });

      if (!(await spendPoints(phoneClean, reward.pointsCost))) {
        return res.status(400).json({ error: 'Insufficient points' });
      }

      let code = '';
      if (reward.rewardType === 'coupon') {
        code = 'REDEEM_' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await col.coupons.insertOne({
          code,
          type: 'fixed',
          value: parseFloat(reward.rewardValue),
          minPurchase: 0,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          maxUses: 1,
          usedCount: 0,
          usedBy: [],
          // Bind the coupon to the phone that redeemed it — won offers must only
          // work for the customer who earned them.
          ownerPhone: phoneClean,
          active: true,
          createdAt: new Date()
        });
      }

      await col.redemptions.insertOne({
        customerId: phoneClean,
        rewardId: String(rewardId),
        rewardName: reward.name,
        pointsSpent: reward.pointsCost,
        rewardValue: reward.rewardValue || 0,
        couponCode: code || null,
        createdAt: new Date()
      });

      // Confirm the redemption with a pop-up (feed + OS push).
      sendPushToPhone(phoneClean, '🎟️ Reward redeemed', `${reward.name} — ${code ? 'your code: ' + code : 'it has been added to your account.'}`);

      res.json({ success: true, pointsCost: reward.pointsCost, couponCode: code, message: `Successfully redeemed ${reward.name}!` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed' });
    }
  });

};
