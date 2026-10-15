const request = require('supertest');

// Route-ordering regressions: a parameter route registered first used to
// swallow the fixed admin routes behind it.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer, REAUTH } = require('./helpers');

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
    const r = await request(app).put('/api/admin/loyalty/settings').set(bearer(ownerToken)).send({ ...before, spinCooldownHours: nextCooldown, ...REAUTH });
    expect(r.body.success).toBe(true);
    const after = (await request(app).get('/api/admin/loyalty/settings').set(bearer(ownerToken))).body;
    expect(after.spinCooldownHours).toBe(nextCooldown);
    // Put it back so other test files see the default 24h window.
    await request(app).put('/api/admin/loyalty/settings').set(bearer(ownerToken)).send({ ...after, spinCooldownHours: 24, ...REAUTH });
  });
});

describe('Old APK links', () => {
  it('a removed APK version redirects to the newest one', async () => {
    const r = await request(app).get('/apk/blitzmall-v3.apk');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^\/apk\/blitzmall-v\d+\.apk$/);
  });
});

describe('PC update feed', () => {
  const RELEASES = 'https://github.com/yrngaffer/blitzmall-backend/releases/latest/download/';

  it('redirects update files to the newest GitHub release asset', async () => {
    for (const file of ['latest.yml', 'BlitzMall-Setup-0.1.53.exe', 'BlitzMall-Setup-0.1.53.exe.blockmap']) {
      const r = await request(app).get(`/api/pc-update/${file}`);
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(RELEASES + file);
    }
  });

  it('follows PC_RELEASES_REPO and ignores a malformed value', async () => {
    const prev = process.env.PC_RELEASES_REPO;
    try {
      process.env.PC_RELEASES_REPO = 'someone/new-repo';
      let r = await request(app).get('/api/pc-update/latest.yml');
      expect(r.headers.location).toBe('https://github.com/someone/new-repo/releases/latest/download/latest.yml');
      process.env.PC_RELEASES_REPO = 'evil.com/x/y';
      r = await request(app).get('/api/pc-update/latest.yml');
      expect(r.headers.location).toBe(RELEASES + 'latest.yml');
    } finally {
      if (prev === undefined) delete process.env.PC_RELEASES_REPO;
      else process.env.PC_RELEASES_REPO = prev;
    }
  });

  it('refuses anything that is not an update file', async () => {
    for (const file of ['index.html', 'secrets.json', 'latest.yml.exe.txt']) {
      const r = await request(app).get(`/api/pc-update/${file}`);
      expect(r.statusCode).toBe(404);
    }
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
    await request(app).post('/api/admin/users').set(bearer(ownerToken)).send({ username, password: 'oldpass1', role: 'cashier', permissions: ['sales'], ...REAUTH });
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
