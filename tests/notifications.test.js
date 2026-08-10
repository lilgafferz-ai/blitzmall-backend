const request = require('supertest');

// Configure env BEFORE importing the server so connectDb() targets a
// dedicated test database (never the real shop DB).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken } = require('./helpers');
const { notifyStaffAlerts } = _test || {};

// Unique 10-digit phone per call so a prior test run's data can never
// interfere with a later run.
let seq = 7000;
const freshPhone = () => { seq += 11; return '07' + String(Date.now() + seq).slice(-8); };

let ownerToken = null;
const auth = () => ({ Authorization: 'Bearer ' + ownerToken });

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});

afterAll(async () => {
  if (client) await client.close();
});

describe('Customer test push endpoint', () => {
  it('sends a test push to a known customer and lands in their feed', async () => {
    const phone = freshPhone();
    // A customer record exists as soon as they place an order.
    const prod = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name: 'Notif Test Milk', price: 100, buyingPrice: 60, stock: 20, image: [] });
    expect(prod.body.success).toBe(true);

    await request(app).post('/api/orders').send({
      customerId: phone,
      customerName: 'Push Tester',
      items: [{ _id: prod.body.productId, name: 'Notif Test Milk', quantity: 1 }]
    });

    const since = new Date().toISOString();
    const r = await request(app)
      .post('/api/notifications/test')
      .send({ phone, platform: 'web' });
    expect(r.statusCode).toBe(200);
    expect(r.body.success).toBe(true);

    // The test push also wrote a customer feed event the PC app can poll.
    const feed = await request(app).get(`/api/notifications/feed?phone=${phone}&since=${encodeURIComponent(since)}`);
    expect(feed.statusCode).toBe(200);
    const hit = (feed.body || []).find(e => e && /test notification/i.test(String(e.title)));
    expect(hit).toBeTruthy();
  });

  it('refuses a test push for an unknown phone', async () => {
    const r = await request(app)
      .post('/api/notifications/test')
      .send({ phone: '07000000000' });
    expect(r.statusCode).toBe(403);
  });
});

describe('Staff test push endpoint', () => {
  it('sends a test push to a real staff account and refuses unknown usernames', async () => {
    const uname = 'notiftest_staff_' + Date.now();
    const created = await request(app)
      .post('/api/admin/users')
      .set(auth())
      .send({ username: uname, password: 'pass12345', name: 'Notif Staff', role: 'cashier', permissions: ['sales'] });
    expect(created.body.success).toBe(true);

    const good = await request(app)
      .post('/api/notifications/test')
      .send({ role: 'staff', staffUsername: uname });
    expect(good.statusCode).toBe(200);
    expect(good.body.success).toBe(true);

    const bad = await request(app)
      .post('/api/notifications/test')
      .send({ role: 'staff', staffUsername: 'no_such_staff' });
    expect(bad.statusCode).toBe(403);
  });
});

describe('Staff stock / expiry alert engine', () => {
  it('pushes an out-of-stock alert to the admin feed when a product hits 0', async () => {
    const name = 'NotifOut_' + Date.now();
    const prod = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name, price: 100, buyingPrice: 60, stock: 0, image: [] });
    expect(prod.body.success).toBe(true);

    const since = new Date().toISOString();
    await notifyStaffAlerts(); // deterministic — the fire-and-forget hook may already have fired too

    const feed = await request(app).get(`/api/notifications/feed?admin=1&since=${encodeURIComponent(since)}`);
    expect(feed.statusCode).toBe(200);
    const hit = (feed.body || []).find(e => /out of stock/i.test(String(e.title)) && String(e.body).includes(name));
    expect(hit).toBeTruthy();
  });

  it('pushes an expiring-soon alert to the admin feed for a product expiring within the window', async () => {
    const name = 'NotifExp_' + Date.now();
    const in3Days = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const prod = await request(app)
      .post('/api/admin/products')
      .set(auth())
      .send({ name, price: 100, buyingPrice: 60, stock: 20, expiryDate: in3Days, image: [] });
    expect(prod.body.success).toBe(true);

    const since = new Date().toISOString();
    await notifyStaffAlerts();

    const feed = await request(app).get(`/api/notifications/feed?admin=1&since=${encodeURIComponent(since)}`);
    expect(feed.statusCode).toBe(200);
    const hit = (feed.body || []).find(e => /expiring soon/i.test(String(e.title)) && String(e.body).includes(name));
    expect(hit).toBeTruthy();
  });
});
