const request = require('supertest');

// Regression tests for every hole found in the October 2026 review: each test
// replays an attack that used to work and pins that it no longer does.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken, customerToken, bearer } = require('./helpers');

let seq = 0;
const freshPhone = () => '07' + String(Date.now() + (seq += 53) * 7919 + Math.floor(Math.random() * 1e8)).slice(-8);

let ownerToken = null;
const owner = () => bearer(ownerToken);
const mockDb = () => _test.mockDb();

const createProduct = async (fields) => {
  const r = await request(app).post('/api/admin/products').set(owner())
    .send({ image: [], buyingPrice: 0, stock: 50, ...fields, name: fields.name + ' ' + Date.now() + '-' + (seq += 1) });
  expect(r.body.success).toBe(true);
  return r.body.productId;
};
const placeOrder = async (phone, items, extra = {}) =>
  request(app).post('/api/orders').set(bearer(await customerToken(request, app, phone)))
    .send({ customerName: 'Shopper', items, paymentMethod: 'delivery', ...extra });
const myOrders = async (phone) =>
  (await request(app).get('/api/customer-orders/' + phone).set(bearer(await customerToken(request, app, phone)))).body;

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});

afterAll(async () => {
  if (client) await client.close();
});

describe('Customer accounts are no longer keyed by a guessable phone number', () => {
  it('another customer cannot read my orders, profile, promos, baskets or feed', async () => {
    const victim = freshPhone();
    const attacker = freshPhone();
    const pid = await createProduct({ name: 'ATK-Milk', price: 100 });
    await placeOrder(victim, [{ _id: pid, quantity: 1 }], { deliveryLocation: 'Home', gpsCoords: { lat: 1, lng: 2 } });
    const atk = bearer(await customerToken(request, app, attacker));

    for (const url of [`/api/customer-orders/${victim}`, `/api/customers/${victim}`, `/api/promos/status/${victim}`, `/api/customer/baskets/${victim}`, `/api/notifications/feed?phone=${victim}`]) {
      const r = await request(app).get(url).set(atk);
      expect([401, 403]).toContain(r.statusCode);
    }
    // And with no session at all.
    for (const url of [`/api/customer-orders/${victim}`, `/api/customers/${victim}`, `/api/notifications/feed?phone=${victim}`]) {
      expect((await request(app).get(url)).statusCode).toBe(401);
    }
  });

  it('another customer cannot cancel my order or spend my points', async () => {
    const victim = freshPhone();
    const attacker = freshPhone();
    const pid = await createProduct({ name: 'ATK-Bread', price: 80 });
    const placed = await placeOrder(victim, [{ _id: pid, quantity: 1 }]);
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone: victim, points: 500 });
    const atk = bearer(await customerToken(request, app, attacker));

    const cancel = await request(app).post(`/api/customer-orders/${placed.body.orderId}/cancel`).set(atk).send({ customerId: victim });
    expect(cancel.statusCode).toBe(404);
    expect((await myOrders(victim))[0].status).toBe('pending');

    // The phone in the body is ignored — the attacker can only touch their own (empty) balance.
    const convert = await request(app).post('/api/loyalty/convert-to-wallet').set(atk).send({ phone: victim, points: 100 });
    expect(convert.statusCode).toBe(400);
    const redeem = await request(app).post('/api/loyalty/redeem-reward').set(atk).send({ customerId: victim, rewardId: 'tier-100' });
    expect(redeem.statusCode).toBe(400);
    const prof = await request(app).get('/api/customers/' + victim).set(bearer(await customerToken(request, app, victim)));
    expect(prof.body.loyaltyPoints).toBe(500);
  });

  it("the AI chat can't place or cancel orders for a phone number typed into the request", async () => {
    const victim = freshPhone();
    const pid = await createProduct({ name: 'ATK-Sugar', price: 90 });
    await placeOrder(victim, [{ _id: pid, quantity: 1 }]);
    const r = await request(app).post('/api/ai/chat').send({ message: 'yes cancel it please', customerId: victim });
    expect(r.body.response).toMatch(/log in/i);
    expect((await myOrders(victim))[0].status).toBe('pending');
  });

  it('a customer session never opens a staff route', async () => {
    const tok = bearer(await customerToken(request, app, freshPhone()));
    expect((await request(app).get('/api/admin/orders').set(tok)).statusCode).toBe(401);
    expect((await request(app).post('/api/admin/sales').set(tok).send({ items: [{ name: 'x', price: 1, qty: 1 }] })).statusCode).toBe(401);
  });
});

describe('Staff sessions can be revoked', () => {
  const makeCashier = async () => {
    const username = 'atk_cashier_' + Date.now() + '_' + (seq += 1);
    const created = await request(app).post('/api/admin/users').set(owner())
      .send({ username, password: 'cashpass123', name: 'Cashier', role: 'cashier', permissions: ['sales'] });
    const login = await request(app).post('/api/admin/login').send({ username, password: 'cashpass123' });
    return { id: created.body.userId, token: login.body.token };
  };

  it('deleting a staff account kills their token immediately', async () => {
    const c = await makeCashier();
    expect((await request(app).get('/api/admin/me').set(bearer(c.token))).statusCode).toBe(200);
    expect((await request(app).delete('/api/admin/users/' + c.id).set(owner())).statusCode).toBe(200);
    const after = await request(app).get('/api/admin/me').set(bearer(c.token));
    expect(after.statusCode).toBe(401);
    expect(after.body.sessionRevoked).toBe(true);
  });

  it('changing permissions signs the user out, and permissions come from the DB, not the token', async () => {
    const c = await makeCashier();
    // A cashier (sales only) can't edit orders…
    expect((await request(app).put('/api/admin/orders/000000000000000000000000').set(bearer(c.token)).send({ status: 'packed' })).statusCode).toBe(403);
    // …and when the owner grants 'orders', the old token is revoked.
    await request(app).put('/api/admin/users/' + c.id).set(owner()).send({ permissions: ['sales', 'orders'] });
    expect((await request(app).get('/api/admin/me').set(bearer(c.token))).statusCode).toBe(401);
  });

  it('"revoke sessions" signs a user out of every device', async () => {
    const c = await makeCashier();
    await request(app).post(`/api/admin/users/${c.id}/revoke-sessions`).set(owner());
    expect((await request(app).get('/api/admin/me').set(bearer(c.token))).statusCode).toBe(401);
  });

  it('only the owner can export the whole database', async () => {
    const c = await makeCashier();
    expect((await request(app).get('/api/admin/export').set(bearer(c.token))).statusCode).toBe(403);
    expect((await request(app).get('/api/admin/export').set(owner())).statusCode).toBe(200);
  });

  it('the first-owner setup stays closed once an owner exists', async () => {
    const r = await request(app).post('/api/admin/setup').send({ username: 'evil_owner', password: 'evilpass1' });
    expect(r.statusCode).toBe(400);
  });
});

describe('M-Pesa can no longer be faked', () => {
  it('nobody can send an STK prompt without a session', async () => {
    const r = await request(app).post('/api/mpesa/stk-push').send({ phone: '0712345678', amount: 1 });
    expect(r.statusCode).toBe(401);
  });

  it('a customer cannot submit a till saleDraft (the old points-minting trick)', async () => {
    const tok = bearer(await customerToken(request, app, freshPhone()));
    const r = await request(app).post('/api/mpesa/stk-push').set(tok)
      .send({ phone: '0712345678', amount: 1, saleDraft: { items: [{ name: 'Fake', price: 10000000, qty: 1 }], customerPhone: '0712345678' } });
    expect(r.statusCode).toBe(401);
  });

  it('a forged "payment successful" callback does not mark an order paid', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ name: 'ATK-Rice', price: 500 });
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    const checkoutRequestId = 'ws_CO_FAKE_' + Date.now();
    await mockDb().collection('mpesa_requests').insertOne({
      checkoutRequestId, phone: '254712345678', amount: 1, orderId: String(placed.body.orderId),
      saleDraft: null, saleCreated: false, status: 'pending', createdAt: new Date()
    });
    const cb = await request(app).post('/api/mpesa/callback').send({
      Body: { stkCallback: { CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'The service request is processed successfully.' } }
    });
    expect(cb.body.ResultCode).toBe(0); // Safaricom always gets an ack…
    await new Promise(r => setTimeout(r, 50));
    const order = (await myOrders(phone))[0];
    expect(order.paymentStatus).toBe('pending'); // …but nothing is paid without Safaricom's own confirmation
    const reqDoc = await mockDb().collection('mpesa_requests').findOne({ checkoutRequestId });
    expect(reqDoc.status).toBe('pending');
  });

  it('a callback without the shared secret is ignored when MPESA_CALLBACK_SECRET is set', async () => {
    process.env.MPESA_CALLBACK_SECRET = 'cb-secret';
    try {
      const checkoutRequestId = 'ws_CO_SECRET_' + Date.now();
      await mockDb().collection('mpesa_requests').insertOne({ checkoutRequestId, amount: 5, status: 'pending', createdAt: new Date() });
      await request(app).post('/api/mpesa/callback?secret=wrong').send({ Body: { stkCallback: { CheckoutRequestID: checkoutRequestId, ResultCode: 0 } } });
      const doc = await mockDb().collection('mpesa_requests').findOne({ checkoutRequestId });
      expect(doc.callbackAt).toBeUndefined();
    } finally {
      delete process.env.MPESA_CALLBACK_SECRET;
    }
  });

  it('the amount charged always comes from the order, never the client', async () => {
    process.env.MPESA_MOCK_ENABLED = 'true';
    try {
      const phone = freshPhone();
      const pid = await createProduct({ name: 'ATK-Oil', price: 750 });
      const placed = await placeOrder(phone, [{ _id: pid, quantity: 2 }]);
      const r = await request(app).post('/api/mpesa/stk-push').set(bearer(await customerToken(request, app, phone)))
        .send({ phone, amount: 1, orderId: placed.body.orderId });
      expect(r.body.success).toBe(true);
      expect(r.body.amount).toBe(1500);
    } finally {
      delete process.env.MPESA_MOCK_ENABLED;
    }
  });
});

describe('Checkout charges what the shop shows', () => {
  it('flash-sale / expiry prices are what the order is billed at', async () => {
    const phone = freshPhone();
    const inThreeDays = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const pid = await createProduct({ name: 'ATK-Yoghurt', price: 200, buyingPrice: 60, expiryDate: inThreeDays });
    const shown = (await request(app).get('/api/products')).body.find(p => String(p._id) === String(pid));
    expect(shown.price).toBe(100); // 50% expiry discount on display…
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 2, price: 1 }]);
    expect(placed.body.totalPrice).toBe(200); // …and at checkout (2 × 100), never the tampered 1
  });

  it('stores the cost price on each line so online-order profit is real', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ name: 'ATK-Flour', price: 300, buyingPrice: 220 });
    await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    const order = (await myOrders(phone))[0];
    expect(order.items[0].buyingPrice).toBe(220);
    expect(_test.orderProfit(order, new Map())).toBe(80);
  });

  it('refuses to sell more than is in stock and leaves stock untouched', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ name: 'ATK-Last-One', price: 100, stock: 1 });
    const r = await placeOrder(phone, [{ _id: pid, quantity: 2 }]);
    expect(r.statusCode).toBe(409);
    const ok = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    expect(ok.body.success).toBe(true);
    const sold = await placeOrder(freshPhone(), [{ _id: pid, quantity: 1 }]);
    expect(sold.statusCode).toBe(409);
    expect(sold.body.error).toMatch(/sold out/i);
  });

  it("enforces a voucher's minimum purchase at checkout, not just in the preview", async () => {
    const phone = freshPhone();
    const pid = await createProduct({ name: 'ATK-Gum', price: 50 });
    const r = await placeOrder(phone, [{ _id: pid, quantity: 1 }], { couponCode: 'BLITZ10' }); // min KES 1000
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/minimum/i);
  });
});

describe('Cancelling gives everything back', () => {
  it('returns stock, wallet cash and the voucher on cancel', async () => {
    const phone = freshPhone();
    const tok = bearer(await customerToken(request, app, phone));
    const pid = await createProduct({ name: 'ATK-Tea', price: 1000, stock: 5 });
    // KES 40 of wallet cash (200 pts → KES 40) and a personal KES 50 voucher.
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 200 });
    await request(app).post('/api/loyalty/convert-to-wallet').set(tok).send({ points: 200 });
    const code = await _test.issueVoucher({ phone, type: 'fixed', value: 50, minPurchase: 100, prefix: 'ATK' });

    const placed = await placeOrder(phone, [{ _id: pid, quantity: 2 }], { couponCode: code, useWallet: true });
    expect(placed.body.success).toBe(true);
    expect(placed.body.walletApplied).toBe(40);
    expect(placed.body.totalPrice).toBe(2000 - 50 - 40);

    const cancel = await request(app).post(`/api/customer-orders/${placed.body.orderId}/cancel`).set(tok);
    expect(cancel.body.success).toBe(true);
    expect(cancel.body.walletRefunded).toBe(40);

    const prof = (await request(app).get('/api/customers/' + phone).set(tok)).body;
    expect(prof.walletBalance).toBe(40);
    expect(prof.vouchers.find(v => v.code === code).used).toBe(false);
    const product = (await request(app).get('/api/admin/products').set(owner())).body.find(p => String(p._id) === String(pid));
    expect(product.stock).toBe(5);

    // Cancelling twice changes nothing more.
    const again = await request(app).put('/api/admin/orders/' + placed.body.orderId).set(owner()).send({ status: 'cancelled' });
    expect(again.body.success).toBe(true);
    expect((await request(app).get('/api/customers/' + phone).set(tok)).body.walletBalance).toBe(40);
  });

  it('a cancelled order cannot be quietly reopened', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ name: 'ATK-Salt', price: 40 });
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    await request(app).put('/api/admin/orders/' + placed.body.orderId).set(owner()).send({ status: 'cancelled' });
    const reopen = await request(app).put('/api/admin/orders/' + placed.body.orderId).set(owner()).send({ status: 'pending' });
    expect(reopen.statusCode).toBe(400);
  });
});

describe('Reports and housekeeping', () => {
  it('refunded sales are not counted as revenue', async () => {
    const before = (await request(app).get('/api/admin/summary').set(owner())).body.summary.all.revenue;
    const sale = await request(app).post('/api/admin/sales').set(owner()).send({ items: [{ name: 'Refund me', price: 777, qty: 1 }], paymentMethod: 'cash', amountGiven: 777 });
    expect(sale.body.success).toBe(true);
    await mockDb().collection('sales').updateOne({ _id: sale.body.saleId }, { $set: { refunded: true } });
    const after = (await request(app).get('/api/admin/summary').set(owner())).body.summary.all.revenue;
    expect(after).toBeCloseTo(before, 2);
  });

  it('the image-search debug endpoint is gone and image search needs a staff session', async () => {
    expect((await request(app).get('/api/image-search-debug')).statusCode).not.toBe(200);
    expect((await request(app).post('/api/products/search-images').send({ name: 'milk' })).statusCode).toBe(401);
  });

  it('/api/health reports the live version', async () => {
    const r = await request(app).get('/api/health');
    expect(r.body.ok).toBe(true);
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs on Nairobi time', () => {
    expect(process.env.TZ).toBe('Africa/Nairobi');
  });
});
