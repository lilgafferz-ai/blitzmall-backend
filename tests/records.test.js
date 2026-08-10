const request = require('supertest');

// Regression test for the 🗑️ Delete Records tool (owner only). The counts
// endpoint must report how many documents each collection really holds, and
// the delete endpoint must actually wipe the selected types. A past bug
// captured the collection variables before connectDb() assigned them, so every
// count silently came back 0 and every delete no-op'd.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MOCK_DB = '1';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken } = require('./helpers');

const SEED_PRODUCTS = 3;
const SEED_SALES = 2;

beforeAll(async () => {
  await connectDb();
  const db = _test.mockDb();
  await db.collection('products').deleteMany({});
  await db.collection('sales').deleteMany({});
});

afterAll(async () => {
  // Leave no trace for other suites, whatever happened in this one.
  const db = _test.mockDb();
  await db.collection('products').deleteMany({});
  await db.collection('sales').deleteMany({});
  delete process.env.MOCK_DB;
  if (client) await client.close();
});

describe('Delete Records (owner wipe tool)', () => {
  it('counts every record type and deletes the selected ones', async () => {
    const db = _test.mockDb();
    for (let i = 0; i < SEED_PRODUCTS; i++) {
      await db.collection('products').insertOne({ name: 'Wipe Test Product ' + i, price: 100 + i, stock: 5, category: 'Test' });
    }
    for (let i = 0; i < SEED_SALES; i++) {
      await db.collection('sales').insertOne({ items: [], total: 50, method: 'cash', createdAt: new Date() });
    }

    const token = await getOwnerToken(request, app);
    expect(token).toBeTruthy();

    // 1) Counts reflect what is really in the DB (not 0s)
    const countsRes = await request(app).get('/api/admin/records/counts').set('Authorization', 'Bearer ' + token);
    expect(countsRes.statusCode).toBe(200);
    expect(countsRes.body.success).toBe(true);
    expect(countsRes.body.counts.products).toBe(SEED_PRODUCTS);
    expect(countsRes.body.counts.sales).toBe(SEED_SALES);
    // Every known record type is reported (>= 0)
    for (const key of ['orders', 'expenses', 'credit', 'reviews', 'coupons', 'customers', 'banners', 'loyalty', 'promo_claims', 'saved_baskets', 'stock_transfers', 'shifts', 'audit_logs']) {
      expect(typeof countsRes.body.counts[key]).toBe('number');
    }

    // 2) Deleting selected types actually removes their records
    const delRes = await request(app).delete('/api/admin/records').set('Authorization', 'Bearer ' + token).send({ types: ['products', 'sales'] });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.success).toBe(true);
    expect(delRes.body.deleted).toBe(SEED_PRODUCTS + SEED_SALES);
    expect(delRes.body.types.slice().sort()).toEqual(['products', 'sales']);

    // 3) Counts drop to zero afterwards
    const afterRes = await request(app).get('/api/admin/records/counts').set('Authorization', 'Bearer ' + token);
    expect(afterRes.body.counts.products).toBe(0);
    expect(afterRes.body.counts.sales).toBe(0);
  });
});
