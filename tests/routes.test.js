const request = require('supertest');

// Route-ordering regressions: a parameter route registered first used to
// swallow the fixed admin routes behind it.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer } = require('./helpers');

let ownerToken = null;

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});

afterAll(async () => {
  if (client) await client.close();
});

describe('Loyalty Controls routes are reachable', () => {
  it('GET /api/admin/loyalty/settings returns the settings (not a phone lookup for "settings")', async () => {
    const r = await request(app).get('/api/admin/loyalty/settings').set(bearer(ownerToken));
    expect(r.statusCode).toBe(200);
    expect(r.body.earnRate).toBeGreaterThan(0);
    expect(Array.isArray(r.body.redeemTiers)).toBe(true);
  });

  it('GET /api/admin/loyalty/stats returns the economics', async () => {
    const r = await request(app).get('/api/admin/loyalty/stats').set(bearer(ownerToken));
    expect(r.statusCode).toBe(200);
    expect(typeof r.body.memberCount).toBe('number');
  });

  it('PUT /api/admin/loyalty/settings actually saves', async () => {
    const before = (await request(app).get('/api/admin/loyalty/settings').set(bearer(ownerToken))).body;
    const nextCooldown = before.spinCooldownHours === 24 ? 25 : 24;
    const r = await request(app).put('/api/admin/loyalty/settings').set(bearer(ownerToken)).send({ ...before, spinCooldownHours: nextCooldown });
    expect(r.body.success).toBe(true);
    const after = (await request(app).get('/api/admin/loyalty/settings').set(bearer(ownerToken))).body;
    expect(after.spinCooldownHours).toBe(nextCooldown);
    // Put it back so other test files see the default 24h window.
    await request(app).put('/api/admin/loyalty/settings').set(bearer(ownerToken)).send({ ...after, spinCooldownHours: 24 });
  });
});

describe('Old APK links', () => {
  it('a removed APK version redirects to the newest one', async () => {
    const r = await request(app).get('/apk/blitzmall-v3.apk');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^\/apk\/blitzmall-v\d+\.apk$/);
  });
});

describe('Settings endpoints', () => {
  it('/api/shop-info returns the shop contact and coordinates', async () => {
    const r = await request(app).get('/api/shop-info');
    expect(r.statusCode).toBe(200);
    expect(r.body.name).toBeTruthy();
    expect(r.body.coords).toEqual(expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) }));
  });

  it('staff can change their own password; old sessions end, the new token works', async () => {
    const username = 'settings_staff_' + Date.now();
    await request(app).post('/api/admin/users').set(bearer(ownerToken)).send({ username, password: 'oldpass1', role: 'cashier', permissions: ['sales'] });
    const login = await request(app).post('/api/admin/login').send({ username, password: 'oldpass1' });
    const oldToken = login.body.token;
    const wrong = await request(app).post('/api/admin/me/password').set(bearer(oldToken)).send({ currentPassword: 'nope', newPassword: 'newpass1' });
    expect(wrong.statusCode).toBe(400);
    const ok = await request(app).post('/api/admin/me/password').set(bearer(oldToken)).send({ currentPassword: 'oldpass1', newPassword: 'newpass1' });
    expect(ok.body.success).toBe(true);
    expect((await request(app).get('/api/admin/me').set(bearer(oldToken))).statusCode).toBe(401);
    expect((await request(app).get('/api/admin/me').set(bearer(ok.body.token))).statusCode).toBe(200);
    expect((await request(app).post('/api/admin/login').send({ username, password: 'newpass1' })).body.token).toBeTruthy();

    // Sign out everywhere ends the new session too.
    await request(app).post('/api/admin/me/logout-all').set(bearer(ok.body.token));
    expect((await request(app).get('/api/admin/me').set(bearer(ok.body.token))).statusCode).toBe(401);
  });
});
