const request = require('supertest');

// Two-step sign-in (TOTP) for owner/managers and step-up re-authentication on
// destructive owner actions. Offline mock DB only (MOCK_DB=1).
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const totp = require('@otplib/totp');
const { crypto: otpCrypto } = require('@otplib/plugin-crypto-node');
const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken, customerToken, bearer, OWNER_PASSWORD, REAUTH } = require('./helpers');
const { decryptSecret } = require('../lib/mfa');

const STAFF_PW = 'staffpass123';
const users = () => _test.mockDb().collection('users');
const auditEntries = async (action) => _test.mockDb().collection('audit_logs').find({ action }).toArray();
let seq = 0;
const freshPhone = () => { seq += 1; return '07' + String((Date.now() + seq * 7919 + Math.floor(Math.random() * 1e8)) % 1e8).padStart(8, '0'); };

// Current code for the account's live (or pending) secret. The server accepts
// each 30-second code once, so tests that need several codes in a row forget
// the last-used step first (a real user would wait for the next code).
const codeFor = async (username, { pending = false, stepOffset = 0 } = {}) => {
  const u = await users().findOne({ username });
  const secret = decryptSecret(pending ? u.mfaPendingSecret : u.mfaSecret);
  return totp.generate({ secret, crypto: otpCrypto, epoch: Math.floor(Date.now() / 1000) + stepOffset * 30 });
};
const freshCode = async (username) => {
  await users().updateOne({ username }, { $unset: { mfaLastStep: '' } });
  return codeFor(username);
};
const wrongCode = async (username, opts = {}) => {
  const valid = new Set(await Promise.all([-1, 0, 1].map(o => codeFor(username, { ...opts, stepOffset: o }))));
  for (let i = 0; ; i++) { const c = String(123456 + i).padStart(6, '0'); if (!valid.has(c)) return c; }
};

let ownerToken;
const owner = () => bearer(ownerToken);
const makeManager = async () => {
  const username = `mfa_mgr_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const c = await request(app).post('/api/admin/users').set(owner())
    .send({ username, password: STAFF_PW, name: 'MFA Manager', role: 'manager', permissions: ['sales', 'orders'], ...REAUTH });
  expect(c.body.success).toBe(true);
  const l = await request(app).post('/api/admin/login').send({ username, password: STAFF_PW });
  expect(l.body.token).toBeTruthy();
  return { username, userId: String(c.body.userId), token: l.body.token };
};
// Full enrolment; returns the new session token and the recovery codes.
const enrol = async (username, token, password = STAFF_PW) => {
  const s = await request(app).post('/api/admin/me/mfa/setup').set(bearer(token)).send({ currentPassword: password });
  expect(s.statusCode).toBe(200);
  const a = await request(app).post('/api/admin/me/mfa/activate').set(bearer(token)).send({ code: await codeFor(username, { pending: true }) });
  expect(a.statusCode).toBe(200);
  return { token: a.body.token, recoveryCodes: a.body.recoveryCodes, setup: s.body };
};
const passwordStep = async (username, password = STAFF_PW) => request(app).post('/api/admin/login').send({ username, password });

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});
afterAll(async () => { if (client) await client.close(); });

describe('Enrolling an authenticator', () => {
  let mgr;
  beforeAll(async () => { mgr = await makeManager(); });

  it('needs the password to start, stores only an encrypted secret, and switches on with the first code', async () => {
    expect((await request(app).get('/api/admin/me/mfa').set(bearer(mgr.token))).body).toMatchObject({ available: true, enabled: false });

    const noPw = await request(app).post('/api/admin/me/mfa/setup').set(bearer(mgr.token)).send({});
    expect(noPw.statusCode).toBe(403);
    expect(noPw.body.reauthRequired).toBe(true);

    const s = await request(app).post('/api/admin/me/mfa/setup').set(bearer(mgr.token)).send({ currentPassword: STAFF_PW });
    expect(s.statusCode).toBe(200);
    expect(s.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/BlitzMall:/);
    expect(s.body.qr).toMatch(/^data:image\/png;base64,/);
    const key = s.body.manualKey.replace(/ /g, '');
    expect(s.body.otpauthUrl).toContain('secret=' + key);

    const stored = await users().findOne({ username: mgr.username });
    expect(stored.mfaEnabled).toBeFalsy();
    expect(JSON.stringify(stored)).not.toContain(key);

    const bad = await request(app).post('/api/admin/me/mfa/activate').set(bearer(mgr.token)).send({ code: await wrongCode(mgr.username, { pending: true }) });
    expect(bad.statusCode).toBe(400);

    const a = await request(app).post('/api/admin/me/mfa/activate').set(bearer(mgr.token)).send({ code: await codeFor(mgr.username, { pending: true }) });
    expect(a.statusCode).toBe(200);
    expect(a.body.recoveryCodes).toHaveLength(10);
    // Sessions that never passed the second step are signed out; this device gets a new one.
    expect((await request(app).get('/api/admin/me').set(bearer(mgr.token))).statusCode).toBe(401);
    const me = await request(app).get('/api/admin/me').set(bearer(a.body.token));
    expect(me.body.user.mfaEnabled).toBe(true);
    mgr.token = a.body.token;

    const after = await users().findOne({ username: mgr.username });
    expect(after.mfaRecoveryCodes).toHaveLength(10);
    for (const c of a.body.recoveryCodes) expect(after.mfaRecoveryCodes).not.toContain(c);
    expect((await auditEntries('mfa_enabled')).some(e => e.details.includes(mgr.username))).toBe(true);
  });

  it('never returns the secret or recovery hashes in the staff list', async () => {
    const list = await request(app).get('/api/admin/users').set(owner());
    const row = list.body.find(u => u.username === mgr.username);
    expect(row.mfaEnabled).toBe(true);
    for (const f of ['password', 'mfaSecret', 'mfaRecoveryCodes', 'mfaLastStep', 'mfaPendingSecret']) expect(row[f]).toBeUndefined();
  });

  it('moving to a new phone needs the current code as well as the password', async () => {
    const r = await request(app).post('/api/admin/me/mfa/setup').set(bearer(mgr.token)).send({ currentPassword: STAFF_PW });
    expect(r.statusCode).toBe(403);
    expect(r.body.mfaRequired).toBe(true);
  });

  it('cashiers cannot enrol', async () => {
    const username = `mfa_cashier_${Date.now()}`;
    await request(app).post('/api/admin/users').set(owner()).send({ username, password: STAFF_PW, role: 'cashier', permissions: ['sales'], ...REAUTH });
    const t = (await passwordStep(username)).body.token;
    expect((await request(app).post('/api/admin/me/mfa/setup').set(bearer(t)).send({ currentPassword: STAFF_PW })).statusCode).toBe(403);
  });
});

describe('Signing in with two-step on', () => {
  let mgr, recoveryCodes;
  beforeAll(async () => {
    mgr = await makeManager();
    ({ recoveryCodes } = await enrol(mgr.username, mgr.token));
  });

  it('a correct password alone gives no session, only a short-lived pending token', async () => {
    const r = await passwordStep(mgr.username);
    expect(r.statusCode).toBe(200);
    expect(r.body.token).toBeUndefined();
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.mfaToken).toBeTruthy();
    // The pending token is not a staff session.
    expect((await request(app).get('/api/admin/me').set(bearer(r.body.mfaToken))).statusCode).toBe(401);
    expect((await request(app).get('/api/admin/sales').set(bearer(r.body.mfaToken))).statusCode).toBe(401);
  });

  it('the code completes sign-in; the same code cannot be replayed', async () => {
    const { mfaToken } = (await passwordStep(mgr.username)).body;
    expect((await request(app).post('/api/admin/login/mfa').send({ mfaToken: 'garbage', code: '123456' })).body.restart).toBe(true);
    const code = await freshCode(mgr.username);
    const ok = await request(app).post('/api/admin/login/mfa').send({ mfaToken, code });
    expect(ok.statusCode).toBe(200);
    expect((await request(app).get('/api/admin/me').set(bearer(ok.body.token))).statusCode).toBe(200);

    const replay = await request(app).post('/api/admin/login/mfa').send({ mfaToken, code });
    expect(replay.statusCode).toBe(401);
    expect(replay.body.token).toBeUndefined();
  });

  it('a recovery code works exactly once', async () => {
    const rc = recoveryCodes[0];
    const first = await request(app).post('/api/admin/login/mfa').send({ mfaToken: (await passwordStep(mgr.username)).body.mfaToken, code: rc.toLowerCase() });
    expect(first.statusCode).toBe(200);
    expect(first.body.token).toBeTruthy();
    expect(first.body.recoveryCodesLeft).toBe(9);
    const again = await request(app).post('/api/admin/login/mfa').send({ mfaToken: (await passwordStep(mgr.username)).body.mfaToken, code: rc });
    expect(again.statusCode).toBe(401);
    expect((await auditEntries('mfa_recovery_code_used')).some(e => e.details.includes(mgr.username))).toBe(true);
    expect((await request(app).get('/api/admin/me/mfa').set(bearer(first.body.token))).body.recoveryCodesLeft).toBe(9);
  });

  it('wrong codes count toward the same 5-try lock as wrong passwords', async () => {
    const victim = await makeManager();
    await enrol(victim.username, victim.token);
    for (let i = 0; i < 2; i++) expect((await passwordStep(victim.username, 'wrong-' + i)).statusCode).toBe(401);
    const { mfaToken } = (await passwordStep(victim.username)).body;
    expect(mfaToken).toBeTruthy();
    const bad = await wrongCode(victim.username);
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/admin/login/mfa').send({ mfaToken, code: bad })).statusCode).toBe(401);
    // Locked now: even the right code, or the right password, is refused.
    const locked = await request(app).post('/api/admin/login/mfa').send({ mfaToken, code: await freshCode(victim.username) });
    expect(locked.statusCode).toBe(429);
    expect((await passwordStep(victim.username)).statusCode).toBe(429);
    expect((await auditEntries('login_mfa_failed')).filter(e => e.details.includes(victim.username))).toHaveLength(3);
    expect((await auditEntries('account_locked')).some(e => e.details.includes(victim.username))).toBe(true);
  });

  it('managers can switch it off (with password + code); the owner can reset a manager who lost their phone', async () => {
    const m = await makeManager();
    const { token } = await enrol(m.username, m.token);
    const off = await request(app).post('/api/admin/me/mfa/disable').set(bearer(token)).send({ currentPassword: STAFF_PW, mfaCode: await freshCode(m.username) });
    expect(off.statusCode).toBe(200);
    expect((await passwordStep(m.username)).body.token).toBeTruthy();
    expect((await auditEntries('mfa_disabled')).some(e => e.details.includes(m.username))).toBe(true);

    const lost = await makeManager();
    await enrol(lost.username, lost.token);
    expect((await request(app).put('/api/admin/users/' + lost.userId).set(owner()).send({ resetMfa: true })).statusCode).toBe(403);
    const reset = await request(app).put('/api/admin/users/' + lost.userId).set(owner()).send({ resetMfa: true, ...REAUTH });
    expect(reset.statusCode).toBe(200);
    expect((await passwordStep(lost.username)).body.token).toBeTruthy();
    expect((await auditEntries('mfa_reset_by_owner')).some(e => e.details.includes(lost.username))).toBe(true);
  });
});

describe('Step-up re-authentication on destructive owner actions', () => {
  let phone, staffId;
  beforeAll(async () => {
    phone = freshPhone();
    await customerToken(request, app, phone, 'Step-up Shopper');
    staffId = (await makeManager()).userId;
  });
  const calls = () => [
    ['POST /api/admin/customers/wipe', (body) => request(app).post('/api/admin/customers/wipe').set(owner()).send({ confirm: 'DELETE ALL CUSTOMERS', ...body })],
    ['POST /api/admin/customers/:phone/delete', (body) => request(app).post(`/api/admin/customers/${phone}/delete`).set(owner()).send(body)],
    ['POST /api/admin/customers/:phone/reset-pin', (body) => request(app).post(`/api/admin/customers/${phone}/reset-pin`).set(owner()).send(body)],
    ['DELETE /api/admin/records', (body) => request(app).delete('/api/admin/records').set(owner()).send({ types: ['expenses'], ...body })],
    ['PUT /api/admin/loyalty/settings', (body) => request(app).put('/api/admin/loyalty/settings').set(owner()).send({ earnRate: 100, ...body })],
    ['POST /api/admin/users', (body) => request(app).post('/api/admin/users').set(owner()).send({ username: 'stepup_' + Date.now(), password: STAFF_PW, role: 'cashier', ...body })],
    ['PUT /api/admin/users/:id', (body) => request(app).put('/api/admin/users/' + staffId).set(owner()).send({ name: 'Renamed', ...body })]
  ];

  it.each(calls().map(([name], i) => [name, i]))('%s is refused without the password', async (name, i) => {
    const r = await calls()[i][1]({});
    expect(r.statusCode).toBe(403);
    expect(r.body.reauthRequired).toBe(true);
  });

  it('nothing happened while refused: the customer still exists and can sign in', async () => {
    const c = await _test.mockDb().collection('customers').findOne({ phone });
    expect(c).toBeTruthy();
    expect(c.pinHash).toBeTruthy();
  });

  it('a wrong password is refused and audit-logged; the right one goes through and clears the count', async () => {
    const wrong = await calls()[2][1]({ currentPassword: 'not-the-password' });
    expect(wrong.statusCode).toBe(403);
    expect((await auditEntries('reauth_failed')).some(e => /reset-pin/.test(e.details))).toBe(true);
    const ok = await calls()[2][1]({ currentPassword: OWNER_PASSWORD });
    expect(ok.statusCode).toBe(200);
    const ownerDoc = (await users().find({ role: 'owner' }).toArray())[0];
    expect(ownerDoc.failedLogins || 0).toBe(0);
  });

  it('the wipe preview (dry run) still needs no password', async () => {
    expect((await request(app).post('/api/admin/customers/wipe').set(owner()).send({ dryRun: true })).statusCode).toBe(200);
  });
});

// The shared test owner is enrolled here and restored afterwards (even if a
// test fails) so every other test file can keep signing in with a password.
describe('Owner with two-step on', () => {
  let ownerName, ownerId, mgr;
  const clearOwnerMfa = () => users().updateMany({ role: 'owner' }, {
    $set: { mfaEnabled: false, failedLogins: 0 },
    $unset: { mfaSecret: '', mfaRecoveryCodes: '', mfaLastStep: '', mfaEnabledAt: '', mfaPendingSecret: '', mfaPendingAt: '', loginLockedUntil: '' }
  });
  beforeAll(async () => {
    await clearOwnerMfa();
    ownerToken = await getOwnerToken(request, app);
    const me = await request(app).get('/api/admin/me').set(owner());
    ownerName = me.body.user.username;
    ownerId = String((await users().findOne({ username: ownerName }))._id);
    mgr = await makeManager();
    await enrol(mgr.username, mgr.token);
    ownerToken = (await enrol(ownerName, ownerToken, OWNER_PASSWORD)).token;
  });
  afterAll(async () => { await clearOwnerMfa(); });

  it('the owner cannot switch two-step sign-in off', async () => {
    const r = await request(app).post('/api/admin/me/mfa/disable').set(owner()).send({ ...REAUTH, mfaCode: await freshCode(ownerName) });
    expect(r.statusCode).toBe(403);
    expect((await request(app).get('/api/admin/me/mfa').set(owner())).body).toMatchObject({ enabled: true, canDisable: false });
    expect((await request(app).put('/api/admin/users/' + ownerId).set(owner()).send({ resetMfa: true, ...REAUTH, mfaCode: await freshCode(ownerName) })).statusCode).toBe(400);
  });

  it('owner sign-in needs the code', async () => {
    const r = await passwordStep(ownerName, OWNER_PASSWORD);
    expect(r.body.token).toBeUndefined();
    expect(r.body.mfaRequired).toBe(true);
  });

  it('step-up then needs the password AND a code (authenticator or recovery)', async () => {
    const settings = (await request(app).get('/api/admin/loyalty/settings').set(owner())).body;
    const put = (body) => request(app).put('/api/admin/loyalty/settings').set(owner()).send({ earnRate: settings.earnRate, ...body });

    const pwOnly = await put(REAUTH);
    expect(pwOnly.statusCode).toBe(403);
    expect(pwOnly.body.mfaRequired).toBe(true);
    expect((await put({ ...REAUTH, mfaCode: await wrongCode(ownerName) })).statusCode).toBe(403);
    expect((await put({ ...REAUTH, mfaCode: await freshCode(ownerName) })).statusCode).toBe(200);

    const codes = (await request(app).post('/api/admin/me/mfa/recovery-codes').set(owner()).send({ ...REAUTH, mfaCode: await freshCode(ownerName) })).body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect((await put({ ...REAUTH, mfaCode: codes[0] })).statusCode).toBe(200);
    expect((await put({ ...REAUTH, mfaCode: codes[0] })).statusCode).toBe(403);
  });

  it('the owner can reset a manager\'s two-step sign-in with password + code', async () => {
    const r = await request(app).put('/api/admin/users/' + mgr.userId).set(owner()).send({ resetMfa: true, ...REAUTH, mfaCode: await freshCode(ownerName) });
    expect(r.statusCode).toBe(200);
    expect((await passwordStep(mgr.username)).body.token).toBeTruthy();
  });
});
