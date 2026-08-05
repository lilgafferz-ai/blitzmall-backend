const request = require('supertest');

// Set env BEFORE requiring the server (see auth.test.js for details).
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

describe('Products API', () => {
  it('should fetch products successfully', async () => {
    const res = await request(app).get('/api/products');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });
});
