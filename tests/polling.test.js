const request = require('supertest');

// Set env BEFORE requiring the server (see auth.test.js for details).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer } = require('./helpers');

let token;
beforeAll(async () => {
  await connectDb();
  token = await getOwnerToken(request, app);
});
afterAll(async () => { if (client) await client.close(); });

// HQ polls the order list every 15 s and refreshes products after every sale;
// unchanged lists must cost a 304, not the whole payload again.
describe('Cheap polling for the HQ till', () => {
  it('answers an unchanged order list with 304 when the client sends its ETag', async () => {
    const first = await request(app).get('/api/admin/orders').set(bearer(token));
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    const again = await request(app).get('/api/admin/orders').set(bearer(token)).set('If-None-Match', etag);
    expect(again.statusCode).toBe(304);
    expect(again.text || '').toBe('');
    const stale = await request(app).get('/api/admin/orders').set(bearer(token)).set('If-None-Match', '"something-else"');
    expect(stale.statusCode).toBe(200);
    expect(Array.isArray(stale.body)).toBe(true);
  });

  it('lets the app read the ETag header cross-origin (PC app = file:// origin)', async () => {
    const r = await request(app).get('/api/admin/orders').set(bearer(token)).set('Origin', 'null');
    expect(String(r.headers['access-control-expose-headers'] || '')).toMatch(/ETag/i);
  });

  it('serves ?lite=1 products without photos, with the same photo fingerprints', async () => {
    const created = await request(app).post('/api/admin/products').set(bearer(token)).send({
      name: 'Lite Poll Test ' + Date.now(), category: 'Other', price: 55, buyingPrice: 30, stock: 9,
      barcode: 'LITE' + Date.now(), image: 'data:image/png;base64,iVBORw0KGgo='
    });
    expect(created.statusCode).toBeLessThan(300);
    const full = await request(app).get('/api/admin/products').set(bearer(token));
    const lite = await request(app).get('/api/admin/products?lite=1').set(bearer(token));
    expect(lite.statusCode).toBe(200);
    expect(lite.body.length).toBe(full.body.length);
    expect(lite.body.every(p => p.image === undefined)).toBe(true);
    const withPhoto = full.body.find(p => p.image && p.image.length);
    expect(withPhoto).toBeTruthy();
    expect(withPhoto.imageTag).toBeTruthy();
    expect(lite.body.find(p => String(p._id) === String(withPhoto._id)).imageTag).toBe(withPhoto.imageTag);
    expect(lite.text.length).toBeLessThan(full.text.length);
  });
});
