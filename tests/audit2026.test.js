const request = require('supertest');

// Regression tests for the October 2026 security audit. Each block replays an
// attack that worked before the fix and asserts it no longer does. Runs on the
// offline mock DB like the rest of the suite (MOCK_DB=1) — never production.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const jwt = require('jsonwebtoken');
const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken, customerToken, bearer } = require('./helpers');
const { earnPoints } = require('../lib/loyalty');

let seq = 0;
const freshPhone = () => { seq += 1; return '07' + String((Date.now() + seq * 7919 + Math.floor(Math.random() * 1e8)) % 1e8).padStart(8, '0'); };
const uniq = (s) => `${s} ${Date.now()}${Math.floor(Math.random() * 1e5)}`;

let ownerToken;
const owner = () => bearer(ownerToken);
const db = () => _test.mockDb();

const createProduct = async (fields = {}) => {
  const r = await request(app).post('/api/admin/products').set(owner())
    .send({ price: 300, buyingPrice: 200, stock: 50, image: [], ...fields, name: uniq(fields.name || 'AUD-Item') });
  expect(r.body.success).toBe(true);
  return String(r.body.productId);
};
const staff = async (role, permissions) => {
  const username = `aud_${role}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const c = await request(app).post('/api/admin/users').set(owner()).send({ username, password: 'staffpass123', name: 'AUD ' + role, role, permissions });
  expect(c.body.success).toBe(true);
  const l = await request(app).post('/api/admin/login').send({ username, password: 'staffpass123' });
  expect(l.body.token).toBeTruthy();
  return { username, userId: String(c.body.userId), token: l.body.token, auth: () => bearer(l.body.token) };
};
const placeOrder = async (phone, items) =>
  request(app).post('/api/orders').set(bearer(await customerToken(request, app, phone)))
    .send({ customerName: 'Audit Shopper', items, paymentMethod: 'delivery' });
const setStatus = (orderId, status, who = owner()) => request(app).put('/api/admin/orders/' + orderId).set(who).send({ status });
const auditEntries = async (action) => (await db().collection('audit_logs').find({ action }).toArray());
const card = (phone) => db().collection('loyalty').findOne({ phone });

let cashier, manager;
beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
  cashier = await staff('cashier', ['sales']);
  manager = await staff('manager', ['sales', 'inventory', 'orders', 'records', 'expenses', 'credit', 'reviews', 'loyalty']);
});
afterAll(async () => { if (client) await client.close(); });

describe('A cashier (sales only) cannot read data outside the till', () => {
  const forbidden = [
    '/api/admin/orders', '/api/admin/loyalty', '/api/admin/coupons', '/api/admin/loyalty/settings',
    '/api/admin/loyalty/stats', '/api/admin/audit-logs', '/api/admin/expenses', '/api/admin/credit',
    '/api/admin/shifts', '/api/admin/predictions', '/api/admin/reviews', '/api/admin/product-reviews',
    '/api/admin/pricing-rules', '/api/admin/transfers'
  ];
  it.each(forbidden)('GET %s → 403', async (url) => {
    expect((await request(app).get(url).set(cashier.auth())).statusCode).toBe(403);
  });

  it('still gets stock alerts from /api/admin/summary, but no revenue or profit', async () => {
    const r = await request(app).get('/api/admin/summary').set(cashier.auth());
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.body.out)).toBe(true);
    expect(r.body.summary).toBeUndefined();
    expect(r.body.predictions).toBeUndefined();
  });

  it('keeps what the till needs: recent sales and a loyalty lookup', async () => {
    expect((await request(app).get('/api/admin/sales?limit=5').set(cashier.auth())).statusCode).toBe(200);
    expect((await request(app).get('/api/admin/loyalty/0712000000').set(cashier.auth())).statusCode).toBe(200);
  });

  it('denied attempts are written to the audit log — once per route, so polling can\'t flood it', async () => {
    await request(app).get('/api/admin/credit').set(cashier.auth());
    await request(app).get('/api/admin/credit').set(cashier.auth());
    const denied = (await auditEntries('permission_denied')).filter(d => /admin\/credit/.test(d.details) && d.userId === cashier.userId);
    expect(denied.length).toBe(1);
  });

  it('cannot use the AI assistant as a back door to customer, credit or profit data', async () => {
    for (const message of ['find customer 0712345678', 'show who owes credit', "what's my profit this month", 'list all coupons']) {
      const r = await request(app).post('/api/admin/ai/chat').set(cashier.auth()).send({ message });
      expect(r.statusCode).toBe(403);
    }
  });

  it('only the owner reads the audit log, and it cannot be wiped', async () => {
    expect((await request(app).get('/api/admin/audit-logs').set(manager.auth())).statusCode).toBe(403);
    const r = await request(app).get('/api/admin/audit-logs').set(owner());
    expect(r.statusCode).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    const before = await db().collection('audit_logs').countDocuments({});
    const wipe = await request(app).delete('/api/admin/records').set(owner()).send({ types: ['audit_logs'] });
    expect(wipe.body.types || []).not.toContain('audit_logs');
    expect(await db().collection('audit_logs').countDocuments({})).toBeGreaterThanOrEqual(before);
  });
});

describe('Loyalty economy is owner-controlled and points are money', () => {
  it('a manager cannot change the loyalty settings (earn rate, prize odds, redemption values)', async () => {
    const r = await request(app).put('/api/admin/loyalty/settings').set(manager.auth()).send({ earnRate: 1 });
    expect(r.statusCode).toBe(403);
  });

  it('settings reject an absurd earn rate and ignore unknown fields (no mass assignment)', async () => {
    const bad = await request(app).put('/api/admin/loyalty/settings').set(owner()).send({ earnRate: 0.001 });
    expect(bad.statusCode).toBe(400);
    const ok = await request(app).put('/api/admin/loyalty/settings').set(owner()).send({ earnRate: 200, injectedFlag: true, walletRatePointsPerKsh: 0.0001 });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.settings.injectedFlag).toBeUndefined();
    expect(ok.body.settings.walletRatePointsPerKsh).toBeUndefined();
  });

  it('a manager can add at most 1,000 points at a time; every adjustment is audit-logged', async () => {
    const phone = freshPhone();
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 10 });
    expect((await request(app).post('/api/admin/loyalty/manual-points').set(manager.auth()).send({ phone, points: 5000, reason: 'x' })).statusCode).toBe(403);
    expect((await request(app).post('/api/admin/loyalty/add-points').set(manager.auth()).send({ phone, points: 5000 })).statusCode).toBe(403);
    const ok = await request(app).post('/api/admin/loyalty/manual-points').set(manager.auth()).send({ phone, points: 500, reason: 'goodwill' });
    expect(ok.body.points).toBe(510);
    expect((await auditEntries('points_manual_adjust')).some(a => a.details.includes(phone))).toBe(true);
    const ai = await request(app).post('/api/admin/ai/chat').set(manager.auth()).send({ message: `add 5000 points to ${phone}` });
    expect(ai.body.response).toMatch(/at most 1,000/);
    expect((await card(phone)).points).toBe(510);
  });

  it('a points award running alongside a wallet conversion can never refund the spent points', async () => {
    const phone = freshPhone();
    const token = await customerToken(request, app, phone);
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 1000 });
    const [conv, earned] = await Promise.all([
      request(app).post('/api/loyalty/convert-to-wallet').set(bearer(token)).send({ points: 1000 }),
      earnPoints(phone, 2000) // e.g. a till sale finishing at the same moment (1 pt per KES 200)
    ]);
    expect(conv.body.success).toBe(true);
    const c = await card(phone);
    // 1,000 points became KES 200; only the newly earned points remain.
    expect(c.points).toBe(earned);
    expect(c.walletBalance).toBe(200);
  });

  it('coupons: no >90% or unknown-type coupons, and creation is audit-logged', async () => {
    expect((await request(app).post('/api/admin/coupons').set(manager.auth()).send({ code: uniq('FREE').replace(/\D/g, '') + 'X', type: 'percent', value: 150 })).statusCode).toBe(400);
    expect((await request(app).post('/api/admin/coupons').set(manager.auth()).send({ code: 'WEIRD' + Date.now(), type: 'store_credit', value: 5 })).statusCode).toBe(400);
    const code = 'AUD' + Date.now();
    expect((await request(app).post('/api/admin/coupons').set(manager.auth()).send({ code, type: 'percent', value: 10 })).body.success).toBe(true);
    expect((await auditEntries('coupon_created')).some(a => a.details.includes(code))).toBe(true);
  });
});

describe('Order status rules', () => {
  it('a delivered order cannot be moved back, and only the owner can cancel it (a return)', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ price: 1000, stock: 10 });
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    expect((await setStatus(placed.body.orderId, 'delivered')).statusCode).toBe(200);
    const pointsAfterDelivery = (await card(phone)).points;
    expect(pointsAfterDelivery).toBeGreaterThan(0);

    expect((await setStatus(placed.body.orderId, 'pending')).statusCode).toBe(400);
    expect((await setStatus(placed.body.orderId, 'cancelled', manager.auth())).statusCode).toBe(403);
    // The AI assistant obeys the same rule.
    const ai = await request(app).post('/api/admin/ai/chat').set(owner()).send({ message: `mark order #${String(placed.body.orderId).slice(-6)} pending` });
    expect(ai.body.response).toMatch(/already delivered/i);

    expect((await setStatus(placed.body.orderId, 'cancelled')).statusCode).toBe(200);
    expect((await card(phone)).points).toBe(pointsAfterDelivery - (await db().collection('orders').findOne({ customerId: phone })).pointsAwarded);
  });

  it('a "delivered" racing a cancel cannot resurrect the cancelled order', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ stock: 5 });
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    await Promise.all([setStatus(placed.body.orderId, 'cancelled'), setStatus(placed.body.orderId, 'delivered')]);
    const o = await db().collection('orders').findOne({ customerId: phone });
    // Whichever won, the order is in ONE consistent final state.
    if (o.status === 'cancelled') expect(o.pointsAwardedAt === undefined || o.pointsAwarded !== undefined).toBe(true);
    expect(['cancelled', 'delivered']).toContain(o.status);
    const again = await setStatus(placed.body.orderId, 'delivered');
    if (o.status === 'cancelled') expect(again.statusCode).toBe(400);
  });
});

describe('Promos unlock on DELIVERED orders only', () => {
  it('two unpaid pending orders do not unlock the spin wheel', async () => {
    const phone = freshPhone();
    const pid = await createProduct();
    await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    await placeOrder(phone, [{ _id: pid, quantity: 2 }]);
    const r = await request(app).post('/api/promos/spin').set(bearer(await customerToken(request, app, phone))).send({});
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/two purchases/i);
  });
});

describe('Till (POS) fraud controls', () => {
  it('selling below the shelf price is flagged on the sale and audit-logged', async () => {
    const pid = await createProduct({ price: 300 });
    const r = await request(app).post('/api/admin/sales').set(cashier.auth()).send({ items: [{ productId: pid, name: 'x', price: 1, qty: 1 }], paymentMethod: 'cash' });
    expect(r.body.success).toBe(true);
    const sale = await db().collection('sales').findOne({ _id: r.body.saleId });
    expect(sale.priceOverrides).toBe(1);
    expect(sale.items[0].priceOverride.catalogPrice).toBe(300);
    expect((await auditEntries('sale_price_override')).some(a => a.details.includes(String(r.body.saleId)))).toBe(true);
  });

  it('a voided sale is archived, audit-logged, and a double void restores stock only once', async () => {
    const pid = await createProduct({ stock: 10 });
    const sale = await request(app).post('/api/admin/sales').set(owner()).send({ items: [{ productId: pid, name: 'x', price: 300, qty: 2 }], paymentMethod: 'cash' });
    const stockAfterSale = (await db().collection('products').findOne({ _id: pid }) || (await request(app).get('/api/admin/products').set(owner())).body.find(p => String(p._id) === pid)).stock;
    const [a, b] = await Promise.all([
      request(app).delete('/api/admin/sales/' + sale.body.saleId).set(manager.auth()),
      request(app).delete('/api/admin/sales/' + sale.body.saleId).set(manager.auth())
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    const p = (await request(app).get('/api/admin/products').set(owner())).body.find(x => String(x._id) === pid);
    expect(p.stock).toBe(stockAfterSale + 2);
    const archived = await db().collection('voided_sales').find({}).toArray();
    expect(archived.some(v => String(v.sale._id) === String(sale.body.saleId) && v.voidedBy === manager.username)).toBe(true);
    expect((await auditEntries('sale_voided')).some(e => e.details.includes(String(sale.body.saleId)))).toBe(true);
  });

  it('a cashier cannot book a sale to another branch', async () => {
    const branchCashier = await staff('cashier', ['sales']);
    await db().collection('users').updateOne({ username: branchCashier.username }, { $set: { branchId: 'branch-A' } });
    const r = await request(app).post('/api/admin/sales').set(branchCashier.auth()).send({ items: [{ name: 'Loose', price: 50, qty: 1 }], paymentMethod: 'cash', branchId: 'branch-B' });
    const sale = await db().collection('sales').findOne({ _id: r.body.saleId });
    expect(sale.branchId).toBe('branch-A');
  });
});

describe('Records wipe protects money and evidence', () => {
  it('refuses to wipe loyalty cards while customers hold wallet cash', async () => {
    const phone = freshPhone();
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 500 });
    await request(app).post('/api/loyalty/convert-to-wallet').set(bearer(await customerToken(request, app, phone))).send({ points: 500 });
    const r = await request(app).delete('/api/admin/records').set(owner()).send({ types: ['loyalty'] });
    expect(r.statusCode).toBe(409);
    expect((await card(phone)).walletBalance).toBe(100);
  });
});

describe('Catalogue limits', () => {
  it('a flash sale can never exceed 90% off, and is audit-logged', async () => {
    const pid = await createProduct({ price: 1000 });
    await request(app).post(`/api/admin/products/${pid}/flash-sale`).set(owner()).send({ flashSale: true, flashSaleDiscount: 150, durationHours: 1 });
    const shown = (await request(app).get('/api/products')).body.find(p => String(p._id) === pid);
    expect(shown.price).toBe(100);
    expect((await auditEntries('flash_sale_set')).some(a => a.details.includes(pid))).toBe(true);
  });

  it('price and stock edits are audit-logged with before → after', async () => {
    const pid = await createProduct({ price: 500, stock: 9 });
    await request(app).put('/api/admin/products/' + pid).set(owner()).send({ price: 450, stock: 3 });
    const e = (await auditEntries('product_updated')).find(a => a.details.includes('price 500 → 450'));
    expect(e).toBeTruthy();
    expect(e.details).toMatch(/stock 9 → 3/);
  });

  it('stock transfers reject NaN / negative quantities', async () => {
    const pid = await createProduct();
    const r = await request(app).post('/api/admin/transfers').set(owner()).send({ fromBranchId: 'a', toBranchId: 'b', items: [{ productId: pid, qty: -5 }] });
    expect(r.statusCode).toBe(400);
  });
});

describe('Staff sign-in brute force', () => {
  it('locks an account after 5 wrong passwords (even with the right one after) and logs it', async () => {
    const victim = await staff('cashier', ['sales']);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/admin/login').send({ username: victim.username, password: 'wrong-' + i })).statusCode).toBe(401);
    }
    const locked = await request(app).post('/api/admin/login').send({ username: victim.username, password: 'staffpass123' });
    expect(locked.statusCode).toBe(429);
    expect(locked.body.token).toBeUndefined();
    expect((await auditEntries('login_failed')).filter(a => a.by === victim.username).length).toBeGreaterThanOrEqual(5);
    expect((await auditEntries('account_locked')).some(a => a.by === victim.username)).toBe(true);
  });

  it('new staff passwords need 8+ characters', async () => {
    const r = await request(app).post('/api/admin/users').set(owner()).send({ username: 'short_' + Date.now(), password: 'abc123', role: 'cashier' });
    expect(r.statusCode).toBe(400);
  });

  it('a token signed with another algorithm (alg:none) is refused', async () => {
    const forged = jwt.sign({ userId: cashier.userId, username: cashier.username, role: 'owner', tv: 0 }, null, { algorithm: 'none' });
    expect((await request(app).get('/api/admin/me').set(bearer(forged))).statusCode).toBe(401);
  });
});

describe('Customers never see the shop\'s cost prices', () => {
  it('order responses and history carry no buyingPrice', async () => {
    const phone = freshPhone();
    const pid = await createProduct({ price: 300, buyingPrice: 210 });
    const placed = await placeOrder(phone, [{ _id: pid, quantity: 1 }]);
    expect(placed.body.items[0].buyingPrice).toBeUndefined();
    const mine = (await request(app).get('/api/customer-orders/' + phone).set(bearer(await customerToken(request, app, phone)))).body;
    expect(mine[0].items[0].buyingPrice).toBeUndefined();
  });

  it('API responses are marked no-store', async () => {
    const r = await request(app).get('/api/auth/me').set(bearer(await customerToken(request, app, freshPhone())));
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('M-Pesa', () => {
  it('the auto-confirming mock is refused in production', () => {
    const { mpesaMock } = require('../lib/mpesa');
    const env = { ...process.env };
    try {
      process.env.MPESA_MOCK_ENABLED = 'true';
      process.env.NODE_ENV = 'production';
      expect(mpesaMock()).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(mpesaMock()).toBe(true);
    } finally {
      process.env.MPESA_MOCK_ENABLED = env.MPESA_MOCK_ENABLED || '';
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.MPESA_MOCK_ENABLED === undefined) delete process.env.MPESA_MOCK_ENABLED;
    }
  });

  it('a callback keeps the receipt for reconciliation and flags an amount that differs from the request', async () => {
    const checkoutRequestId = 'ws_CO_AUDIT_' + Date.now();
    await db().collection('mpesa_requests').insertOne({ checkoutRequestId, status: 'pending', amount: 500, phone: '254712345678', purpose: 'order', createdAt: new Date() });
    await request(app).post('/api/mpesa/callback').send({ Body: { stkCallback: {
      CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }, { Name: 'MpesaReceiptNumber', Value: 'QAB1CD2EF3' }] }
    } } });
    const doc = await db().collection('mpesa_requests').findOne({ checkoutRequestId });
    expect(doc.callbackMeta.MpesaReceiptNumber).toBe('QAB1CD2EF3');
    expect(doc.amountMismatch).toBe(true);
    expect(doc.status).toBe('pending'); // a callback alone never marks anything paid
  });

  it('a rider cannot ring up a till payment', async () => {
    const rider = await staff('rider', ['deliveries']);
    const r = await request(app).post('/api/mpesa/stk-push').set(rider.auth()).send({ phone: '0712345678', saleDraft: { items: [{ name: 'x', price: 10, qty: 1 }] } });
    expect(r.statusCode).toBe(403);
  });
});
