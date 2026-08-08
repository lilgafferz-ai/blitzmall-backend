const request = require('supertest');

// Direct coverage for the offline FileCollection mock — the DB layer CI runs
// against. The notification feed queries { $or: [{ phone }, { audience: 'all' }] },
// and the mock previously treated $or as a literal key (matching nothing),
// which failed the backend suite in CI. This test guards that behaviour.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MOCK_DB = '1'; // force the offline mock — no real MongoDB needed
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');

beforeAll(async () => {
  await connectDb();
  // Start each run from a clean slate so leftover docs from a previous run
  // (the mock persists to local_db_fallback.json) can never affect results.
  await _test.mockDb().collection('mockdb_test').deleteMany({});
});

afterAll(async () => {
  delete process.env.MOCK_DB; // never leak mock mode into other test files
  if (client) await client.close();
});

describe('Offline FileCollection mock', () => {
  const coll = () => _test.mockDb().collection('mockdb_test');

  it('supports $or queries (own feed + broadcasts, never someone else\'s)', async () => {
    const c = coll();
    await c.insertOne({ phone: '7000000001', audience: 'customer', title: 'mine', createdAt: new Date() });
    await c.insertOne({ phone: null, audience: 'all', title: 'broadcast', createdAt: new Date() });
    await c.insertOne({ phone: '7000000002', audience: 'customer', title: 'other', createdAt: new Date() });

    const feed = await c
      .find({ createdAt: { $gt: new Date(0) }, $or: [{ phone: '7000000001' }, { audience: 'all' }] })
      .toArray();
    const titles = feed.map(d => d.title).sort();
    expect(titles).toEqual(['broadcast', 'mine']);
  });

  it('$or matches nothing when no branch matches', async () => {
    const c = coll();
    const none = await c
      .find({ $or: [{ phone: '9999999999' }, { audience: 'nobody' }] })
      .toArray();
    expect(none).toEqual([]);
  });

  it('$or ANDs with sibling equality fields (Mongo semantics)', async () => {
    const c = coll();
    const both = await c
      .find({ title: 'mine', $or: [{ phone: '7000000001' }, { phone: '7000000002' }] })
      .toArray();
    expect(both.map(d => d.phone)).toEqual(['7000000001']);
  });
});

// Keep the feed flow covered end-to-end via the API too: the GET
// /api/notifications/feed route builds the same $or query the transport-fee
// notification relies on, so a customer must see their own events and
// broadcasts — but never someone else's.
describe('Notification feed via API ($or path)', () => {
  it('a customer sees only their own feed events plus broadcasts', async () => {
    const feedCol = _test.mockDb().collection('notifications_feed');
    await feedCol.insertOne({ phone: '7000000001', audience: 'customer', title: 'mine', body: 'x', createdAt: new Date() });
    await feedCol.insertOne({ phone: '7000000002', audience: 'customer', title: 'other', body: 'x', createdAt: new Date() });

    const feed = await request(app).get('/api/notifications/feed?phone=7000000001');
    expect(feed.statusCode).toBe(200);
    const titles = feed.body.map(n => n.title || '');
    expect(titles).toContain('mine'); // own event visible
    expect(titles).not.toContain('other'); // someone else's never leaks in
  });
});
