const request = require('supertest');

// Configure env BEFORE importing the server so connectDb() targets a
// dedicated test database (never the real shop DB). In CI there is no local
// MongoDB, so the server falls back to its offline mock mode — the assertions
// below pass either way. No SMS gateway is configured in tests, so the server
// runs in dev mode and echoes the OTP back (devOtp) for the flow to complete.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

// Unique 10-digit Kenyan-style numbers so parallel/CI/repeat runs never collide.
// Mixes the wall clock, a per-call counter and a large random so phones can
// never collide with another test file's phone created in the SAME millisecond
// (under --runInBand every file shares one clock and one server instance).
let seq = 0;
const newPhone = () => '07' + String(Date.now() + (seq += 37) * 7919 + Math.floor(Math.random() * 1e8)).slice(-8);

const requestOtp = async (phone, name = 'Test Shopper') =>
  request(app).post('/api/auth').send({ name, phone });

const verifyOtp = async (phone, otp, extra = {}) =>
  request(app).post('/api/auth/verify-otp').send({ phone, otp, name: 'Test Shopper', ...extra });

describe('OTP phone verification (first-time sign-in)', () => {
  it('requires an OTP for a first-time number and does NOT create an account yet', async () => {
    const phone = newPhone();
    const res = await requestOtp(phone);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.otpRequired).toBe(true);
    expect(res.body.devOtp).toMatch(/^\d{6}$/);
    // No account until the code is verified — signing in again still asks for OTP.
    const again = await requestOtp(phone);
    expect(again.body.otpRequired).toBe(true);
  });

  it('enforces a resend cooldown between OTP requests', async () => {
    const phone = newPhone();
    await requestOtp(phone);
    const res = await requestOtp(phone); // immediate second request
    expect(res.statusCode).toBe(429);
    expect(res.body.otpRequired).toBe(true);
    expect(res.body.resendAfter).toBeGreaterThan(0);
  });

  it('rejects a wrong code and accepts the right one afterwards', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    const wrong = await verifyOtp(phone, '000000');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body.error).toMatch(/incorrect/i);
    const ok = await verifyOtp(phone, body.devOtp);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.customerId).toBe(phone);
  });

  it('burns the OTP after a successful verification (single use)', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    await verifyOtp(phone, body.devOtp);
    const replay = await verifyOtp(phone, body.devOtp);
    expect(replay.statusCode).toBe(400);
    expect(replay.body.error).toMatch(/no pending code/i);
  });

  it('rejects verification when no code was requested', async () => {
    const res = await verifyOtp(newPhone(), '123456');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no pending code/i);
  });

  it('lets a verified customer sign straight back in without OTP (returning)', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    await verifyOtp(phone, body.devOtp);
    const again = await requestOtp(phone, 'Test Shopper');
    expect(again.body.success).toBe(true);
    expect(again.body.returning).toBe(true);
    expect(again.body.otpRequired).toBeFalsy();
  });

  it('awards the referral bonus only after OTP verification', async () => {
    // Referrer: a verified first-time account.
    const referrerPhone = newPhone();
    const refReq = await requestOtp(referrerPhone, 'Referrer');
    await verifyOtp(referrerPhone, refReq.body.devOtp);

    // New shopper signs in with the referrer's phone as the referral code.
    const shopperPhone = newPhone();
    const otpRes = await requestOtp(shopperPhone, 'Referee');
    expect(otpRes.body.otpRequired).toBe(true);

    // Before verification the account must not exist — a direct sign-in for the
    // same new number is still OTP-gated (nothing was pre-created).
    const pre = await requestOtp(shopperPhone, 'Referee');
    expect(pre.body.success).toBe(false);

    const ok = await verifyOtp(shopperPhone, otpRes.body.devOtp, { referralCode: referrerPhone });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.referralBonus).toBeGreaterThan(0);
  });

  it('expires a stale OTP and requires a fresh request', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    // Force-expire the entry (test hook) — a real code only lives 10 minutes.
    const entry = _test.otpStore.get(phone);
    expect(entry).toBeTruthy();
    entry.expiresAt = Date.now() - 1;
    const stale = await verifyOtp(phone, body.devOtp);
    expect(stale.statusCode).toBe(400);
    expect(stale.body.error).toMatch(/expired/i);

    // A fresh request issues a new working code.
    const fresh = await requestOtp(phone);
    const ok = await verifyOtp(phone, fresh.body.devOtp);
    expect(ok.body.success).toBe(true);
  });
});
