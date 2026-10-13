// Shared test helper: the test DB only ever allows ONE owner account (shared
// across test files and runs), so we login with whichever known test owner
// exists — creating one only when the DB is fresh (CI). All known usernames
// share the same password so login always succeeds after the first creation.
async function getOwnerToken(request, app) {
  for (const uname of ['test_owner', 'sec_owner', 'promo_owner', 'dbg_owner']) {
    const r = await request(app).post('/api/admin/login').send({ username: uname, password: 'secure123' });
    if (r.body && r.body.token) return r.body.token;
  }
  await request(app).post('/api/admin/setup').send({ username: 'test_owner', password: 'secure123', name: 'Test Owner' });
  const r = await request(app).post('/api/admin/login').send({ username: 'test_owner', password: 'secure123' });
  return r.body && r.body.token;
}

// Customer sessions: sign in exactly like the app does (request a code, then
// verify it). No SMS gateway exists in tests, so the server's on-screen
// fallback hands the code back as devOtp. Tokens are cached per phone because
// a second code for the same number inside 30s is refused (resend cooldown).
const customerTokens = new Map();
async function customerToken(request, app, phone, name = 'Test Shopper', extra = {}) {
  if (customerTokens.has(phone)) return customerTokens.get(phone);
  const r = await request(app).post('/api/auth').send({ name, phone });
  if (!r.body || !r.body.devOtp) throw new Error('No devOtp for ' + phone + ': ' + JSON.stringify(r.body));
  const v = await request(app).post('/api/auth/verify-otp').send({ phone, otp: r.body.devOtp, name, ...extra });
  if (!v.body || !v.body.token) throw new Error('Sign-in failed for ' + phone + ': ' + JSON.stringify(v.body));
  customerTokens.set(phone, v.body.token);
  return v.body.token;
}

const bearer = (token) => ({ Authorization: 'Bearer ' + token });

module.exports = { getOwnerToken, customerToken, bearer };
