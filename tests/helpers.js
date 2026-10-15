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

// Customer sessions: sign in exactly like the app does now — phone + PIN. On a
// fresh number we enroll (set a PIN + recovery question); if the number was
// already enrolled in an earlier run we fall back to logging in with the same
// test PIN. Tokens are cached per phone so repeated sign-ins are cheap.
const TEST_PIN = '1234';
const customerTokens = new Map();
async function customerToken(request, app, phone, name = 'Test Shopper', extra = {}) {
  if (customerTokens.has(phone)) return customerTokens.get(phone);
  let r = await request(app).post('/api/auth/enroll').send({
    phone, name, pin: TEST_PIN, securityQuestion: 'Test question?', securityAnswer: 'test', ...extra
  });
  if (!(r.body && r.body.token)) {
    r = await request(app).post('/api/auth/login').send({ phone, pin: TEST_PIN });
  }
  if (!r.body || !r.body.token) throw new Error('Sign-in failed for ' + phone + ': ' + JSON.stringify(r.body));
  customerTokens.set(phone, r.body.token);
  return r.body.token;
}

const bearer = (token) => ({ Authorization: 'Bearer ' + token });

module.exports = { getOwnerToken, customerToken, bearer };
