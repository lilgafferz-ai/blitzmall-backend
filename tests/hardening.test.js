const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Second security batch (v0.1.51): sliding staff sessions, CORS allowlist, CSP,
// body limits, the wallet ledger and signed OTA bundles.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client, _test } = require('../server');
const { getOwnerToken, customerToken, bearer } = require('./helpers');

let seq = 0;
const freshPhone = () => '07' + String(Date.now() + (seq += 61) * 7907 + Math.floor(Math.random() * 1e8)).slice(-8);

let ownerToken = null;
const owner = () => bearer(ownerToken);

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});

afterAll(async () => {
  if (client) await client.close();
});

// The owner's token, re-signed as if it had been issued `ageSeconds` ago.
const agedOwnerToken = (ageSeconds, expiresIn = '3650d') => {
  const { userId, username, role, tv } = jwt.decode(ownerToken);
  return jwt.sign({ userId, username, role, tv, iat: Math.floor(Date.now() / 1000) - ageSeconds }, process.env.JWT_SECRET, { expiresIn });
};

describe('Staff sessions slide and expire', () => {
  it('new staff tokens last 30 days, not 10 years', () => {
    const { iat, exp } = jwt.decode(ownerToken);
    expect(exp - iat).toBe(30 * 24 * 3600);
  });

  it('a fresh token is not renewed on every request', async () => {
    const r = await request(app).get('/api/admin/summary').set(owner());
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-renewed-token']).toBeUndefined();
  });

  it('an active device gets a fresh token once its token is older than 12 hours', async () => {
    const r = await request(app).get('/api/admin/summary').set(bearer(agedOwnerToken(13 * 3600)));
    expect(r.statusCode).toBe(200);
    const renewed = r.headers['x-renewed-token'];
    expect(renewed).toBeTruthy();
    const d = jwt.decode(renewed);
    expect(Math.abs(d.iat - Date.now() / 1000)).toBeLessThan(60);
    expect((await request(app).get('/api/admin/summary').set(bearer(renewed))).statusCode).toBe(200);
  });

  it('an old 10-year token unused for over 30 days is refused', async () => {
    const r = await request(app).get('/api/admin/summary').set(bearer(agedOwnerToken(31 * 24 * 3600)));
    expect(r.statusCode).toBe(401);
    expect(r.body.sessionRevoked).toBe(true);
  });

  it('the till/push routes that accept staff sessions apply the same cap', async () => {
    const r = await request(app).post('/api/notifications/test').set(bearer(agedOwnerToken(31 * 24 * 3600))).send({ role: 'staff' });
    expect(r.statusCode).toBe(401);
  });
});

describe('CORS allowlist', () => {
  const acao = (r) => r.headers['access-control-allow-origin'];

  it('a random website gets no CORS grant', async () => {
    const r = await request(app).get('/api/products').set('Origin', 'https://evil.example');
    expect(acao(r)).toBeUndefined();
    const pre = await request(app).options('/api/orders').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(acao(pre)).toBeUndefined();
  });

  it.each([
    ['the Android app', 'https://localhost'],
    ['the PC app (file://)', 'null'],
    ['local development', 'http://localhost:3000'],
    ['local development by IP', 'http://127.0.0.1:5000']
  ])('%s is allowed', async (_, origin) => {
    const r = await request(app).get('/api/products').set('Origin', origin);
    expect(acao(r)).toBe(origin);
  });

  it('the web app on its own domain is allowed, and can read the renewed token', async () => {
    const r = await request(app).get('/api/products').set('Host', 'shop.example.com').set('Origin', 'https://shop.example.com');
    expect(acao(r)).toBe('https://shop.example.com');
    expect(r.headers['access-control-expose-headers']).toMatch(/X-Renewed-Token/i);
  });

  it('server-to-server calls without an Origin (Safaricom) are untouched', async () => {
    const r = await request(app).post('/api/mpesa/callback').send({});
    expect(r.statusCode).toBe(200);
  });
});

describe('Content-Security-Policy', () => {
  it('is sent on the web app and the API, and forbids inline scripts', async () => {
    for (const url of ['/', '/api/health']) {
      const csp = (await request(app).get(url)).headers['content-security-policy'];
      expect(csp).toBeTruthy();
      const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src'));
      expect(scriptSrc).toBeTruthy();
      expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
      expect(csp).toMatch(/object-src 'none'/);
    }
  });

  it('the shipped index.html has no inline <script> left to break', () => {
    const html = fs.readFileSync(path.join(__dirname, '../shop-frontend/public/index.html'), 'utf8');
    expect(html).not.toMatch(/<script>/i);
    expect(html).not.toMatch(/\son[a-z]+=["']/i);
  });
});

describe('Request body limits', () => {
  const big = (mb) => 'x'.repeat(mb * 1024 * 1024);

  it('ordinary routes refuse a multi-megabyte body', async () => {
    const tok = bearer(await customerToken(request, app, freshPhone()));
    const r = await request(app).post('/api/orders').set(tok).send({ customerName: big(2), items: [] });
    expect(r.statusCode).toBe(413);
  });

  it('product photo uploads still accept a full-size photo', async () => {
    const photo = 'data:image/jpeg;base64,' + Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    const r = await request(app).post('/api/admin/products').set(owner())
      .send({ name: 'HARD-Photo ' + Date.now(), price: 10, buyingPrice: 5, stock: 1, image: [photo] });
    expect(r.statusCode).not.toBe(413);
  });
});

describe('Wallet ledger', () => {
  const ledgerOf = async (phone) => (await request(app).get('/api/admin/wallet/ledger/' + phone).set(owner())).body;
  const createProduct = async (price) => (await request(app).post('/api/admin/products').set(owner())
    .send({ name: 'HARD-Ledger ' + Date.now() + '-' + (seq += 1), price, buyingPrice: 0, stock: 20, image: [] })).body.productId;

  it('records every wallet movement with the balance after it', async () => {
    const phone = freshPhone();
    const tok = bearer(await customerToken(request, app, phone));
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 500 });
    expect((await request(app).post('/api/loyalty/convert-to-wallet').set(tok).send({ points: 500 })).body.walletBalance).toBe(100);

    const pid = await createProduct(60);
    const placed = await request(app).post('/api/orders').set(tok)
      .send({ customerName: 'Ledger', items: [{ _id: pid, quantity: 1 }], paymentMethod: 'delivery', useWallet: true });
    expect(placed.body.walletApplied).toBe(60);
    await request(app).post(`/api/customer-orders/${placed.body.orderId}/cancel`).set(tok);

    const { balance, transactions } = await ledgerOf(phone);
    expect(balance).toBe(100);
    const oldestFirst = transactions.slice().reverse();
    expect(oldestFirst.map(t => [t.type, t.amount, t.balanceAfter])).toEqual([
      ['points_conversion', 100, 100],
      ['order_payment', -60, 40],
      ['order_refund', 60, 100]
    ]);
    expect(oldestFirst[1].refId).toBe(String(placed.body.orderId));
    expect(oldestFirst[2].refId).toBe(String(placed.body.orderId));

    // The customer sees the same statement — and only their own.
    const mine = await request(app).get('/api/customer/wallet/history').set(tok);
    expect(mine.body.balance).toBe(100);
    expect(mine.body.transactions).toHaveLength(3);
    const other = await request(app).get('/api/customer/wallet/history').set(bearer(await customerToken(request, app, freshPhone())));
    expect(other.body.transactions).toHaveLength(0);
  });

  it('reconciliation passes for ledger-backed balances and flags a change that bypassed the ledger', async () => {
    const phone = freshPhone();
    const tok = bearer(await customerToken(request, app, phone));
    await request(app).post('/api/admin/loyalty/add-points').set(owner()).send({ phone, points: 100 });
    await request(app).post('/api/loyalty/convert-to-wallet').set(tok).send({ points: 100 });

    let report = (await request(app).get('/api/admin/wallet/reconcile').set(owner())).body;
    expect(report.mismatches.find(m => m.phone === phone)).toBeUndefined();

    // Someone edits the balance straight in the database.
    await _test.mockDb().collection('loyalty').updateOne({ phone }, { $inc: { walletBalance: 500 } });
    report = (await request(app).get('/api/admin/wallet/reconcile').set(owner())).body;
    expect(report.ok).toBe(false);
    expect(report.mismatches.find(m => m.phone === phone)).toMatchObject({ balance: 520, ledger: 20, difference: 500 });

    await _test.mockDb().collection('loyalty').updateOne({ phone }, { $inc: { walletBalance: -500 } });
  });

  it('balances from before the ledger get an opening entry exactly once', async () => {
    const phone = freshPhone();
    await _test.mockDb().collection('loyalty').insertOne({ phone, points: 0, walletBalance: 75, createdAt: new Date() });
    const { seedOpeningBalances } = require('../lib/wallet');
    await seedOpeningBalances();
    await seedOpeningBalances();
    const { transactions } = await ledgerOf(phone);
    expect(transactions.map(t => [t.type, t.amount])).toEqual([['opening_balance', 75]]);
  });

  it('only the owner can read the ledger or run reconciliation', async () => {
    const tok = bearer(await customerToken(request, app, freshPhone()));
    expect((await request(app).get('/api/admin/wallet/reconcile').set(tok)).statusCode).toBe(401);
    expect((await request(app).get('/api/admin/wallet/reconcile')).statusCode).toBe(401);
  });
});

describe('Signed OTA bundles', () => {
  const FRONTEND = path.join(__dirname, '../shop-frontend');
  const messageFn = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    const line = src.split('\n').find(l => /const otaSignedMessage = /.test(l));
    return new Function(line.replace(/^export /, '') + '\nreturn otaSignedMessage;')();
  };
  // src/otaUpdate.js is an ES module for the app; evaluate it with its two
  // imports supplied as plain values.
  const loadAppVerifier = (publicKey, appVersion) => {
    const src = fs.readFileSync(path.join(FRONTEND, 'src/otaUpdate.js'), 'utf8')
      .replace(/^import .*$/mg, '')
      .replace(/^export /mg, '');
    return new Function('OTA_PUBLIC_KEY_SPKI', 'APP_VERSION', src + '\nreturn { verifyOtaManifest, versionLess };')(publicKey, appVersion);
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const sign = (fields) => crypto.sign('sha256', Buffer.from(messageFn(path.join(FRONTEND, 'scripts/make-ota-bundle.js'))(fields)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const subtle = crypto.webcrypto.subtle;
  const base = { version: '0.1.51-abc', url: 'https://x/updates/b.zip', appVersion: '0.1.51', sha256: 'a'.repeat(64) };

  it('the build script and the app sign/verify the exact same message', () => {
    const a = messageFn(path.join(FRONTEND, 'scripts/make-ota-bundle.js'));
    const b = messageFn(path.join(FRONTEND, 'src/otaUpdate.js'));
    expect(a(base)).toBe(b(base));
  });

  it('the app accepts a correctly signed bundle', async () => {
    const { verifyOtaManifest } = loadAppVerifier(spki, '0.1.51');
    await expect(verifyOtaManifest({ ...base, signature: sign(base) }, { subtle })).resolves.toBeUndefined();
  });

  it('the app refuses unsigned, tampered, wrongly-keyed and downgrade bundles', async () => {
    const { verifyOtaManifest } = loadAppVerifier(spki, '0.1.51');
    const signature = sign(base);
    await expect(verifyOtaManifest({ ...base }, { subtle })).rejects.toThrow(/not signed/);
    await expect(verifyOtaManifest({ ...base, signature, sha256: 'b'.repeat(64) }, { subtle })).rejects.toThrow(/signature is invalid/);
    await expect(verifyOtaManifest({ ...base, signature, version: '0.1.51-evil' }, { subtle })).rejects.toThrow(/signature is invalid/);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await expect(loadAppVerifier(other, '0.1.51').verifyOtaManifest({ ...base, signature }, { subtle })).rejects.toThrow(/signature is invalid/);
    const old = { ...base, appVersion: '0.1.9' };
    await expect(loadAppVerifier(spki, '0.1.10').verifyOtaManifest({ ...old, signature: sign(old) }, { subtle })).rejects.toThrow(/downgrade/);
  });

  it('the compiled-in public key is a valid P-256 key', async () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'src/otaPublicKey.js'), 'utf8');
    const key = src.match(/OTA_PUBLIC_KEY_SPKI = '([^']+)'/)[1];
    await expect(subtle.importKey('spki', Buffer.from(key, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])).resolves.toBeTruthy();
  });

  it('/api/native-update relays the signature fields from latest.json', async () => {
    const r = await request(app).get('/api/native-update');
    expect(r.statusCode).toBe(200);
    const latest = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'ota/latest.json'), 'utf8'));
    expect(r.body.version).toBe(latest.version);
    expect(r.body.sha256).toBe(latest.sha256 || null);
    expect(r.body.signature).toBe(latest.signature || null);
  });
});
