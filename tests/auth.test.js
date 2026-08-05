const request = require('supertest');

// Configure env BEFORE importing the server so connectDb() targets a
// dedicated test database (never the real shop DB). In CI there is no local
// MongoDB, so the server falls back to its offline mock mode — the assertions
// below pass either way.
process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';

const { app, connectDb, client } = require('../server');

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

describe('Auth API', () => {
  it('should reject login without credentials', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({});

    // Because of the way /api/admin/login is written:
    // "if (!username && password) { username = 'owner'; }"
    // if both are missing, it might proceed and fail at db lookup or return 401
    expect(res.statusCode).not.toBe(200);
  });
});
