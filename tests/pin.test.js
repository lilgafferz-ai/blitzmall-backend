const request = require('supertest');

// Configure env BEFORE importing the server so connectDb() targets a dedicated
// test database (never the real shop DB). In CI there is no local MongoDB, so
// the server falls back to its offline mock mode — the assertions pass either way.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');
const { getOwnerToken, bearer, REAUTH } = require('./helpers');

beforeAll(async () => { await connectDb(); });
afterAll(async () => { if (client) await client.close(); });

// Unique 10-digit Kenyan-style numbers so parallel/CI/repeat runs never collide.
let seq = 0;
const newPhone = () => '07' + String(Date.now() + (seq += 37) * 7919 + Math.floor(Math.random() * 1e8)).slice(-8);

const enroll = (phone, over = {}) => request(app).post('/api/auth/enroll').send({
  phone, name: 'Test Shopper', pin: '1234', securityQuestion: 'Favourite colour?', securityAnswer: 'blue', ...over
});
const login = (phone, pin) => request(app).post('/api/auth/login').send({ phone, pin });

describe('phone + PIN sign-up (enroll)', () => {
  it('creates an account, issues a token and a random referral code', async () => {
    const phone = newPhone();
    const res = await enroll(phone);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.customerId).toBe(phone);
    expect(res.body.referralCode).toMatch(/^BM[A-Z0-9]{6}$/);
    const me = await request(app).get('/api/auth/me').set(bearer(res.body.token));
    expect(me.statusCode).toBe(200);
    expect(me.body.customerId).toBe(phone);
  });

  it('rejects a PIN that is not 4–6 digits', async () => {
    expect((await enroll(newPhone(), { pin: '12' })).statusCode).toBe(400);
    expect((await enroll(newPhone(), { pin: '1234567' })).statusCode).toBe(400);
    expect((await enroll(newPhone(), { pin: 'abcd' })).statusCode).toBe(400);
  });

  it('requires a security question and answer', async () => {
    expect((await enroll(newPhone(), { securityQuestion: '' })).statusCode).toBe(400);
    expect((await enroll(newPhone(), { securityAnswer: '   ' })).statusCode).toBe(400);
  });

  it('refuses to overwrite a PIN that already exists (no silent takeover)', async () => {
    const phone = newPhone();
    await enroll(phone);
    const again = await enroll(phone, { pin: '9999' });
    expect(again.statusCode).toBe(409);
    expect(again.body.hasPin).toBe(true);
    // The original PIN still works; the attempted new one does not.
    expect((await login(phone, '1234')).statusCode).toBe(200);
    expect((await login(phone, '9999')).statusCode).toBe(401);
  });

  it('never returns a PIN or answer hash to the client', async () => {
    const res = await enroll(newPhone());
    expect(res.body.pinHash).toBeUndefined();
    expect(res.body.securityAnswerHash).toBeUndefined();
  });

  it('pays NO referral bonus at sign-up (farm-proof — credited on first order)', async () => {
    const ref = await enroll(newPhone());               // referrer
    const res = await enroll(newPhone(), { referralCode: ref.body.referralCode });
    expect(res.statusCode).toBe(200);
    expect(res.body.referralBonus || 0).toBe(0);         // no instant wallet-mintable payout
  });
});

describe('phone + PIN sign-in (login)', () => {
  it('signs in with the correct PIN', async () => {
    const phone = newPhone();
    await enroll(phone);
    const res = await login(phone, '1234');
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.customerId).toBe(phone);
  });

  it('rejects a wrong PIN and counts down the remaining tries', async () => {
    const phone = newPhone();
    await enroll(phone);
    const res = await login(phone, '0000');
    expect(res.statusCode).toBe(401);
    expect(res.body.attemptsLeft).toBe(4);
  });

  it('a number with no PIN is told to enroll', async () => {
    const res = await login(newPhone(), '1234');
    expect(res.statusCode).toBe(404);
    expect(res.body.needsEnroll).toBe(true);
  });

  it('locks the account after 5 wrong PINs — even a correct PIN is then refused', async () => {
    const phone = newPhone();
    await enroll(phone);
    let last;
    for (let i = 0; i < 5; i++) last = await login(phone, '0000');
    expect(last.statusCode).toBe(429);
    expect(last.body.locked).toBe(true);
    const correctWhileLocked = await login(phone, '1234');
    expect(correctWhileLocked.statusCode).toBe(429);
    expect(correctWhileLocked.body.locked).toBe(true);
  });
});

describe('forgot PIN → security-question recovery', () => {
  it('returns the security question, then resets the PIN with the right answer', async () => {
    const phone = newPhone();
    const first = await enroll(phone);
    const q = await request(app).post('/api/auth/recover').send({ phone });
    expect(q.statusCode).toBe(200);
    expect(q.body.securityQuestion).toBe('Favourite colour?');
    // Answer matches case/space-insensitively.
    const reset = await request(app).post('/api/auth/reset').send({ phone, securityAnswer: '  BLUE ', newPin: '5678' });
    expect(reset.statusCode).toBe(200);
    expect(reset.body.token).toBeTruthy();
    // New PIN works, old PIN does not.
    expect((await login(phone, '5678')).statusCode).toBe(200);
    expect((await login(phone, '1234')).statusCode).toBe(401);
    // The reset bumped tokenVersion, so the pre-reset session is dead.
    const old = await request(app).get('/api/auth/me').set(bearer(first.body.token));
    expect(old.statusCode).toBe(401);
  });

  it('rejects a wrong security answer', async () => {
    const phone = newPhone();
    await enroll(phone);
    const reset = await request(app).post('/api/auth/reset').send({ phone, securityAnswer: 'green', newPin: '5678' });
    expect(reset.statusCode).toBe(401);
    expect((await login(phone, '1234')).statusCode).toBe(200); // original PIN unchanged
  });
});

describe('session controls', () => {
  it('"sign out of all devices" kills every existing token', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone);
    const auth = bearer(body.token);
    expect((await request(app).get('/api/auth/me').set(auth)).statusCode).toBe(200);
    expect((await request(app).post('/api/auth/logout-all').set(auth)).statusCode).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth)).statusCode).toBe(401);
  });

  it('change-pin requires the current PIN, rotates the token, and swaps the PIN', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone);
    const oldAuth = bearer(body.token);
    // Missing / wrong current PIN is refused — a stolen token alone can't take over.
    expect((await request(app).post('/api/auth/change-pin').set(oldAuth).send({ newPin: '246810' })).statusCode).toBe(401);
    expect((await request(app).post('/api/auth/change-pin').set(oldAuth).send({ currentPin: '0000', newPin: '246810' })).statusCode).toBe(401);
    // Correct current PIN → fresh token issued; old sessions are invalidated.
    const r = await request(app).post('/api/auth/change-pin').set(oldAuth).send({ currentPin: '1234', newPin: '246810' });
    expect(r.statusCode).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect((await request(app).get('/api/auth/me').set(oldAuth)).statusCode).toBe(401); // old token killed
    expect((await request(app).get('/api/auth/me').set(bearer(r.body.token))).statusCode).toBe(200); // fresh token works
    expect((await login(phone, '246810')).statusCode).toBe(200);
    expect((await login(phone, '1234')).statusCode).toBe(401);
  });

  it('change-pin rejects a bad PIN and an unauthenticated caller', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone);
    expect((await request(app).post('/api/auth/change-pin').set(bearer(body.token)).send({ newPin: '12' })).statusCode).toBe(400);
    expect((await request(app).post('/api/auth/change-pin').send({ newPin: '4321' })).statusCode).toBe(401);
  });

  it('/api/auth/check reports whether a number has an account / PIN', async () => {
    const phone = newPhone();
    const before = await request(app).post('/api/auth/check').send({ phone });
    expect(before.body.exists).toBe(false);
    expect(before.body.hasPin).toBe(false);
    await enroll(phone);
    const after = await request(app).post('/api/auth/check').send({ phone });
    expect(after.body.exists).toBe(true);
    expect(after.body.hasPin).toBe(true);
    expect(after.body.hasRecovery).toBe(true);
    expect(after.body.name).toBeUndefined(); // never leak the name unauthenticated
  });
});

describe('admin Customers dashboard (owner-only)', () => {
  it('lists customers with money/points but never a PIN hash, and is owner-gated', async () => {
    const phone = newPhone();
    await enroll(phone);
    // No token → rejected.
    expect((await request(app).get('/api/admin/customers')).statusCode).toBe(401);
    const token = await getOwnerToken(request, app);
    const list = await request(app).get('/api/admin/customers').set(bearer(token));
    expect(list.statusCode).toBe(200);
    const row = list.body.customers.find(c => c.phone === phone);
    expect(row).toBeTruthy();
    expect(row.hasPin).toBe(true);
    expect(row.pinHash).toBeUndefined();
    expect(row.securityAnswerHash).toBeUndefined();
  });

  it('shows one customer in detail (question yes, answer/PIN never)', async () => {
    const phone = newPhone();
    await enroll(phone);
    const token = await getOwnerToken(request, app);
    const res = await request(app).get('/api/admin/customers/' + phone).set(bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.security.hasPin).toBe(true);
    expect(res.body.security.securityQuestion).toBe('Favourite colour?');
    expect(JSON.stringify(res.body)).not.toContain('pinHash');
    expect(JSON.stringify(res.body)).not.toContain('securityAnswerHash');
    expect(Array.isArray(res.body.aiChats)).toBe(true);
  });

  it('resets a customer PIN: clears it, logs them out; recovery is via the security question, NOT a re-enroll a stranger could race', async () => {
    const phone = newPhone();
    const { body } = await enroll(phone);
    const token = await getOwnerToken(request, app);
    const reset = await request(app).post('/api/admin/customers/' + phone + '/reset-pin').set(bearer(token)).send(REAUTH);
    expect(reset.statusCode).toBe(200);
    expect(reset.body.success).toBe(true);
    // Old session is dead and the old PIN no longer logs in.
    expect((await request(app).get('/api/auth/me').set(bearer(body.token))).statusCode).toBe(401);
    expect((await login(phone, '1234')).body.needsEnroll).toBe(true);
    // The account still has recovery set, so a stranger CANNOT re-enroll to claim it.
    const claim = await enroll(phone, { pin: '4321', securityAnswer: 'red' });
    expect(claim.statusCode).toBe(409);
    expect(claim.body.needsRecovery).toBe(true);
    // The real owner answers their security question and sets a new PIN (money/points untouched).
    const recovered = await request(app).post('/api/auth/reset').send({ phone, securityAnswer: 'blue', newPin: '4321' });
    expect(recovered.statusCode).toBe(200);
    expect((await login(phone, '4321')).statusCode).toBe(200);
  });
});
