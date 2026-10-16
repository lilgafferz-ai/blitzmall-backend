#!/usr/bin/env node
// Local development server: `npm run dev` (or double-click start-local-server.cmd).
//
// Runs the real backend (server.js) on http://localhost:5000 — the address the
// apps' "Local Server (Development)" connection uses — against a SEPARATE
// database so testing never touches the live shop:
//
//   * MongoDB on this PC, database `blitzmall_dev` (never `my_shop`, never the
//     Atlas cluster in .env). No MongoDB running → a JSON file in .dev/.
//   * First run copies the live product catalogue + banners into it (public
//     data only: no customers, orders, staff or cost prices). `--reset` wipes
//     the dev database and copies again; `--no-seed` skips the copy.
//   * Its own JWT / MFA secrets (generated once into .dev/, git-ignored), so a
//     dev token can never sign anyone into the live shop and vice versa.
//   * M-Pesa is simulated (payments confirm after 3 s), and SMS, real push,
//     and KRA eTIMS submission are switched off, so nothing reaches real
//     phones or KRA. Optional keys in .env (Google image finder, Ollama) are
//     still used.
//
// Open HQ / the shop, pick "Local Server (Development)" on the login screen,
// and create the dev owner account on first sign-in.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEV_DIR = path.join(ROOT, '.dev');
const DB_NAME = 'blitzmall_dev';
const LOCAL_MONGO = `mongodb://127.0.0.1:27017/${DB_NAME}`;
const LIVE_API = 'https://blitzmall-backend.onrender.com/api';
const PORT = process.env.PORT || '5000';
const args = new Set(process.argv.slice(2));

function devSecrets() {
  const file = path.join(DEV_DIR, 'secrets.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const secrets = {
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2));
  console.log('🔑 Generated dev-only secrets in .dev/secrets.json');
  return secrets;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// Fields the public catalogue adds on the fly (live pricing rules, ratings);
// the dev copy stores the plain product so its own pricing rules apply.
const COMPUTED = ['appliedRules', 'discountApplied', 'isFlashSale', 'flashSaleDiscount', 'flashSaleExpires', 'flashSaleReason', 'originalPrice', 'ratingAvg', 'ratingCount'];
const toDoc = (item, ObjectId) => {
  const doc = { ...item };
  if (typeof doc._id === 'string' && /^[0-9a-f]{24}$/i.test(doc._id)) doc._id = new ObjectId(doc._id);
  if (item.originalPrice !== undefined) doc.price = item.originalPrice;
  for (const k of COMPUTED) delete doc[k];
  for (const k of ['createdAt', 'updatedAt', 'expiryDate']) if (typeof doc[k] === 'string' && doc[k]) doc[k] = new Date(doc[k]);
  return doc;
};

// Returns true when MongoDB on this PC is reachable (and the copy is done).
async function prepareDevDatabase() {
  let MongoClient, ObjectId;
  try { ({ MongoClient, ObjectId } = require('mongodb')); } catch (e) {
    console.error('❌ Backend packages are missing. Run `npm install` in this folder first.');
    process.exit(1);
  }
  const client = new MongoClient(LOCAL_MONGO, { serverSelectionTimeoutMS: 2500 });
  try {
    await client.connect();
  } catch (e) {
    console.warn('⚠️ MongoDB is not running on this PC — using the file database .dev/dev_db.json (starts empty).');
    return false;
  }
  try {
    const db = client.db(DB_NAME);
    if (args.has('--reset')) {
      await db.dropDatabase();
      console.log(`🧹 Wiped the ${DB_NAME} database`);
    }
    const products = db.collection('products');
    if (args.has('--no-seed') || await products.countDocuments() > 0) return true;

    console.log('📥 Copying the live catalogue (products + banners) into the dev database…');
    const [liveProducts, liveBanners] = await Promise.all([
      fetchJson(`${LIVE_API}/products`),
      fetchJson(`${LIVE_API}/banners`).catch(() => []),
    ]);
    if (Array.isArray(liveProducts) && liveProducts.length) {
      await products.insertMany(liveProducts.map(p => toDoc(p, ObjectId)));
    }
    const banners = db.collection('banners');
    if (Array.isArray(liveBanners) && liveBanners.length && await banners.countDocuments() === 0) {
      await banners.insertMany(liveBanners.map(b => toDoc(b, ObjectId)));
    }
    console.log(`✅ Copied ${liveProducts.length || 0} products and ${liveBanners.length || 0} banners (no cost prices — set them in HQ if you need profit reports)`);
    return true;
  } catch (e) {
    console.warn('⚠️ Could not copy the live catalogue (offline?) — the dev shop starts empty:', e.message);
    return true;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const secrets = devSecrets();
  await prepareDevDatabase();

  // Everything set here wins over .env (dotenv never overrides a set
  // variable, even an empty one), so live credentials in .env stay unused.
  const env = {
    ...process.env,
    PORT,
    NODE_ENV: 'development',
    DB_NAME,
    MONGODB_URI: LOCAL_MONGO,
    ALLOW_OFFLINE_DB: 'true',
    OFFLINE_DB_FILE: path.join(DEV_DIR, 'dev_db.json'),
    JWT_SECRET: secrets.JWT_SECRET,
    MFA_ENCRYPTION_KEY: secrets.MFA_ENCRYPTION_KEY,
    MPESA_CALLBACK_SECRET: '',
    MPESA_MOCK_ENABLED: 'true',
    MPESA_ENV: 'sandbox',
    CALLBACK_URL: '',
    AT_USERNAME: '', AT_API_KEY: '', AT_SENDER_ID: '', AT_SANDBOX: '',
    FCM_SERVICE_ACCOUNT_JSON: '',
    ETIMS_VSCU_URL: '', ETIMS_VSCU_KEY: '',
    DEV_SERVER: '1',
  };

  console.log(`\n🧪 BlitzMall LOCAL DEV server → http://localhost:${PORT}  (database: ${DB_NAME}, M-Pesa simulated, no SMS/push)`);
  console.log('   In the app: login screen → Server Connection → "Local Server (Development)". Ctrl+C to stop.\n');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const stop = () => child.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => { console.error('❌ Dev server failed to start:', e); process.exit(1); });
