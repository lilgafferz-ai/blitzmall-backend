// Idempotent boot-time migrations, seeds and configuration warnings.
const { col, ensureIndexes } = require('./db');
const { getLoyaltySettings, seedLoyaltySettings, seedRewards } = require('./loyalty');
const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY, MPESA_SHORTCODE, getMpesaCallbackUrl } = require('./mpesa');
const { otpScreenFallback } = require('./sms');

// One-time data migrations and seeds that run on every boot (idempotent).
async function prepareShop() {
  // Migration: carry any existing 24h/48h promo claims into the atomic
  // cooldown slots (added for bank-grade anti-abuse). Without this, shoppers
  // who already claimed today could spin again once right after deploy.
  try {
    const s = await getLoyaltySettings();
    const spinMs = (s.spinCooldownHours || 24) * 3600 * 1000;
    const scratchMs = (s.scratchCooldownHours || 48) * 3600 * 1000;
    const windowMs = Math.max(spinMs, scratchMs);
    const recentClaims = await col.promo_claims.find({ at: { $gt: new Date(Date.now() - windowMs) } }).toArray();
    for (const c of recentClaims) {
      try {
        const key = String(c.phone) + ':' + c.type;
        const existing = await col.promo_cooldowns.findOne({ _id: key });
        if (!existing || new Date(existing.at) < new Date(c.at)) {
          await col.promo_cooldowns.findOneAndUpdate(
            { _id: key, at: { $lte: new Date(c.at) } },
            { $set: { _id: key, phone: String(c.phone), type: c.type, at: new Date(c.at), updatedAt: new Date() } },
            { upsert: true }
          );
        }
      } catch (e) { /* keep going */ }
    }
  } catch (e) { console.error('Promo cooldown migration failed:', e.message); }

  try {
    const bannerCount = await col.banners.countDocuments();
    if (bannerCount === 0) {
      await col.banners.insertMany([
        { title: "🚀 MEGA LAUNCH", text: "Free Delivery on Mall Area orders! Limited time.", code: "", gradient: "linear-gradient(135deg, #ff007f, #7f00ff)", active: true, createdAt: new Date() },
        { title: "🎁 WEEKEND SPECIAL", text: "Get 10% discount on orders over KES 1000!", code: "BLITZ10", gradient: "linear-gradient(135deg, #00f2fe, #4facfe)", active: true, createdAt: new Date() },
        { title: "💳 INSTANT PAY", text: "Scan & Pay with secure M-Pesa STK push!", code: "", gradient: "linear-gradient(135deg, #38ef7d, #11998e)", active: true, createdAt: new Date() }
      ]);
    }
  } catch (err) {
    console.error('Failed to seed banners:', err);
  }

  // Seed the public marketing coupons referenced by the home-screen ads, so
  // those voucher codes actually work at checkout (they were previously shown
  // in the UI but never existed in the coupons collection).
  try {
    const seedCoupons = [
      { code: 'BLITZ10', type: 'percent', value: 10, minPurchase: 1000, maxUses: 0, note: 'Weekend Special banner code' },
      { code: 'SHAKE15', type: 'percent', value: 15, minPurchase: 500, maxUses: 0, note: 'Scratch campaign code' },
      { code: 'SPIN50', type: 'fixed', value: 50, minPurchase: 500, maxUses: 0, note: 'Legacy wheel code' },
      { code: 'SPINFREE', type: 'free_delivery', value: 0, minPurchase: 300, maxUses: 0, note: 'Legacy wheel code' },
      { code: 'LUCKY30', type: 'fixed', value: 30, minPurchase: 300, maxUses: 0, note: 'Legacy scratch code' },
      { code: 'LUCKY50', type: 'fixed', value: 50, minPurchase: 500, maxUses: 0, note: 'Legacy scratch code' },
      { code: 'LUCKYDEL', type: 'free_delivery', value: 0, minPurchase: 300, maxUses: 0, note: 'Legacy scratch code' },
    ];
    for (const sc of seedCoupons) {
      const exists = await col.coupons.findOne({ code: sc.code });
      if (!exists) {
        await col.coupons.insertOne({
          code: sc.code, type: sc.type, value: sc.value,
          minPurchase: sc.minPurchase, expiresAt: null,
          maxUses: sc.maxUses, usedCount: 0, usedBy: [], ownerPhone: null,
          active: true, createdAt: new Date(), note: sc.note || ''
        });
      }
    }
  } catch (err) {
    console.error('Failed to seed marketing coupons:', err);
  }

  // Seed the loyalty economy defaults FIRST (this also migrates any shop still
  // on the legacy 1pt=KES1 currency), then derive the reward catalogue from it.
  await seedLoyaltySettings();
  await seedRewards();

  // Seed categories if empty
  try {
    const catCount = await col.categories.countDocuments();
    if (catCount === 0) {
      const allProducts = await col.products.find().toArray();
      let uniqueProductCats = [...new Set(allProducts.map(p => (p.category || '').trim()).filter(Boolean))];
      if (uniqueProductCats.length === 0) {
        uniqueProductCats = ['Cooking', 'Drinks', 'Snacks', 'Bakery', 'Other'];
      }
      const seedDocs = uniqueProductCats.map(name => ({ name, createdAt: new Date() }));
      await col.categories.insertMany(seedDocs);
      console.log(`🌱 Seeded ${seedDocs.length} initial categories`);
    }
  } catch (err) {
    console.error('Failed to seed categories:', err);
  }

  // Warn if M-Pesa env vars are not set
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
    console.warn('⚠️ M-Pesa environment variables (MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY) are not fully configured. M-Pesa payments will fail.');
  }
  if (getMpesaCallbackUrl() === 'https://your-deployed-url.com/api/mpesa/callback') {
    console.warn('⚠️ CALLBACK_URL env var not set. M-Pesa callbacks will not reach your server.');
  }
  if (!process.env.AT_USERNAME || !process.env.AT_API_KEY) {
    console.warn('⚠️ Africa\'s Talking SMS credentials (AT_USERNAME, AT_API_KEY) not configured — OTP codes cannot be sent by SMS.');
  }
  if (otpScreenFallback()) {
    console.warn('⚠️ OTP_SCREEN_FALLBACK is ON — when an SMS fails, the sign-in code is shown on screen, so ANYONE can sign in to ANY account. Set OTP_SCREEN_FALLBACK=false once SMS delivery works.');
  }
  if (process.env.MPESA_MOCK_ENABLED === 'true') {
    console.warn('⚠️ MPESA_MOCK_ENABLED=true — every M-Pesa payment auto-confirms without money moving. Never enable this in production.');
  }
  if (!process.env.MPESA_CALLBACK_SECRET) {
    console.warn('⚠️ MPESA_CALLBACK_SECRET not set — callbacks are still verified against Safaricom before anything is marked paid, but set a secret and append ?secret=<value> to CALLBACK_URL for defence in depth.');
  }

  await ensureIndexes();
}

module.exports = { prepareShop };
