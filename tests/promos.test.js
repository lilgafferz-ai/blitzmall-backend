const request = require('supertest');

// Set env BEFORE requiring the server (see auth.test.js for details).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken } = require('./helpers');
const { customerTier, tierFromPoints, earnPoints, issueVoucher, pickWeighted, WHEEL_SECTORS, SCRATCH_OUTCOMES, getLoyaltySettings, LOYALTY_SETTINGS_DEFAULTS } = _test || {};

// Unique 10-digit phone per call so a prior test run's promo claim can never
// interfere with a later run (claims persist in the test DB).
let seq = 1000;
const freshPhone = () => { seq += 7; return '07' + String(Date.now() + seq).slice(-8); };

// Orders now REQUIRE every item to resolve to a real catalogue product (server
// prices are authoritative), so the promo tests create their own products.
let PRODUCTS = {};

beforeAll(async () => {
  await connectDb();
  const token = await getOwnerToken(request, app);
  const create = async (name, price) => {
    const r = await request(app)
      .post('/api/admin/products')
      .set({ Authorization: 'Bearer ' + token })
      .send({ name, price, buyingPrice: Math.round(price * 0.7), stock: 50, image: [] });
    return r.body && r.body.productId;
  };
  // Unique names (PT- prefix) so test files sharing the test DB never collide.
  PRODUCTS.milk = await create('PT-Milk', 120);
  PRODUCTS.bread = await create('PT-Bread', 300);
  PRODUCTS.item0 = await create('PT-Item 0', 150);
  PRODUCTS.item1 = await create('PT-Item 1', 150);
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

describe('Customer tier (points-based)', () => {
  it('tiers follow the points balance (Bronze 0-199 / Silver 200-599 / Gold 600-1499 / Platinum 1500+)', () => {
    expect(customerTier(0)).toBe('Bronze');
    expect(customerTier(199)).toBe('Bronze');
    expect(customerTier(200)).toBe('Silver');
    expect(customerTier(599)).toBe('Silver');
    expect(customerTier(600)).toBe('Gold');
    expect(customerTier(1499)).toBe('Gold');
    expect(customerTier(1500)).toBe('Platinum');
    expect(tierFromPoints(2500)).toBe('Platinum');
  });
});

describe('Points earning (business-first)', () => {
  it('awards 1 point per KES 200, floored — never rounded up', async () => {
    expect(await earnPoints(freshPhone(), 199)).toBe(0); // KES 199 = 0 pts
    expect(await earnPoints(freshPhone(), 200)).toBe(1);
    expect(await earnPoints(freshPhone(), 400)).toBe(2);
    expect(await earnPoints(freshPhone(), 999)).toBe(4);
    expect(await earnPoints(freshPhone(), 0)).toBe(0);
    expect(await earnPoints(freshPhone(), -5)).toBe(0);
  });

  it('default settings keep 1pt/200, jackpots on, 2-order promo gate', async () => {
    const s = await getLoyaltySettings();
    expect(s.earnRate).toBe(200);
    expect(s.jackpotEnabled).toBe(true);
    expect(s.minOrdersForPromo).toBe(2);
    // Owner currency: 5 pts = KES 1 (100 PTS = KES 20 cashback).
    expect(s.redeemTiers).toEqual([
      { points: 100, value: 20 },
      { points: 250, value: 50 },
      { points: 500, value: 100 },
      { points: 1000, value: 200 }
    ]);
    expect(LOYALTY_SETTINGS_DEFAULTS.earnRate).toBe(200);
  });
});

describe('Promo tables stay anti-exploit', () => {
  it('the wheel gives most weight to nothing (65% total) and tiny prizes', () => {
    const total = WHEEL_SECTORS.reduce((s, o) => s + (o.weight || 0), 0);
    const nothing = WHEEL_SECTORS.filter(o => o.prize === 'again').reduce((s, o) => s + (o.weight || 0), 0);
    expect(Math.round(total)).toBe(100);
    expect(nothing).toBeGreaterThan(50);
  });

  it('the scratch card is mostly a miss (64%)', () => {
    const total = SCRATCH_OUTCOMES.reduce((s, o) => s + (o.weight || 0), 0);
    const miss = SCRATCH_OUTCOMES.filter(o => o.prize === 'lose').reduce((s, o) => s + (o.weight || 0), 0);
    expect(Math.round(total)).toBe(100);
    expect(miss).toBeGreaterThan(50);
  });

  it('disabling jackpots removes the jackpot outcome entirely', () => {
    const outcomes = new Set(Array.from({ length: 200 }, () => pickWeighted(SCRATCH_OUTCOMES, 'Bronze', false).prize));
    expect(outcomes.has('jackpot')).toBe(false);
  });
});

describe('Promos API (spin wheel + scratch card)', () => {
  it('requires TWO completed orders before the spin unlocks', async () => {
    const phone = freshPhone();
    // One order is NOT enough — gate blocks the spin.
    await request(app).post('/api/orders').send({
      customerId: phone, customerName: 'One Order', items: [{ _id: PRODUCTS.milk, quantity: 1 }], paymentMethod: 'delivery'
    });
    const blocked = await request(app).post('/api/promos/spin').send({ phone, name: 'One Order' });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error).toMatch(/two purchases/i);
    expect(blocked.body.orderCount).toBe(1);

    // Second order unlocks it — spin succeeds and lands on a real sector.
    await request(app).post('/api/orders').send({
      customerId: phone, customerName: 'One Order', items: [{ _id: PRODUCTS.bread, quantity: 1 }], paymentMethod: 'delivery'
    });
    const res = await request(app).post('/api/promos/spin').send({ phone, name: 'One Order' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.sectorIndex).toBe('number');
    expect(WHEEL_SECTORS[res.body.sectorIndex]).toBeTruthy();

    // Rolling 24h cooldown — an immediate second spin is refused.
    const again = await request(app).post('/api/promos/spin').send({ phone, name: 'One Order' });
    expect(again.body.alreadyUsed).toBe(true);
  });

  it('brand-new phones are blocked from the scratch card', async () => {
    const phone = freshPhone();
    const res = await request(app).post('/api/promos/scratch').send({ phone, name: 'New User' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/two purchases/i);
    expect(res.body.code || '').toBe('');
  });

  it('the scratch card works after two orders and never guarantees a prize', async () => {
    const phone = freshPhone();
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/orders').send({
        customerId: phone, customerName: 'Scratcher', items: [{ _id: i === 0 ? PRODUCTS.item0 : PRODUCTS.item1, quantity: 1 }], paymentMethod: 'delivery'
      });
    }
    const res = await request(app).post('/api/promos/scratch').send({ phone, name: 'Scratcher' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // Outcomes are only: miss, small points, coupon, delivery, jackpot.
    expect(['lose', 'points1', 'points2', 'points3', 'points4', 'points5', 'fixed50', 'fixed100', 'delivery', 'jackpot']).toContain(res.body.prizeName);
    // A miss must never fabricate a coupon code.
    if (res.body.prizeName === 'lose') expect(res.body.code || '').toBe('');
  });

  it('cash coupon prizes stay LOCKED for low-spend shoppers (rerolled to points/try-again)', async () => {
    const phone = freshPhone();
    // Two small orders — total spend KES 300 is far below the smallest cash
    // unlock threshold (KES 500 = KES 50 prize × 10), so a cash win must be
    // rerolled to a non-cash outcome every single time.
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/orders').send({
        customerId: phone, customerName: 'Low Spender', items: [{ _id: i === 0 ? PRODUCTS.item0 : PRODUCTS.item1, quantity: 1 }], paymentMethod: 'delivery'
      });
    }
    const res = await request(app).post('/api/promos/spin').send({ phone, name: 'Low Spender' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // Low spenders can NEVER win a fixed-cash coupon: the wheel rerolls any
    // cash sector to points/try-again. Points (any amount), jackpot and free
    // delivery are all legitimate low-spender wins — they cost the shop no
    // cash — so the assertion is on "no cash", not on one specific roll.
    expect(['fixed50', 'fixed100']).not.toContain(res.body.prizeName);
    expect(res.body.type || '').not.toBe('fixed');
    // A miss or points win must never fabricate a coupon code.
    if (res.body.prizeName === 'again' || res.body.pointsAdded > 0) {
      expect(res.body.code || '').toBe('');
    }
  });
});

describe('Phone-bound voucher flow', () => {
  it('a won voucher only validates for the winning phone and is single-use', async () => {
    const owner = freshPhone();
    const stranger = freshPhone();
    const code = await issueVoucher({ phone: owner, type: 'fixed', value: 50, minPurchase: 100, prefix: 'TEST' });

    // Correct owner + sufficient total → valid
    const ok = await request(app)
      .post('/api/coupons/validate')
      .send({ code, total: 500, phone: owner });
    expect(ok.body.valid).toBe(true);
    expect(ok.body.discount).toBe(50);

    // Anyone else → rejected (discount is not for just anyone)
    const denied = await request(app)
      .post('/api/coupons/validate')
      .send({ code, total: 500, phone: stranger });
    expect(denied.body.valid).toBe(false);

    // Using it in an order consumes it…
    const order = await request(app).post('/api/orders').send({
      customerId: owner,
      customerName: 'Owner',
      items: [{ _id: PRODUCTS.bread, quantity: 2 }],
      paymentMethod: 'delivery',
      couponCode: code,
      discount: 50
    });
    expect(order.body.success).toBe(true);

    // …so a second use of the same voucher is refused for the owner too.
    const reused = await request(app)
      .post('/api/coupons/validate')
      .send({ code, total: 500, phone: owner });
    expect(reused.body.valid).toBe(false);
  });

  it('seeded marketing coupons (BLITZ10) validate for any shopper', async () => {
    const res = await request(app)
      .post('/api/coupons/validate')
      .send({ code: 'BLITZ10', total: 2000, phone: freshPhone() });
    expect(res.body.valid).toBe(true);
    expect(res.body.type).toBe('percent');
    expect(res.body.discount).toBe(200);

    const tooSmall = await request(app)
      .post('/api/coupons/validate')
      .send({ code: 'BLITZ10', total: 100, phone: freshPhone() });
    expect(tooSmall.body.valid).toBe(false); // min purchase KES 1000
  });
});
