// MongoDB connection, collection handles (col.*) and indexes.
const { MongoClient } = require('mongodb');
const { IS_TEST, DB_NAME, MONGO_URI, OFFLINE_DB_FILE } = require('./config');
const { createFileDb } = require('./mockdb');

// Under Jest the MongoDB driver retries for the FULL serverSelectionTimeoutMS
// even when the connection is refused, so in CI (where no MongoDB exists)
// every test file would otherwise stall ~5s before falling back to the
// offline mock. Tests connect mock-fast instead; production keeps 5s.
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: IS_TEST ? 500 : 5000 });

let db;
// Live handles to every collection, filled in by assignCollections(). Shared as ONE
// object so any module can read the current handle (col.orders etc.).
const col = {};

// The local-Mongo / JSON-file fallbacks exist for offline development and the
// test suite ONLY. In production (a real MONGODB_URI configured) a failed Atlas
// connection used to silently drop the live shop onto a JSON file on Render's
// ephemeral disk: orders written there vanished on the next deploy, and the
// empty file DB had no owner, so /api/admin/setup let anyone create one. Now
// production retries Atlas and, if it stays down, exits so Render restarts it.
const offlineDbAllowed = () =>
  IS_TEST || process.env.ALLOW_OFFLINE_DB === 'true' || !process.env.MONGODB_URI;

async function connectPrimaryWithRetry() {
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`Connecting to MongoDB Atlas (attempt ${i}/${attempts})...`);
      await client.connect();
      return client.db(DB_NAME);
    } catch (err) {
      console.error(`❌ MongoDB Atlas connection failed (attempt ${i}):`, err.message);
      if (i === attempts) throw err;
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * 2 ** (i - 1))));
    }
  }
}

async function connectDatabase() {
  if (!offlineDbAllowed()) {
    db = await connectPrimaryWithRetry(); // throws → process exits → Render restarts
    col.db = db;
    console.log('✅ Connected to MongoDB Atlas');
    assignCollections();
    return;
  }
  try {
    // MOCK_DB=1 (test mode only) jumps straight to the offline file DB. CI has
    // no MongoDB, so this makes the backend test suite deterministic instead of
    // depending on connection-refused timing. The offline mock behaves like a
    // real DB (see FileCollection below), so tests pass either way.
    if (process.env.MOCK_DB === '1' && IS_TEST) {
      throw new Error('MOCK_DB=1: skipping real MongoDB (offline mock mode)');
    }
    console.log(process.env.MONGODB_URI ? 'Connecting to MongoDB...' : `Connecting to local MongoDB (${DB_NAME})...`);
    await client.connect();
    db = client.db(DB_NAME);
    col.db = db;
    console.log(`✅ Connected to MongoDB (database ${DB_NAME})`);
  } catch (err) {
    if (err && err.message && err.message.startsWith('MOCK_DB=1')) {
      console.log('🧪 MOCK_DB=1 — offline mock mode (skipping real MongoDB)');
    } else {
      console.error('❌ MongoDB Atlas connection failed:', err.message);
    }
    console.log(`Connecting to fallback Local MongoDB (mongodb://127.0.0.1:27017/${DB_NAME})...`);
    try {
      if (process.env.MOCK_DB === '1' && IS_TEST) {
        throw new Error('MOCK_DB=1: skipping local MongoDB (offline mock mode)');
      }
      const localClient = new MongoClient(`mongodb://127.0.0.1:27017/${DB_NAME}`, { serverSelectionTimeoutMS: IS_TEST ? 500 : 2000 });
      await localClient.connect();
      db = localClient.db(DB_NAME);
      col.db = db;
      console.log('✅ Connected to Local MongoDB');
    } catch (localErr) {
      if (!(localErr && localErr.message && localErr.message.startsWith('MOCK_DB=1'))) {
        console.error('❌ Local MongoDB connection failed:', localErr.message);
      }
      console.log(`⚠️ Entering Offline Mock Mode (Local File DB: ${OFFLINE_DB_FILE})...`);

      db = createFileDb(OFFLINE_DB_FILE);
      col.db = db;
    }
  }
  assignCollections();
}

// Indexes for every hot lookup (customer phone, order history, coupons,
// promo slots, M-Pesa callbacks). Non-unique on purpose — a duplicate in old
// data must never stop the server from booting. Real MongoDB only; the offline
// mock has no index support (and needs none).
async function ensureIndexes() {
  if (!col.db || typeof col.db.collection('orders').createIndex !== 'function') return;
  const specs = [
    ['orders', { customerId: 1, createdAt: -1 }], ['orders', { createdAt: -1 }], ['orders', { status: 1 }],
    ['sales', { createdAt: -1 }], ['sales', { cashierUserId: 1, createdAt: -1 }],
    ['customers', { phone: 1 }], ['customers', { referralCode: 1 }],
    ['loyalty', { phone: 1 }], ['coupons', { code: 1 }], ['coupons', { ownerPhone: 1 }],
    ['promo_claims', { phone: 1, type: 1, at: -1 }], ['credit', { phone: 1 }],
    ['notification_tokens', { token: 1 }], ['notification_tokens', { phone: 1 }], ['notification_tokens', { role: 1, staffUser: 1 }],
    ['notifications_feed', { createdAt: -1 }], ['notifications_feed', { phone: 1, createdAt: -1 }],
    ['mpesa_requests', { checkoutRequestId: 1 }], ['mpesa_requests', { orderId: 1, status: 1 }],
    ['users', { username: 1 }], ['products', { name: 1 }], ['saved_baskets', { customerId: 1 }],
    ['shifts', { cashierId: 1, status: 1 }], ['audit_logs', { createdAt: -1 }],
    ['wallet_transactions', { phone: 1, createdAt: -1 }],
    ['orders', { 'deliverySlot.date': 1 }], ['orders', { 'rider.userId': 1, status: 1 }],
    ['tax_invoices', { invoiceNo: -1 }], ['tax_invoices', { source: 1, sourceId: 1, type: 1 }], ['tax_invoices', { status: 1 }],
    ['product_reviews', { productId: 1, createdAt: -1 }], ['product_reviews', { productId: 1, phone: 1 }],
    ['purchase_orders', { createdAt: -1 }], ['stock_takes', { status: 1 }], ['mpesa_requests', { purpose: 1, walletPhone: 1, status: 1 }],
    ['ai_chats', { phone: 1, createdAt: -1 }], ['audit_logs', { timestamp: -1 }], ['voided_sales', { voidedAt: -1 }]
  ];
  for (const [coll, keys] of specs) {
    try { await col.db.collection(coll).createIndex(keys); } catch (e) { console.warn(`Index ${coll} ${JSON.stringify(keys)} skipped:`, e.message); }
  }
}

function assignCollections() {
  // Set collections from db/mock db
  col.products = db.collection('products');
  col.orders = db.collection('orders');
  col.sales = db.collection('sales');
  col.expenses = db.collection('expenses');
  col.credit = db.collection('credit');
  col.reviews = db.collection('reviews');
  col.staff = db.collection('staff');
  col.users = db.collection('users');
  col.loyalty = db.collection('loyalty');
  col.coupons = db.collection('coupons');
  col.branches = db.collection('branches');
  col.audit_logs = db.collection('audit_logs');
  col.shifts = db.collection('shifts');
  col.pricing_rules = db.collection('pricing_rules');
  col.stock_transfers = db.collection('stock_transfers');
  col.loyalty_rewards = db.collection('loyalty_rewards');
  col.redemptions = db.collection('redemptions');
  col.saved_baskets = db.collection('saved_baskets');
  col.banners = db.collection('banners');
  col.categories = db.collection('categories');
  col.customers = db.collection('customers');
  col.promo_claims = db.collection('promo_claims');
  col.notification_tokens = db.collection('notification_tokens');
  col.notifications_feed = db.collection('notifications_feed');
  col.loyalty_settings = db.collection('loyalty_settings');
  col.promo_cooldowns = db.collection('promo_cooldowns');
  col.wallet_transactions = db.collection('wallet_transactions');
  // v0.1.51 features: settings, tax invoices, reports, suppliers, stock-takes, product reviews
  for (const name of ['shop_settings', 'counters', 'tax_invoices', 'daily_reports', 'suppliers', 'purchase_orders', 'stock_takes', 'product_reviews']) col[name] = db.collection(name);
  // Customer ↔ AI assistant conversation log (shown per customer in Admin → Customers).
  col.ai_chats = db.collection('ai_chats');
  // Copy of everything the owner's "Delete all customers" removed, so a wipe can be undone.
  col.customer_wipe_archive = db.collection('customer_wipe_archive');
  // Voided till sales are moved here (not destroyed) so a void can be audited.
  col.voided_sales = db.collection('voided_sales');
}

module.exports = { client, db, col, offlineDbAllowed, connectPrimaryWithRetry, connectDatabase, ensureIndexes, assignCollections };
