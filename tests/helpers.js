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

module.exports = { getOwnerToken };
