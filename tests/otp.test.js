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
    // No SMS gateway in tests, so the server must flag the failed delivery
    // (which is what makes the app show the code on screen) and hand back the
    // short resend window instead of stranding the customer.
    expect(res.body.smsDelivered).toBe(false);
    expect(res.body.resendAfter).toBeLessThanOrEqual(30);
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

  it('issues a customer session token only after the code is verified', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    expect(body.token).toBeUndefined(); // requesting a code never signs you in
    const ok = await verifyOtp(phone, body.devOtp);
    expect(ok.body.token).toBeTruthy();
    const me = await request(app).get('/api/auth/me').set({ Authorization: 'Bearer ' + ok.body.token });
    expect(me.statusCode).toBe(200);
    expect(me.body.customerId).toBe(phone);
  });

  it('a RETURNING number must verify a fresh code too — a phone number alone never signs in', async () => {
    const phone = newPhone();
    const first = await requestOtp(phone);
    await verifyOtp(phone, first.body.devOtp);
    // Skip the 30s resend cooldown (test hook) and sign in again as if on a new device.
    _test.otpStore.get(phone).lastSentAt = 0;
    const again = await requestOtp(phone, 'Test Shopper');
    expect(again.body.success).toBe(false);
    expect(again.body.otpRequired).toBe(true);
    expect(again.body.returning).toBe(true);
    expect(again.body.token).toBeUndefined();
    const wrong = await verifyOtp(phone, again.body.devOtp === '111111' ? '222222' : '111111');
    expect(wrong.statusCode).toBe(400);
    const ok = await verifyOtp(phone, again.body.devOtp);
    expect(ok.body.success).toBe(true);
    expect(ok.body.returning).toBe(true);
    expect(ok.body.token).toBeTruthy();
  });

  it('with OTP_SCREEN_FALLBACK=false a failed SMS never reveals the code', async () => {
    process.env.OTP_SCREEN_FALLBACK = 'false';
    try {
      const res = await requestOtp(newPhone());
      expect(res.statusCode).toBe(503);
      expect(res.body.devOtp).toBeUndefined();
      expect(res.body.otpRequired).toBeFalsy();
    } finally {
      delete process.env.OTP_SCREEN_FALLBACK;
    }
  });

  it('"sign out of all devices" kills every existing session token', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    const { body: v } = await verifyOtp(phone, body.devOtp);
    const auth = { Authorization: 'Bearer ' + v.token };
    expect((await request(app).get('/api/auth/me').set(auth)).statusCode).toBe(200);
    expect((await request(app).post('/api/auth/logout-all').set(auth)).statusCode).toBe(200);
    const after = await request(app).get('/api/auth/me').set(auth);
    expect(after.statusCode).toBe(401);
    expect(after.body.authRequired).toBe(true);
  });

  it('gives every account a random referral code (never the phone number)', async () => {
    const phone = newPhone();
    const { body } = await requestOtp(phone);
    const { body: v } = await verifyOtp(phone, body.devOtp);
    expect(v.referralCode).toMatch(/^BM[A-Z0-9]{6}$/);
    expect(v.referralCode).not.toContain(phone);
  });

  it('credits a referral made with the new random code', async () => {
    const referrerPhone = newPhone();
    const refReq = await requestOtp(referrerPhone, 'Referrer');
    const { body: ref } = await verifyOtp(referrerPhone, refReq.body.devOtp);
    const shopperPhone = newPhone();
    const otpRes = await requestOtp(shopperPhone, 'Referee');
    const ok = await verifyOtp(shopperPhone, otpRes.body.devOtp, { referralCode: ref.referralCode.toLowerCase() });
    expect(ok.body.success).toBe(true);
    expect(ok.body.referralBonus).toBeGreaterThan(0);
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

// Africa's Talking answers HTTP 200/201 even when a message FAILED per
// recipient (statusCode 101 invalid number, 102 insufficient balance, 103
// inactive, 104 sender ID not allowed). Treating HTTP 200 as delivered is what
// stranded first-time customers: no SMS arrived AND the code was never echoed
// to the app, so the code step dead-ended. These pin the parsing.
describe("Africa's Talking delivery detection", () => {
  const originalFetch = global.fetch;
  let savedEnv;

  const atReply = (recipientStatus) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      SMSMessageData: {
        Message: 'Sent to 1/1 Total Cost: KES 0.8000',
        Recipients: [{ statusCode: recipientStatus === 'Success' ? 100 : 102, number: '+254700000000', status: recipientStatus }]
      }
    })
  });

  beforeEach(() => {
    savedEnv = { AT_USERNAME: process.env.AT_USERNAME, AT_API_KEY: process.env.AT_API_KEY };
    process.env.AT_USERNAME = 'blitzmall';
    process.env.AT_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (savedEnv.AT_USERNAME === undefined) delete process.env.AT_USERNAME;
    else process.env.AT_USERNAME = savedEnv.AT_USERNAME;
    if (savedEnv.AT_API_KEY === undefined) delete process.env.AT_API_KEY;
    else process.env.AT_API_KEY = savedEnv.AT_API_KEY;
  });

  it('treats HTTP 200 with a failed recipient as undelivered and echoes the code', async () => {
    global.fetch = jest.fn(async () => atReply('Failed'));
    const res = await requestOtp(newPhone());
    expect(res.statusCode).toBe(200);
    expect(res.body.smsDelivered).toBe(false);
    expect(res.body.devOtp).toMatch(/^\d{6}$/);
    // The gateway must be asked in Africa's Talking's documented +254 format.
    const [, opts] = global.fetch.mock.calls[0];
    expect(new URLSearchParams(opts.body).get('to')).toMatch(/^\+254\d{9}$/);
  });

  it('never echoes the code when the gateway accepts the recipient', async () => {
    global.fetch = jest.fn(async () => atReply('Success'));
    const res = await requestOtp(newPhone());
    expect(res.body.smsDelivered).toBe(true);
    expect(res.body.devOtp).toBeUndefined();
  });
});
