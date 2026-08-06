const request = require('supertest');

// Set env BEFORE requiring the server (see auth.test.js for details).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { customerTier, issueVoucher, pickWeighted, WHEEL_SECTORS, SCRATCH_OUTCOMES } = _test || {};

// Unique 10-digit phone per call so a prior test run's daily promo claim can
// never interfere with a later run (claims persist in the test DB).
let seq = 1000;
const freshPhone = () => { seq += 7; return '07' + String(Date.now() + seq).slice(-8); };

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

describe('Customer tier (promo eligibility)', () => {
  it('gates real discounts behind actual shopping', () => {
    expect(customerTier(0, 0)).toBe('Visitor');
    expect(customerTier(1, 1000)).toBe('Bronze');
    expect(customerTier(6, 2000)).toBe('Silver');      // 5+ orders
    expect(customerTier(2, 4000)).toBe('Silver');      // KES 3000+ spent
    expect(customerTier(16, 5000)).toBe('Gold');       // 15+ orders
    expect(customerTier(4, 12000)).toBe('Gold');       // KES 10000+ spent
  });

  it('visitors can only win retries or points (never money off)', () => {
    const outcomes = new Set(SCRATCH_OUTCOMES.map(o => pickWeighted(SCRATCH_OUTCOMES, 'Visitor').prize));
    for (const o of outcomes) {
      expect(['lose', 'points30']).toContain(o);
    }
  });
});

describe('Promos API (spin wheel + scratch card)', () => {
  it('a shopper can spin once per day and gets a server-issued prize', async () => {
    const phone = freshPhone();
    // Place an order so this phone is a real shopper (Bronze tier or higher).
    await request(app).post('/api/orders').send({
      customerId: phone,
      customerName: 'Spin Tester',
      items: [{ name: 'Milk 500ml', price: 120, quantity: 1 }],
      paymentMethod: 'delivery'
    });

    const res = await request(app).post('/api/promos/spin').send({ phone, name: 'Spin Tester' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tier).not.toBe('Visitor');
    expect(typeof res.body.sectorIndex).toBe('number');
    expect(WHEEL_SECTORS[res.body.sectorIndex]).toBeTruthy();

    // A second spin on the same day is refused (server-side daily limit).
    const again = await request(app).post('/api/promos/spin').send({ phone, name: 'Spin Tester' });
    expect(again.body.alreadyUsed).toBe(true);
  });

  it('brand-new phones (no shopping) can never win a money voucher', async () => {
    const phone = freshPhone();
    const res = await request(app).post('/api/promos/scratch').send({ phone, name: 'New User' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(['lose', 'points30']).toContain(res.body.prizeName);
    expect(res.body.code || '').toBe('');
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
      items: [{ name: 'Bread', price: 300, quantity: 2 }],
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
