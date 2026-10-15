const request = require('supertest');

// Owner tools in Admin → Customers: label the owner's own shopping account (with a
// one-time 1,000,000-point boost) and wipe every other customer account.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer } = require('./helpers');

beforeAll(async () => { await connectDb(); });
afterAll(async () => { if (client) await client.close(); });

let seq = 0;
const newPhone = () => '07' + String(Date.now() + (seq += 37) * 7919 + Math.floor(Math.random() * 1e8)).slice(-8);
const enroll = (phone, name = 'Test Shopper') => request(app).post('/api/auth/enroll').send({
  phone, name, pin: '1234', securityQuestion: 'Favourite colour?', securityAnswer: 'blue'
});

describe('owner account (make-owner)', () => {
  it('is owner-staff only', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone);
    expect((await request(app).post(`/api/admin/customers/${phone}/make-owner`)).statusCode).toBe(401);
    // A customer token is not a staff token.
    expect((await request(app).post(`/api/admin/customers/${phone}/make-owner`).set(bearer(body.token))).statusCode).toBe(401);
  });

  it('labels the account Owner and pays the 1,000,000-point boost exactly once (→ Platinum)', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone, 'RedMan');
    const token = await getOwnerToken(request, app);
    const r = await request(app).post(`/api/admin/customers/${phone}/make-owner`).set(bearer(token));
    expect(r.statusCode).toBe(200);
    expect(r.body.boosted).toBe(true);
    expect(r.body.points).toBe(1000000);
    expect(r.body.tier).toBe('Platinum');
    // Clicking again does not stack another million.
    const again = await request(app).post(`/api/admin/customers/${phone}/make-owner`).set(bearer(token));
    expect(again.body.boosted).toBe(false);
    expect(again.body.points).toBe(1000000);
    // The customer app sees the label and the points.
    const prof = await request(app).get('/api/customers/' + phone).set(bearer(body.token));
    expect(prof.body.isOwner).toBe(true);
    expect(prof.body.loyaltyPoints).toBe(1000000);
    expect(prof.body.tier).toBe('Platinum');
    // Admin list shows it, first.
    const list = await request(app).get('/api/admin/customers').set(bearer(token));
    expect(list.body.customers[0].phone).toBe(phone);
    expect(list.body.customers[0].isOwner).toBe(true);
  });

  it('404s for a number with no account', async () => {
    const token = await getOwnerToken(request, app);
    expect((await request(app).post(`/api/admin/customers/${newPhone()}/make-owner`).set(bearer(token))).statusCode).toBe(404);
  });
});

describe('delete one customer', () => {
  it('deletes even the owner-labelled account, so the number can sign up fresh', async () => {
    const token = await getOwnerToken(request, app);
    const phone = newPhone();
    const session = (await enroll(phone, 'Mark')).body.token;
    await request(app).post(`/api/admin/customers/${phone}/make-owner`).set(bearer(token));
    // Funded account with no way back in: enroll refuses.
    await request(app).post('/api/admin/customers/' + phone + '/reset-pin').set(bearer(token));
    expect((await request(app).post(`/api/admin/customers/${phone}/delete`)).statusCode).toBe(401);

    const del = await request(app).post(`/api/admin/customers/${phone}/delete`).set(bearer(token));
    expect(del.statusCode).toBe(200);
    expect(del.body.deleted.customers).toBe(1);
    expect(del.body.deleted.loyalty).toBe(1);
    expect((await request(app).get('/api/auth/me').set(bearer(session))).statusCode).toBe(401);
    expect((await request(app).get('/api/admin/customers/' + phone).set(bearer(token))).statusCode).toBe(404);

    const fresh = await enroll(phone, 'RedMan');
    expect(fresh.statusCode).toBe(200);
    const again = await request(app).post(`/api/admin/customers/${phone}/make-owner`).set(bearer(token));
    expect(again.body.boosted).toBe(true);
    expect(again.body.points).toBe(1000000);
  });

  it('404s for an unknown number', async () => {
    const token = await getOwnerToken(request, app);
    expect((await request(app).post(`/api/admin/customers/${newPhone()}/delete`).set(bearer(token))).statusCode).toBe(404);
  });
});

describe('delete all customers (wipe)', () => {
  it('previews, refuses without the phrase, then wipes everyone except the owner account', async () => {
    const token = await getOwnerToken(request, app);
    const owner = newPhone();
    const ownerSession = (await enroll(owner, 'RedMan')).body.token;
    await request(app).post(`/api/admin/customers/${owner}/make-owner`).set(bearer(token));
    const shopper = newPhone();
    const shopperSession = (await enroll(shopper)).body.token;
    await request(app).post('/api/admin/loyalty/manual-points').set(bearer(token)).send({ phone: shopper, points: 50, reason: 'test' });

    expect((await request(app).post('/api/admin/customers/wipe').send({ dryRun: true })).statusCode).toBe(401);

    const preview = await request(app).post('/api/admin/customers/wipe').set(bearer(token)).send({ dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.counts.customers).toBeGreaterThanOrEqual(1);
    expect(preview.body.keptOwnerAccounts).toBe(1);
    // Dry run deleted nothing.
    expect((await request(app).get('/api/auth/me').set(bearer(shopperSession))).statusCode).toBe(200);

    expect((await request(app).post('/api/admin/customers/wipe').set(bearer(token)).send({ confirm: 'yes' })).statusCode).toBe(400);

    const wipe = await request(app).post('/api/admin/customers/wipe').set(bearer(token)).send({ confirm: 'DELETE ALL CUSTOMERS' });
    expect(wipe.statusCode).toBe(200);
    expect(wipe.body.deleted.customers).toBeGreaterThanOrEqual(1);
    expect(wipe.body.wipeId).toMatch(/^wipe-/);

    const list = await request(app).get('/api/admin/customers').set(bearer(token));
    expect(list.body.customers.map(c => c.phone)).toEqual([owner]);
    // The shopper's session is gone; the owner's account, points and session survive.
    expect((await request(app).get('/api/auth/me').set(bearer(shopperSession))).statusCode).toBe(401);
    expect((await request(app).get('/api/admin/loyalty/' + shopper).set(bearer(token))).body.points || 0).toBe(0);
    const prof = await request(app).get('/api/customers/' + owner).set(bearer(ownerSession));
    expect(prof.statusCode).toBe(200);
    expect(prof.body.loyaltyPoints).toBe(1000000);
    // The wiped shopper's number can sign up fresh.
    expect((await enroll(shopper)).statusCode).toBe(200);
  });
});
