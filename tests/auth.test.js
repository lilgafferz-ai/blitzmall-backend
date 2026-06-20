const request = require('supertest');
const { app, connectDb, client } = require('../server');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  // Use in-memory MongoDB for testing
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.JWT_SECRET = 'test_secret_key';
  
  await connectDb();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
  if (mongoServer) {
    await mongoServer.stop();
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
