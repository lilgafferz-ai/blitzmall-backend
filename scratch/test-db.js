const { MongoClient } = require('mongodb');

async function test(uri) {
  console.log('Testing URI:', uri.replace(/:([^@]+)@/, ':****@'));
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('✅ Connected successfully!');
    const db = client.db('my_shop');
    const cols = await db.listCollections().toArray();
    console.log('Collections:', cols.map(c => c.name));
    return true;
  } catch (err) {
    console.log('❌ Failed:', err.message);
    return false;
  } finally {
    await client.close();
  }
}

async function main() {
  const uris = [
    'mongodb+srv://RedMan:21Savage.@cluster0.bbn0afu.mongodb.net/?appName=Cluster0',
    'mongodb+srv://RedMan:21Savage@cluster0.bbn0afu.mongodb.net/?appName=Cluster0'
  ];
  for (const uri of uris) {
    const ok = await test(uri);
    if (ok) break;
  }
}

main();
