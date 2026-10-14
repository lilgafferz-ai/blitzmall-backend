const request = require('supertest');

// Set env BEFORE requiring the server (see auth.test.js for details).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer } = require('./helpers');

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

describe('Products API', () => {
  it('should fetch products successfully', async () => {
    const res = await request(app).get('/api/products');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('never exposes cost prices or internal alert markers to shoppers', async () => {
    const token = await getOwnerToken(request, app);
    const name = 'PRIV-Cost Check ' + Date.now();
    const created = await request(app).post('/api/admin/products').set(bearer(token))
      .send({ name, price: 250, buyingPrice: 180, stock: 0, image: [] });
    expect(created.body.success).toBe(true);

    const pub = await request(app).get('/api/products');
    const mine = pub.body.find(p => p.name === name);
    expect(mine).toBeTruthy();
    expect(mine.price).toBe(250);
    for (const p of pub.body) {
      expect(p).not.toHaveProperty('buyingPrice');
      expect(p).not.toHaveProperty('alertedOutAt');
    }

    // Staff still see the cost price.
    const admin = await request(app).get('/api/admin/products').set(bearer(token));
    expect(admin.body.find(p => p.name === name).buyingPrice).toBe(180);
  });
});
