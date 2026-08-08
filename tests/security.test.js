const request = require('supertest');

// Configure env BEFORE importing the server so connectDb() targets a
// dedicated test database (never the real shop DB).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken } = require('./helpers');

// Unique 10-digit phone per call so a prior test run's data can never
// interfere with a later run.
let seq = 5000;
const freshPhone = () => { seq += 9; return '07' + String(Date.now() + seq).slice(-8); };

let ownerToken = null;
let P = {}; // catalogue products the tests order (orders require real products)

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
  const create = async (name, price) => {
    const r = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name, price, buyingPrice: Math.round(price * 0.7), stock: 50, image: [] });
    return r.body && r.body.productId;
  };
  // ST- prefix keeps these unique in the shared test DB.
  P.dup = await create('ST-Duplicate Item', 100);
  P.other = await create('ST-Different Item', 200);
  P.bread = await create('ST-Bread', 200);
  P.item0 = await create('ST-Item 0', 150);
  P.item1 = await create('ST-Item 1', 150);
});

afterAll(async () => {
  if (client) await client.close();
});

const auth = () => ({ Authorization: 'Bearer ' + ownerToken });

describe('Order security (bank-grade)', () => {
  it('uses the SERVER price, never a client-tampered price', async () => {
    // Create a product priced KES 500 in the catalogue.
    const prod = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name: 'Security Test Milk', price: 500, buyingPrice: 300, stock: 10, image: [] });
    expect(prod.body.success).toBe(true);
    const productId = prod.body.productId;

    // Customer tries to pay KES 1 for 2 of them.
    const phone = freshPhone();
    const order = await request(app).post('/api/orders').send({
      customerId: phone,
      customerName: 'Tamperer',
      items: [{ _id: productId, name: 'Security Test Milk', price: 1, quantity: 2 }],
      paymentMethod: 'delivery'
    });
    expect(order.body.success).toBe(true);

    const orders = await request(app).get('/api/customer-orders/' + phone);
    const saved = orders.body[0];
    expect(saved.items[0].price).toBe(500);          // server price, not 1
    expect(saved.totalPrice).toBe(1000);             // 500 × 2, not 2
  });

  it('rejects the SAME basket from the same phone within 60 seconds (double-charge protection)', async () => {
    const phone = freshPhone();
    const basket = {
      customerId: phone,
      customerName: 'Double Tapper',
      items: [{ _id: P.dup, quantity: 1 }],
      paymentMethod: 'delivery'
    };
    const first = await request(app).post('/api/orders').send(basket);
    expect(first.body.success).toBe(true);

    // Same basket, immediately → blocked.
    const second = await request(app).post('/api/orders').send(basket);
    expect(second.statusCode).toBe(429);
    expect(second.body.success).toBe(false);

    // A DIFFERENT basket from the same phone is allowed right away.
    const other = await request(app).post('/api/orders').send({
      ...basket,
      items: [{ _id: P.other, quantity: 2 }]
    });
    expect(other.body.success).toBe(true);
  });

  it('blocks placing an order without a real phone number', async () => {
    const res = await request(app).post('/api/orders').send({
      customerId: 'not-a-phone', customerName: 'Bot', items: [{ _id: P.dup, quantity: 1 }]
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('REJECTS a basket whose items do not resolve to real catalogue products (no price-tampering hole)', async () => {
    // A hacked client strips the _id and invents a name/price → order refused.
    const invented = await request(app).post('/api/orders').send({
      customerId: freshPhone(), customerName: 'Hacker',
      items: [{ name: 'Invented Product That Does Not Exist', price: 1, quantity: 99 }]
    });
    expect(invented.statusCode).toBe(400);
    expect(invented.body.error).toMatch(/catalogue/i);

    // A valid _id that no longer exists → order refused.
    const stale = await request(app).post('/api/orders').send({
      customerId: freshPhone(), customerName: 'Hacker',
      items: [{ _id: '000000000000000000000000', quantity: 1 }]
    });
    expect(stale.statusCode).toBe(400);
  });
});

describe('Loyalty endpoint security', () => {
  it('refuses to mint points without an owner/manager token (was fully public)', async () => {
    // No token at all → must be rejected (the old code happily minted points here).
    const anon = await request(app)
      .post('/api/admin/loyalty/add-points')
      .send({ phone: freshPhone(), points: 100000 });
    expect([401, 403]).toContain(anon.statusCode);

    // A logged-in CASHIER must also be refused (owner/manager only).
    const username = 'sec_cashier_' + Date.now();
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth())
      .send({ username, password: 'cashpass123', name: 'Cashier', role: 'cashier', permissions: ['sales'] });
    if (created.body && created.body.success) {
      const cashierLogin = await request(app)
        .post('/api/admin/login')
        .send({ username, password: 'cashpass123' });
      const cashierToken = cashierLogin.body && cashierLogin.body.token;
      expect(cashierToken).toBeTruthy();
      const denied = await request(app)
        .post('/api/admin/loyalty/add-points')
        .set({ Authorization: 'Bearer ' + cashierToken })
        .send({ phone: freshPhone(), points: 500 });
      expect([403, 401]).toContain(denied.statusCode);
    }
  });
});

describe('Transport fee (set by the person processing the order)', () => {
  it('marks the fee confirmed, recomputes the total and notifies the customer', async () => {
    const phone = freshPhone();
    const placed = await request(app).post('/api/orders').send({
      customerId: phone, customerName: 'Delivery Customer',
      items: [{ _id: P.bread, quantity: 2 }],
      paymentMethod: 'delivery', deliveryLocation: 'Matunda Town', deliveryFee: 0
    });
    expect(placed.body.success).toBe(true);
    const orderId = placed.body.orderId;

    // The provisional fee is NOT confirmed yet.
    let saved = (await request(app).get('/api/customer-orders/' + phone)).body[0];
    expect(saved.deliveryFeeConfirmed).toBe(false);

    // Processor (owner) sets the transport fee to KES 300.
    const setFee = await request(app)
      .put('/api/admin/orders/' + orderId)
      .set(auth())
      .send({ deliveryFee: 300 });
    expect(setFee.body.success).toBe(true);

    saved = (await request(app).get('/api/customer-orders/' + phone)).body[0];
    expect(saved.deliveryFee).toBe(300);
    expect(saved.deliveryFeeConfirmed).toBe(true);
    expect(saved.deliveryFeeSetBy).toBeTruthy();
    expect(saved.totalPrice).toBe(700); // 400 items + 300 transport − 0 discount − 0 wallet

    // The customer got an in-app feed notification about the fee.
    const feed = await request(app).get('/api/notifications/feed?phone=' + phone);
    expect(feed.body.some(n => /transport fee/i.test((n.title || '') + ' ' + (n.body || '')))).toBe(true);
  });
});

describe('Points Redemption Store (owner currency)', () => {
  it('the store reflects the owner default currency 5 pts = KES 1', async () => {
    const rewards = await request(app).get('/api/loyalty/rewards');
    expect(rewards.statusCode).toBe(200);
    expect(Array.isArray(rewards.body)).toBe(true);
    expect(rewards.body[0]).toMatchObject({ pointsCost: 100, rewardValue: 20 });
    expect(rewards.body[rewards.body.length - 1]).toMatchObject({ pointsCost: 1000, rewardValue: 200 });
  });

  it('redeeming a settings tier binds the coupon to the phone and deducts points', async () => {
    const phone = freshPhone();
    // Give the customer 150 points.
    await request(app)
      .post('/api/admin/loyalty/add-points')
      .set(auth())
      .send({ phone, points: 150 });

    const redeem = await request(app).post('/api/loyalty/redeem-reward').send({ customerId: phone, rewardId: 'tier-100' });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.body.success).toBe(true);
    expect(redeem.body.pointsCost).toBe(100);
    expect(redeem.body.couponCode).toMatch(/^REDEEM_/);

    // Points deducted (150 - 100 = 50).
    const prof = await request(app).get('/api/customers/' + phone);
    expect(prof.body.loyaltyPoints).toBe(50);

    // The coupon only validates for this phone (phone-bound, single use).
    const ok = await request(app).post('/api/coupons/validate').send({ code: redeem.body.couponCode, total: 5000, phone });
    expect(ok.body.valid).toBe(true);
    expect(ok.body.discount).toBe(20);
    const stranger = await request(app).post('/api/coupons/validate').send({ code: redeem.body.couponCode, total: 5000, phone: freshPhone() });
    expect(stranger.body.valid).toBe(false);
  });

  it('converts points to wallet cash at 5 pts = KES 1 (multiples of 5 only)', async () => {
    const phone = freshPhone();
    await request(app).post('/api/admin/loyalty/add-points').set(auth()).send({ phone, points: 100 });

    // Non-multiple of 5 → refused.
    const bad = await request(app).post('/api/loyalty/convert-to-wallet').send({ phone, points: 12 });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toMatch(/multiples of 5/i);

    // 50 points = KES 10 wallet cash.
    const ok = await request(app).post('/api/loyalty/convert-to-wallet').send({ phone, points: 50 });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.points).toBe(50);
    expect(ok.body.walletBalance).toBe(10);

    // Overdraw → refused.
    const over = await request(app).post('/api/loyalty/convert-to-wallet').send({ phone, points: 55 });
    expect(over.statusCode).toBe(400);
  });

  it('refuses to redeem a tier the customer cannot afford', async () => {
    const phone = freshPhone();
    await request(app)
      .post('/api/admin/loyalty/add-points')
      .set(auth())
      .send({ phone, points: 50 });
    const redeem = await request(app).post('/api/loyalty/redeem-reward').send({ customerId: phone, rewardId: 'tier-100' });
    expect(redeem.statusCode).toBe(400);
    expect(redeem.body.error).toMatch(/insufficient/i);
  });
});

describe('Notification token registration (staff push)', () => {
  it('registers a staff token for a real staff account and refuses unknown usernames', async () => {
    // Create a dedicated staff user so the test is deterministic in both the
    // shared Mongo test DB and the offline mock.
    const uname = 'notif_staff_' + Date.now();
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth())
      .send({ username: uname, password: 'pass12345', name: 'Notif Staff', role: 'cashier', permissions: ['sales'] });
    expect(created.body.success).toBe(true);

    const good = await request(app)
      .post('/api/notifications/register')
      .send({ role: 'staff', staffUsername: uname, token: 'STAFF-TOKEN-' + Date.now(), platform: 'android' });
    expect(good.statusCode).toBe(200);
    expect(good.body.success).toBe(true);

    const bad = await request(app)
      .post('/api/notifications/register')
      .send({ role: 'staff', staffUsername: 'no_such_user', token: 'STAFF-TOKEN-BAD-' + Date.now() });
    expect(bad.statusCode).toBe(403);
  });

  it('a customer token still requires a real customer', async () => {
    const r = await request(app)
      .post('/api/notifications/register')
      .send({ phone: '07999999999', token: 'CUST-TOKEN-' + Date.now() });
    expect(r.statusCode).toBe(403);
  });
});

describe('Promo atomicity', () => {
  it('two simultaneous spins never both win — at most one is granted', async () => {
    const phone = freshPhone();
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/orders').send({
        customerId: phone, customerName: 'Racer', items: [{ _id: i === 0 ? P.item0 : P.item1, quantity: 1 }]
      });
    }
    const [a, b] = await Promise.all([
      request(app).post('/api/promos/spin').send({ phone, name: 'Racer' }),
      request(app).post('/api/promos/spin').send({ phone, name: 'Racer' })
    ]);
    const granted = [a.body, b.body].filter(x => x && x.success === true).length;
    const refused = [a.body, b.body].filter(x => x && x.alreadyUsed === true).length;
    expect(granted).toBeLessThanOrEqual(1);
    expect(granted + refused).toBeGreaterThanOrEqual(2); // both requests got a definitive answer
  });
});
