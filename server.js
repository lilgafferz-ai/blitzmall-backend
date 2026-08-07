require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const helmet = require('helmet');
// express-mongo-sanitize removed: it reassigns req.query, which throws under
// Express 5 (req.query is getter-only). Replaced by the Express 5-safe
// sanitizeRequest middleware defined below.
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const productCache = new NodeCache({ stdTTL: 300 }); // Cache products for 5 minutes

const app = express();
app.set('trust proxy', 1);
const path = require('path');
// Downloadable APK(s) live OUTSIDE the web build so they aren't bundled into the
// app itself. Still served at the same /apk/... URL the Share screen/QR use.
app.use('/apk', express.static(path.join(__dirname, 'shop-frontend/downloads')));
// Self-hosted over-the-air web bundles for the native app (see /api/native-update)
app.use('/updates', express.static(path.join(__dirname, 'shop-frontend/ota')));
// Serve React frontend
app.use(express.static(path.join(__dirname, 'shop-frontend/build')));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
// NoSQL-injection sanitizer (Express 5-safe). Strips dangerous keys ($-prefixed
// or containing ".") from request data in place, and re-pins a sanitized
// req.query via defineProperty (assignment to req.query throws in Express 5).
function stripKeys(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      stripKeys(obj[key], depth + 1);
    }
  }
  return obj;
}
app.use((req, res, next) => {
  try { if (req.body) stripKeys(req.body); } catch (e) {}
  try { if (req.params) stripKeys(req.params); } catch (e) {}
  try {
    const q = req.query;
    if (q && typeof q === 'object') {
      stripKeys(q);
      Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
    }
  } catch (e) {}
  next();
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Strict limit for auth routes
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/my_shop';
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });

let db, db_, products_, orders_, sales_, expenses_, credit_, reviews_, staff_, users_, loyalty_, coupons_, branches_;
let audit_logs_, shifts_, pricing_rules_, stock_transfers_, loyalty_rewards_, redemptions_, saved_baskets_, banners_, categories_;
let customers_, promo_claims_, notification_tokens_, notifications_feed_, loyalty_settings_;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined.');
  process.exit(1);
}
const JWT_EXPIRES = '24h';

// Shop GPS coordinates (Point A for delivery tracking)
const SHOP_COORDS = { lat: 0.8273, lng: 35.1207 }; // Matunda, Kakamega - Blitz Mall location
const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Helper: extract branchId from query/body/user
const branchFilter = (req) => {
  // If user is owner and no branch specified, return {} (view all)
  // If user is owner and branch specified, filter by it
  // If user is manager/cashier, filter by their branch
  if (req.user.role === 'owner') {
    const b = req.query.branchId || req.body?.branchId;
    return b ? { branchId: b } : {};
  }
  // Manager/cashier only see their branch
  return req.user.branchId ? { branchId: req.user.branchId } : {};
};

async function connectDb() {
  try {
    console.log('Connecting to primary MongoDB Atlas...');
    await client.connect();
    db = client.db('my_shop');
    db_ = db;
    console.log('✅ Connected to MongoDB Atlas');
  } catch (err) {
    console.error('❌ MongoDB Atlas connection failed:', err.message);
    console.log('Connecting to fallback Local MongoDB (mongodb://127.0.0.1:27017/my_shop)...');
    try {
      const localClient = new MongoClient('mongodb://127.0.0.1:27017/my_shop', { serverSelectionTimeoutMS: 2000 });
      await localClient.connect();
      db = localClient.db('my_shop');
      db_ = db;
      console.log('✅ Connected to Local MongoDB');
    } catch (localErr) {
      console.error('❌ Local MongoDB connection failed:', localErr.message);
      console.log('⚠️ Entering Offline Mock Mode (Local File DB: local_db_fallback.json)...');
      
      const fs = require('fs');
      const path = require('path');
      const DB_FILE = path.join(__dirname, 'local_db_fallback.json');
      
      let localDbData = {};
      try {
        if (fs.existsSync(DB_FILE)) {
          localDbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
      } catch (e) {
        console.error('Failed to load local DB file:', e);
      }
      
      const saveLocalDb = () => {
        try {
          fs.writeFileSync(DB_FILE, JSON.stringify(localDbData, null, 2), 'utf8');
        } catch (e) {
          console.error('Failed to save local DB file:', e);
        }
      };

      const matchFilter = (item, filter) => {
        if (!filter || Object.keys(filter).length === 0) return true;
        for (const [k, v] of Object.entries(filter)) {
          if (k === '_id' && item._id) {
            if (item._id.toString() !== v.toString()) return false;
            continue;
          }
          if (item[k] !== v) return false;
        }
        return true;
      };

      class FileCollection {
        constructor(name) {
          this.name = name;
        }
        
        find(filter = {}) {
          const data = localDbData[this.name] || [];
          let filtered = data.filter(item => matchFilter(item, filter));
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () => filtered
          };
          return cursor;
        }

        async findOne(filter = {}) {
          const data = localDbData[this.name] || [];
          return data.find(item => matchFilter(item, filter)) || null;
        }

        async insertOne(doc) {
          if (!localDbData[this.name]) localDbData[this.name] = [];
          if (!doc._id) doc._id = new ObjectId().toString();
          localDbData[this.name].push(doc);
          saveLocalDb();
          return { insertedId: doc._id, acknowledged: true };
        }

        async insertMany(docs) {
          if (!localDbData[this.name]) localDbData[this.name] = [];
          for (const doc of docs) {
            if (!doc._id) doc._id = new ObjectId().toString();
            localDbData[this.name].push(doc);
          }
          saveLocalDb();
          return { acknowledged: true, insertedCount: docs.length };
        }

        async updateOne(filter, update) {
          const list = localDbData[this.name] || [];
          const item = list.find(item => matchFilter(item, filter));
          if (item) {
            if (update.$set) Object.assign(item, update.$set);
            if (update.$inc) {
              for (const [k, v] of Object.entries(update.$inc)) {
                item[k] = (item[k] || 0) + v;
              }
            }
            saveLocalDb();
            return { matchedCount: 1, modifiedCount: 1 };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }

        async updateMany(filter, update) {
          const list = localDbData[this.name] || [];
          let modifiedCount = 0;
          for (const item of list) {
            if (matchFilter(item, filter)) {
              if (update.$set) Object.assign(item, update.$set);
              if (update.$inc) {
                for (const [k, v] of Object.entries(update.$inc)) {
                  item[k] = (item[k] || 0) + v;
                }
              }
              modifiedCount++;
            }
          }
          if (modifiedCount > 0) saveLocalDb();
          return { matchedCount: modifiedCount, modifiedCount };
        }

        async deleteOne(filter) {
          const list = localDbData[this.name] || [];
          const idx = list.findIndex(item => matchFilter(item, filter));
          if (idx !== -1) {
            list.splice(idx, 1);
            saveLocalDb();
            return { deletedCount: 1 };
          }
          return { deletedCount: 0 };
        }

        async deleteMany(filter = {}) {
          const list = localDbData[this.name] || [];
          const before = list.length;
          localDbData[this.name] = list.filter(item => !matchFilter(item, filter));
          saveLocalDb();
          return { deletedCount: before - (localDbData[this.name] || []).length };
        }

        async countDocuments(filter = {}) {
          const data = localDbData[this.name] || [];
          return data.filter(item => matchFilter(item, filter)).length;
        }
      }

      // Re-map db connection calls to use local file mock collections
      db = {
        collection: (name) => new FileCollection(name)
      };
      db_ = db;
    }
  }
  
  // Set collections from db/mock db
  products_ = db.collection('products');
  orders_ = db.collection('orders');
  sales_ = db.collection('sales');
  expenses_ = db.collection('expenses');
  credit_ = db.collection('credit');
  reviews_ = db.collection('reviews');
  staff_ = db.collection('staff');
  users_ = db.collection('users');
  loyalty_ = db.collection('loyalty');
  coupons_ = db.collection('coupons');
  branches_ = db.collection('branches');
  audit_logs_ = db.collection('audit_logs');
  shifts_ = db.collection('shifts');
  pricing_rules_ = db.collection('pricing_rules');
  stock_transfers_ = db.collection('stock_transfers');
  loyalty_rewards_ = db.collection('loyalty_rewards');
  redemptions_ = db.collection('redemptions');
  saved_baskets_ = db.collection('saved_baskets');
  banners_ = db.collection('banners');
  categories_ = db.collection('categories');
  customers_ = db.collection('customers');
  promo_claims_ = db.collection('promo_claims');
  notification_tokens_ = db.collection('notification_tokens');
  notifications_feed_ = db.collection('notifications_feed');
  loyalty_settings_ = db.collection('loyalty_settings');

  try {
    const bannerCount = await banners_.countDocuments();
    if (bannerCount === 0) {
      await banners_.insertMany([
        { title: "🚀 MEGA LAUNCH", text: "Free Delivery on Mall Area orders! Limited time.", code: "", gradient: "linear-gradient(135deg, #ff007f, #7f00ff)", active: true, createdAt: new Date() },
        { title: "🎁 WEEKEND SPECIAL", text: "Get 10% discount on orders over KES 1000!", code: "BLITZ10", gradient: "linear-gradient(135deg, #00f2fe, #4facfe)", active: true, createdAt: new Date() },
        { title: "💳 INSTANT PAY", text: "Scan & Pay with secure M-Pesa STK push!", code: "", gradient: "linear-gradient(135deg, #38ef7d, #11998e)", active: true, createdAt: new Date() }
      ]);
    }
  } catch (err) {
    console.error('Failed to seed banners:', err);
  }

  // Seed the public marketing coupons referenced by the home-screen ads, so
  // those voucher codes actually work at checkout (they were previously shown
  // in the UI but never existed in the coupons collection).
  try {
    const seedCoupons = [
      { code: 'BLITZ10', type: 'percent', value: 10, minPurchase: 1000, maxUses: 0, note: 'Weekend Special banner code' },
      { code: 'SHAKE15', type: 'percent', value: 15, minPurchase: 500, maxUses: 0, note: 'Scratch campaign code' },
      { code: 'SPIN50', type: 'fixed', value: 50, minPurchase: 500, maxUses: 0, note: 'Legacy wheel code' },
      { code: 'SPINFREE', type: 'free_delivery', value: 0, minPurchase: 300, maxUses: 0, note: 'Legacy wheel code' },
      { code: 'LUCKY30', type: 'fixed', value: 30, minPurchase: 300, maxUses: 0, note: 'Legacy scratch code' },
      { code: 'LUCKY50', type: 'fixed', value: 50, minPurchase: 500, maxUses: 0, note: 'Legacy scratch code' },
      { code: 'LUCKYDEL', type: 'free_delivery', value: 0, minPurchase: 300, maxUses: 0, note: 'Legacy scratch code' },
    ];
    for (const sc of seedCoupons) {
      const exists = await coupons_.findOne({ code: sc.code });
      if (!exists) {
        await coupons_.insertOne({
          code: sc.code, type: sc.type, value: sc.value,
          minPurchase: sc.minPurchase, expiresAt: null,
          maxUses: sc.maxUses, usedCount: 0, usedBy: [], ownerPhone: null,
          active: true, createdAt: new Date(), note: sc.note || ''
        });
      }
    }
  } catch (err) {
    console.error('Failed to seed marketing coupons:', err);
  }

  await seedRewards();

  // Seed the loyalty economy defaults (earn rate, tiers, redeem tiers, promo
  // odds) so the Admin → Loyalty Controls tab has a real document to edit —
  // without this the settings UI silently fails to persist.
  await seedLoyaltySettings();

  // Seed categories if empty
  try {
    const catCount = await categories_.countDocuments();
    if (catCount === 0) {
      const allProducts = await products_.find().toArray();
      let uniqueProductCats = [...new Set(allProducts.map(p => (p.category || '').trim()).filter(Boolean))];
      if (uniqueProductCats.length === 0) {
        uniqueProductCats = ['Cooking', 'Drinks', 'Snacks', 'Bakery', 'Other'];
      }
      const seedDocs = uniqueProductCats.map(name => ({ name, createdAt: new Date() }));
      await categories_.insertMany(seedDocs);
      console.log(`🌱 Seeded ${seedDocs.length} initial categories`);
    }
  } catch (err) {
    console.error('Failed to seed categories:', err);
  }

  // Warn if M-Pesa env vars are not set
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
    console.warn('⚠️ M-Pesa environment variables (MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY) are not fully configured. M-Pesa payments will fail.');
  }
  if (getMpesaCallbackUrl() === 'https://your-deployed-url.com/api/mpesa/callback') {
    console.warn('⚠️ CALLBACK_URL env var not set. M-Pesa callbacks will not reach your server.');
  }

  if (require.main === module) {
    app.listen(PORT, () => {
    console.log(`🚀 Shop backend running on http://localhost:${PORT}`);
    console.log(`📦 Database initialization complete`);

    // Pre-warm the M-Pesa OAuth token so the FIRST payment doesn't pay an extra
    // ~1-2s for the token round-trip, then refresh every 50 min (cache lasts 55)
    // so a live sale never hits a cold token.
    const mpesaConfigured = MPESA_CONSUMER_KEY && !MPESA_CONSUMER_KEY.startsWith('your_') &&
                            MPESA_CONSUMER_SECRET && !MPESA_CONSUMER_SECRET.startsWith('your_');
    if (mpesaConfigured && process.env.MPESA_MOCK_ENABLED !== 'true') {
      const warm = () => getMpesaToken()
        .then(() => console.log('🔥 M-Pesa token pre-warmed'))
        .catch(e => console.warn('M-Pesa token pre-warm failed:', e.message));
      warm();
      setInterval(warm, 50 * 60 * 1000);
    }
  });
  }
}

if (require.main === module) {
  connectDb().catch(err => {
    console.error('Fatal database setup error:', err);
    setTimeout(() => process.exit(1), 500);
  });
}

// ===== CUSTOMER =====
app.get('/api/products', async (req, res) => {
  try {
    const cacheKey = 'all_products';
    const cached = productCache.get(cacheKey);
    if (cached) return res.json(cached);

    const list = await products_.find().toArray();
    const priced = await applyPricingRules(list);
    
    productCache.set(cacheKey, priced);
    res.json(priced);
  } catch (e) {
    console.error('Failed to fetch products:', e);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
app.get('/api/admin/products', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const list = await products_.find(filter).toArray();
    res.json(await applyPricingRules(list));
  } catch (e) {
    console.error('Failed to fetch products:', e);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
// Customer sign-in is keyed by PHONE NUMBER: every account's shopping record,
// loyalty points, vouchers and debts live under the phone they sign in with.
app.post('/api/auth', authLimiter, async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  let referralBonus = 0;
  try {
    const phoneClean = String(phone).replace(/[^0-9]/g, '');
    const existingCust = await customers_.findOne({ phone: phoneClean });
    if (existingCust) {
      await customers_.updateOne(
        { phone: phoneClean },
        { $set: { name: (name || existingCust.name || '').trim(), lastLoginAt: new Date() } }
      );
    } else {
      const newCust = {
        phone: phoneClean, name: (name || '').trim(),
        createdAt: new Date(), lastLoginAt: new Date(),
        orderCount: 0, totalSpent: 0
      };
      // Referral: when a new shopper signs in with a friend's phone code, BOTH
      // earn bonus loyalty points (once per referred phone — no double dips).
      const refCode = String(req.body.referralCode || '').replace(/[^0-9]/g, '');
      if (refCode && refCode !== phoneClean) {
        try {
          const referrer = await customers_.findOne({ phone: refCode });
          if (referrer && !(Array.isArray(referrer.referrals) && referrer.referrals.includes(phoneClean))) {
            newCust.referredBy = refCode;
            await addLoyaltyPoints(refCode, REFERRER_BONUS_POINTS);
            await customers_.updateOne(
              { phone: refCode },
              { $push: { referrals: phoneClean }, $inc: { referralCount: 1 } }
            );
          }
        } catch (e) { console.error('Referral award failed:', e); }
      }
      await customers_.insertOne(newCust);
      if (newCust.referredBy) {
        await addLoyaltyPoints(phoneClean, REFEREE_BONUS_POINTS);
        referralBonus = REFEREE_BONUS_POINTS;
      }
    }
    const orders = await orders_.find({ customerId: phoneClean }).toArray();
    res.json({ success: true, customerId: phoneClean, returning: !!existingCust || orders.length > 0, message: `Welcome ${name}!`, referralBonus });
  } catch (err) {
    res.json({ success: true, customerId: String(phone).replace(/[^0-9]/g, ''), returning: false, message: `Welcome ${name}!`, referralBonus });
  }
});
app.post('/api/orders', async (req, res) => {
  const { customerId, items, customerName, paymentMethod, deliveryLocation, deliveryFee, gpsCoords, couponCode, discount } = req.body;
  if (!customerId || !items || !items.length) return res.status(400).json({ error: 'Missing data' });
  try {
    const fee = parseFloat(deliveryFee) || 0;
    // Never trust the client's discount amount — recompute it from the coupon
    // on the server so promo discounts can't be faked, AND re-run the full
    // eligibility check (owner phone, already used, expiry, limit) so a used
    // or foreign voucher can never be re-granted at order time.
    let safeDiscount = 0;
    let couponEligible = false;
    if (couponCode) {
      try {
        const cc = String(couponCode).toUpperCase();
        const coupon = await coupons_.findOne({ code: cc, active: true });
        if (coupon) {
          const phoneClean = String(customerId).replace(/[^0-9]/g, '');
          const expired = coupon.expiresAt && new Date(coupon.expiresAt) < new Date();
          const alreadyUsedByMe = Array.isArray(coupon.usedBy) && coupon.usedBy.includes(customerId);
          const foreign = coupon.ownerPhone && String(coupon.ownerPhone) !== phoneClean;
          const limitReached = coupon.maxUses > 0 && (coupon.usedCount || 0) >= coupon.maxUses;
          if (!expired && !alreadyUsedByMe && !foreign && !limitReached) {
            couponEligible = true;
            const itemsTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
            if (coupon.type === 'percent') safeDiscount = itemsTotal * (coupon.value || 0) / 100;
            else if (coupon.type === 'fixed') safeDiscount = coupon.value || 0;
            safeDiscount = Math.min(safeDiscount, itemsTotal + fee);
          }
        }
      } catch (e) { console.error('Failed to recompute discount:', e); }
    }
    const discountAmt = Math.round(safeDiscount * 100) / 100;
    const order = {
      customerId, customerName, items,
      totalPrice: Math.max(0, items.reduce((s, i) => s + i.price * i.quantity, 0) + fee - discountAmt),
      paymentMethod: paymentMethod || 'delivery', status: 'pending', createdAt: new Date(),
      deliveryLocation: deliveryLocation || '',
      deliveryFee: fee,
      gpsCoords: gpsCoords || null,
      gpsAccuracy: (gpsCoords && gpsCoords.accuracy) ? gpsCoords.accuracy : null,
      shopCoords: SHOP_COORDS,
      couponCode: couponCode || null,
      discount: discountAmt,
      deliveryProgress: 0,
      dispatchedAt: null,
      deliveredAt: null
    };
    const result = await orders_.insertOne(order);
    for (const it of items) { const id = it._id || it.id; if (id && ObjectId.isValid(id)) await products_.updateOne({ _id: new ObjectId(id) }, { $inc: { stock: -Math.abs(it.quantity) } }); }

    // Keep the customer's shopping record (keyed by phone) up to date.
    try {
      const cust = await customers_.findOne({ phone: String(customerId).replace(/[^0-9]/g, '') });
      if (cust) {
        await customers_.updateOne(
          { phone: cust.phone },
          { $set: {
              orderCount: (cust.orderCount || 0) + 1,
              totalSpent: Math.round(((cust.totalSpent || 0) + order.totalPrice) * 100) / 100,
              lastOrderAt: new Date(),
              lastLoginAt: new Date()
            } }
        );
      } else {
        await customers_.insertOne({
          phone: String(customerId).replace(/[^0-9]/g, ''), customerName: customerName || '',
          orderCount: 1, totalSpent: order.totalPrice, lastOrderAt: new Date(),
          createdAt: new Date(), lastLoginAt: new Date()
        });
      }
    } catch (e) { console.error('Failed to update customer record:', e); }

    // Consume the voucher so a promo/discount code can only be used once per
    // customer (one-time personal vouchers from the spin wheel / scratch card).
    // Only consumed when the coupon actually qualified for this order.
    if (couponCode && couponEligible) {
      try {
        const cc = String(couponCode).toUpperCase();
        const coupon = await coupons_.findOne({ code: cc });
        if (coupon) {
          const usedBy = Array.isArray(coupon.usedBy) && !coupon.usedBy.includes(customerId)
            ? [...coupon.usedBy, customerId]
            : (coupon.usedBy || []);
          await coupons_.updateOne({ code: cc }, {
            $set: { usedBy, usedCount: (coupon.usedCount || 0) + 1 }
          });
        }
      } catch (e) { console.error('Failed to mark coupon used:', e); }
    }

    console.log('🔔 NEW ORDER:', order.customerName, 'KES', order.totalPrice);
    // Native toasts for the shop PC (Electron) — polled via /api/notifications/feed.
    // No customer name/payment method here — the feed endpoint is unauthenticated
    // (the shop PC polls it), so the body stays free of personally identifying data.
    addFeedEvent({ audience: 'admin', title: '🛒 New Order', body: `New order received — KES ${order.totalPrice}` });
    res.json({ success: true, orderId: result.insertedId, message: 'Order placed! Pay on delivery.' });
  } catch (e) { console.error('Failed to place order:', e); res.status(500).json({ error: 'Failed to place order' }); }
});
app.get('/api/customer-orders/:customerId', async (req, res) => {
  try { res.json(await orders_.find({ customerId: req.params.customerId }).toArray()); } catch (e) { console.error('Failed to fetch orders:', e); res.status(500).json({ error: 'Failed to fetch orders' }); }
});

// ===== JWT AUTH MIDDLEWARE =====

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Permission-based gate for routes the frontend already shows to staff.
// Owner always passes; anyone else must hold the named permission in their
// permissions array (the same list that decides which tabs staff see, e.g.
// the Inventory tab on the phone POS). Keeps the server consistent with the UI.
const requirePermission = (perm) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'owner') return next();
    if (Array.isArray(req.user.permissions) && req.user.permissions.includes(perm)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

// Helper branchFilter definition moved to top level

// ===== USERS & JWT AUTH =====

// Seed / create first owner
app.post('/api/admin/setup', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const existing = await users_.findOne({ role: 'owner' });
    if (existing) return res.status(400).json({ error: 'Owner already exists. Login instead.' });
    const hashed = await bcrypt.hash(password, 10);
    const r = await users_.insertOne({
      username: username.toLowerCase().trim(),
      password: hashed,
      name: (name || username).trim(),
      role: 'owner',
      branchId: null, // owner has no branch
      createdAt: new Date(),
    });
    console.log('👑 Owner account created:', username);
    res.json({ success: true, message: 'Owner account created! You can now login.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create owner' }); }
});

// JWT Login
app.post('/api/admin/login', authLimiter, async (req, res) => {
  let { username, password } = req.body;
  if (!username && password) {
    username = 'owner';
  }
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const userCount = await users_.countDocuments();
    if (userCount === 0) {
      return res.status(401).json({ error: 'No owner account found. Create one first.', needsSetup: true });
    }
    const user = await users_.findOne({ username: username.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username, name: user.name, role: user.role, branchId: user.branchId || null, permissions: user.permissions || [] },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    res.json({ success: true, token, user: { name: user.name, role: user.role, username: user.username, branchId: user.branchId || null, permissions: user.permissions || [] } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

// Verify token
app.get('/api/admin/me', authenticate, async (req, res) => {
  res.json({ success: true, user: { name: req.user.name, role: req.user.role, username: req.user.username, branchId: req.user.branchId || null, permissions: req.user.permissions || [] } });
});

// Create cashier/manager users (owner only, now with branchId)
app.post('/api/admin/users', authenticate, authorize('owner'), async (req, res) => {
  const { username, password, name, role, branchId, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const validRoles = ['cashier', 'manager', 'staff'];
  if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Role must be cashier, manager or staff' });

  // Default permissions if none provided based on role
  let userPermissions = permissions;
  if (!userPermissions || !Array.isArray(userPermissions)) {
    if (role === 'cashier') {
      userPermissions = ['sales'];
    } else if (role === 'staff') {
      userPermissions = ['inventory', 'orders', 'expenses', 'reviews', 'loyalty'];
    } else if (role === 'manager') {
      userPermissions = ['sales', 'inventory', 'orders', 'records', 'expenses', 'credit', 'reviews', 'loyalty'];
    } else {
      userPermissions = ['sales'];
    }
  }

  try {
    const existing = await users_.findOne({ username: username.toLowerCase().trim() });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const r = await users_.insertOne({
      username: username.toLowerCase().trim(),
      password: hashed,
      name: (name || username).trim(),
      role: role || 'cashier',
      branchId: branchId || null,
      permissions: userPermissions,
      createdAt: new Date(),
    });
    res.json({ success: true, userId: r.insertedId, message: `${role || 'cashier'} created!` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create user' }); }
});

// List all users
app.get('/api/admin/users', authenticate, authorize('owner'), async (req, res) => {
  try {
    const users = await users_.find({}, { projection: { password: 0 } }).sort({ createdAt: 1 }).toArray();
    res.json(users);
  } catch (e) { console.error('Failed to fetch users:', e); res.status(500).json({ error: 'Failed to fetch users' }); }
});

// Delete a user
app.delete('/api/admin/users/:userId', authenticate, authorize('owner'), async (req, res) => {
  try {
    const r = await users_.deleteOne({ _id: new ObjectId(req.params.userId) });
    if (!r.deletedCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (e) { console.error('Failed to delete user:', e); res.status(500).json({ error: 'Failed to delete user' }); }
});

// ===== BRANCHES (owner only) =====
app.post('/api/admin/branches', authenticate, authorize('owner'), async (req, res) => {
  const { name, location, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Branch name required' });
  try {
    const r = await branches_.insertOne({ name: name.trim(), location: location || '', phone: phone || '', email: email || '', active: true, createdAt: new Date() });
    res.json({ success: true, branchId: r.insertedId });
  } catch (e) { console.error('Failed to create branch:', e); res.status(500).json({ error: 'Failed to create branch' }); }
});

app.get('/api/admin/branches', authenticate, async (req, res) => {
  try { res.json(await branches_.find().sort({ name: 1 }).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/branches/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const { name, location, phone, email, active } = req.body;
    const u = {};
    if (name !== undefined) u.name = name.trim();
    if (location !== undefined) u.location = location;
    if (phone !== undefined) u.phone = phone;
    if (email !== undefined) u.email = email;
    if (active !== undefined) u.active = active;
    await branches_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: u });
    res.json({ success: true });
  } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/branches/:id', authenticate, authorize('owner'), async (req, res) => {
  try { const r = await branches_.deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

// ---- Online image search via DuckDuckGo (real product photos, no API key needed) ----
async function searchDuckDuckGoImages(query, maxResults = 10) {
  const results = [];
  try {
    // Step 1: Get vqd token from DuckDuckGo's image search page
    const htmlRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await htmlRes.text();
    const vqdMatch = html.match(/vqd=([\w-]+)/);
    if (!vqdMatch) return results;
    const vqd = vqdMatch[1];

    // Step 2: Fetch image results using the vqd token
    const imgRes = await fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${vqd}&o=json&f=,,,&p=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const data = await imgRes.json();

    if (data.results && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (r.image) results.push(r.image);
        if (results.length >= maxResults) break;
      }
    }
  } catch (e) {
    console.error('DuckDuckGo image search failed:', e.message);
  }
  return results;
}

// ---- Shared image search pipeline: OpenFoodFacts → DuckDuckGo → AI fallback ----
// Returns up to 3 image URLs. Used by both the API endpoint and autoFetchProductImage.
// Finds REAL photos BY NAME, only returning a photo when the product's own details
// (brand, product, size) match the words typed — so the picture and the typed
// description line up. Barcode is a fallback only. No AI / no random web images.
async function searchProductImages(name, barcode) {
  const images = [];
  const addImg = (url) => {
    if (url && typeof url === 'string' && !url.startsWith('data:') && !images.includes(url)) images.push(url);
  };
  // fetch with a timeout so a slow source can't hang the finder
  const fetchT = (url, ms = 7000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { headers: { 'User-Agent': 'BlitzMall/1.0' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };
  // Normalise text and glue sizes together ("500 ml" -> "500ml") for matching.
  const STOP = new Set(['the','and','for','with','of','a','an','x','pack','pcs','pc','ml','l','g','kg']);
  const norm = (s) => (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/(\d)\s+(ml|l|g|kg|cl|mg|kgs|pcs)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim();

  // Open Facts family (food, drinks, beauty, household, pet) — real product
  // photos with a searchable catalogue, no API key.
  const FACTS = [
    'https://world.openfoodfacts.org',
    'https://world.openbeautyfacts.org',
    'https://world.openproductsfacts.org',
    'https://world.openpetfoodfacts.org',
  ];

  const qWords = norm(name).split(' ').filter(w => w.length >= 2 && !STOP.has(w));
  const sizeWords = qWords.filter(w => /\d/.test(w));   // 500ml, 1l, 250g …
  const textWords = qWords.filter(w => !/\d/.test(w));  // brand / product words

  // NAME — the primary, strict path. Query EVERY free, no-key image source in
  // parallel, then keep only results whose own text contains the words you typed,
  // so the chosen photo matches your description. Best match first.
  if (qWords.length) {
    // Search by brand/product words (size terms make searches miss); size is
    // still scored below for ranking.
    const searchTerms = textWords.length ? textWords.join(' ') : (name || '').trim();
    const need = Math.max(1, Math.ceil(textWords.length * 0.6)); // a majority of brand/product words must match
    const q = encodeURIComponent(searchTerms);

    // Each source yields { url, text, bonus }. `text` is what we match against;
    // `bonus` prioritises real product packshots (Open Facts) over generic images.
    const sources = [
      // Google Custom Search images — broadest coverage, finds almost anything.
      // Only active when GOOGLE_API_KEY + GOOGLE_CSE_ID env vars are set.
      ...((process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) ? [(async () => {
        try {
          const r = await fetchT(`https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&searchType=image&imgType=photo&num=8&q=${encodeURIComponent((name || '').trim())}`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.items || []).map(it => ({ url: it.link, text: `${it.title || ''} ${it.snippet || ''}`, bonus: 5 })).filter(c => c.url);
        } catch (e) { return []; }
      })()] : []),
      // Open Facts family — real product packshots
      ...FACTS.map((base) => (async () => {
        try {
          const r = await fetchT(`${base}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&fields=product_name,brands,quantity,image_front_url`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.products || []).filter(p => p.image_front_url).map(p => ({
            url: p.image_front_url,
            text: `${p.product_name || ''} ${p.brands || ''} ${p.quantity || ''}`,
            bonus: 6,
          }));
        } catch (e) { return []; }
      })()),
      // Wikimedia Commons — free, no key
      (async () => {
        try {
          const r = await fetchT(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=15&prop=imageinfo&iiprop=url&iiurlwidth=600&format=json&origin=*`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          const pages = d.query && d.query.pages ? Object.values(d.query.pages) : [];
          return pages.map(p => ({
            url: p.imageinfo && p.imageinfo[0] && (p.imageinfo[0].thumburl || p.imageinfo[0].url),
            text: (p.title || '').replace(/^File:/i, '').replace(/\.\w+$/, ''),
            bonus: 1,
          })).filter(c => c.url && /\.(jpe?g|png|webp)$/i.test(c.url));
        } catch (e) { return []; }
      })(),
      // Openverse — aggregates Flickr, Wikimedia, museums and more (free, no key)
      (async () => {
        try {
          const r = await fetchT(`https://api.openverse.org/v1/images/?q=${q}&page_size=15&mature=false`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.results || []).map(x => ({
            url: x.thumbnail || x.url,
            text: `${x.title || ''} ${(x.tags || []).map(t => t.name).join(' ')}`,
            bonus: 0,
          })).filter(c => c.url);
        } catch (e) { return []; }
      })(),
    ];

    const all = (await Promise.all(sources)).flat();
    const scored = [];
    for (const c of all) {
      const text = norm(c.text);
      if (!text) continue;
      const tm = textWords.filter(w => text.includes(w)).length;
      const sm = sizeWords.filter(w => text.includes(w)).length;
      let score;
      if (textWords.length) {
        if (tm < need) continue;          // not enough of your words match — reject
        score = tm * 2 + sm + (c.bonus || 0);
      } else {
        if (sm === 0) continue;
        score = sm + (c.bonus || 0);
      }
      scored.push({ url: c.url, score });
    }
    scored.sort((a, b) => b.score - a.score).forEach(c => { if (images.length < 3) addImg(c.url); });
  }

  // BARCODE — fallback only: if a code happens to be present and the name found
  // nothing, look it up (an exact, guaranteed-correct match).
  if (images.length === 0 && barcode && barcode.trim()) {
    const bc = barcode.trim();
    for (const base of FACTS) {
      if (images.length >= 3) break;
      try {
        const r = await fetchT(`${base}/api/v0/product/${bc}.json`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d.status === 1 && d.product) { addImg(d.product.image_front_url); addImg(d.product.image_url); }
      } catch (e) {}
    }
  }

  // Only photos whose details match what you typed — accuracy over quantity
  // (returns nothing rather than a wrong picture; then you upload manually).
  return images.slice(0, 3);
}

// ---- Rate limiter for public image search endpoint ----
const searchImagesLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image searches. Please wait a moment.', images: [] }
});

// ---- Public endpoint: search product images online by barcode or name ----
app.post('/api/products/search-images', searchImagesLimiter, async (req, res) => {
  const { name, barcode } = req.body;
  if (!name && !barcode) return res.status(400).json({ error: 'Product name or barcode required', images: [] });

  try {
    const images = await searchProductImages(name, barcode);
    res.json({ images });
  } catch (e) {
    console.error('Image search failed:', e.message);
    res.json({ images: [] }); // no fake/AI images — real photos only
  }
});

// ---- Auto-fetch images when adding a product (used internally) ----
async function autoFetchProductImage(name, barcode) {
  try {
    return await searchProductImages(name, barcode);
  } catch (e) {
    console.error('autoFetchProductImage failed:', e.message);
    return []; // no fake/AI images — real photos only
  }
}

// ===== PRODUCTS =====
app.post('/api/admin/products', authenticate, requirePermission('inventory'), async (req, res) => {
  const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate, branchId } = req.body;
  if (!name || price === undefined || price === '') return res.status(400).json({ error: 'Name and selling price required' });
  try {
    const userAgent = req.headers['user-agent'] || '';
    const isMobile = /Mobile|Android|iP(hone|od|ad)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/i.test(userAgent);
    
    const product = {
      name, category: (category || '').trim() || 'Other', barcode: (barcode || '').trim(),
      buyingPrice: parseFloat(buyingPrice) || 0, price: parseFloat(price) || 0, stock: parseInt(stock, 10) || 0,
      description: description || '', image: image || await autoFetchProductImage(name, barcode),
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      branchId: branchId || req.user.branchId || null,
      createdAt: new Date(),
    };
    const result = await products_.insertOne(product);
    productCache.del('all_products');
    res.json({ success: true, productId: result.insertedId, message: 'Product added!' });
  } catch (e) { console.error('Failed to add product:', e); res.status(500).json({ error: 'Failed to add product' }); }
});
app.put('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
  const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate } = req.body;
  try {
    const u = {};
    if (name !== undefined) u.name = name;
    if (category !== undefined) u.category = (category || '').trim() || 'Other';
    if (barcode !== undefined) u.barcode = (barcode || '').trim();
    if (buyingPrice !== undefined) u.buyingPrice = parseFloat(buyingPrice) || 0;
    if (price !== undefined) u.price = parseFloat(price) || 0;
    if (stock !== undefined) u.stock = parseInt(stock, 10) || 0;
    if (description !== undefined) u.description = description;
    if (image !== undefined) u.image = image;
    if (expiryDate !== undefined) u.expiryDate = expiryDate ? new Date(expiryDate) : null;
    const r = await products_.updateOne({ _id: new ObjectId(req.params.productId) }, { $set: u });
    if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
    productCache.del('all_products');
    res.json({ success: true, message: 'Product updated!' });
  } catch (e) { console.error('Failed to update product:', e); res.status(500).json({ error: 'Failed to update product' }); }
});
app.delete('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
  try { const r = await products_.deleteOne({ _id: new ObjectId(req.params.productId) }); if (!r.deletedCount) return res.status(404).json({ error: 'Product not found' }); productCache.del('all_products'); res.json({ success: true });} catch (e) { console.error('Failed to delete product:', e); res.status(500).json({ error: 'Failed to delete product' }); }
});

// ===== CATEGORIES =====
app.get('/api/admin/categories', authenticate, async (req, res) => {
  try {
    const list = await categories_.find().sort({ name: 1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/api/admin/categories', authenticate, requirePermission('inventory'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  const trimmedName = name.trim();
  try {
    // Database-agnostic case-insensitive duplicate check to support FileCollection
    const allCats = await categories_.find().toArray();
    const exists = allCats.some(c => c.name.toLowerCase() === trimmedName.toLowerCase());
    if (exists) return res.status(400).json({ error: 'Category already exists' });
    
    const category = {
      name: trimmedName,
      createdAt: new Date()
    };
    const result = await categories_.insertOne(category);
    res.json({ success: true, category: { _id: result.insertedId, name: trimmedName } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add category' });
  }
});

app.delete('/api/admin/categories/:id', authenticate, requirePermission('inventory'), async (req, res) => {
  try {
    const r = await categories_.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Category not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ===== ORDERS =====
app.get('/api/admin/orders', authenticate, async (req, res) => {
  try { const filter = branchFilter(req); res.json(await orders_.find(filter).sort({ createdAt: -1 }).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.put('/api/admin/orders/:orderId', authenticate, async (req, res) => {
  try {
    const { status, deliveryFee, deliveryProgress } = req.body;
    const update = {};
    if (status !== undefined) {
      update.status = status;
      // Set dispatch timestamp when order goes out for delivery
      if (status === 'on_the_way') {
        const existing = await orders_.findOne({ _id: new ObjectId(req.params.orderId) });
        if (existing && !existing.dispatchedAt) {
          update.dispatchedAt = new Date();
          update.deliveryProgress = 0;
        }
      }
      // Set delivered timestamp and progress to 100 when delivered
      if (status === 'delivered') {
        update.deliveredAt = new Date();
        update.deliveryProgress = 100;
      }
    }
    if (deliveryProgress !== undefined) update.deliveryProgress = deliveryProgress;
    if (deliveryFee !== undefined) {
      const fee = parseFloat(deliveryFee) || 0;
      update.deliveryFee = fee;
      const order = await orders_.findOne({ _id: new ObjectId(req.params.orderId) });
      if (order) {
        const itemsTotal = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
        update.totalPrice = Math.max(0, itemsTotal + fee - (order.discount || 0));
      }
    }
    const r = await orders_.updateOne({ _id: new ObjectId(req.params.orderId) }, { $set: update });
    if (!r.matchedCount) return res.status(404).json({ error: 'Order not found' });
    // Push the customer a status update (fires only when FCM is configured).
    try {
      const updated = await orders_.findOne({ _id: new ObjectId(req.params.orderId) });
      if (updated && updated.customerId) {
        if (updated.status === 'on_the_way') sendPushToPhone(updated.customerId, '🛵 On the way!', 'Your BlitzMall order is out for delivery — it will arrive soon.');
        else if (updated.status === 'delivered') {
          sendPushToPhone(updated.customerId, '✅ Delivered!', 'Your BlitzMall order has been delivered. Enjoy!');
          // Loyalty points: 1 pt per KES 200 of net paid spend, awarded ONCE per
          // completed (delivered) order. Cancelled orders never earn points.
          if (!updated.pointsAwardedAt && (updated.totalPrice || 0) > 0) {
            await earnPoints(updated.customerId, updated.totalPrice);
            await orders_.updateOne({ _id: new ObjectId(req.params.orderId) }, { $set: { pointsAwardedAt: new Date() } });
          }
        }
        else if (updated.status === 'cancelled') sendPushToPhone(updated.customerId, '❌ Order cancelled', 'Your BlitzMall order was cancelled.');
      }
    } catch (e) { console.error('Order status push failed:', e.message); }
    res.json({ success: true });
  } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
});
app.delete('/api/admin/orders/:orderId', authenticate, authorize('owner'), async (req, res) => {
  try {
    const r = await orders_.deleteOne({ _id: new ObjectId(req.params.orderId) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Public tracking endpoint - customers can check delivery status
app.get('/api/orders/:orderId/tracking', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await orders_.findOne({ _id: new ObjectId(req.params.orderId) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
    // Calculate estimated progress based on time elapsed since dispatch
    let estimatedProgress = order.deliveryProgress || 0;
    if (order.status === 'on_the_way' && order.dispatchedAt) {
      const elapsed = (Date.now() - new Date(order.dispatchedAt).getTime()) / 1000; // seconds
      const estimatedDeliveryTime = 20 * 60; // 20 minutes in seconds
      estimatedProgress = Math.min(95, Math.round((elapsed / estimatedDeliveryTime) * 100));
    }
    if (order.status === 'delivered') estimatedProgress = 100;
    
    res.json({
      orderId: order._id,
      status: order.status,
      shopCoords: order.shopCoords || SHOP_COORDS,
      customerCoords: order.gpsCoords,
      deliveryProgress: estimatedProgress,
      dispatchedAt: order.dispatchedAt,
      deliveredAt: order.deliveredAt,
      deliveryLocation: order.deliveryLocation
    });
  } catch (e) { console.error('Failed to fetch tracking:', e); res.status(500).json({ error: 'Failed to fetch tracking' }); }
});

// ===== POS SALES =====
app.post('/api/admin/sales', authenticate, async (req, res) => {
  const { items, paymentMethod, amountGiven, cashPart, mpesaPart, staff, customerPhone, branchId } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items in sale' });
  try {
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const profit = items.reduce((s, i) => s + (i.price - (i.buyingPrice || 0)) * i.qty, 0);
    const given = parseFloat(amountGiven) || 0;
    const sale = {
      items, total, profit, paymentMethod: paymentMethod || 'cash', amountGiven: given,
      cashPart: parseFloat(cashPart) || 0, mpesaPart: parseFloat(mpesaPart) || 0,
      change: paymentMethod === 'cash' && given > total ? +(given - total).toFixed(2) : 0,
      staff: staff || req.user.name || 'Owner',
      cashierUserId: req.user.userId,
      customerPhone: customerPhone || '', channel: 'pos',
      branchId: branchId || req.user.branchId || null,
      createdAt: new Date(),
    };
    const result = await sales_.insertOne(sale);
    for (const it of items) if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: -Math.abs(it.qty) } });
    console.log('🧾 SALE: KES', total, '| by', sale.staff);
    if (sale.customerPhone) earnPoints(sale.customerPhone, total);
    res.json({ success: true, saleId: result.insertedId, change: sale.change, total });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to record sale' }); }
});
app.get('/api/admin/sales', authenticate, async (req, res) => {
  try { const l = parseInt(req.query.limit, 10) || 20; const filter = branchFilter(req); res.json(await sales_.find(filter).sort({ createdAt: -1 }).limit(l).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.delete('/api/admin/sales/:saleId', authenticate, authorize('owner', 'manager'), async (req, res) => {
  try {
    const sale = await sales_.findOne({ _id: new ObjectId(req.params.saleId) });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    for (const it of sale.items) if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty) } });
    // Voiding a sale reverses any loyalty points it earned (anti-abuse).
    if (sale.customerPhone && sale.total) reversePoints(sale.customerPhone, sale.total);
    await sales_.deleteOne({ _id: new ObjectId(req.params.saleId) });
    res.json({ success: true });
  } catch (e) { console.error('Failed to void sale:', e); res.status(500).json({ error: 'Failed to void sale' }); }
});

// ===== EXPENSES =====
app.post('/api/admin/expenses', authenticate, async (req, res) => {
  const { description, amount, branchId } = req.body;
  if (!description || amount === undefined || amount === '') return res.status(400).json({ error: 'Description and amount required' });
  try { const r = await expenses_.insertOne({ description, amount: parseFloat(amount) || 0, createdBy: req.user.name, branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, expenseId: r.insertedId });} catch (e) { console.error('Failed to add expense:', e); res.status(500).json({ error: 'Failed to add expense' }); }
});
app.get('/api/admin/expenses', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await expenses_.find(filter).sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/expenses/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await expenses_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

// ===== CREDIT =====
app.post('/api/admin/credit', authenticate, async (req, res) => {
  const { customerName, phone, amount, note, branchId } = req.body;
  if (!customerName || amount === undefined || amount === '') return res.status(400).json({ error: 'Name and amount required' });
  try { const r = await credit_.insertOne({ customerName, phone: (phone || '').trim(), amount: parseFloat(amount) || 0, note: note || '', paid: false, branchId: branchId || req.user.branchId || null, createdAt: new Date(), paidAt: null }); res.json({ success: true, creditId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/credit', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await credit_.find(filter).sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/credit/:id/pay', authenticate, async (req, res) => { try { const r = await credit_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { paid: true, paidAt: new Date() } }); if (!r.matchedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/credit/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await credit_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

// ===== REVIEWS =====
app.post('/api/reviews', async (req, res) => {
  const { customerId, customerName, rating, message } = req.body;
  if (!rating) return res.status(400).json({ error: 'Rating required' });
  try { const r = await reviews_.insertOne({ customerId: customerId || '', customerName: customerName || 'Customer', rating: Math.max(1, Math.min(5, parseInt(rating, 10) || 0)), message: (message || '').trim(), createdAt: new Date() }); res.json({ success: true, reviewId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/reviews/summary', async (req, res) => {
  try { const all = await reviews_.find().toArray(); const count = all.length; const avg = count ? all.reduce((s, r) => s + (r.rating || 0), 0) / count : 0; res.json({ count, average: Math.round(avg * 10) / 10 }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/reviews', authenticate, async (req, res) => { try { res.json(await reviews_.find().sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/reviews/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await reviews_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

// ===== STAFF =====
app.post('/api/admin/staff', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { name, role, branchId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { const r = await staff_.insertOne({ name: name.trim(), role: role || 'Cashier', branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, staffId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/staff', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await staff_.find(filter).sort({ createdAt: 1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/staff/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await staff_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });

// ===== SUMMARY =====
app.get('/api/admin/summary', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const [sales, orders, expenses, products] = await Promise.all([
      sales_.find(filter).toArray(), orders_.find(filter).toArray(),
      expenses_.find(filter).toArray(), products_.find(filter).toArray()
    ]);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = now.getDay(); const mondayOffset = dow === 0 ? 6 : dow - 1;
    const startWeek = new Date(startToday); startWeek.setDate(startToday.getDate() - mondayOffset);
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startYear = new Date(now.getFullYear(), 0, 1);
    const periods = { today: startToday, week: startWeek, month: startMonth, year: startYear, all: new Date(0) };
    const inP = (d, s) => new Date(d) >= s;
    const calc = (start) => {
      let revenue = 0, profit = 0, cash = 0, mpesa = 0, count = 0;
      for (const s of sales) { if (!inP(s.createdAt, start)) continue; count++; revenue += s.total || 0; profit += s.profit || 0; if (s.paymentMethod === 'cash') cash += s.total || 0; else if (s.paymentMethod === 'mpesa') mpesa += s.total || 0; else if (s.paymentMethod === 'split') { cash += s.cashPart || 0; mpesa += s.mpesaPart || 0; } }
      for (const o of orders) { 
        if (o.status === 'cancelled') continue;
        if (!inP(o.createdAt, start)) continue; 
        count++; 
        revenue += o.totalPrice || 0; 
        let op = 0; 
        for (const it of (o.items || [])) { 
          const q = it.quantity || it.qty || 0; 
          op += ((it.price || 0) - (it.buyingPrice || 0)) * q; 
        } 
        profit += op; 
        if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0; 
        else cash += o.totalPrice || 0; 
      }
      let exp = 0; for (const e of expenses) if (inP(e.createdAt, start)) exp += e.amount || 0;
      return { revenue, profit, expenses: exp, net: profit - exp, cash, mpesa, count };
    };
    const summary = {}; for (const k in periods) summary[k] = calc(periods[k]);
    const tally = {};
    for (const s of sales) for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0);
    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0);
    }
    const best = Object.entries(tally).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 6);
    const low = products.filter(p => p.stock !== undefined && p.stock > 0 && p.stock < 2).map(p => ({ name: p.name, stock: p.stock }));
    const out = products.filter(p => p.stock !== undefined && p.stock <= 0).map(p => ({ name: p.name }));
    const soon = new Date(now.getTime() + 7 * 86400000);
    const expiringSoon = products.filter(p => p.expiryDate && new Date(p.expiryDate) >= now && new Date(p.expiryDate) <= soon).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
    const expired = products.filter(p => p.expiryDate && new Date(p.expiryDate) < now).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
    // Predictions: AI-powered insights
    const predictions = generatePredictions(sales, orders, products, tally);
    res.json({ summary, best, low, out, expiringSoon, expired, predictions });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to build summary' }); }
});

// ===== PREDICTIONS ENGINE =====
function generatePredictions(sales, orders, products, tally) {
  const now = new Date();
  const predictions = { restock: [], slowMoving: [], forecast: [] };

  // Build per-product sales velocity (units sold per day over last 30 days)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const recentSales = [...sales, ...orders].filter(s => new Date(s.createdAt) >= thirtyDaysAgo);
  const velocity = {}; // { productName: unitsPerDay }
  const productMap = {}; // { productName: product }
  for (const p of products) productMap[p.name] = p;

  for (const s of recentSales) {
    for (const it of (s.items || [])) {
      const name = it.name;
      const qty = it.qty || it.quantity || 0;
      if (!name) continue;
      velocity[name] = (velocity[name] || 0) + qty;
    }
  }

  // Calculate daily rate (units/day over 30 days)
  for (const name in velocity) {
    velocity[name] = velocity[name] / 30; // units per day
  }

  // Restock predictions: if stock will run out within 14 days at current rate
  for (const p of products) {
    const name = p.name;
    const stock = p.stock || 0;
    const rate = velocity[name] || 0;
    if (rate > 0 && stock > 0) {
      const daysLeft = stock / rate;
      if (daysLeft <= 14) {
        predictions.restock.push({
          name,
          currentStock: stock,
          dailyRate: Math.round(rate * 100) / 100,
          daysLeft: Math.round(daysLeft * 10) / 10,
          estimatedDate: new Date(now.getTime() + daysLeft * 86400000),
          priority: daysLeft <= 3 ? 'high' : daysLeft <= 7 ? 'medium' : 'low',
        });
      }
    } else if (stock <= 0 && rate > 0) {
      predictions.restock.push({
        name,
        currentStock: 0,
        dailyRate: Math.round(rate * 100) / 100,
        daysLeft: 0,
        estimatedDate: now,
        priority: 'critical',
      });
    }
  }

  // Sort restock by most urgent
  predictions.restock.sort((a, b) => a.daysLeft - b.daysLeft);

  // Slow-moving: products with rate < 1 unit per day and stock > 10
  for (const p of products) {
    const name = p.name;
    const stock = p.stock || 0;
    const rate = velocity[name] || 0;
    if (rate > 0 && rate < 1 && stock >= 10) {
      predictions.slowMoving.push({
        name,
        currentStock: stock,
        monthlyRate: Math.round(rate * 30),
      });
    }
  }
  predictions.slowMoving.sort((a, b) => a.monthlyRate - b.monthlyRate);

  // 7-day sales forecast: simple moving average
  const last7Days = [...sales, ...orders].filter(s => new Date(s.createdAt) >= new Date(now.getTime() - 7 * 86400000));
  const dailyRevenue = {};
  for (const s of last7Days) {
    const day = new Date(s.createdAt).toISOString().slice(0, 10);
    dailyRevenue[day] = (dailyRevenue[day] || 0) + (s.total || s.totalPrice || 0);
  }
  const dayValues = Object.values(dailyRevenue);
  const avgDaily = dayValues.length > 0 ? dayValues.reduce((a, b) => a + b, 0) / dayValues.length : 0;
  predictions.forecast = {
    next7Days: Math.round(avgDaily * 7),
    avgDaily: Math.round(avgDaily * 100) / 100,
    dataPoints: dayValues.length,
  };

  return predictions;
}

// Standalone predictions endpoint
app.get('/api/admin/predictions', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const [sales, orders, products] = await Promise.all([
      sales_.find(filter).toArray(), orders_.find(filter).toArray(), products_.find(filter).toArray()
    ]);
    const tally = {};
    for (const s of sales) for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0);
    for (const o of orders) for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0);
    res.json(generatePredictions(sales, orders, products, tally));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// ===== EXPORT =====
app.get('/api/admin/export', authenticate, async (req, res) => {
  try {
    const [products, orders, sales, expenses, credit, reviews, staff] = await Promise.all([
      products_.find().toArray(), orders_.find().toArray(), sales_.find().toArray(),
      expenses_.find().toArray(), credit_.find().toArray(), reviews_.find().toArray(), staff_.find().toArray(),
    ]);
    res.json({ shop: 'Brilliant / Blitz Mall', exportedAt: new Date(), products, orders, sales, expenses, credit, reviews, staff });
  } catch (e) { console.error('Failed to export:', e); res.status(500).json({ error: 'Failed to export' }); }
});

// ===== LOYALTY & REWARDS =====
// Referral rewards — a shopper who brings a friend earns bonus loyalty points
// for BOTH of them, once per new friend (see /api/auth).
const REFERRER_BONUS_POINTS = 100;
const REFEREE_BONUS_POINTS = 50;

// ===== LOYALTY ENGINE (business-first, settings-driven) =====
// Every rate/threshold/probability below lives in loyalty_settings_ so the
// owner can retune the economics from the Admin → Loyalty Controls tab without
// a code change. Defaults match the owner's spec:
//   - 1 point per KES 200 of NET paid spend, floored (KES 199 = 0 pts)
//   - 100 points redeem for KES 100 (higher tiers slightly better value)
//   - Tiers by points: Bronze 0-199 / Silver 200-599 / Gold 600-1499 / Platinum 1500+
//   - Spin: 2 paid orders gate, 1 spin / 24h; Scratch: 2 orders, 1 / 48h
const LOYALTY_SETTINGS_DEFAULTS = {
  earnRate: 200, // KES spent per 1 point
  tierThresholds: { silver: 200, gold: 600, platinum: 1500 },
  redeemTiers: [
    { points: 100, value: 100 },
    { points: 250, value: 250 },
    { points: 500, value: 600 },
    { points: 1000, value: 1300 }
  ],
  jackpotEnabled: true,
  spinCooldownHours: 24,
  scratchCooldownHours: 48,
  minOrdersForPromo: 2,
  seasonalEvents: [] // { name, pointsMultiplier, active }
};

let loyaltySettingsCache = null;
async function getLoyaltySettings() {
  if (loyaltySettingsCache) return loyaltySettingsCache;
  try {
    const doc = loyalty_settings_ ? await loyalty_settings_.findOne({ key: 'default' }) : null;
    const stored = (doc && doc.value) || {};
    loyaltySettingsCache = {
      ...LOYALTY_SETTINGS_DEFAULTS,
      ...stored,
      // Probabilities are owner-editable: fall back to the code constants when
      // the stored settings don't carry a weight table yet.
      spinWeights: Array.isArray(stored.spinWeights) ? stored.spinWeights : WHEEL_SECTORS.map(o => ({ prize: o.prize, weight: o.weight })),
      scratchWeights: Array.isArray(stored.scratchWeights) ? stored.scratchWeights : SCRATCH_OUTCOMES.map(o => ({ prize: o.prize, weight: o.weight }))
    };
  } catch (e) { loyaltySettingsCache = { ...LOYALTY_SETTINGS_DEFAULTS }; }
  return loyaltySettingsCache;
}
const saveLoyaltySettings = async (value) => {
  loyaltySettingsCache = null;
  if (!loyalty_settings_) return;
  // findOne → insertOne fallback keeps saves working even in offline mock mode,
  // where updateOne's upsert option is not supported (silent no-op otherwise).
  const existing = await loyalty_settings_.findOne({ key: 'default' });
  if (existing) await loyalty_settings_.updateOne({ key: 'default' }, { $set: { value, updatedAt: new Date() } });
  else await loyalty_settings_.insertOne({ key: 'default', value, updatedAt: new Date() });
};
const seedLoyaltySettings = async () => {
  try {
    if (!loyalty_settings_) return;
    const exists = await loyalty_settings_.findOne({ key: 'default' });
    if (!exists) await loyalty_settings_.insertOne({ key: 'default', value: LOYALTY_SETTINGS_DEFAULTS, updatedAt: new Date() });
  } catch (e) { console.error('Failed to seed loyalty settings:', e); }
};

// Tier is driven by the POINTS balance (never by spend, so tiers can't be
// gamed by high-value single orders). Kept as a named export for the tests.
const tierFromPoints = (points) => {
  const p = points || 0;
  if (p >= 1500) return 'Platinum';
  if (p >= 600) return 'Gold';
  if (p >= 200) return 'Silver';
  return 'Bronze';
};
const customerTier = tierFromPoints;

// Core award — 1 point per earnRate KES of NET paid spend, floored.
// ONLY call for completed + paid transactions (delivered orders, POS sales).
// Cancelled/refunded orders never reach here, and refunds call reversePoints.
async function earnPoints(phone, netSpent) {
  if (!phone || !netSpent || netSpent <= 0) return 0;
  try {
    const s = await getLoyaltySettings();
    let pts = Math.floor(netSpent / (s.earnRate || 200));
    // Seasonal event multiplier (e.g. 2x promo weekend) — off by default.
    const events = (s.seasonalEvents || []).filter(e => e && e.active && parseFloat(e.pointsMultiplier) > 1);
    for (const ev of events) pts = Math.floor(pts * parseFloat(ev.pointsMultiplier));
    if (pts <= 0) return 0;
    const existing = await loyalty_.findOne({ phone });
    if (existing) {
      const newTotal = (existing.totalSpent || 0) + netSpent;
      const newPoints = (existing.points || 0) + pts;
      await loyalty_.updateOne({ phone }, { $set: { totalSpent: newTotal, points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
    } else {
      await loyalty_.insertOne({ phone, customerName: '', totalSpent: netSpent, points: pts, tier: tierFromPoints(pts), createdAt: new Date(), updatedAt: new Date() });
    }
    return pts;
  } catch (e) { console.error('Loyalty error:', e); return 0; }
}

// Reverse points earned on a refund/void (never below zero — no farming).
async function reversePoints(phone, netSpent) {
  if (!phone || !netSpent || netSpent <= 0) return;
  try {
    const s = await getLoyaltySettings();
    const pts = Math.floor(netSpent / (s.earnRate || 200));
    if (pts <= 0) return;
    const existing = await loyalty_.findOne({ phone });
    if (!existing) return;
    const newPoints = Math.max(0, (existing.points || 0) - pts);
    await loyalty_.updateOne({ phone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
  } catch (e) { console.error('Reverse loyalty error:', e); }
}

app.get('/api/admin/loyalty/:phone', authenticate, async (req, res) => {
  try {
    const entry = await loyalty_.findOne({ phone: req.params.phone });
    if (!entry) return res.json({ exists: false, message: 'No loyalty record found' });
    res.json({ exists: true, phone: entry.phone, customerName: entry.customerName, totalSpent: entry.totalSpent, points: entry.points, tier: entry.tier });
  } catch (e) { console.error('Failed to lookup loyalty:', e); res.status(500).json({ error: 'Failed to lookup loyalty' }); }
});

app.put('/api/admin/loyalty/:phone', authenticate, async (req, res) => {
  try {
    const r = await loyalty_.updateOne({ phone: req.params.phone }, { $set: { customerName: req.body.customerName || '' } });
    res.json({ success: true });
  } catch (e) { console.error('Failed to update:', e); res.status(500).json({ error: 'Failed to update' }); }
});

app.get('/api/admin/loyalty', authenticate, async (req, res) => {
  try { res.json(await loyalty_.find().sort({ totalSpent: -1 }).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/loyalty/redeem', authenticate, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const entry = await loyalty_.findOne({ phone: String(phone).replace(/[^0-9]/g, '') });
    if (!entry) return res.status(404).json({ error: 'Customer not found' });
    const s = await getLoyaltySettings();
    const tiers = (s.redeemTiers || []).slice().sort((a, b) => a.points - b.points);
    // Pick the biggest tier the member's balance covers (min redemption = 100).
    const chosen = [...tiers].reverse().find(t => (entry.points || 0) >= t.points);
    if (!chosen) return res.status(400).json({ error: 'Not enough points — minimum redemption is 100 points' });
    const remaining = (entry.points || 0) - chosen.points;
    await loyalty_.updateOne({ phone: entry.phone }, { $inc: { points: -chosen.points }, $set: { tier: tierFromPoints(remaining), updatedAt: new Date() } });
    const code = 'LOYALTY_' + Math.random().toString(36).substring(2, 8).toUpperCase();
    await coupons_.insertOne({
      code, type: 'fixed', value: chosen.value, minPurchase: 0,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      maxUses: 1, usedCount: 0, usedBy: [], ownerPhone: entry.phone,
      active: true, createdAt: new Date(), source: 'loyalty'
    });
    await redemptions_.insertOne({ customerId: entry.phone, rewardName: `KES ${chosen.value} Discount Coupon`, pointsSpent: chosen.points, rewardValue: chosen.value, redeemedAt: new Date() });
    res.json({ success: true, code, pointsSpent: chosen.points, message: `Redeemed ${chosen.points} points for a KES ${chosen.value} coupon!` });
  } catch (e) { console.error('Failed to redeem:', e); res.status(500).json({ error: 'Failed to redeem' }); }
});

app.post('/api/admin/loyalty/add-points', async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'Phone and points required' });
  try {
    const existing = await loyalty_.findOne({ phone });
    if (existing) {
      const newPoints = Math.max(0, (existing.points || 0) + parseInt(points));
      await loyalty_.updateOne({ phone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
      res.json({ success: true, points: newPoints });
    } else {
      await loyalty_.insertOne({
        phone,
        customerName: '',
        totalSpent: 0,
        points: Math.max(0, parseInt(points)),
        tier: tierFromPoints(parseInt(points)),
        createdAt: new Date(),
        updatedAt: new Date()
      });
      res.json({ success: true, points: parseInt(points) });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add points' }); }
});

// ===== COUPONS =====
app.post('/api/admin/coupons', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { code, type, value, minPurchase, expiresAt, maxUses } = req.body;
  if (!code || !type || value === undefined) return res.status(400).json({ error: 'Code, type and value required' });
  try {
    const existing = await coupons_.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(400).json({ error: 'Coupon code already exists' });
    const r = await coupons_.insertOne({
      code: code.toUpperCase(), type: type, value: parseFloat(value) || 0,
      minPurchase: parseFloat(minPurchase) || 0, expiresAt: expiresAt ? new Date(expiresAt) : null,
      maxUses: parseInt(maxUses, 10) || 0, usedCount: 0, active: true, createdAt: new Date(),
    });
    res.json({ success: true, couponId: r.insertedId });
  } catch (e) { console.error('Failed to create coupon:', e); res.status(500).json({ error: 'Failed to create coupon' }); }
});
app.get('/api/admin/coupons', authenticate, async (req, res) => { try { res.json(await coupons_.find().sort({ createdAt: -1 }).toArray()); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/coupons/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await coupons_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active: req.body.active } }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/coupons/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await coupons_.deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ success: true }); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); } });
app.post('/api/coupons/validate', async (req, res) => {
  const { code, total, phone } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const phoneClean = String(phone || '').replace(/[^0-9]/g, '');
    const coupon = await coupons_.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code', valid: false });
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return res.json({ valid: false, error: 'Coupon expired' });
    // Personal vouchers (spin wheel / scratch card / loyalty) are bound to the
    // phone that won them — they must not work for anyone else.
    if (coupon.ownerPhone && String(coupon.ownerPhone) !== phoneClean) {
      return res.json({ valid: false, error: 'This voucher is linked to a different account' });
    }
    if (Array.isArray(coupon.usedBy) && (coupon.usedBy.includes(phone) || coupon.usedBy.includes(phoneClean))) {
      return res.json({ valid: false, error: 'This voucher was already used' });
    }
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) return res.json({ valid: false, error: 'Coupon usage limit reached' });
    if (total < coupon.minPurchase) return res.json({ valid: false, error: `Minimum purchase KES ${coupon.minPurchase} required` });
    let discount = 0;
    if (coupon.type === 'percent') discount = total * coupon.value / 100;
    else if (coupon.type === 'fixed') discount = coupon.value;
    else if (coupon.type === 'free_delivery') discount = 0; // frontend zeroes the delivery fee
    discount = Math.min(discount, total);
    res.json({ valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount: Math.round(discount * 100) / 100, campaignId: coupon._id, minPurchase: coupon.minPurchase || 0 });
  } catch (e) { console.error('Failed to validate coupon:', e); res.status(500).json({ error: 'Failed to validate' }); }
});

// ===== CUSTOMER ACCOUNT (keyed by phone number) =====
// A customer's shopping record, debts and vouchers all live under the phone
// they sign in with — no separate accounts, no way to game the system.
// ===== LOYALTY ADMIN CONTROLS (owner/manager) =====
// Owner can retune the whole loyalty economy, award or claw back points, and
// watch the business maths (reward cost vs sales) without a code deploy.
app.get('/api/admin/loyalty/settings', authenticate, async (req, res) => {
  try { res.json(await getLoyaltySettings()); }
  catch (e) { console.error('Failed to load loyalty settings:', e); res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/loyalty/settings', authenticate, authorize('owner', 'manager'), async (req, res) => {
  try {
    const current = await getLoyaltySettings();
    const next = { ...current, ...(req.body || {}) };
    // Basic sanity: earnRate and thresholds must be positive numbers.
    if (!(parseFloat(next.earnRate) > 0)) return res.status(400).json({ error: 'earnRate must be a positive number' });
    next.earnRate = parseFloat(next.earnRate);
    next.jackpotEnabled = !!next.jackpotEnabled;
    if (next.tierThresholds) {
      const t = next.tierThresholds;
      if (!(parseFloat(t.silver) > 0 && parseFloat(t.gold) > parseFloat(t.silver) && parseFloat(t.platinum) > parseFloat(t.gold))) {
        return res.status(400).json({ error: 'Tier thresholds must be ascending' });
      }
    }
    // Sanitise the owner-editable odds tables (fall back to defaults if broken).
    for (const key of ['spinWeights', 'scratchWeights']) {
      if (Array.isArray(next[key])) {
        next[key] = next[key]
          .filter(x => x && typeof x.weight === 'number' && x.weight >= 0)
          .map(x => ({ prize: String(x.prize), weight: x.weight }));
      } else {
        delete next[key];
      }
    }
    await saveLoyaltySettings(next);
    res.json({ success: true, settings: next });
  } catch (e) { console.error('Failed to save loyalty settings:', e); res.status(500).json({ error: 'Failed' }); }
});

// Manual bonus points OR claw-back (negative points, e.g. removing fraud).
app.post('/api/admin/loyalty/manual-points', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { phone, points, reason } = req.body;
  const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '') : '';
  const pts = parseInt(points, 10);
  if (!cleanPhone || !pts) return res.status(400).json({ error: 'Phone and points (positive or negative) required' });
  try {
    const existing = await loyalty_.findOne({ phone: cleanPhone });
    if (!existing && pts < 0) return res.status(404).json({ error: 'No loyalty record to claw back from' });
    const newPoints = Math.max(0, (existing ? existing.points || 0 : 0) + pts);
    if (existing) {
      await loyalty_.updateOne({ phone: cleanPhone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
    } else {
      await loyalty_.insertOne({ phone: cleanPhone, customerName: '', totalSpent: 0, points: newPoints, tier: tierFromPoints(newPoints), createdAt: new Date(), updatedAt: new Date() });
    }
    await redemptions_.insertOne({ customerId: cleanPhone, rewardName: `Manual ${pts > 0 ? 'bonus' : 'adjustment'} — ${(reason || '').slice(0, 120)}`, pointsSpent: 0, rewardValue: 0, manualPoints: pts, reason: reason || '', redeemedAt: new Date() });
    res.json({ success: true, points: newPoints });
  } catch (e) { console.error('Failed to adjust points:', e); res.status(500).json({ error: 'Failed' }); }
});

// Loyalty economics: redemption stats, reward cost vs sales, customer LTV.
app.get('/api/admin/loyalty/stats', authenticate, async (req, res) => {
  try {
    const members = await loyalty_.find().toArray();
    const redemptions = await redemptions_.find().sort({ redeemedAt: -1 }).toArray();
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const recentRedemptions = redemptions.filter(r => r.redeemedAt && new Date(r.redeemedAt) >= since30);
    const rewardCost30d = recentRedemptions.reduce((s, r) => s + (r.rewardValue || 0), 0);
    const [sales30, orders30] = await Promise.all([
      sales_.find({ createdAt: { $gte: since30 } }).toArray(),
      orders_.find({ createdAt: { $gte: since30 } }).toArray()
    ]);
    const salesRevenue30d = sales30.reduce((s, x) => s + (x.total || 0), 0) +
      orders30.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.totalPrice || 0), 0);
    res.json({
      memberCount: members.length,
      totalPointsOut: members.reduce((s, m) => s + (m.points || 0), 0),
      redemptions: redemptions.length,
      redemptionCount30d: recentRedemptions.length,
      rewardCost30d: Math.round(rewardCost30d * 100) / 100,
      salesRevenue30d: Math.round(salesRevenue30d * 100) / 100,
      rewardCostPct: salesRevenue30d > 0 ? Math.round((rewardCost30d / salesRevenue30d) * 10000) / 100 : 0,
      topCustomers: members.slice().sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0)).slice(0, 10)
        .map(m => ({ phone: m.phone, name: m.customerName || '', points: m.points || 0, totalSpent: Math.round((m.totalSpent || 0) * 100) / 100, tier: m.tier })),
      recentRedemptions: recentRedemptions.slice(0, 20).map(r => ({
        customerId: r.customerId, rewardName: r.rewardName, pointsSpent: r.pointsSpent, rewardValue: r.rewardValue,
        manualPoints: r.manualPoints || 0, redeemedAt: r.redeemedAt
      }))
    });
  } catch (e) { console.error('Loyalty stats failed:', e); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/customers/:phone', async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const cust = await customers_.findOne({ phone });
    const orders = await orders_.find({ customerId: phone }).toArray();
    const active = orders.filter(o => o.status !== 'cancelled');
    const totalSpent = active.reduce((s, o) => s + (o.totalPrice || 0), 0);
    const credits = await credit_.find({ phone }).toArray();
    const outstandingDebt = credits.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0);
    const loyalty = await loyalty_.findOne({ phone });
    const vouchers = await coupons_.find({ ownerPhone: phone, active: true }).toArray();
    const tier = loyalty ? tierFromPoints(loyalty.points) : 'Bronze';
    // Effective redemption tiers (owner-tunable in Admin → Loyalty Controls) so
    // the app's "best coupon" display always matches what the store redeems.
    const loyaltySettings = await getLoyaltySettings();
    const redeemTiers = (loyaltySettings && Array.isArray(loyaltySettings.redeemTiers)) ? loyaltySettings.redeemTiers : null;
    res.json({
      exists: !!cust || active.length > 0,
      phone,
      isOwner: !!(cust && cust.isOwner),
      redeemTiers,
      referralCode: phone,
      referralCount: cust ? cust.referralCount || 0 : 0,
      referredBy: cust ? cust.referredBy || null : null,
      name: (cust && cust.name) || (active.length ? active[active.length - 1].customerName : '') || '',
      memberSince: cust && cust.createdAt ? cust.createdAt : null,
      orderCount: active.length,
      totalSpent: Math.round(totalSpent * 100) / 100,
      outstandingDebt: Math.round(outstandingDebt * 100) / 100,
      loyaltyPoints: loyalty ? loyalty.points || 0 : 0,
      loyaltyTier: loyalty ? loyalty.tier : tier,
      tier,
      vouchers: vouchers.map(v => ({
        code: v.code, type: v.type, value: v.value, minPurchase: v.minPurchase || 0,
        used: (Array.isArray(v.usedBy) && v.usedBy.includes(phone)),
        expiresAt: v.expiresAt || null
      }))
    });
  } catch (e) { console.error('Failed to load customer profile:', e); res.status(500).json({ error: 'Failed to load profile' }); }
});

// ===== PROMOS: SPIN WHEEL + SCRATCH CARD =====
// Everything is decided server-side so the odds can't be cheated, discounts
// are only handed to real shoppers (tier is derived from the phone-number
// shopping record), and every voucher is bound to the winning phone, valid for
// a single use. Codes issued here therefore ALWAYS work at checkout.
// "Once per day" follows the shop's local day (Africa/Nairobi), matching the
// messages the app shows customers (kept for display; cooldowns are now a
// rolling 24h/48h window, not calendar days).
const promoDayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

// 12 wheel outcomes — the prize table from the owner spec. `weight` is the
// probability out of 100. sectorIndex maps each outcome to a wheel slice for
// the spin animation (the client renders 12 slices from the same array).
const WHEEL_SECTORS = [
  { label: 'TRY AGAIN', color: '#3a3a46', prize: 'again', title: 'So Close!', message: 'No luck today — come back in 24h for another spin.', sectorIndex: 0, weight: 45 },
  { label: 'TRY AGAIN', color: '#3a3a46', prize: 'again', title: 'So Close!', message: 'No luck today — come back in 24h for another spin.', sectorIndex: 1, weight: 20 },
  { label: '1 POINT', color: '#30d158', prize: 'points1', points: 1, title: '1 Loyalty Point!', message: 'You won 1 loyalty point — it was added to your account.', sectorIndex: 2, weight: 10 },
  { label: '2 POINTS', color: '#30d158', prize: 'points2', points: 2, title: '2 Loyalty Points!', message: 'You won 2 loyalty points — they were added to your account.', sectorIndex: 3, weight: 8 },
  { label: '3 POINTS', color: '#30d158', prize: 'points3', points: 3, title: '3 Loyalty Points!', message: 'You won 3 loyalty points — they were added to your account.', sectorIndex: 4, weight: 5 },
  { label: '5 POINTS', color: '#30d158', prize: 'points5', points: 5, title: '5 Loyalty Points!', message: 'You won 5 loyalty points — they were added to your account.', sectorIndex: 5, weight: 4 },
  { label: 'KES 50 OFF', color: '#bf5af2', prize: 'fixed50', type: 'fixed', value: 50, minPurchase: 300, title: 'KES 50 Off Unlocked!', message: 'You won KES 50 off! Valid on orders over KES 300.', sectorIndex: 6, weight: 3 },
  { label: '10 POINTS', color: '#ffd60a', prize: 'points10', points: 10, title: '10 Loyalty Points!', message: 'You won 10 loyalty points — they were added to your account.', sectorIndex: 7, weight: 2 },
  { label: 'FREE DELIVERY', color: '#64d2ff', prize: 'delivery', type: 'free_delivery', value: 0, minPurchase: 300, title: 'Free Delivery!', message: 'You won free delivery on your next order (over KES 300).', sectorIndex: 8, weight: 1.5 },
  { label: 'KES 100 OFF', color: '#ff9f0a', prize: 'fixed100', type: 'fixed', value: 100, minPurchase: 500, title: 'KES 100 Off Unlocked!', message: 'You won KES 100 off! Valid on orders over KES 500.', sectorIndex: 9, weight: 1 },
  { label: '25 POINTS', color: '#30d158', prize: 'points25', points: 25, title: '25 Loyalty Points!', message: 'You won 25 loyalty points — they were added to your account.', sectorIndex: 10, weight: 0.4 },
  { label: 'JACKPOT', color: '#ff2d55', prize: 'jackpot', points: 100, title: '🎰 JACKPOT — 100 Points!', message: 'You hit the jackpot! 100 loyalty points were added.', sectorIndex: 11, weight: 0.1, jackpot: true },
];

// Scratch card outcomes (server decides what's under the foil). Mostly a miss,
// small points, rare coupons, very rare jackpot.
const SCRATCH_OUTCOMES = [
  { prize: 'lose', label: 'TRY AGAIN', title: 'Better Luck Tomorrow!', message: 'No prize this time — scratch again in 48h.', weight: 64 },
  { prize: 'points1', points: 1, title: '1 Loyalty Point!', message: 'You won 1 loyalty point!', weight: 10 },
  { prize: 'points2', points: 2, title: '2 Loyalty Points!', message: 'You won 2 loyalty points!', weight: 8 },
  { prize: 'points3', points: 3, title: '3 Loyalty Points!', message: 'You won 3 loyalty points!', weight: 6 },
  { prize: 'points4', points: 4, title: '4 Loyalty Points!', message: 'You won 4 loyalty points!', weight: 5 },
  { prize: 'points5', points: 5, title: '5 Loyalty Points!', message: 'You won 5 loyalty points!', weight: 3 },
  { prize: 'fixed50', type: 'fixed', value: 50, minPurchase: 300, title: 'KES 50 Discount Unlocked!', message: 'You won KES 50 off! Valid on orders over KES 300.', weight: 1.5 },
  { prize: 'fixed100', type: 'fixed', value: 100, minPurchase: 500, title: 'KES 100 Discount Unlocked!', message: 'You won KES 100 off! Valid on orders over KES 500.', weight: 1 },
  { prize: 'delivery', type: 'free_delivery', value: 0, minPurchase: 300, title: 'Free Delivery Unlocked!', message: 'You won free delivery on your next order (over KES 300).', weight: 1 },
  { prize: 'jackpot', points: 100, title: '🎰 JACKPOT — 100 Points!', message: 'Jackpot! 100 loyalty points were added.', weight: 0.5, jackpot: true },
];

function pickWeighted(list, tier, jackpotEnabled = true) {
  // Higher tiers get slightly better odds: the two "nothing" outcomes shrink
  // and the weight is gifted to small-point outcomes (never increases the
  // normal point earning rate). Jackpots can be switched off in settings.
  const shift = tier === 'Platinum' ? 10 : tier === 'Gold' ? 6 : tier === 'Silver' ? 3 : 0;
  const weighted = list
    .map((item) => {
      let w = item.weight || 0;
      if (item.jackpot && !jackpotEnabled) w = 0;
      else if ((item.prize === 'again' || item.prize === 'lose') && shift > 0) w = Math.max(0, w - shift);
      else if (item.points && !item.jackpot && shift > 0) w = w + shift / 3;
      return { item, w };
    })
    .filter(x => x.w > 0);
  const total = weighted.reduce((s, x) => s + x.w, 0);
  if (!total) return list[0];
  let roll = Math.random() * total;
  for (const x of weighted) {
    roll -= x.w;
    if (roll <= 0) return x.item;
  }
  return weighted[weighted.length - 1].item;
}

async function addLoyaltyPoints(phone, points) {
  if (!points) return;
  try {
    const existing = await loyalty_.findOne({ phone });
    if (existing) {
      const newPoints = (existing.points || 0) + points;
      await loyalty_.updateOne({ phone }, { $set: { points: newPoints, tier: tierFromPoints(newPoints), updatedAt: new Date() } });
    } else {
      await loyalty_.insertOne({ phone, customerName: '', totalSpent: 0, points, tier: tierFromPoints(points), createdAt: new Date(), updatedAt: new Date() });
    }
  } catch (e) { console.error('Failed to add loyalty points:', e); }
}

async function issueVoucher({ phone, type, value, minPurchase, prefix }) {
  const code = (prefix || 'PROMO') + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  await coupons_.insertOne({
    code,
    type: type || 'fixed',
    value: value || 0,
    minPurchase: minPurchase || 0,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    maxUses: 1,
    usedCount: 0,
    usedBy: [],
    ownerPhone: String(phone).replace(/[^0-9]/g, ''),
    active: true,
    createdAt: new Date(),
    source: 'promo'
  });
  return code;
}

async function runPromo({ phone, name, type }) {
  const phoneClean = String(phone || '').replace(/[^0-9]/g, '');
  if (!phoneClean) return { success: false, error: 'Phone required' };
  const s = await getLoyaltySettings();
  const cooldownHours = type === 'spin' ? (s.spinCooldownHours || 24) : (s.scratchCooldownHours || 48);
  const cooldownMs = cooldownHours * 3600 * 1000;
  const day = promoDayKey();

  // Rolling cooldown window (24h spin / 48h scratch) — not calendar days.
  const claimed = await promo_claims_.findOne({ phone: phoneClean, type, at: { $gt: new Date(Date.now() - cooldownMs) } });
  if (claimed) {
    const nextAt = new Date(new Date(claimed.at).getTime() + cooldownMs);
    return {
      success: false, alreadyUsed: true, day, nextAt,
      tier: claimed.tier || 'Bronze',
      prizeName: claimed.prizeName || 'again',
      title: claimed.title || '', message: claimed.message || `Already claimed — come back in ${cooldownHours}h!`,
      code: claimed.code || '', pointsAdded: claimed.pointsAdded || 0,
      sectorIndex: claimed.sectorIndex !== undefined ? claimed.sectorIndex : 1
    };
  }

  // Anti-abuse gate: at least two completed (non-cancelled) orders required.
  const orders = await orders_.find({ customerId: phoneClean }).toArray();
  const completed = orders.filter(o => o.status !== 'cancelled');
  if (completed.length < (s.minOrdersForPromo || 2)) {
    return {
      success: false,
      error: type === 'spin' ? 'Complete two purchases to unlock Lucky Spin.' : 'Complete two purchases to unlock the Scratch Card.',
      orderCount: completed.length, minOrders: s.minOrdersForPromo || 2
    };
  }

  const loyalty = await loyalty_.findOne({ phone: phoneClean });
  const tier = tierFromPoints(loyalty ? loyalty.points : 0);

  // Build the outcome table from the owner-editable settings weights.
  const table = type === 'spin' ? WHEEL_SECTORS : SCRATCH_OUTCOMES;
  const weightList = type === 'spin' ? (s.spinWeights || []) : (s.scratchWeights || []);
  const list = table.map(o => {
    const w = (weightList.find(x => x && x.prize === o.prize) || {}).weight;
    return { ...o, weight: typeof w === 'number' ? w : o.weight };
  });
  const picked = pickWeighted(list, tier, s.jackpotEnabled !== false);
  let code = '', pointsAdded = 0;
  let title = picked.title || '', message = picked.message || '';

  if (picked.prize === 'again' || picked.prize === 'lose') {
    // nothing — intentionally. Most players should win nothing or very little.
  } else if (picked.points) {
    pointsAdded = picked.points;
    await addLoyaltyPoints(phoneClean, pointsAdded);
  } else {
    code = await issueVoucher({ phone: phoneClean, type: picked.type, value: picked.value, minPurchase: picked.minPurchase, prefix: type === 'spin' ? 'SPIN' : 'SCR' });
  }

  try {
    await promo_claims_.insertOne({
      phone: phoneClean, name: (name || '').trim(), type, day, tier, at: new Date(),
      prizeName: picked.prize, title, message, code, pointsAdded,
      sectorIndex: picked.sectorIndex !== undefined ? picked.sectorIndex : null,
      createdAt: new Date()
    });
  } catch (e) { console.error('Failed to record promo claim:', e); }

  return {
    success: true, alreadyUsed: false, day, tier,
    prizeName: picked.prize, title, message,
    code, type: picked.type || '', value: picked.value || 0,
    minPurchase: picked.minPurchase || 0, pointsAdded, sectorIndex: picked.sectorIndex
  };
}

app.post('/api/promos/spin', async (req, res) => {
  try {
    const r = await runPromo({ phone: req.body.phone, name: req.body.name, type: 'spin' });
    res.json(r);
  } catch (e) { console.error('Spin failed:', e); res.status(500).json({ error: 'Failed to spin' }); }
});

app.post('/api/promos/scratch', async (req, res) => {
  try {
    const r = await runPromo({ phone: req.body.phone, name: req.body.name, type: 'scratch' });
    res.json(r);
  } catch (e) { console.error('Scratch failed:', e); res.status(500).json({ error: 'Failed to scratch' }); }
});

// Today's promo status for a phone — lets the UI show "come back tomorrow"
// and the prize won even after an app restart.
app.get('/api/promos/status/:phone', async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/[^0-9]/g, '');
    const day = promoDayKey();
    const s = await getLoyaltySettings();
    const spinCooldownMs = (s.spinCooldownHours || 24) * 3600 * 1000;
    const scratchCooldownMs = (s.scratchCooldownHours || 48) * 3600 * 1000;
    const [spin, scratch, orders, loyalty] = await Promise.all([
      promo_claims_.findOne({ phone, type: 'spin', at: { $gt: new Date(Date.now() - spinCooldownMs) } }),
      promo_claims_.findOne({ phone, type: 'scratch', at: { $gt: new Date(Date.now() - scratchCooldownMs) } }),
      orders_.find({ customerId: phone }).toArray(),
      loyalty_.findOne({ phone })
    ]);
    const completed = orders.filter(o => o.status !== 'cancelled');
    const totalSpent = completed.reduce((s, o) => s + (o.totalPrice || 0), 0);
    const minOrders = s.minOrdersForPromo || 2;
    const tier = tierFromPoints(loyalty ? loyalty.points : 0);
    const spinInfo = spin ? { used: true, day, at: spin.at, nextAt: new Date(new Date(spin.at).getTime() + spinCooldownMs), prizeName: spin.prizeName, code: spin.code || '', title: spin.title || '', message: spin.message || '' } : { used: false, day };
    const scratchInfo = scratch ? { used: true, day, at: scratch.at, nextAt: new Date(new Date(scratch.at).getTime() + scratchCooldownMs), prizeName: scratch.prizeName, code: scratch.code || '', title: scratch.title || '', message: scratch.message || '' } : { used: false, day };
    res.json({
      phone,
      tier,
      loyaltyPoints: loyalty ? loyalty.points || 0 : 0,
      orderCount: completed.length,
      minOrders,
      promosLocked: completed.length < minOrders,
      totalSpent: Math.round(totalSpent * 100) / 100,
      spin: spinInfo,
      scratch: scratchInfo
    });
  } catch (e) { console.error('Promo status failed:', e); res.status(500).json({ error: 'Failed' }); }
});

// ===== M-PESA STK PUSH =====
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const MPESA_BASE = MPESA_ENV === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const getMpesaCallbackUrl = () => process.env.CALLBACK_URL || 'https://your-deployed-url.com/api/mpesa/callback'; // ⚠️ SET CALLBACK_URL env var!

async function safaricomRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });

    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Safaricom returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(
        data.errorMessage ||
        data.error_description ||
        data.message ||
        `Safaricom HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// Token cache (valid for ~55 minutes out of 60)
let _mpesaTokenCache = { token: null, expiresAt: 0 };

async function getMpesaToken() {
  if (_mpesaTokenCache.token && Date.now() < _mpesaTokenCache.expiresAt) {
    return _mpesaTokenCache.token;
  }
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  try {
    const data = await safaricomRequest(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!data.access_token) {
      throw new Error(data.errorMessage || 'No access_token in response');
    }
    _mpesaTokenCache = { token: data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
    return data.access_token;
  } catch (e) {
    throw new Error(`M-Pesa token request failed: ${e.message}`);
  }
}

function mpesaTimestamp() {
  const d = new Date();
  return d.getFullYear().toString() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + String(d.getSeconds()).padStart(2,'0');
}

function formatPhone(phone) {
  let p = (phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

app.post('/api/mpesa/stk-push', async (req, res) => {
  const { phone, amount, orderId, saleId, saleDraft } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  try {
    // Double payment protection
    if (orderId && ObjectId.isValid(orderId)) {
      const order = await orders_.findOne({ _id: new ObjectId(orderId) });
      if (order) {
        if (order.paymentStatus === 'paid') {
          return res.status(400).json({ success: false, error: 'This order has already been paid and confirmed!' });
        }
      }
      
      // Check if there is a confirmed request
      const existingConfirmed = await db_.collection('mpesa_requests').findOne({ orderId: orderId.toString(), status: 'confirmed' });
      if (existingConfirmed) {
        return res.status(400).json({ success: false, error: 'Payment for this order has already been confirmed!' });
      }

      // Check if there is a pending request created within the last 2 minutes
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      const existingPending = await db_.collection('mpesa_requests').findOne({
        orderId: orderId.toString(),
        status: 'pending',
        createdAt: { $gte: twoMinutesAgo }
      });
      if (existingPending) {
        return res.status(400).json({ success: false, error: 'A payment request has already been sent to your phone. Please wait a moment.' });
      }
    }

    let isMock = false;
    
    // Mock simulation is ONLY active if explicitly enabled via env var
    if (process.env.MPESA_MOCK_ENABLED === 'true') {
      isMock = true;
    }

    let token;
    if (!isMock) {
      try {
        // If credentials are placeholders and mock is NOT enabled, do not even try. Fail immediately.
        if (!MPESA_CONSUMER_KEY || MPESA_CONSUMER_KEY.startsWith('your_') || 
            !MPESA_CONSUMER_SECRET || MPESA_CONSUMER_SECRET.startsWith('your_') ||
            !MPESA_SHORTCODE || MPESA_SHORTCODE.startsWith('your_')) {
          return res.status(400).json({ success: false, error: 'M-Pesa API credentials are not configured.' });
        }
        token = await getMpesaToken();
        if (!token) {
          return res.status(500).json({ success: false, error: 'Failed to retrieve M-Pesa token from Safaricom.' });
        }
      } catch (err) {
        console.error('M-Pesa authentication failed:', err.message);
        return res.status(500).json({ success: false, error: 'M-Pesa authentication failed: ' + err.message });
      }
    }

    if (!isMock) {
      try {
        if (!MPESA_PASSKEY || MPESA_PASSKEY.startsWith('your_')) {
          return res.status(400).json({
            success: false,
            error: 'M-Pesa passkey is not configured.'
          });
        }

        const callbackUrl = getMpesaCallbackUrl();

        if (
          process.env.NODE_ENV === 'production' &&
          (!callbackUrl.startsWith('https://') ||
            callbackUrl.includes('localhost') ||
            callbackUrl.includes('127.0.0.1'))
        ) {
          return res.status(400).json({
            success: false,
            error: `Invalid production M-Pesa callback URL: ${callbackUrl}`
          });
        }

        const formattedPhone = formatPhone(phone);

        if (!/^254(7|1)\d{8}$/.test(formattedPhone)) {
          return res.status(400).json({
            success: false,
            error: `Invalid M-Pesa phone number: ${formattedPhone}`
          });
        }

        const numericAmount = Math.ceil(Number(amount));

        if (!Number.isFinite(numericAmount) || numericAmount < 1) {
          return res.status(400).json({
            success: false,
            error: `Invalid M-Pesa amount: ${amount}`
          });
        }

        const timestamp = mpesaTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        const body = {
          BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline', Amount: numericAmount,
          PartyA: formattedPhone, PartyB: MPESA_SHORTCODE, PhoneNumber: formattedPhone,
          CallBackURL: callbackUrl, AccountReference: 'Brilliant', TransactionDesc: 'Payment for goods',
        };
        const mpesaData = await safaricomRequest(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (mpesaData.ResponseCode === '0') {
          if (db_) {
            await db_.collection('mpesa_requests').insertOne({
              checkoutRequestId: mpesaData.CheckoutRequestID, merchantRequestId: mpesaData.MerchantRequestID,
              phone: formattedPhone, amount: body.Amount, orderId: orderId || null, saleId: saleId || null,
              saleDraft: saleDraft || null, saleCreated: false,
              status: 'pending', createdAt: new Date(),
            });
          }
          return res.json({ success: true, checkoutRequestId: mpesaData.CheckoutRequestID, message: 'M-Pesa prompt sent! Ask customer to enter PIN.' });
        } else {
          return res.status(400).json({ success: false, error: mpesaData.errorMessage || mpesaData.ResultDesc || 'M-Pesa request rejected by Safaricom.' });
        }
      } catch (err) {
        console.error('M-Pesa STK Push request failed:', err.message);
        return res.status(500).json({ success: false, error: 'M-Pesa STK Push request failed: ' + err.message });
      }
    }

    if (isMock) {
      const mockCheckoutId = 'MOCK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      const formattedPhone = formatPhone(phone);
      const mockAmount = Math.ceil(parseFloat(amount));
      if (db_) {
        await db_.collection('mpesa_requests').insertOne({
          checkoutRequestId: mockCheckoutId,
          merchantRequestId: 'MOCK-REQ-' + Math.random().toString(36).substr(2, 9).toUpperCase(),
          phone: formattedPhone,
          amount: mockAmount,
          orderId: orderId || null,
          saleId: saleId || null,
          saleDraft: saleDraft || null,
          saleCreated: false,
          status: 'pending',
          createdAt: new Date(),
        });
      }
      
      // Automatically confirm the payment after 3 seconds
      setTimeout(async () => {
        try {
          if (db_) {
            const status = 'confirmed';
            await db_.collection('mpesa_requests').updateOne(
              { checkoutRequestId: mockCheckoutId },
              { $set: { status, resultCode: 0, resultDesc: 'The service request is processed successfully.', completedAt: new Date() } }
            );
            if (orderId && ObjectId.isValid(orderId)) {
              await orders_.updateOne({ _id: new ObjectId(orderId) }, { $set: { paymentStatus: 'paid', paymentMethod: 'mpesa' } });
            }
            await finalizePosSale(mockCheckoutId);
            console.log('✅ Mock M-Pesa payment confirmed:', mockCheckoutId);
          }
        } catch (e) {
          console.error('Error in mock callback simulation:', e);
        }
      }, 3000);

      res.json({ 
        success: true, 
        checkoutRequestId: mockCheckoutId, 
        message: 'M-Pesa simulation initiated! Confirming in 3 seconds...' 
      });
    }
  } catch (err) { console.error('STK Push error:', err); res.status(500).json({ error: 'Failed to initiate M-Pesa payment', details: err.message }); }
});

// Customer cancel order endpoint
app.post('/api/customer-orders/:orderId/cancel', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { customerId } = req.body;
    if (!ObjectId.isValid(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

    const order = await orders_.findOne({ _id: new ObjectId(orderId), customerId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ error: `Cannot cancel an order that is already ${order.status}` });

    await orders_.updateOne({ _id: new ObjectId(orderId) }, { $set: { status: 'cancelled' } });
    
    // Restore stock
    for (const it of order.items) {
      const id = it._id || it.id;
      if (id && ObjectId.isValid(id)) {
        await products_.updateOne({ _id: new ObjectId(id) }, { $inc: { stock: Math.abs(it.quantity) } });
      }
    }
    res.json({ success: true, message: 'Order cancelled successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// Banners GET (Customer view - only active ones)
app.get('/api/banners', async (req, res) => {
  try {
    const list = await banners_.find({ active: true }).sort({ createdAt: 1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch banners' });
  }
});

// Banners GET (Admin view - all)
app.get('/api/admin/banners', authenticate, async (req, res) => {
  try {
    const list = await banners_.find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch banners' });
  }
});

// Banner POST (Create)
app.post('/api/admin/banners', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { title, text, code, gradient } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const banner = {
      title,
      text: text || '',
      code: code || '',
      gradient: gradient || 'linear-gradient(135deg, #ffd24a, #ff7a1a)',
      active: true,
      createdAt: new Date()
    };
    const r = await banners_.insertOne(banner);
    res.json({ success: true, bannerId: r.insertedId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create banner' });
  }
});

// Banner PUT (Toggle active or edit)
app.put('/api/admin/banners/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { title, text, code, gradient, active } = req.body;
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid banner ID' });

    let u = {};
    if (title !== undefined) u.title = title;
    if (text !== undefined) u.text = text;
    if (code !== undefined) u.code = code;
    if (gradient !== undefined) u.gradient = gradient;
    if (active !== undefined) u.active = !!active;

    const r = await banners_.updateOne({ _id: new ObjectId(id) }, { $set: u });
    if (!r.matchedCount) return res.status(404).json({ error: 'Banner not found' });
    res.json({ success: true, message: 'Banner updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update banner' });
  }
});

// Banner DELETE
app.delete('/api/admin/banners/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid banner ID' });
    const r = await banners_.deleteOne({ _id: new ObjectId(id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Banner not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete banner' });
  }
});

// Product Flash Sale Toggle/Set
app.post('/api/admin/products/:productId/flash-sale', authenticate, async (req, res) => {
  const { flashSale, flashSaleDiscount, durationHours } = req.body;
  try {
    const { productId } = req.params;
    if (!ObjectId.isValid(productId)) return res.status(400).json({ error: 'Invalid product ID' });

    let u = {};
    if (flashSale !== undefined) u.flashSale = !!flashSale;
    if (flashSaleDiscount !== undefined) u.flashSaleDiscount = parseFloat(flashSaleDiscount) || 0;
    
    if (flashSale) {
      const duration = parseFloat(durationHours) || 24; // default 24 hours
      u.flashSaleExpires = new Date(Date.now() + duration * 60 * 60 * 1000);
    } else {
      u.flashSaleExpires = null;
    }

    const r = await products_.updateOne({ _id: new ObjectId(productId) }, { $set: u });
    if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
    productCache.del('all_products');
    res.json({ success: true, message: 'Flash sale updated!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update flash sale settings' });
  }
});

// ---------------------------------------------------------------------------
// Idempotently record a POS sale from a stored M-Pesa draft once payment is
// confirmed. Safe to call from every confirm point (callback, status query,
// mock) — the atomic `saleCreated` flag guarantees the sale is written AT MOST
// ONCE, even if the cashier's browser disconnects between PIN entry and the
// sale being saved. This is what stops "money taken, no sale recorded".
// ---------------------------------------------------------------------------
async function finalizePosSale(checkoutRequestId) {
  if (!db_) return;
  let claimed;
  try {
    // Atomic claim: only the FIRST caller flips saleCreated false->true and
    // gets the document back. Any later/racing caller matches nothing -> null.
    claimed = await db_.collection('mpesa_requests').findOneAndUpdate(
      { checkoutRequestId, status: 'confirmed', 'saleDraft.items.0': { $exists: true }, saleCreated: { $ne: true } },
      { $set: { saleCreated: true } }
    );
  } catch (e) { console.error('finalizePosSale claim error:', e.message); return; }

  // mongodb driver v6+ returns the matched doc directly; older returns {value}.
  const reqDoc = claimed && claimed.value !== undefined ? claimed.value : claimed;
  if (!reqDoc || !reqDoc.saleDraft || !Array.isArray(reqDoc.saleDraft.items) || !reqDoc.saleDraft.items.length) return;

  const draft = reqDoc.saleDraft;
  try {
    const items = draft.items;
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const profit = items.reduce((s, i) => s + (i.price - (i.buyingPrice || 0)) * i.qty, 0);
    const sale = {
      items, total, profit,
      paymentMethod: 'mpesa', amountGiven: 0, cashPart: 0, mpesaPart: total, change: 0,
      staff: draft.staff || 'Owner',
      cashierUserId: draft.cashierUserId || null,
      customerPhone: draft.customerPhone || reqDoc.phone || '',
      channel: 'pos',
      branchId: draft.branchId || null,
      createdAt: new Date(),
      mpesaCheckoutId: checkoutRequestId,
    };
    const result = await sales_.insertOne(sale);
    for (const it of items) {
      if (it.productId && ObjectId.isValid(it.productId)) {
        await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: -Math.abs(it.qty) } });
      }
    }
    await db_.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: { saleId: result.insertedId } });
    if (sale.customerPhone) earnPoints(sale.customerPhone, total);
    console.log('🧾 POS SALE auto-recorded from M-Pesa:', checkoutRequestId, '| KES', total, '| by', sale.staff);
  } catch (e) {
    console.error('finalizePosSale create error:', e.message);
    // Creation failed after claiming — release the flag so another confirm
    // point (or the next status poll) can retry instead of losing the sale.
    try { await db_.collection('mpesa_requests').updateOne({ checkoutRequestId }, { $set: { saleCreated: false } }); } catch (_) {}
  }
}

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callback = req.body.Body?.stkCallback;
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;
    const resultDesc = callback.ResultDesc;
    console.log('📱 M-Pesa callback:', checkoutRequestId, resultCode, resultDesc);
    if (db_) {
      const req_ = await db_.collection('mpesa_requests').findOne({ checkoutRequestId });
      if (req_) {
        const status = resultCode === 0 ? 'confirmed' : 'failed';
        await db_.collection('mpesa_requests').updateOne(
          { checkoutRequestId }, { $set: { status, resultCode, resultDesc, completedAt: new Date() } }
        );
        if (status === 'confirmed' && req_.orderId && ObjectId.isValid(req_.orderId)) {
          await orders_.updateOne({ _id: new ObjectId(req_.orderId) }, { $set: { paymentStatus: 'paid', paymentMethod: 'mpesa' } });
        }
        if (status === 'confirmed') { await finalizePosSale(checkoutRequestId); }
        console.log(status === 'confirmed' ? '✅ Payment confirmed' : '❌ Payment failed/cancelled');
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) { console.error('Callback error:', err); res.json({ ResultCode: 0, ResultDesc: 'Success' }); }
});

app.get('/api/mpesa/status/:checkoutRequestId', async (req, res) => {
  try {
    const req_ = await db_.collection('mpesa_requests').findOne({ checkoutRequestId: req.params.checkoutRequestId });
    if (!req_) return res.status(404).json({ error: 'Not found' });
    
    // Auto-query Safaricom if still pending (bypasses localtunnel callback issues)
    if (req_.status === 'pending' && process.env.MPESA_MOCK_ENABLED !== 'true') {
      try {
        const token = await getMpesaToken();
        const timestamp = mpesaTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        const data = await safaricomRequest(`${MPESA_BASE}/mpesa/stkpushquery/v1/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: req.params.checkoutRequestId }),
        });
        
        // ResultCode is present when transaction is finished (can be string or number)
        if (data.ResultCode !== undefined) {
          const rc = String(data.ResultCode);
          const desc = data.ResultDesc || '';
          
          // "Still processing" means Safaricom hasn't finalized — keep polling
          if (desc.toLowerCase().includes('still') && desc.toLowerCase().includes('process')) {
            console.log('⏳ Still processing, will keep polling...');
            return res.json({ status: 'pending', resultDesc: '' });
          }
          
          const status = rc === '0' ? 'confirmed' : 'failed';
          const resultDesc = rc === '0' 
            ? '✅ Transaction Complete — Payment Received!' 
            : rc === '1032' ? '❌ Payment Cancelled by Customer'
            : rc === '1' ? '❌ Insufficient M-Pesa Balance'
            : rc === '2001' ? '❌ Wrong PIN Entered'
            : rc === '1037' ? '⏱️ Payment Timed Out — Customer took too long'
            : `❌ Payment Declined (Code: ${rc})`;
          
          await db_.collection('mpesa_requests').updateOne(
            { checkoutRequestId: req.params.checkoutRequestId }, 
            { $set: { status, resultCode: data.ResultCode, resultDesc, completedAt: new Date() } }
          );
          if (status === 'confirmed' && req_.orderId && ObjectId.isValid(req_.orderId)) {
            await orders_.updateOne({ _id: new ObjectId(req_.orderId) }, { $set: { paymentStatus: 'paid', paymentMethod: 'mpesa' } });
          }
          if (status === 'confirmed') { await finalizePosSale(req.params.checkoutRequestId); }
          console.log(status === 'confirmed' ? '✅ Payment confirmed via query' : `❌ Payment failed: ${resultDesc}`);
          return res.json({ status, resultDesc });
        }
      } catch (e) {
        console.error('Auto-query Safaricom error:', e.message);
      }
    }
    
    res.json({ status: req_.status, resultDesc: req_.resultDesc || '' });
  } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/mpesa/query', async (req, res) => {
  const { checkoutRequestId } = req.body;
  try {
    const token = await getMpesaToken();
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const data = await safaricomRequest(`${MPESA_BASE}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Failed to query status' }); }
});

// Seed default loyalty rewards if collection is empty
const seedRewards = async () => {
  try {
    if (!loyalty_rewards_) return;
    // Upsert (not insert-if-empty) so existing databases get the new tier
    // table: 100→KES100, 250→KES250, 500→KES600, 1000→KES1300.
    const tiers = [
      { name: 'KES 100 Discount Coupon', pointsCost: 100, rewardType: 'coupon', rewardValue: 100, active: true },
      { name: 'KES 250 Discount Coupon', pointsCost: 250, rewardType: 'coupon', rewardValue: 250, active: true },
      { name: 'KES 600 Discount Coupon', pointsCost: 500, rewardType: 'coupon', rewardValue: 600, active: true },
      { name: 'KES 1300 Discount Coupon', pointsCost: 1000, rewardType: 'coupon', rewardValue: 1300, active: true }
    ];
    for (const t of tiers) {
      await loyalty_rewards_.updateOne({ pointsCost: t.pointsCost }, { $set: t }, { upsert: true });
    }
    // Deactivate legacy rewards that aren't in the new tier table (old
    // 'KES 250 @ 200 pts', 'KES 750 @ 500', 'Free Blitz Drink @ 50'...) so the
    // customer store never shows stale, misleading or sub-100-point offers.
    await loyalty_rewards_.updateMany({ pointsCost: { $nin: [100, 250, 500, 1000] } }, { $set: { active: false } });
    console.log('✅ Seeded default loyalty rewards');
  } catch (err) {
    console.error('Failed to seed loyalty rewards:', err);
  }
};

// Audit log helper
const logAction = async (userId, username, action, details, branchId = null) => {
  try {
    if (audit_logs_) {
      await audit_logs_.insertOne({
        userId,
        username,
        action,
        details,
        branchId,
        timestamp: new Date()
      });
    }
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
};

// Dynamic pricing calculation helper
const applyPricingRules = async (prods) => {
  try {
    if (!pricing_rules_) return prods;
    const rules = await pricing_rules_.find({ active: true }).toArray();

    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const currentTimeString = `${String(currentHour).padStart(2,'0')}:${String(currentMin).padStart(2,'0')}`;

    return prods.map(p => {
      let finalPrice = p.price;
      let appliedRules = [];

      // 1. Expiry Check (Auto Flash Sale for items expiring within 7 days)
      let isFlashSale = false;
      let flashSaleDiscount = 0;
      let flashSaleExpires = null;
      let flashSaleReason = '';
      
      if (p.expiryDate) {
        const exp = new Date(p.expiryDate);
        const diffTime = exp - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 7) {
          isFlashSale = true;
          flashSaleDiscount = 50; // 50% discount for expiring goods
          flashSaleExpires = p.expiryDate;
          flashSaleReason = `Expiring soon (${diffDays} days left)`;
        }
      }
      
      // 2. Manual Flash Sale
      if (!isFlashSale && p.flashSale && p.flashSaleExpires) {
        const expires = new Date(p.flashSaleExpires);
        if (expires > now) {
          isFlashSale = true;
          flashSaleDiscount = parseFloat(p.flashSaleDiscount) || 0;
          flashSaleExpires = p.flashSaleExpires;
          flashSaleReason = 'Special Flash Sale!';
        }
      }

      if (isFlashSale && flashSaleDiscount > 0) {
        finalPrice = finalPrice * (1 - (flashSaleDiscount / 100));
        appliedRules.push(`Flash Sale (${flashSaleDiscount}% Off)`);
      } else if (rules.length) {
        for (const rule of rules) {
          if (rule.type === 'happy_hour') {
            if (rule.startHour && rule.endHour) {
              if (currentTimeString >= rule.startHour && currentTimeString <= rule.endHour) {
                finalPrice = finalPrice * (1 - (rule.discountPercent / 100));
                appliedRules.push(rule.name);
              }
            }
          } else if (rule.type === 'expiry' && p.expiryDate) {
            const exp = new Date(p.expiryDate);
            const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays <= rule.conditionValue) {
              finalPrice = finalPrice * (1 - (rule.discountPercent / 100));
              appliedRules.push(rule.name);
            }
          }
        }
      }

      return {
        ...p,
        originalPrice: p.price,
        price: Math.round(finalPrice),
        discountApplied: appliedRules.length > 0,
        appliedRules,
        isFlashSale,
        flashSaleDiscount,
        flashSaleExpires,
        flashSaleReason
      };
    });
  } catch (err) {
    console.error('Error in applyPricingRules:', err);
    return prods;
  }
};

// Audit Logs fetch
app.get('/api/admin/audit-logs', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const logs = await audit_logs_.find(filter).sort({ timestamp: -1 }).limit(100).toArray();
    res.json(logs);
  } catch (e) {
    console.error('Failed to fetch audit logs:', e);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Shift Management: Start Shift
app.post('/api/admin/shifts/start', authenticate, async (req, res) => {
  const { startingCash } = req.body;
  if (startingCash === undefined || startingCash === null) return res.status(400).json({ error: 'Starting cash balance is required' });
  try {
    const active = await shifts_.findOne({ cashierId: req.user.userId, status: 'open' });
    if (active) return res.status(400).json({ error: 'You already have an open shift. Close it first.' });

    const shift = {
      cashierId: req.user.userId,
      cashierName: req.user.name || req.user.username,
      branchId: req.user.branchId || null,
      startTime: new Date(),
      startingCash: parseFloat(startingCash),
      status: 'open'
    };
    const r = await shifts_.insertOne(shift);
    await logAction(req.user.userId, req.user.username, 'SHIFT_START', `Started shift with KES ${startingCash}`, req.user.branchId);
    res.json({ success: true, shiftId: r.insertedId });
  } catch (e) {
    console.error('Failed to start shift:', e);
    res.status(500).json({ error: 'Failed to start shift' });
  }
});

// Shift Management: End Shift
app.post('/api/admin/shifts/end', authenticate, async (req, res) => {
  const { closingCash } = req.body;
  if (closingCash === undefined || closingCash === null) return res.status(400).json({ error: 'Closing cash balance is required' });
  try {
    const active = await shifts_.findOne({ cashierId: req.user.userId, status: 'open' });
    if (!active) return res.status(400).json({ error: 'No active shift found.' });

    const filter = {
      cashierUserId: active.cashierId,
      createdAt: { $gte: active.startTime },
      ...(active.branchId ? { branchId: active.branchId } : {})
    };
    
    const salesList = await sales_.find(filter).toArray();
    const cashSalesTotal = salesList.reduce((acc, sale) => {
      if (sale.paymentMethod === 'cash') return acc + (sale.totalPrice || sale.total || 0);
      if (sale.paymentMethod === 'split') return acc + (parseFloat(sale.cashPart) || 0);
      return acc;
    }, 0);

    const mpesaSalesTotal = salesList.reduce((acc, sale) => {
      if (sale.paymentMethod === 'mpesa') return acc + (sale.totalPrice || sale.total || 0);
      if (sale.paymentMethod === 'split') return acc + (parseFloat(sale.mpesaPart) || 0);
      return acc;
    }, 0);

    const expectedCash = active.startingCash + cashSalesTotal;
    const difference = parseFloat(closingCash) - expectedCash;

    await shifts_.updateOne(
      { _id: active._id },
      {
        $set: {
          endTime: new Date(),
          closingCash: parseFloat(closingCash),
          expectedCash,
          cashSales: cashSalesTotal,
          mpesaSales: mpesaSalesTotal,
          salesCount: salesList.length,
          difference,
          status: 'closed'
        }
      }
    );

    await logAction(
      req.user.userId,
      req.user.username,
      'SHIFT_CLOSE',
      `Closed shift. Expected KES ${expectedCash}, Actual KES ${closingCash}. Diff KES ${difference}`,
      req.user.branchId
    );

    res.json({
      success: true,
      summary: {
        startingCash: active.startingCash,
        cashSales: cashSalesTotal,
        mpesaSales: mpesaSalesTotal,
        expectedCash,
        closingCash: parseFloat(closingCash),
        difference,
        salesCount: salesList.length
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to close shift' });
  }
});

// Shift Management: Check active shift status
app.get('/api/admin/shifts/active', authenticate, async (req, res) => {
  try {
    const active = await shifts_.findOne({ cashierId: req.user.userId, status: 'open' });
    res.json({ active: !!active, shift: active });
  } catch (e) {
    console.error('Failed to check active shift:', e);
    res.status(500).json({ error: 'Failed to check active shift' });
  }
});

// Shift Management: Fetch shifts list
app.get('/api/admin/shifts', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const list = await shifts_.find(filter).sort({ startTime: -1 }).limit(100).toArray();
    res.json(list);
  } catch (e) {
    console.error('Failed to fetch shifts:', e);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Dynamic Pricing: Fetch active rules
app.get('/api/admin/pricing-rules', authenticate, async (req, res) => {
  try {
    res.json(await pricing_rules_.find().toArray());
  } catch (e) {
    console.error('Failed to fetch rules:', e);
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// Dynamic Pricing: Save active rule
app.post('/api/admin/pricing-rules', authenticate, authorize('owner'), async (req, res) => {
  const { name, type, discountPercent, conditionValue, startHour, endHour, active } = req.body;
  if (!name || !type || !discountPercent) return res.status(400).json({ error: 'Missing pricing fields' });
  try {
    const rule = {
      name,
      type,
      discountPercent: parseFloat(discountPercent),
      conditionValue: parseInt(conditionValue) || 0,
      startHour: startHour || null,
      endHour: endHour || null,
      active: active !== false,
      createdAt: new Date()
    };
    await pricing_rules_.insertOne(rule);
    await logAction(req.user.userId, req.user.username, 'CREATE_PRICING_RULE', `Created rule ${name} (${type})`, req.user.branchId);
    res.json({ success: true });
  } catch (e) {
    console.error('Failed to save rule:', e);
    res.status(500).json({ error: 'Failed to save rule' });
  }
});

// Dynamic Pricing: Update active rule status
app.put('/api/admin/pricing-rules/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const { active, discountPercent } = req.body;
    const update = {};
    if (active !== undefined) update.active = active;
    if (discountPercent !== undefined) update.discountPercent = parseFloat(discountPercent);
    await pricing_rules_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    await logAction(req.user.userId, req.user.username, 'UPDATE_PRICING_RULE', `Updated rule ${req.params.id}`, req.user.branchId);
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Dynamic Pricing: Delete pricing rule
app.delete('/api/admin/pricing-rules/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    await pricing_rules_.deleteOne({ _id: new ObjectId(req.params.id) });
    await logAction(req.user.userId, req.user.username, 'DELETE_PRICING_RULE', `Deleted rule ${req.params.id}`, req.user.branchId);
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Inter-Branch Stock Transfers: Fetch transfers list
app.get('/api/admin/transfers', authenticate, async (req, res) => {
  try {
    const list = await stock_transfers_.find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Inter-Branch Stock Transfers: Request transfer
app.post('/api/admin/transfers', authenticate, authorize('owner'), async (req, res) => {
  const { fromBranchId, toBranchId, items } = req.body;
  if (!fromBranchId || !toBranchId || !items || !items.length) {
    return res.status(400).json({ error: 'Invalid transfer details' });
  }
  try {
    const transfer = {
      fromBranchId,
      toBranchId,
      items,
      status: 'pending',
      createdAt: new Date(),
      createdBy: req.user.username
    };
    await stock_transfers_.insertOne(transfer);
    await logAction(req.user.userId, req.user.username, 'TRANSFER_CREATE', `Created transfer from ${fromBranchId} to ${toBranchId}`, req.user.branchId);
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Inter-Branch Stock Transfers: Complete transfer
app.post('/api/admin/transfers/:id/complete', authenticate, authorize('owner'), async (req, res) => {
  try {
    const transfer = await stock_transfers_.findOne({ _id: new ObjectId(req.params.id) });
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    for (const it of transfer.items) {
      const prod = await products_.findOne({ _id: new ObjectId(it.productId) });
      if (prod) {
        const targetProd = await products_.findOne({ name: prod.name, branchId: transfer.toBranchId });
        if (targetProd) {
          await products_.updateOne({ _id: targetProd._id }, { $inc: { stock: parseInt(it.qty) } });
        } else {
          const { _id, ...cleanProd } = prod;
          await products_.insertOne({
            ...cleanProd,
            branchId: transfer.toBranchId,
            stock: parseInt(it.qty)
          });
        }
        await products_.updateOne({ _id: prod._id }, { $inc: { stock: -parseInt(it.qty) } });
      }
    }

    await stock_transfers_.updateOne({ _id: transfer._id }, { $set: { status: 'completed', completedAt: new Date() } });
    await logAction(req.user.userId, req.user.username, 'TRANSFER_COMPLETE', `Completed transfer ${transfer._id}`, req.user.branchId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Loyalty Program Points Store
app.get('/api/loyalty/rewards', async (req, res) => {
  try {
    const rewards = await loyalty_rewards_.find({ active: true }).toArray();
    res.json(rewards);
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Loyalty Program: Redeem Points Reward
app.post('/api/loyalty/redeem-reward', async (req, res) => {
  const { customerId, rewardId } = req.body;
  if (!customerId || !rewardId) return res.status(400).json({ error: 'Missing parameters' });
  try {
    const reward = await loyalty_rewards_.findOne({ _id: new ObjectId(rewardId) });
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const member = await loyalty_.findOne({ phone: customerId });
    if (!member || (member.points || 0) < reward.pointsCost) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    await loyalty_.updateOne({ phone: customerId }, { $inc: { points: -reward.pointsCost } });

    let code = '';
    if (reward.rewardType === 'coupon') {
      code = 'REDEEM_' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await coupons_.insertOne({
        code,
        type: 'fixed',
        value: parseFloat(reward.rewardValue),
        minPurchase: 0,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        maxUses: 1,
        active: true,
        createdAt: new Date()
      });
    }

    await redemptions_.insertOne({
      customerId,
      rewardId: reward._id,
      rewardName: reward.name,
      pointsSpent: reward.pointsCost,
      couponCode: code || null,
      createdAt: new Date()
    });

    res.json({ success: true, pointsCost: reward.pointsCost, couponCode: code, message: `Successfully redeemed ${reward.name}!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Saved Shopping Baskets
app.get('/api/customer/baskets/:customerId', async (req, res) => {
  try {
    const list = await saved_baskets_.find({ customerId: req.params.customerId }).toArray();
    res.json(list);
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/customer/baskets', async (req, res) => {
  const { customerId, basketName, items } = req.body;
  if (!customerId || !basketName || !items || !items.length) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  try {
    await saved_baskets_.insertOne({
      customerId,
      basketName,
      items,
      createdAt: new Date()
    });
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/customer/baskets/:id', async (req, res) => {
  try {
    await saved_baskets_.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Dispatch Audit Log for Automated Receipts
app.post('/api/admin/receipt-delivery/log', authenticate, async (req, res) => {
  const { phone, details } = req.body;
  try {
    await logAction(
      req.user.userId,
      req.user.username,
      'RECEIPT_DISPATCH',
      `Auto-dispatched WhatsApp/SMS receipt to ${phone}: ${details}`,
      req.user.branchId
    );
    res.json({ success: true });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});
// ===== LLM BRAIN (Ollama, optional) =====
// If a local Ollama server is reachable the assistants answer anything the rule
// engine cannot match. Falls back to the rules automatically (even on Render,
// where Ollama is absent), so the app keeps working everywhere.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
let ollamaOk = false;
let ollamaCheckedAt = 0;

async function ollamaReady() {
  if (Date.now() - ollamaCheckedAt < 60 * 1000) return ollamaOk;
  ollamaCheckedAt = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(OLLAMA_URL + '/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    ollamaOk = r.ok;
  } catch (e) { ollamaOk = false; }
  return ollamaOk;
}

async function askOllama(system, user, timeoutMs = 15000) {
  if (!(await ollamaReady())) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ] })
    });
    clearTimeout(t);
    if (!res.ok) { ollamaCheckedAt = 0; return null; }
    const data = await res.json();
    return (data.message && data.message.content) ? data.message.content.trim() : null;
  } catch (e) {
    console.error('[AI] Ollama error:', e.message);
    ollamaCheckedAt = 0;
    return null;
  }
}

// Common Swahili/Sheng product words -> English, so "maziwa" finds Milk.
const SW_TO_EN = {
  maziwa: 'milk', mkate: 'bread', sukari: 'sugar', unga: 'flour', mafuta: 'oil',
  mayai: 'eggs', chai: 'tea', samaki: 'fish', nyama: 'meat', mahindi: 'maize',
  mchele: 'rice', viazi: 'potatoes', kabichi: 'cabbage', matunda: 'fruit',
  mboga: 'vegetables', sabuni: 'soap', mandazi: 'mandazi', chapati: 'chapati',
  ndizi: 'bananas', karanga: 'groundnuts', supu: 'soup', soda: 'soda', maji: 'water',
  juisi: 'juice', siagi: 'butter', jibini: 'cheese', kuku: 'chicken', ndimu: 'lime',
  nyanya: 'tomatoes', vitunguu: 'onions', pilipili: 'peppers', karoti: 'carrots'
};
function expandSwahili(str) {
  return str.split(' ').map(w => (SW_TO_EN[w] || w)).join(' ');
}

// ===== AI ASSISTANT ENGINE =====
function normalizeAiText(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/['']/g, "'").replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findMatchingProducts(query, products, limit = 5) {
  const q = expandSwahili(normalizeAiText(query));
  const stopWords = new Set(['add','buy','get','order','put','place','grab','take','want','need','find','search','show','me','the','a','an','to','in','my','some','with','and','or','for','of','is','it','this','that','please','can','you','i','do','have','from','on','at','up','out','about','how','much','what','which','give','look']);
  const words = q.split(' ').filter(w => w.length > 1 && !stopWords.has(w));
  const scored = products.map(p => {
    const name = normalizeAiText(p.name);
    let score = 0;
    if (name === q) score += 100;
    if (name.includes(q)) score += 80;
    if (q.includes(name) && name.length > 2) score += 70;
    for (const sw of words) {
      if (name.includes(sw)) score += 20;
      for (const nw of name.split(' ')) {
        if (nw.startsWith(sw) || sw.startsWith(nw)) score += 15;
      }
    }
    return { product: p, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.product);
}

function detectAiIntent(text, products) {
  const t = normalizeAiText(text);
  // Place a real order when several items are mentioned: "order milk and bread"
  if (/\b(order|buy|agiza|nunua)\b/i.test(t) && /\b(and|na|plus|&|,)\b/i.test(t)) {
    const multi = findMatchingProducts(t, products, 10);
    if (multi.length >= 2) return { type: 'place_order', products: multi };
  }
  if (/\b(add|buy|get|order|put|grab|take|want|need|give me|cart|ongeza|nunua|weka|chagua)\b/i.test(t)) {
    const matched = findMatchingProducts(t, products, 1);
    if (matched.length > 0) {
      const qtyMatch = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
      const wordToNum = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
      const qty = qtyMatch ? (wordToNum[qtyMatch[1]] || parseInt(qtyMatch[1]) || 1) : 1;
      return { type: 'add_to_cart', product: matched[0], quantity: qty };
    }
    return { type: 'add_to_cart_no_match' };
  }
  if (/\b(track|status|where|follow|locate|my order|my orders|fuatilia|iko wapi)\b/i.test(t)) return { type: 'order_status' };
  if (/\b(cancel|stop|abort|void|ghairi|futa)\b/i.test(t)) {
    if (/\b(yes|confirm|do it|go ahead|please|sure)\b/i.test(t)) return { type: 'confirm_cancel' };
    return { type: 'cancel_order' };
  }
  if (/\b(complain|complaint|issue|problem|wrong|bad|terrible|awful|delay|late|missing|broken|damaged|refund|lalamiko|shida|tatizo)\b/i.test(t)) return { type: 'complaint' };
  if (/\b(recipe|cook|make|prepare|bake|fry|dish|meal|how to make|mapishi|kupika|kaanga)\b/i.test(t)) return { type: 'recipe' };
  if (/\b(loyalty|points|reward|cashback|balance|tier|redeem|pointi|zawadi|hatua)\b/i.test(t)) return { type: 'loyalty' };
  if (/\b(delivery|shipping|fare|deliver|usafirishaji|peleka)\b/i.test(t)) return { type: 'delivery' };
  if (/\b(discount|coupon|promo|code|offer|deal|save|punguzo|kuponi)\b/i.test(t)) return { type: 'discount' };
  if (/\b(search|find|show|look|browse|list|tafuta|nionyeshe|onyesha)\b/i.test(t)) {
    const matched = findMatchingProducts(t, products, 5);
    return matched.length > 0 ? { type: 'product_search', results: matched } : { type: 'product_search_no_results' };
  }
  if (/\b(recommend|suggest|popular|best|top|what should|pendekeza|bora)\b/i.test(t)) return { type: 'recommend' };
  if (/\b(hello|hi|hey|jambo|sup|yo|morning|afternoon|evening|how are|what's up|habari|mambo|vipi|poa|sijambo)\b/i.test(t)) return { type: 'greeting' };
  if (/\b(help|what can you|capabilities|features)\b/i.test(t)) return { type: 'help' };
  if (/\b(price|cost|how much|expensive|cheap|bei|ngapi|ghali|nafuu)\b/i.test(t)) {
    const matched = findMatchingProducts(t, products, 5);
    return matched.length > 0 ? { type: 'price_check', products: matched } : { type: 'price_general' };
  }
  if (/\b(stock|available|in stock|out of|left|remaining|imeisha|hakuna)\b/i.test(t)) {
    const matched = findMatchingProducts(t, products, 5);
    return matched.length > 0 ? { type: 'stock_check', products: matched } : { type: 'stock_general' };
  }
  const matched = findMatchingProducts(t, products, 3);
  if (matched.length > 0) return { type: 'product_search', results: matched };
  return { type: 'unknown' };
}

async function generateAiResponse(intent, text, context) {
  const { customerId, products, orders, loyalty, message } = context;
  switch (intent.type) {
    case 'greeting':
      return `Jambo! 👋 Welcome to BlitzMall AI.\n\nI can help you shop, track orders, find deals, and more!\n\nTry asking me:\n• "Add milk to cart"\n• "Track my order"\n• "Show me deals"`;
    case 'add_to_cart': {
      const p = intent.product;
      return `🛒 **Added to cart:**\n• ${p.name} × ${intent.quantity} — KES ${(p.price * intent.quantity).toLocaleString()}\n\nView your cart or continue shopping!`;
    }
    case 'add_to_cart_no_match': {
      const searchResults = findMatchingProducts(text, products, 3);
      if (searchResults.length > 0) {
        return `I couldn't find an exact match, but here are similar products:\n\n${searchResults.map(p => `• ${p.name} — KES ${p.price}`).join('\n')}\n\nSay "add [product name]" to add one to your cart!`;
      }
      return `I couldn't find a matching product. Try:\n• "add [product name]" — e.g., "add milk to cart"\n• "search [keyword]" — to browse products`;
    }
    case 'order_status': {
      if (!customerId) return '👤 Please log in first so I can look up your orders.';
      if (!orders.length) return '📦 You don\'t have any orders yet. Start shopping today!';
      const latest = orders[0];
      const emoji = { pending: '⏳', packed: '📦', on_the_way: '🛵', delivered: '✅', cancelled: '❌' };
      return `${emoji[latest.status] || '📋'} **Your Latest Order:**\n\n• Order ID: #${latest._id.toString().slice(-6)}\n• Status: **${(latest.status || 'pending').toUpperCase()}**\n• Total: KES ${(latest.totalPrice || 0).toLocaleString()}\n• Items: ${latest.items.map(i => `${i.name} ×${i.quantity}`).join(', ')}\n• Payment: ${(latest.paymentMethod || 'delivery').toUpperCase()}\n• Date: ${new Date(latest.createdAt).toLocaleDateString()}\n\nSay "cancel order" if it's still pending.`;
    }
    case 'cancel_order': {
      if (!customerId) return '👤 Please log in first to manage your orders.';
      const pending = orders.find(o => o.status === 'pending');
      if (!pending) return '🔍 You don\'t have any pending orders that can be cancelled.';
      return `📋 Found pending order #${pending._id.toString().slice(-6)} (KES ${(pending.totalPrice || 0).toLocaleString()}).\n\nGo to **My Orders** in your profile to cancel it, or say "yes cancel it" and I'll cancel it for you now.`;
    }
    case 'confirm_cancel': {
      if (!customerId) return '👤 Please log in first.';
      const pending = orders.find(o => o.status === 'pending');
      if (!pending) return '🔍 No pending orders to cancel.';
      try {
        await orders_.updateOne({ _id: new ObjectId(pending._id) }, { $set: { status: 'cancelled' } });
        for (const it of pending.items) {
          const id = it._id || it.id;
          if (id && ObjectId.isValid(id)) {
            await products_.updateOne({ _id: new ObjectId(id) }, { $inc: { stock: Math.abs(it.quantity) } });
          }
        }
        return `❌ **Order Cancelled:**\n\nOrder #${pending._id.toString().slice(-6)} has been cancelled and stock restored.\n\nNeed anything else?`;
      } catch (err) {
        return '⚠️ Failed to cancel order. Please try from My Orders page.';
      }
    }
    case 'complaint': {
      if (customerId) {
        try {
          await reviews_.insertOne({ customerId, customerName: 'Customer', rating: 1, message: `[AI Complaint] ${message}`, createdAt: new Date() });
        } catch (e) {
          console.error('Failed to log AI complaint:', e);
        }
      }
      return `📝 I'm sorry to hear about this issue. Your complaint has been noted and logged.\n\nTo help us resolve it faster:\n• Which order is affected?\n• What specifically went wrong?\n\nOur team will look into this. You can also use **Profile → Rate us** for formal feedback.`;
    }
    case 'recipe': {
      const available = products.filter(p => /milk|flour|sugar|oil|bread|egg/i.test(p.name)).slice(0, 6);
      const prodList = available.length > 0 ? `\n\nAvailable in store:\n${available.map(p => `• ${p.name} — KES ${p.price}`).join('\n')}` : '';
      return `🍳 **Recipe Ideas:**\n\n1. **Pancakes** — Mix flour, milk, sugar; fry in oil\n2. **French Toast** — Dip bread in egg+milk; fry golden\n3. **Stir Fry** — Vegetables + cooking oil\n4. **Milkshake** — Blend milk + sugar + ice${prodList}\n\nSay "add [ingredient]" to add to your cart!`;
    }
    case 'loyalty': {
      if (!customerId) return '👤 Log in to check your loyalty points!';
      if (!loyalty) return '🎁 Join our loyalty program! Earn 1 point per KES 100 spent.\n\nBronze → Silver (KES 25K) → Gold (KES 100K) → Platinum\nRedeem points for discounts at checkout!';
      return `🎁 **Your Loyalty Card:**\n\n• Tier: **${loyalty.tier}**\n• Points: **${loyalty.points}** PTS\n• Total Spent: KES ${(loyalty.totalSpent || 0).toLocaleString()}\n• Est. Cashback: KES ${Math.round((loyalty.points || 0) * 5).toLocaleString()}`;
    }
    case 'delivery':
      return `🚚 **Delivery Options:**\n\n• **Mall Area:** FREE delivery!\n• **Standard:** KES 150 flat fee\n• **Free Delivery:** Orders over KES 1,500!\n\n📍 GPS pinning available at checkout.`;
    case 'discount': {
      let couponInfo = '';
      try {
        const activeCoupons = await coupons_.find({ active: true }).toArray();
        if (activeCoupons.length > 0) {
          couponInfo = activeCoupons.map(c => {
            const disc = c.type === 'percent' ? `${c.value}% off` : `KES ${c.value} off`;
            const min = c.minPurchase ? ` (min KES ${c.minPurchase})` : '';
            return `• \`${c.code}\` — ${disc}${min}`;
          }).join('\n');
        }
      } catch (e) {
        console.error('Failed to fetch active coupons:', e);
      }
      return `🏷️ **Active Deals:**\n\n${couponInfo || '• Use code \`BLITZ10\` for 10% off orders over KES 1,000!'}\n\n🎡 Try the **Spin the Wheel** on the home screen for exclusive coupons!`;
    }
    case 'product_search': {
      if (!intent.results || intent.results.length === 0) return '🔍 No products found. Try different keywords!';
      return `🔍 **Products found:**\n\n${intent.results.map(p => `• **${p.name}** — KES ${p.price}${p.stock > 0 ? ` (${p.stock} in stock)` : ' ❌ Out of stock'}`).join('\n')}\n\nSay "add [name]" to add to cart!`;
    }
    case 'product_search_no_results':
      return '🔍 No products found. Try different keywords or browse categories on the home screen!';
    case 'recommend': {
      // Personalised picks: prefer categories the customer has bought before.
      const bought = new Set((orders || []).flatMap(o => (o.items || []).map(i => (i.category || '').trim().toLowerCase()).filter(Boolean)));
      let popular = [];
      if (bought.size) {
        popular = products.filter(p => p.stock > 0 && bought.has((p.category || '').trim().toLowerCase())).slice(0, 5);
      }
      if (popular.length < 3) {
        const newest = products.filter(p => p.stock > 0).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
        popular = [...new Set([...popular, ...newest])].slice(0, 5);
      }
      if (!popular.length) return '🛍️ No products available right now.';
      const headline = bought.size ? '🎯 **Recommended for you (from your past orders):**' : '🌟 **Top Picks:**';
      return `${headline}\n\n${popular.map(p => `• **${p.name}** — KES ${p.price}`).join('\n')}\n\nSay "add [name]" to add to cart, or "order milk and bread" to place an order!`;
    }
    case 'price_check': {
      return `💰 **Prices:**\n\n${intent.products.map(p => `• **${p.name}** — KES ${p.price}${p.isFlashSale ? ' ⚡ FLASH' : ''}`).join('\n')}`;
    }
    case 'price_general':
      return '💰 Search for a specific product to see its price, or browse categories!';
    case 'stock_check': {
      return `📦 **Stock Status:**\n\n${intent.products.map(p => `• **${p.name}** — ${p.stock > 10 ? '✅ In stock' : p.stock > 0 ? `⚠️ Low (${p.stock} left)` : '❌ Out of stock'}`).join('\n')}`;
    }
    case 'stock_general':
      return '📦 Check product pages for real-time stock levels!';
    case 'place_order': {
      if (!customerId) return '👤 Please log in first so I can place your order.';
      const inStock = (intent.products || []).filter(p => (p.stock || 0) > 0).slice(0, 10);
      if (!inStock.length) return '😅 Sorry, those items are out of stock right now. Try something else or check back later!';
      const items = inStock.map(p => ({ _id: p._id, name: p.name, price: p.price, quantity: 1 }));
      const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
      let cust = null;
      try { cust = await customers_.findOne({ phone: String(customerId).replace(/[^0-9]/g, '') }); } catch (e) { cust = null; }
      const order = {
        customerId, customerName: (cust && cust.name) || 'Customer', items, totalPrice: total,
        paymentMethod: 'delivery', status: 'pending', createdAt: new Date(),
        deliveryLocation: 'Ordered via AI chat', deliveryFee: 0, gpsCoords: null,
        shopCoords: SHOP_COORDS, couponCode: null, discount: 0,
        deliveryProgress: 0, dispatchedAt: null, deliveredAt: null, viaAi: true
      };
      const result = await orders_.insertOne(order);
      for (const it of items) { if (it._id) await products_.updateOne({ _id: it._id }, { $inc: { stock: -1 } }); }
      intent.orderResult = { orderId: String(result.insertedId), total };
      return `🛍️ **Order placed!**\n\n${items.map(i => `• ${i.name} ×${i.quantity} — KES ${(i.price * i.quantity).toLocaleString()}`).join('\n')}\n\n**Total: KES ${total.toLocaleString()}** — pay on delivery.\n\nSay "track my order" for updates!`;
    }
    case 'help':
    default:
      return `🤖 **BlitzMall AI Assistant**\n\n🛒 **Shopping:**\n• "Add [product] to cart"\n• "Search for [keyword]"\n• "Show me [category]"\n\n📦 **Orders:**\n• "Track my order"\n• "Cancel order"\n\n🎁 **Rewards:**\n• "My loyalty points"\n• "Show me deals"\n\n💡 **More:**\n• "Recipe ideas"\n• "Delivery info"\n• "How much is [product]"\n\nJust ask naturally! 😊`;
  }
}

function customerLlmSystem(products, history) {
  const catalog = (products || []).slice(0, 40).map(p => `- ${p.name} (KES ${p.price})`).join('\n');
  const hist = (Array.isArray(history) && history.length)
    ? '\n\nRecent conversation:\n' + history.slice(-8).map(m => `${m.sender === 'user' ? 'Customer' : 'Assistant'}: ${m.text}`).join('\n')
    : '';
  return `You are BlitzMall's friendly AI shopping assistant for a Kenyan grocery store in Matunda, Kakamega. Customers may write in English, Swahili, or Sheng - reply in the same language they used. Help with: shopping, order tracking, cancellation, complaints, recipes, loyalty points, delivery (Mall Area free, standard KES 150, free over KES 1,500), discounts, product search, prices, stock. Be brief and warm, under 120 words. Products available:\n${catalog}${hist}`;
}

function adminLlmSystem() {
  return `You are BlitzMall's AI Business Assistant for a Kenyan grocery store owner. The owner may ask in English or Swahili - reply in the same language. You have live store data via a built-in analytics engine covering sales, profit, expenses, inventory, orders, staff, loyalty, coupons, predictions, cash vs M-Pesa, customer lookups, credit, shifts and categories. You can also carry out actions the owner requests - adding or restocking products, updating prices, setting discounts, creating or disabling coupons, adding loyalty points, adding staff, recording cash sales and refunding sales. For anything the rules cannot compute, give practical business advice or suggest asking about specific data. Keep answers under 120 words.`;
}

app.post('/api/ai/chat', async (req, res) => {
  const { message, customerId, conversationHistory } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  try {
    const text = message.trim();
    const [products, customerOrders, loyaltyRecord] = await Promise.all([
      products_.find({}).toArray(),
      customerId ? orders_.find({ customerId }).sort({ createdAt: -1 }).toArray() : [],
      customerId ? loyalty_.findOne({ phone: customerId }) : null
    ]);
    const intent = detectAiIntent(text, products);
    let response = await generateAiResponse(intent, text, { customerId, products, orders: customerOrders, loyalty: loyaltyRecord, conversationHistory });
    // If the rule engine could not understand, ask the local Ollama model (handles open-ended questions, Swahili and Sheng).
    if (intent.type === 'unknown') {
      const llm = await askOllama(customerLlmSystem(products, conversationHistory), text);
      if (llm) response = llm;
    }
    let action = null;
    if (intent.type === 'add_to_cart') {
      action = { type: 'add_to_cart', product: intent.product, quantity: intent.quantity };
    } else if (intent.orderResult) {
      action = { type: 'order_placed', orderId: intent.orderResult.orderId, total: intent.orderResult.total };
    }
    res.json({ response, action });
  } catch (err) {
    console.error('AI chat error:', err);
    res.json({ response: 'Sorry, I encountered an error. Please try again.', action: null });
  }
});


// ===== ADMIN AI ASSISTANT ENGINE =====
function detectAdminIntent(text) {
  const t = text.toLowerCase().trim();
  if (/\b(hello|hi|hey|help|what can you)\b/i.test(t)) return { type: 'greeting' };
  if (/\b(restock|add stock|refill|weka stock)\b/i.test(t) && /\d/.test(t)) return { type: 'restock' };
  if (/\b(mark|set|update|change)\b.*\b(delivered|on the way|dispatched|cancelled|cancel|pending)\b/i.test(t)) return { type: 'order_action' };
  if (/\b(add|record|log|weka)\b.*\b(expense|cost|gharama)\b/i.test(t) && /\d/.test(t)) return { type: 'add_expense' };
  if (/\b(anomal\w*|unusual|drop|down|compare|insight|flag|alert)\b/i.test(t)) return { type: 'anomalies' };
  if (/\b(add|create|weka)\b.*\b(product|item|bidhaa)\b/i.test(t)) return { type: 'add_product' };
  if (/\b(update|change|set|weka)\b.*\b(price|bei)\b/i.test(t) && /\d/.test(t)) return { type: 'update_price' };
  if (/\b(discount|punguzo|reduce|cut)\b.*\b(%|percent|percentage)/i.test(t)) return { type: 'set_discount' };
  if (/\b(add|increase|set|update|weka)\b.*\bstock\b/i.test(t) && /\d/.test(t)) return { type: 'adjust_stock' };
  if (/\b(find|lookup|search|show|check|tafuta)\b.*\b(customer|client|mteja)\b/i.test(t)) return { type: 'customer_lookup' };
  if (/\b(credit|owe\w*|debt|deni)\b/i.test(t) && /\b(who|list|show|all|balances|customers|how many)\b/i.test(t)) return { type: 'credit_list' };
  if (/\b(add|give|award|bonus|weka)\b.*\b(points|pointi)\b/i.test(t) && /\d/.test(t)) return { type: 'add_points' };
  if (/\b(create|make|new|weka)\b.*\b(coupon|kuponi|promo)\b/i.test(t)) return { type: 'create_coupon' };
  if (/\b(disable|deactivate|stop|remove|turn off)\b.*\b(coupon|kuponi|promo)\b/i.test(t)) return { type: 'disable_coupon' };
  if (/\b(coupon|kuponi|promo)\b.*\b(redemptions?|redeemed|used|usage|how many)\b/i.test(t)) return { type: 'coupon_redemptions' };
  if (/\b(list|show|active|all)\b.*\b(coupons|kuponi)\b/i.test(t)) return { type: 'list_coupons' };
  if (/\b(average|avg)\b.*\b(order|basket|purchase)\b/i.test(t)) return { type: 'avg_order' };
  if (/\b(best|top|popular|leading)\b.*\b(categor\w*|section\w*)\b/i.test(t)) return { type: 'best_category' };
  if (/\b(repeat|returning|frequent|regular)\b.*\b(customers?|clients?)\b/i.test(t)) return { type: 'repeat_customers' };
  if (/\b(stock|inventory)\b.*\b(value|worth)\b/i.test(t)) return { type: 'stock_value' };
  if (/\b(busiest|peak|best)\b.*\b(hour|time)\b/i.test(t)) return { type: 'busiest_hour' };
  if (/\b(by day|per day|daily)\b/i.test(t) && /\b(sales|revenue|mapato)\b/i.test(t)) return { type: 'sales_by_day' };
  if (/\b(add|register|hire|weka)\b.*\b(staff|employee|worker|cashier|mfanyakazi)\b/i.test(t)) return { type: 'add_staff' };
  if (/\b(working|on duty|on shift|clocked)\b.*\b(today|now)\b/i.test(t)) return { type: 'working_today' };
  if (/\b(shift|muhula)\b.*\b(summary|total|cash|reconcil|report)\b/i.test(t)) return { type: 'shift_summary' };
  if (/\b(staff|employee|cashier)\b.*\b(performance|best|top|rank)\b/i.test(t)) return { type: 'staff_performance' };
  if (/\b(today's|todays|recent|latest)\b.*\b(sales|transactions|receipts)\b/i.test(t)) return { type: 'sales_list' };
  if (/\b(refund|void|reverse)\b.*\b(sale|payment|transaction)\b/i.test(t) && /#/.test(t)) return { type: 'refund_sale' };
  if (/\b(record|log|enter|weka)\b.*\b(sale|payment)\b/i.test(t) && /\d/.test(t)) return { type: 'record_sale' };
  if (/\b(sale|revenue|income|earn|sold|today|this week|this month|how much|performance)\b/i.test(t)) {
    if (/\b(today|now|current)\b/i.test(t)) return { type: 'sales_today' };
    if (/\b(week|weekly)\b/i.test(t)) return { type: 'sales_week' };
    if (/\b(month|monthly)\b/i.test(t)) return { type: 'sales_month' };
    if (/\b(year|yearly|annual)\b/i.test(t)) return { type: 'sales_year' };
    if (/\b(best|top|popular|most|trending)\b/i.test(t)) return { type: 'best_sellers' };
    return { type: 'sales_summary' };
  }
  if (/\b(profit|margin|net|loss)\b/i.test(t)) return { type: 'profit' };
  if (/\b(expense|cost|spend|overhead|deduction)\b/i.test(t)) return { type: 'expenses' };
  if (/\b(inventory|stock|product|item|goods|warehouse)\b/i.test(t)) {
    if (/\b(out|empty|zero|depleted|none)\b/i.test(t)) return { type: 'out_of_stock' };
    if (/\b(low|low stock|running out|critical)\b/i.test(t)) return { type: 'low_stock' };
    if (/\b(expir|rotting|old|expire soon)\b/i.test(t)) return { type: 'expiring' };
    if (/\b(count|total|how many|number|list|show)\b/i.test(t)) return { type: 'inventory_count' };
    return { type: 'inventory_summary' };
  }
  if (/\b(orders?|deliver(y|ies)|customer orders?|pending orders?)\b/i.test(t)) {
    if (/\b(pending|new|incoming|today)\b/i.test(t)) return { type: 'pending_orders' };
    if (/\b(delivered|completed|done|fulfilled)\b/i.test(t)) return { type: 'delivered_orders' };
    if (/\b(cancel)\b/i.test(t)) return { type: 'cancelled_orders' };
    return { type: 'orders_summary' };
  }
  if (/\b(loyalty|points|reward|member|tier)\b/i.test(t)) return { type: 'loyalty_summary' };
  if (/\b(staff|employee|cashier|worker|team)\b/i.test(t)) return { type: 'staff_summary' };
  if (/\b(coupon|discount|promo|deal|offer)\b/i.test(t)) return { type: 'coupons_summary' };
  if (/\b(predict|forecast|trend|expect|future|restock|slow)\b/i.test(t)) return { type: 'predictions' };
  if (/\b(cash|cashier|drawer|balance|register)\b/i.test(t)) return { type: 'cash_summary' };
  if (/\b(summary|overview|dashboard|snapshot|report)\b/i.test(t)) return { type: 'full_summary' };
  return { type: 'general' };
}

async function generateAdminAiResponse(intent, text, branchId, userName) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startWeek = new Date(startToday);
  const dow = now.getDay(); startWeek.setDate(startToday.getDate() - (dow === 0 ? 6 : dow - 1));
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startYear = new Date(now.getFullYear(), 0, 1);
  const inP = (d, s) => new Date(d) >= s;

  const branchQ = branchId ? { branchId } : {};

  const [allSales, allOrders, allExpenses, allProducts, allStaff, allLoyalty, allCoupons] = await Promise.all([
    sales_.find(branchQ).toArray(),
    orders_.find(branchQ).toArray(),
    expenses_.find(branchQ).toArray(),
    products_.find(branchQ).toArray(),
    staff_.find(branchQ).toArray(),
    loyalty_.find({}).toArray(),
    coupons_.find({}).toArray()
  ]);

  const calc = (start) => {
    let revenue = 0, profit = 0, cash = 0, mpesa = 0, count = 0;
    for (const s of allSales) { if (s.refunded || !inP(s.createdAt, start)) continue; count++; revenue += s.total || 0; profit += s.profit || 0; if (s.paymentMethod === 'cash') cash += s.total || 0; else if (s.paymentMethod === 'mpesa') mpesa += s.total || 0; else if (s.paymentMethod === 'split') { cash += s.cashPart || 0; mpesa += s.mpesaPart || 0; } }
    for (const o of allOrders) { if (o.status === 'cancelled' || !inP(o.createdAt, start)) continue; count++; revenue += o.totalPrice || 0; let op = 0; for (const it of (o.items || [])) { const q = it.quantity || it.qty || 0; op += ((it.price || 0) - (it.buyingPrice || 0)) * q; } profit += op; if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0; else cash += o.totalPrice || 0; }
    let exp = 0; for (const e of allExpenses) if (inP(e.createdAt, start)) exp += e.amount || 0;
    return { revenue, profit, expenses: exp, net: profit - exp, cash, mpesa, count };
  };

  const today = calc(startToday);
  const week = calc(startWeek);
  const month = calc(startMonth);
  const year = calc(startYear);

  const money = (n) => 'KES ' + Math.round(n || 0).toLocaleString();
  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;

  const tally = {};
  for (const s of allSales) { if (s.refunded) continue; for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0); }
  for (const o of allOrders) { if (o.status !== 'cancelled') for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0); }
  const best = Object.entries(tally).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
  const outOfStock = allProducts.filter(p => (p.stock || 0) <= 0).map(p => p.name);
  const lowStock = allProducts.filter(p => (p.stock || 0) > 0 && (p.stock || 0) < 2).map(p => p.name + ' (' + p.stock + ')');
  const expiringSoon = allProducts.filter(p => { if (!p.expiryDate) return false; const diff = new Date(p.expiryDate) - now; return diff >= 0 && diff <= 7 * 86400000; }).map(p => p.name);
  const pendingOrders = allOrders.filter(o => o.status === 'pending');
  const deliveredOrders = allOrders.filter(o => o.status === 'delivered');
  const cancelledOrders = allOrders.filter(o => o.status === 'cancelled');

  switch (intent.type) {
    case 'greeting':
      return '\ud83e\udd16 **Blitz Mall AI Business Assistant**\n\nI have access to your full store data. Ask me about:\n\n\ud83d\udcca **Sales** \u2014 "How were sales today?"\n\ud83d\udcb0 **Profit** \u2014 "What\'s my profit this month?"\n\ud83d\udce6 **Inventory** \u2014 "Any out of stock items?"\n\ud83d\uded2 **Orders** \u2014 "Show pending orders"\n\ud83d\udcc8 **Predictions** \u2014 "Restock predictions"\n\ud83d\udc65 **Staff** \u2014 "Who are my staff?"\n\ud83c\udfaf **Best sellers** \u2014 "What sold best?"\n\ud83d\udcb3 **Payments** \u2014 "Cash vs M-Pesa today"\n\nJust ask naturally! \ud83d\ude0a';
    case 'sales_today':
      return '\ud83d\udcca **Today\'s Sales:**\n\n\u2022 **Transactions:** ' + today.count + '\n\u2022 **Revenue:** ' + money(today.revenue) + '\n\u2022 **Cash:** ' + money(today.cash) + '\n\u2022 **M-Pesa:** ' + money(today.mpesa) + '\n\u2022 **Profit:** ' + money(today.profit) + '\n\n' + (today.revenue > 0 ? '\ud83d\udca1 ' + (today.mpesa > today.cash ? 'M-Pesa is leading today!' : 'Cash is leading today!') : 'No sales recorded yet today.');
    case 'sales_week':
      return '\ud83d\udcca **This Week\'s Sales:**\n\n\u2022 **Transactions:** ' + week.count + '\n\u2022 **Revenue:** ' + money(week.revenue) + '\n\u2022 **Profit:** ' + money(week.profit) + '\n\u2022 **Expenses:** ' + money(week.expenses) + '\n\u2022 **Net:** ' + money(week.net) + '\n\n\ud83d\udcc8 Daily avg: ' + money(week.revenue / 7);
    case 'sales_month':
      return '\ud83d\udcca **This Month\'s Sales:**\n\n\u2022 **Transactions:** ' + month.count + '\n\u2022 **Revenue:** ' + money(month.revenue) + '\n\u2022 **Profit:** ' + money(month.profit) + '\n\u2022 **Expenses:** ' + money(month.expenses) + '\n\u2022 **Net:** ' + money(month.net) + '\n\n\ud83d\udcc8 Daily avg: ' + money(month.revenue / now.getDate());
    case 'sales_year':
      return '\ud83d\udcca **Year to Date:**\n\n\u2022 **Transactions:** ' + year.count + '\n\u2022 **Revenue:** ' + money(year.revenue) + '\n\u2022 **Profit:** ' + money(year.profit) + '\n\u2022 **Expenses:** ' + money(year.expenses) + '\n\u2022 **Net:** ' + money(year.net);
    case 'best_sellers':
      if (best.length === 0) return '\ud83d\udcca No sales data yet.';
      return '\ud83c\udfc6 **Top 10 Best Sellers:**\n\n' + best.slice(0, 10).map((b, i) => (i + 1) + '. **' + b.name + '** \u2014 ' + b.qty + ' sold').join('\n') + '\n\nTotal unique products sold: ' + best.length;
    case 'sales_summary':
      return '\ud83d\udcca **Sales Overview:**\n\n\u2022 Today: ' + money(today.revenue) + ' (' + today.count + ' txns)\n\u2022 This Week: ' + money(week.revenue) + ' (' + week.count + ' txns)\n\u2022 This Month: ' + money(month.revenue) + ' (' + month.count + ' txns)\n\u2022 This Year: ' + money(year.revenue) + ' (' + year.count + ' txns)';
    case 'profit':
      return '\ud83d\udcb0 **Profit Breakdown:**\n\n\u2022 Today: ' + money(today.profit) + ' profit' + (today.expenses > 0 ? ' \u2013 ' + money(today.expenses) + ' expenses = **' + money(today.net) + ' net**' : '') + '\n\u2022 This Week: ' + money(week.profit) + ' profit' + (week.expenses > 0 ? ' \u2013 ' + money(week.expenses) + ' expenses = **' + money(week.net) + ' net**' : '') + '\n\u2022 This Month: ' + money(month.profit) + ' profit' + (month.expenses > 0 ? ' \u2013 ' + money(month.expenses) + ' expenses = **' + money(month.net) + ' net**' : '') + '\n\u2022 Year to Date: ' + money(year.profit) + ' profit';
    case 'expenses': {
      const todayExp = allExpenses.filter(e => inP(e.createdAt, startToday));
      return '\ud83d\udcb8 **Expenses:**\n\n\u2022 Today: ' + money(today.expenses) + ' (' + todayExp.length + ' entries)\n\u2022 This Week: ' + money(week.expenses) + '\n\u2022 This Month: ' + money(month.expenses) + '\n\u2022 Year to Date: ' + money(year.expenses) + (todayExp.length > 0 ? '\n\n\ud83d\udccb Today\'s:\n' + todayExp.map(e => '\u2022 ' + e.description + ': ' + money(e.amount)).join('\n') : '');
    }
    case 'out_of_stock':
      return outOfStock.length > 0 ? '\ud83d\udea8 **Out of Stock (' + outOfStock.length + '):**\n\n' + outOfStock.map(n => '\u2022 ' + n).join('\n') + '\n\n\u26a1 Go to Inventory to restock!' : '\u2705 All products are in stock!';
    case 'low_stock':
      return lowStock.length > 0 ? '\u26a0\ufe0f **Low Stock (' + lowStock.length + '):**\n\n' + lowStock.map(n => '\u2022 ' + n).join('\n') + '\n\nThese items need restocking soon.' : '\u2705 No items critically low.';
    case 'expiring':
      return expiringSoon.length > 0 ? '\u23f0 **Expiring Soon (' + expiringSoon.length + '):**\n\n' + expiringSoon.map(n => '\u2022 ' + n).join('\n') + '\n\nConsider a flash sale!' : '\u2705 No products expiring within 7 days.';
    case 'inventory_count':
      return '\ud83d\udce6 **Inventory:**\n\n\u2022 Products: ' + allProducts.length + '\n\u2022 Total stock: ' + allProducts.reduce((s, p) => s + (p.stock || 0), 0) + '\n\u2022 Categories: ' + [...new Set(allProducts.map(p => p.category || 'Other'))].length + '\n\u2022 Out of stock: ' + outOfStock.length + '\n\u2022 Low stock: ' + lowStock.length;
    case 'inventory_summary': {
      const totalValue = allProducts.reduce((s, p) => s + (p.price || 0) * (p.stock || 0), 0);
      const totalCost = allProducts.reduce((s, p) => s + (p.buyingPrice || 0) * (p.stock || 0), 0);
      return '\ud83d\udce6 **Inventory Summary:**\n\n\u2022 Products: ' + allProducts.length + '\n\u2022 Stock value (sell): ' + money(totalValue) + '\n\u2022 Stock value (cost): ' + money(totalCost) + '\n\u2022 Potential profit: ' + money(totalValue - totalCost) + '\n\u2022 Out of stock: ' + outOfStock.length;
    }
    case 'pending_orders':
      if (pendingOrders.length === 0) return '\ud83d\uded2 No pending orders.';
      return '\ud83d\uded2 **Pending Orders (' + pendingOrders.length + '):**\n\n' + pendingOrders.slice(0, 5).map(o => '\u2022 ' + (o.customerName || 'Customer') + ' \u2014 ' + money(o.totalPrice) + ' (' + (o.paymentMethod || 'delivery') + ')').join('\n') + (pendingOrders.length > 5 ? '\n... and ' + (pendingOrders.length - 5) + ' more' : '');
    case 'delivered_orders':
      return '\u2705 Delivered: ' + deliveredOrders.length + ' | \u274c Cancelled: ' + cancelledOrders.length + ' | Rate: ' + pct(deliveredOrders.length, deliveredOrders.length + cancelledOrders.length) + '%';
    case 'cancelled_orders':
      if (cancelledOrders.length === 0) return '\u2705 No cancelled orders.';
      return '\u274c **Cancelled (' + cancelledOrders.length + '):**\n\n' + cancelledOrders.slice(0, 5).map(o => '\u2022 ' + (o.customerName || 'Customer') + ' \u2014 ' + money(o.totalPrice)).join('\n');
    case 'orders_summary':
      return '\ud83d\uded2 **Orders:**\n\n\u2022 Pending: ' + pendingOrders.length + '\n\u2022 Delivered: ' + deliveredOrders.length + '\n\u2022 Cancelled: ' + cancelledOrders.length + '\n\u2022 Total: ' + allOrders.length + '\n\u2022 Revenue: ' + money(allOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.totalPrice || 0), 0));
    case 'loyalty_summary':
      return '\ud83c\udf81 **Loyalty:**\n\n\u2022 Members: ' + allLoyalty.length + '\n\u2022 Points issued: ' + allLoyalty.reduce((s, l) => s + (l.points || 0), 0) + '\n\u2022 Bronze: ' + allLoyalty.filter(l => l.tier === 'Bronze').length + ' | Silver: ' + allLoyalty.filter(l => l.tier === 'Silver').length + ' | Gold: ' + allLoyalty.filter(l => l.tier === 'Gold').length;
    case 'staff_summary':
      return '\ud83d\udc65 **Staff:**\n\n\u2022 Total: ' + allStaff.length + '\n\u2022 Names: ' + (allStaff.length > 0 ? allStaff.map(s => s.name).join(', ') : 'None registered');
    case 'coupons_summary': {
      const active = allCoupons.filter(c => c.active);
      return '\ud83c\udff7\ufe0f **Coupons:**\n\n\u2022 Active: ' + active.length + ' / ' + allCoupons.length + (active.length > 0 ? '\n\n' + active.map(c => '\u2022 ' + c.code + ' \u2014 ' + (c.type === 'percent' ? c.value + '% off' : money(c.value) + ' off')).join('\n') : '');
    }
    case 'predictions': {
      try {
        const tallyPred = {};
        for (const s of allSales) for (const it of (s.items || [])) tallyPred[it.name] = (tallyPred[it.name] || 0) + (it.qty || 0);
        for (const o of allOrders) { if (o.status !== 'cancelled') for (const it of (o.items || [])) tallyPred[it.name] = (tallyPred[it.name] || 0) + (it.quantity || it.qty || 0); }
        const preds = generatePredictions(allSales, allOrders, allProducts, tallyPred);
        let msg = '\ud83e\udde0 **AI Predictions:**\n\n';
        if (preds.forecast && preds.forecast.avgDaily > 0) msg += '\ud83d\udcc8 **7-Day Forecast:** ' + money(preds.forecast.next7Days) + ' (avg ' + money(preds.forecast.avgDaily) + '/day)\n\n';
        if (preds.restock.length > 0) msg += '\ud83d\udd04 **Restock (' + preds.restock.length + '):**\n' + preds.restock.slice(0, 5).map(r => '\u2022 ' + r.name + ' \u2014 ' + r.daysLeft + ' days left').join('\n') + '\n\n';
        if (preds.slowMoving.length > 0) msg += '\ud83d\udc22 **Slow Moving (' + preds.slowMoving.length + '):**\n' + preds.slowMoving.slice(0, 5).map(r => '\u2022 ' + r.name + ' \u2014 ' + r.monthlyRate + '/month').join('\n');
        return msg || 'No prediction data available yet.';
      } catch (e) { return '\u26a0\ufe0f Could not generate predictions: ' + e.message; }
    }
    case 'cash_summary':
      return '\ud83d\udcb3 **Payments:**\n\n\u2022 Today: Cash ' + money(today.cash) + ' | M-Pesa ' + money(today.mpesa) + '\n\u2022 Week: Cash ' + money(week.cash) + ' | M-Pesa ' + money(week.mpesa) + '\n\u2022 Month: Cash ' + money(month.cash) + ' | M-Pesa ' + money(month.mpesa) + (today.revenue > 0 ? '\n\nSplit: ' + pct(today.cash, today.revenue) + '% / ' + pct(today.mpesa, today.revenue) + '%' : '');
    case 'full_summary':
      return '\ud83d\udcca **Business Snapshot:**\n\n\ud83d\udcb0 Revenue: ' + money(today.revenue) + ' today | ' + money(week.revenue) + ' week | ' + money(month.revenue) + ' month\n\ud83d\udcc8 Profit: ' + money(today.profit) + ' today | ' + money(week.profit) + ' week | ' + money(month.profit) + ' month\n\ud83d\udcb8 Expenses: ' + money(today.expenses) + ' today | ' + money(week.expenses) + ' week\n\ud83d\udce6 Products: ' + allProducts.length + ' (' + outOfStock.length + ' out)\n\ud83d\uded2 Orders: ' + allOrders.length + ' (' + pendingOrders.length + ' pending)\n\ud83d\udc65 Staff: ' + allStaff.length + ' | \ud83c\udf81 Loyalty: ' + allLoyalty.length;
    case 'restock': {
      const m = text.match(/restock\s+(.+?)\s+(?:by|with|add)?\s*(\d+)/i);
      if (!m) return '🤖 Say e.g. "restock Milk by 10".';
      const qty = parseInt(m[2], 10);
      const found = findMatchingProducts(m[1], allProducts, 1);
      if (!found.length) return '🔍 I could not find that product in inventory.';
      const p = found[0];
      await products_.updateOne({ _id: p._id }, { $inc: { stock: qty } });
      intent.didWrite = true;
      return `✅ **Restocked:** ${p.name} +${qty} → now ${(p.stock || 0) + qty} in stock.`;
    }
    case 'order_action': {
      const idMatch = text.match(/#\s*([a-zA-Z0-9]{6,})/i) || text.match(/\b([a-f0-9]{24})\b/i);
      const target = idMatch ? idMatch[1].toLowerCase() : '';
      const st = text.toLowerCase();
      const status = /delivered/.test(st) ? 'delivered' : /on the way|dispatched/.test(st) ? 'on_the_way' : /cancell/.test(st) ? 'cancelled' : /pending/.test(st) ? 'pending' : '';
      if (!target || !status) return '🤖 Say e.g. "mark order #5f3ab2 delivered".';
      const order = allOrders.find(o => String(o._id).toLowerCase().includes(target) || String(o._id).slice(-6) === target);
      if (!order) return '🔍 Order not found. Try its ID from the Orders tab.';
      const update = { status };
      if (status === 'on_the_way') update.dispatchedAt = new Date();
      if (status === 'delivered') { update.deliveredAt = new Date(); update.deliveryProgress = 100; }
      await orders_.updateOne({ _id: order._id }, { $set: update });
      intent.didWrite = true;
      return `✅ Order **#${String(order._id).slice(-6)}** marked **${status.replace('_', ' ').toUpperCase()}**.`;
    }
    case 'add_expense': {
      const amtM = text.match(/(?:kes|ksh)?\s*(\d+(?:\.\d+)?)/i);
      const amt = amtM ? parseFloat(amtM[1]) : 0;
      if (!amt) return '🤖 Say e.g. "add expense 500 for transport".';
      const desc = text.replace(/(add|record|log|expense|cost|gharama|kes|ksh|for|\d+(\.\d+)?)/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!desc) return '🤖 Say e.g. "add expense 500 for transport".';
      await expenses_.insertOne({ description: desc, amount: amt, createdBy: userName || 'AI Assistant', branchId: branchId || null, createdAt: new Date() });
      intent.didWrite = true;
      return `🧾 **Expense added:** ${desc} — KES ${amt.toLocaleString()}.`;
    }
    case 'anomalies': {
      const dayRevs = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(startToday);
        d.setDate(startToday.getDate() - i);
        const e = new Date(d);
        e.setDate(d.getDate() + 1);
        let rev = 0;
        for (const s of allSales) { if (s.refunded) continue; if (s.createdAt >= d && s.createdAt < e) rev += s.total || 0; }
        for (const o of allOrders) { if (o.status !== 'cancelled' && o.createdAt >= d && o.createdAt < e) rev += o.totalPrice || 0; }
        dayRevs.push(rev);
      }
      const todayR = dayRevs[dayRevs.length - 1];
      const prevAvg = dayRevs.slice(0, 6).reduce((s, x) => s + x, 0) / Math.max(1, dayRevs.length - 1);
      const deltaPct = prevAvg > 0 ? Math.round(((todayR - prevAvg) / prevAvg) * 100) : 0;
      const flag = pct <= -25 ? '🚨 **ALERT:**' : pct >= 25 ? '🎉 **Strong day:**' : '📊 **Status:**';
      let msg = `${flag} Sales today ${money(todayR)} ${deltaPct < 0 ? '▼' : '▲'} ${Math.abs(deltaPct)}% vs the 6-day average.\n\n`;
      const alerts = [];
      if (outOfStock.length) alerts.push(`• 🚫 **Out of stock (${outOfStock.length}):** ${outOfStock.slice(0, 5).join(', ')}`);
      if (lowStock.length) alerts.push(`• ⚠️ **Low stock:** ${lowStock.slice(0, 5).join(', ')}`);
      if (expiringSoon.length) alerts.push(`• ⏳ **Expiring in 7 days:** ${expiringSoon.slice(0, 5).join(', ')}`);
      return msg + (alerts.length ? alerts.join('\n') : '✅ No major anomalies.');
    }
    case 'add_product': {
      const m = text.match(/add\s+product\s+(.+?)\s+(?:price|bei)\s+(\d+(?:\.\d+)?)/i);
      if (!m) return '🤖 Say e.g. "add product Milk 1L price 65 category Dairy stock 20".';
      const name = m[1].replace(/\s+(?:category|stock|qty)\s+.*$/i, '').trim().slice(0, 60);
      if (!name) return '🤖 Say e.g. "add product Milk 1L price 65 category Dairy stock 20".';
      const price = parseFloat(m[2]);
      if (!price || price <= 0) return '🤖 Price must be more than 0.';
      const catM = text.match(/(?:category|category name)\s+([A-Za-z0-9 &-]+)/i);
      const stM = text.match(/(?:stock|qty)\s+(\d+)/i);
      await products_.insertOne({
        name, price, cost: 0, stock: stM ? parseInt(stM[1], 10) : 0,
        category: catM ? catM[1].trim() : 'General', barcode: null,
        isFlashSale: false, flashSaleDiscount: 0, discountPercent: 0, createdAt: new Date()
      });
      intent.didWrite = true;
      return `✅ **Product added:** ${name} — KES ${price.toLocaleString()}${catM ? ' in ' + catM[1].trim() : ''}, stock ${stM ? stM[1] : 0}.`;
    }
    case 'update_price': {
      const m = text.match(/price\s+of\s+(.+?)\s+(?:to|at)?\s*(\d+(?:\.\d+)?)/i) || text.match(/(.+?)\s+(?:price|bei)\s+(?:to|at|=|:)?\s*(\d+(?:\.\d+)?)/i);
      if (!m) return '🤖 Say e.g. "update Milk price to 70".';
      const prodName = (m[1] || '').replace(/\b(update|change|set|weka|the|to|at)\b/gi, '').trim();
      const price = parseFloat(m[2]);
      const found = findMatchingProducts(prodName, allProducts, 1);
      if (!found.length) return '🔍 I could not find that product.';
      const p = found[0];
      await products_.updateOne({ _id: p._id }, { $set: { price } });
      intent.didWrite = true;
      return `💰 **Price updated:** ${p.name} → KES ${price.toLocaleString()}.`;
    }
    case 'set_discount': {
      const m = text.match(/(?:discount|punguzo|reduce|cut)\s+(.+?)\s+by\s+(\d+(?:\.\d+)?)/i);
      if (!m) return '🤖 Say e.g. "discount Milk by 10%".';
      const found = findMatchingProducts(m[1].trim(), allProducts, 1);
      if (!found.length) return '🔍 I could not find that product.';
      const p = found[0];
      const pct = Math.min(90, Math.max(0, parseFloat(m[2])));
      await products_.updateOne({ _id: p._id }, { $set: { flashSale: true, flashSaleDiscount: pct, discountPercent: pct, flashSaleExpires: new Date(Date.now() + 24 * 3600 * 1000) } });
      intent.didWrite = true;
      return `🏷️ **Discount set:** ${p.name} — ${pct}% off for 24 hours.`;
    }
    case 'adjust_stock': {
      let qty = 0, name = '', absolute = false;
      let m = text.match(/add\s+(\d+)\s+to\s+(.+?)\s+stock/i);
      if (m) { qty = parseInt(m[1], 10); name = m[2].trim(); }
      else { m = text.match(/(?:set|update|weka)\s+(.+?)\s+stock\s+(?:to|by)?\s*(\d+)/i); if (m) { name = m[1].trim(); qty = parseInt(m[2], 10); absolute = true; } }
      if (!name || !qty) return '🤖 Say e.g. "add 5 to Milk stock" or "set Milk stock to 20".';
      const found = findMatchingProducts(name, allProducts, 1);
      if (!found.length) return '🔍 I could not find that product.';
      const p = found[0];
      await products_.updateOne({ _id: p._id }, absolute ? { $set: { stock: qty } } : { $inc: { stock: qty } });
      intent.didWrite = true;
      return absolute ? `📦 **Stock set:** ${p.name} → ${qty}.` : `📦 **Stock updated:** ${p.name} +${qty} → now ${(p.stock || 0) + qty}.`;
    }
    case 'customer_lookup': {
      const phoneM = text.match(/(\d{9,12})/);
      if (!phoneM) return '🤖 Say e.g. "find customer 0712345678".';
      const phone = phoneM[1];
      const [cust, loyalty] = await Promise.all([customers_.findOne({ phone }), loyalty_.findOne({ phone })]);
      const credits = await credit_.find({ phone }).toArray();
      const orderCount = cust ? (cust.orderCount || 0) : await orders_.countDocuments({ customerId: phone });
      const totalSpent = cust ? (cust.totalSpent || 0) : 0;
      const owed = credits.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0);
      const name = (cust && cust.name) || (loyalty && loyalty.customerName) || '—';
      return `👤 **${name}** (${phone})\n\n• Orders: ${orderCount}\n• Total spent: KES ${totalSpent.toLocaleString()}\n• Loyalty: ${loyalty ? loyalty.points : 0} pts (${loyalty ? loyalty.tier : 'None'})\n• Credit owed: KES ${owed.toLocaleString()}\n• Last order: ${cust && cust.lastOrderAt ? new Date(cust.lastOrderAt).toLocaleDateString() : '—'}`;
    }
    case 'credit_list': {
      const owed = await credit_.find({ paid: { $ne: true } }).toArray();
      if (!owed.length) return '✅ No one owes credit right now. 🎉';
      const grouped = {};
      for (const c of owed) { const key = c.phone || c.customerName || 'Unknown'; grouped[key] = (grouped[key] || 0) + (c.amount || 0); }
      const total = owed.reduce((s, c) => s + (c.amount || 0), 0);
      const rows = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 10);
      return `💼 **Credit owed — KES ${total.toLocaleString()} (${owed.length} entries):**\n\n${rows.map(([k, v]) => `• ${k} — KES ${v.toLocaleString()}`).join('\n')}\n\nSay "find customer [phone]" for details.`;
    }
    case 'add_points': {
      const m = text.match(/(\d+)\s*(?:points|pointi)/i);
      const phoneM = text.match(/(\d{9,12})/);
      if (!m || !phoneM) return '🤖 Say e.g. "add 100 loyalty points to 0712345678".';
      const points = parseInt(m[1], 10);
      if (points > 10000) return "⚠️ That's a lot - max 10,000 points per add.";
      const phone = phoneM[1];
      const existing = await loyalty_.findOne({ phone });
      if (existing) await loyalty_.updateOne({ phone }, { $inc: { points }, $set: { updatedAt: new Date() } });
      else await loyalty_.insertOne({ phone, customerName: '', totalSpent: 0, points, tier: 'Bronze', createdAt: new Date(), updatedAt: new Date() });
      intent.didWrite = true;
      return `⭐ **Points added:** +${points} to ${phone} → now ${(existing ? (existing.points || 0) + points : points)} pts.`;
    }
    case 'create_coupon': {
      const m = text.match(/create\s+coupon\s+([A-Z0-9]+)\s+(\d+(?:\.\d+)?)\s*(%|percent|percentage|kes|ksh|sh)?/i);
      if (!m) return '🤖 Say e.g. "create coupon BLITZ20 20% off".';
      const code = m[1].toUpperCase();
      const isPct = m[3] && /%|percent|percentage/i.test(m[3]);
      const value = parseFloat(m[2]);
      if (value <= 0) return '🤖 Coupon value must be greater than 0.';
      if (isPct && value > 90) return '⚠️ Percent discounts are capped at 90%.';
      const existing = await coupons_.findOne({ code });
      if (existing) return `⚠️ Coupon **${code}** already exists.`;
      await coupons_.insertOne({ code, type: isPct ? 'percent' : 'fixed', value, minPurchase: 0, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), maxUses: 0, usedCount: 0, active: true, createdAt: new Date() });
      intent.didWrite = true;
      return `🎟️ **Coupon created:** ${code} — ${isPct ? value + '% off' : 'KES ' + value} (30 days, unlimited uses).`;
    }
    case 'disable_coupon': {
      const m = text.match(/(?:disable|deactivate|stop|remove|turn off)\s+coupon\s+([A-Z0-9]+)/i) || text.match(/coupon\s+([A-Z0-9]+)\s+(?:disable|deactivate|stop|remove|off)/i);
      if (!m) return '🤖 Say e.g. "disable coupon BLITZ20".';
      const code = m[1].toUpperCase();
      const r = await coupons_.updateOne({ code }, { $set: { active: false } });
      if (!r.matchedCount) return `🔍 Coupon **${code}** not found.`;
      intent.didWrite = true;
      return `🚫 **Coupon disabled:** ${code} can no longer be used.`;
    }
    case 'coupon_redemptions': {
      const todayReds = await redemptions_.find({ createdAt: { $gte: startToday } }).toArray();
      const totalReds = await redemptions_.countDocuments({});
      const redByCoupon = {};
      for (const r of todayReds) { const k = r.couponCode || r.rewardName || 'reward'; redByCoupon[k] = (redByCoupon[k] || 0) + 1; }
      const lines = Object.entries(redByCoupon).slice(0, 8).map(([k, v]) => `• ${k} — ${v}×`).join('\n');
      return `🎟️ **Redemptions today:** ${todayReds.length}${lines ? '\n\n' + lines : ''}\n\nAll-time: ${totalReds}. Active coupons: ${allCoupons.filter(c => c.active).length}.`;
    }
    case 'list_coupons': {
      const active = allCoupons.filter(c => c.active);
      if (!active.length) return '🎟️ No active coupons. Say "create coupon CODE 20% off" to make one.';
      return `🎟️ **Active coupons (${active.length}):**\n\n${active.slice(0, 10).map(c => `• **${c.code}** — ${c.type === 'percent' ? c.value + '% off' : 'KES ' + c.value}${c.minPurchase ? ' (min KES ' + c.minPurchase + ')' : ''}${c.usedCount ? ' — ' + c.usedCount + ' uses' : ''}${c.expiresAt ? ' — expires ' + new Date(c.expiresAt).toLocaleDateString() : ''}`).join('\n')}`;
    }
    case 'avg_order': {
      const valid = allOrders.filter(o => o.status !== 'cancelled');
      if (!valid.length) return '📊 No orders yet to calculate an average.';
      const avg = valid.reduce((s, o) => s + (o.totalPrice || 0), 0) / valid.length;
      const todayOrders = allOrders.filter(o => o.status !== 'cancelled' && o.createdAt >= startToday);
      const avgToday = todayOrders.length ? todayOrders.reduce((s, o) => s + (o.totalPrice || 0), 0) / todayOrders.length : 0;
      return `🛒 **Average order value:** KES ${Math.round(avg).toLocaleString()} across ${valid.length} orders.\n• Today: KES ${Math.round(avgToday).toLocaleString()} (${todayOrders.length} orders)`;
    }
    case 'best_category': {
      const prodCat = {};
      for (const p of allProducts) prodCat[String(p._id)] = p.category || 'Uncategorised';
      const catMap = {};
      for (const s of allSales) { if (s.refunded) continue; for (const it of (s.items || [])) { const cat = it.category || prodCat[String(it.productId)] || 'Uncategorised'; catMap[cat] = (catMap[cat] || 0) + ((it.price || 0) * (it.qty || 1)); } }
      for (const o of allOrders) { if (o.status === 'cancelled') continue; for (const it of (o.items || [])) { const cat = it.category || prodCat[String(it._id)] || prodCat[String(it.productId)] || 'Uncategorised'; catMap[cat] = (catMap[cat] || 0) + ((it.price || 0) * (it.quantity || it.qty || 1)); } }
      const rows = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!rows.length) return '📊 No sales data for categories yet.';
      return `🏅 **Top categories:**\n\n${rows.map(([c, v], i) => `${i + 1}. **${c}** — KES ${v.toLocaleString()}`).join('\n')}`;
    }
    case 'repeat_customers': {
      const counts = {};
      for (const o of allOrders) { if (o.status === 'cancelled' || !o.customerId) continue; counts[o.customerId] = (counts[o.customerId] || 0) + 1; }
      const repeat = Object.entries(counts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!repeat.length) return '👥 No repeat customers yet — all single purchases so far.';
      return `👥 **Repeat customers (${Object.values(counts).filter(c => c > 1).length}):**\n\n${repeat.map(([ph, c]) => `• ${ph} — ${c} orders`).join('\n')}\n\nSay "find customer [phone]" for details.`;
    }
    case 'stock_value': {
      const retail = allProducts.reduce((s, p) => s + ((p.stock || 0) * (p.price || 0)), 0);
      const cost = allProducts.reduce((s, p) => s + ((p.stock || 0) * (p.cost || p.buyingPrice || 0)), 0);
      return `📦 **Stock value:**\n• At retail: KES ${retail.toLocaleString()}\n• At cost: KES ${cost.toLocaleString()}\n• ${allProducts.length} products tracked`;
    }
    case 'busiest_hour': {
      const hourMap = {};
      for (const s of allSales) { if (s.refunded || !s.createdAt) continue; const h = new Date(s.createdAt).getHours(); hourMap[h] = (hourMap[h] || 0) + (s.total || 0); }
      const rows = Object.entries(hourMap).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (!rows.length) return '🕐 No sales data yet.';
      const fmt = h => new Date(new Date().setHours(parseInt(h, 10), 0, 0, 0)).toLocaleTimeString([], { hour: 'numeric' });
      return `🕐 **Busiest hours:**\n\n${rows.map(([h, v]) => `• ${fmt(h)} — KES ${v.toLocaleString()}`).join('\n')}`;
    }
    case 'sales_by_day': {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(startToday); d.setDate(startToday.getDate() - i);
        const e = new Date(d); e.setDate(d.getDate() + 1);
        let rev = 0, n = 0;
        for (const s of allSales) { if (s.refunded) continue; if (s.createdAt >= d && s.createdAt < e) { rev += s.total || 0; n++; } }
        for (const o of allOrders) { if (o.status !== 'cancelled' && o.createdAt >= d && o.createdAt < e) { rev += o.totalPrice || 0; n++; } }
        days.push({ d, rev, n });
      }
      return `📆 **Sales — last 7 days:**\n\n${days.map(x => `• ${x.d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })} — KES ${x.rev.toLocaleString()} (${x.n})`).join('\n')}`;
    }
    case 'add_staff': {
      const m = text.match(/add\s+(?:staff|employee|worker|cashier|mfanyakazi)\s+([A-Za-z .'-]+)(?:\s+as\s+([A-Za-z]+))?/i);
      if (!m) return '🤖 Say e.g. "add staff John as Cashier".';
      const name = m[1].trim().slice(0, 60);
      const role = (m[2] || 'Cashier').trim();
      await staff_.insertOne({ name, role, branchId: branchId || null, createdAt: new Date() });
      intent.didWrite = true;
      return `👥 **Staff added:** ${name} (${role}).`;
    }
    case 'working_today': {
      const open = await shifts_.find({ status: 'open' }).toArray();
      if (!open.length) return '🕐 No one is on shift right now.';
      return `🕐 **On shift now (${open.length}):**\n\n${open.map(sh => `• ${sh.cashierName || sh.cashierId} — since ${new Date(sh.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${sh.startingCash ? ' (start KES ' + sh.startingCash.toLocaleString() + ')' : ''}`).join('\n')}`;
    }
    case 'shift_summary': {
      const todayShifts = await shifts_.find({ startTime: { $gte: startToday } }).toArray();
      const open = todayShifts.filter(s => s.status === 'open');
      const closed = todayShifts.filter(s => s.status === 'closed');
      if (!open.length && !closed.length) return '🕐 No shifts opened yet today.';
      let msg = `🕐 **Shifts today (${todayShifts.length}):**\n`;
      if (open.length) msg += `\n**Open now:**\n${open.map(sh => `• ${sh.cashierName || sh.cashierId} — KES ${(sh.cashSales || 0).toLocaleString()} cash / ${(sh.mpesaSales || 0).toLocaleString()} M-Pesa`).join('\n')}`;
      if (closed.length) msg += `\n\n**Closed:**\n${closed.slice(0, 5).map(sh => `• ${sh.cashierName || sh.cashierId} — ${sh.salesCount || 0} sales, KES ${(sh.cashSales || 0).toLocaleString()} cash + ${(sh.mpesaSales || 0).toLocaleString()} M-Pesa${sh.difference != null ? ', diff ' + (sh.difference >= 0 ? '+' : '') + sh.difference.toLocaleString() : ''}`).join('\n')}`;
      return msg;
    }
    case 'staff_performance': {
      const byStaff = {};
      for (const s of allSales) { if (s.refunded || !(s.createdAt >= startWeek)) continue; const k = s.staff || 'Unknown'; byStaff[k] = (byStaff[k] || 0) + (s.total || 0); }
      const rows = Object.entries(byStaff).sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (!rows.length) return '👥 No staff sales recorded this week yet.';
      return `🏆 **Staff performance — this week:**\n\n${rows.map(([n, v], i) => `${i + 1}. **${n}** — KES ${v.toLocaleString()}`).join('\n')}`;
    }
    case 'sales_list': {
      const recent = allSales.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
      if (!recent.length) return '🧾 No sales recorded yet.';
      return `🧾 **Recent sales:**\n\n${recent.map(s => `• ${new Date(s.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — KES ${(s.total || 0).toLocaleString()} (${s.paymentMethod || 'cash'})${s.staff ? ' · ' + s.staff : ''}${s.refunded ? ' ↩️ REFUNDED' : ''}`).join('\n')}`;
    }
    case 'refund_sale': {
      const idM = text.match(/#\s*([a-zA-Z0-9]{6,})/i) || text.match(/\b([a-f0-9]{24})\b/i);
      if (!idM) return '🤖 Say e.g. "refund sale #5f3ab2".';
      const target = idM[1].toLowerCase();
      const sale = allSales.find(s => String(s._id).toLowerCase().includes(target) || String(s._id).slice(-6) === target);
      if (!sale) return '🔍 Sale not found. Try its ID from "recent sales".';
      if (sale.refunded) return `⚠️ Sale #${String(sale._id).slice(-6)} is already refunded.`;
      await sales_.updateOne({ _id: sale._id }, { $set: { refunded: true, refundedAt: new Date(), refundedBy: userName || null } });
      for (const it of (sale.items || [])) { if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty || 1) } }); }
      intent.didWrite = true;
      return `↩️ **Sale refunded:** #${String(sale._id).slice(-6)} — KES ${(sale.total || 0).toLocaleString()} (${sale.paymentMethod}). Stock restored.`;
    }
    case 'record_sale': {
      const amtM = text.match(/(\d+(?:\.\d+)?)/);
      if (!amtM) return '🤖 Say e.g. "record cash sale 500".';
      const total = parseFloat(amtM[1]);
      if (!total || total <= 0 || total > 1000000) return '🤖 That amount looks invalid - enter between 1 and 1,000,000.';
      const paymentMethod = /mpesa|m-pesa/i.test(text) ? 'mpesa' : 'cash';
      const desc = text.replace(/(record|log|enter|weka|cash sale|manual sale|payment|mpesa|m-pesa|for|note|kes|ksh|\d+(\.\d+)?)/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
      await sales_.insertOne({ items: [{ name: desc || 'Manual sale', price: total, qty: 1, productId: null, buyingPrice: 0 }], total, profit: 0, paymentMethod, amountGiven: paymentMethod === 'cash' ? total : 0, cashPart: paymentMethod === 'cash' ? total : 0, mpesaPart: paymentMethod === 'mpesa' ? total : 0, change: 0, staff: userName || 'Owner', cashierUserId: null, customerPhone: '', channel: 'ai', branchId: branchId || null, createdAt: new Date() });
      intent.didWrite = true;
      return `🧾 **Sale recorded:** KES ${total.toLocaleString()} (${paymentMethod})${desc ? ' — ' + desc : ''}.`;
    }
    default:
      return '\ud83e\udd16 **I can help with your business data.**\n\nTry:\n\u2022 "How are sales today?"\n\u2022 "What\'s my profit this month?"\n\u2022 "Any out of stock items?"\n\u2022 "Show pending orders"\n\u2022 "Best selling products"\n\u2022 "Restock predictions"\n\u2022 "Cash vs M-Pesa today"\n\u2022 "Business overview"\n\nI have access to all your store data! \ud83d\udcca\n\n\u26a1 **Try:** "add product [name] price [amount]", "update [product] price to [amount]", "discount [product] by 10%", "add 5 to [product] stock", "create coupon [CODE] 20% off", "find customer [phone]", "who owes credit?", "add staff [name] as [role]", "refund sale #[id]", "record cash sale 500", "any anomalies?"';
  }
}

app.post('/api/admin/ai/chat', authenticate, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
  try {
    const text = message.trim();
    const intent = detectAdminIntent(text);
    // Write commands require owner/manager access - mirrors the role gates on the admin UI.
    const AI_WRITE_INTENTS = new Set(['add_product','update_price','set_discount','adjust_stock','add_points','create_coupon','disable_coupon','add_staff','refund_sale','record_sale','restock','order_action','add_expense']);
    if (AI_WRITE_INTENTS.has(intent.type) && req.user.role !== 'owner' && req.user.role !== 'manager') {
      return res.status(403).json({ response: '🔒 That action needs **owner or manager** access. Please ask the shop owner to do it.', action: null });
    }
    let response = await generateAdminAiResponse(intent, text, req.user.branchId || null, req.user.name);
    if (intent.type === 'general') {
      const llm = await askOllama(adminLlmSystem(), text);
      if (llm) response = llm;
    }
    res.json({ response, action: intent.didWrite ? { type: 'refresh' } : null });
  } catch (err) {
    console.error('Admin AI chat error:', err);
    res.json({ response: 'Sorry, I encountered an error processing your request.' });
  }
});
// Reports the newest downloadable APK so the in-app Share/QR screen always
// links to the latest build automatically — just drop a new *.apk into
// shop-frontend/public/ on release and the app picks it up, no code change.
app.get('/api/app-info', (req, res) => {
  try {
    const fs = require('fs');
    const dir = path.join(__dirname, 'shop-frontend/downloads');
    const apks = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.apk'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!apks.length) return res.json({ apkUrl: null });
    const latest = apks[0];
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      apkUrl: `${base}/apk/${encodeURIComponent(latest.f)}`,
      fileName: latest.f,
      version: new Date(latest.t).toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('app-info error:', e);
    res.json({ apkUrl: null });
  }
});

// Reports the newest over-the-air web bundle for the native app. The mobile app
// calls this on launch; if the version differs from what it's running, it
// downloads the bundle and applies it on the next reopen. The bundle + its
// latest.json are produced by `npm run build` (see scripts/make-ota-bundle.js).
app.get('/api/native-update', (req, res) => {
  try {
    const fs = require('fs');
    const p = path.join(__dirname, 'shop-frontend/ota/latest.json');
    if (!fs.existsSync(p)) return res.json({ version: null });
    const info = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!info.fileName || !info.version) return res.json({ version: null });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ version: info.version, url: `${base}/updates/${encodeURIComponent(info.fileName)}` });
  } catch (e) {
    console.error('native-update error:', e);
    res.json({ version: null });
  }
});

// Lightweight health/version probe. Lets us confirm which build is actually
// running (old broken build won't have this route or the sanitizer fix).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: 'express5-sanitizer-fix', time: new Date().toISOString() });
});

// TEMP diagnostic for the Google image source — remove after debugging. Reveals
// whether the keys are set and what Google replies (never returns the key itself).
app.get('/api/image-search-debug', async (req, res) => {
  const out = { hasKey: !!process.env.GOOGLE_API_KEY, hasCx: !!process.env.GOOGLE_CSE_ID };
  out.keyTail = process.env.GOOGLE_API_KEY ? ('…' + process.env.GOOGLE_API_KEY.slice(-6)) : null; // last 6 chars only
  out.keyLen = process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.length : 0;
  out.cx = process.env.GOOGLE_CSE_ID || null; // the cx is not secret
  if (!out.hasKey || !out.hasCx) return res.json(out);
  try {
    const u = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&searchType=image&num=3&q=coca%20cola`;
    const r = await fetch(u);
    const d = await r.json().catch(() => ({}));
    out.httpStatus = r.status;
    out.itemCount = (d.items || []).length;
    if (d.error) {
      out.googleError = { code: d.error.code, message: d.error.message, status: d.error.status || null };
      // details often carries metadata.consumer = "projects/<NUMBER>" — the project the KEY belongs to
      out.errorDetails = d.error.details || null;
    }
    res.json(out);
  } catch (e) {
    out.fetchError = String((e && e.message) || e);
    res.json(out);
  }
});

// Serve React frontend for any non-API route (React Router support)
app.get('/*path', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/apk') || req.path.startsWith('/updates')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'shop-frontend/build', 'index.html'));
});

// ===== RECORD MANAGEMENT (owner only) — select & delete records =====
// Data cleanup tool: lets the owner wipe records by type (sales, expenses, …)
// or everything at once. User accounts (login) and branches are deliberately
// excluded so nobody can lock themselves out of the app.
const RECORD_COLLS = {
  sales: sales_,
  orders: orders_,
  expenses: expenses_,
  credit: credit_,
  reviews: reviews_,
  coupons: coupons_,
  customers: customers_,
  products: products_,
  banners: banners_,
  loyalty: loyalty_,
  promo_claims: promo_claims_,
  saved_baskets: saved_baskets_,
  stock_transfers: stock_transfers_,
  shifts: shifts_,
  audit_logs: audit_logs_,
};

app.get('/api/admin/records/counts', authenticate, authorize('owner'), async (req, res) => {
  try {
    const counts = {};
    for (const key of Object.keys(RECORD_COLLS)) {
      try { counts[key] = await RECORD_COLLS[key].countDocuments({}); } catch (e) { counts[key] = 0; }
    }
    res.json({ success: true, counts });
  } catch (e) {
    console.error('records/counts error:', e);
    res.status(500).json({ error: 'Failed to load record counts' });
  }
});

app.delete('/api/admin/records', authenticate, authorize('owner'), async (req, res) => {
  const types = Array.isArray(req.body && req.body.types) ? req.body.types : [];
  if (!types.length) return res.status(400).json({ error: 'Select at least one record type to delete' });
  try {
    let deleted = 0;
    const done = [];
    for (const t of types) {
      const coll = RECORD_COLLS[t];
      if (!coll) continue;
      try {
        const r = await coll.deleteMany({});
        deleted += (r.deletedCount || 0);
        done.push(t);
        if (t === 'products') productCache.del('all_products'); // never serve wiped inventory from cache
      } catch (e) { console.error('Failed to wipe collection:', t, e); }
    }
    res.json({ success: true, deleted, types: done });
  } catch (e) {
    console.error('records delete error:', e);
    res.status(500).json({ error: 'Failed to delete records' });
  }
});

// ===== PUSH NOTIFICATIONS (Firebase Cloud Messaging) =====
// Fully config-guarded: everything here no-ops gracefully until the owner adds
// FCM_SERVICE_ACCOUNT_JSON (a Firebase service-account key, pasted as JSON) to
// the server env. The Android app, PC app and website register their device
// tokens with /api/notifications/register; the server sends through the FCM
// HTTP v1 API via firebase-admin.
let fcmApp = null;
function getFcmApp() {
  if (fcmApp) return fcmApp;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    const { initializeApp, cert } = require('firebase-admin/app');
    fcmApp = initializeApp({ credential: cert(JSON.parse(raw)) }, 'blitzmall');
    return fcmApp;
  } catch (e) { console.error('FCM init failed:', e.message); return null; }
}
const fcmConfigured = () => !!getFcmApp();

async function sendToTokens(tokens, title, body, data = {}) {
  const { getMessaging } = require('firebase-admin/messaging');
  let sent = 0;
  for (const token of tokens) {
    try {
      await getMessaging(fcmApp).send({ token, notification: { title: String(title || 'BlitzMall'), body: String(body || '') }, data: { ...data, click_action: 'FCM_PLUGIN_ACTIVITY' } });
      sent++;
    } catch (e) {
      // Dead token (uninstalled/revoked) — drop it so we never retry it.
      if (e && e.code === 'messaging/registration-token-not-registered') await notification_tokens_.deleteMany({ token });
    }
  }
  return { sent };
}

// ===== PC notification feed (Electron desktop toasts) =====
// Real web push is unavailable inside Electron (no PushManager), so the desktop
// app polls this small event feed and shows native Windows toasts. Events are
// written alongside every FCM push (and for new orders) so the PC bridge works
// even before FCM service-account credentials are configured.
async function addFeedEvent({ audience, phone, title, body }) {
  try {
    if (!notifications_feed_) return;
    const doc = {
      audience, // 'admin' | 'customer' | 'all'
      phone: phone ? String(phone).replace(/[^0-9]/g, '') : null,
      title: String(title || 'BlitzMall'),
      body: String(body || ''),
      createdAt: new Date()
    };
    await notifications_feed_.insertOne(doc);
    // Keep the feed small — anything older than 3 days is irrelevant to a poller.
    try {
      await notifications_feed_.deleteMany({ createdAt: { $lt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    } catch (e) {}
  } catch (e) { console.error('addFeedEvent failed:', e.message); }
}

const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // one poller every ~20s per device — plenty of headroom
  standardHeaders: true,
  legacyHeaders: false,
});

// Polled by the Electron PC app (admin=1) — returns events newer than `since`.
// Customers can also poll with their phone number to get their own updates.
app.get('/api/notifications/feed', feedLimiter, async (req, res) => {
  try {
    let since = null;
    if (req.query.since) { const d = new Date(String(req.query.since)); if (!isNaN(d.getTime())) since = d; }
    const phone = req.query.phone ? String(req.query.phone).replace(/[^0-9]/g, '') : null;
    const wantAdmin = req.query.admin === '1';
    if (!phone && !wantAdmin) return res.status(400).json({ error: 'Provide phone or admin=1' });
    const q = { createdAt: { $gt: since || new Date(Date.now() - 7 * 24 * 3600 * 1000) } };
    if (wantAdmin) q.audience = { $in: ['admin', 'all'] };
    else q.$or = [{ phone }, { audience: 'all' }];
    const items = await notifications_feed_.find(q).sort({ createdAt: 1 }).limit(100).toArray();
    res.json(items.map(d => ({
      id: String(d._id), title: d.title, body: d.body,
      audience: d.audience, phone: d.phone || null, createdAt: d.createdAt
    })));
  } catch (e) {
    console.error('notifications/feed error:', e);
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

async function sendPushToPhone(phone, title, body, data = {}) {
  // The PC feed gets the event regardless of FCM setup (fire-and-forget —
  // addFeedEvent catches its own errors).
  if (phone) addFeedEvent({ audience: 'customer', phone, title, body });
  if (!phone || !fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const tokens = await notification_tokens_.find({ phone }).toArray();
    const uniq = [...new Set(tokens.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToPhone failed:', e.message); return { sent: 0 }; }
}

async function sendPushToAll(title, body, data = {}) {
  await addFeedEvent({ audience: 'all', title, body });
  if (!fcmConfigured()) return { sent: 0, skipped: 1 };
  try {
    const all = await notification_tokens_.find().toArray();
    const uniq = [...new Set(all.map(t => t.token).filter(Boolean))];
    if (!uniq.length) return { sent: 0 };
    return await sendToTokens(uniq, title, body, data);
  } catch (e) { console.error('sendPushToAll failed:', e.message); return { sent: 0 }; }
}

const notifRegisterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 token registrations per minute per IP — stops token stuffing
  standardHeaders: true,
  legacyHeaders: false,
});

// Customers register their device/browser token here after enabling notifications.
// Requires an existing customer account so tokens can't be stuffed for random phones.
app.post('/api/notifications/register', notifRegisterLimiter, async (req, res) => {
  const { phone, token, platform } = req.body;
  if (!phone || !token) return res.status(400).json({ error: 'Phone and token required' });
  try {
    const phoneClean = String(phone).replace(/[^0-9]/g, '');
    const cust = await customers_.findOne({ phone: phoneClean });
    if (!cust && !(await orders_.findOne({ customerId: phoneClean }))) {
      return res.status(403).json({ error: 'Unknown customer — sign in first' });
    }
    await notification_tokens_.deleteMany({ token }); // one token belongs to one phone
    await notification_tokens_.insertOne({ phone: phoneClean, token: String(token), platform: platform || 'android', updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) {
    console.error('notifications/register error:', e);
    res.status(500).json({ error: 'Failed to register notification token' });
  }
});

// Forget every token for a phone (called when the customer turns notifications off).
app.post('/api/notifications/unregister', notifRegisterLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const phoneClean = String(phone).replace(/[^0-9]/g, '');
    await notification_tokens_.deleteMany({ phone: phoneClean });
    res.json({ success: true });
  } catch (e) {
    console.error('notifications/unregister error:', e);
    res.status(500).json({ error: 'Failed to unregister' });
  }
});

// Owner sends a push to one customer (phone) or to every registered device.
app.post('/api/admin/notifications/send', authenticate, authorize('owner'), async (req, res) => {
  const { title, body, phone } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and message required' });
  try {
    if (!fcmConfigured()) {
      return res.status(503).json({ error: 'Push is not configured yet — add FCM_SERVICE_ACCOUNT_JSON to the server env.' });
    }
    const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '') : '';
    const result = cleanPhone ? await sendPushToPhone(cleanPhone, title, body) : await sendPushToAll(title, body);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('notifications/send error:', e);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});
const PORT = process.env.PORT || 5000;

module.exports = { app, connectDb, client, _test: { customerTier, tierFromPoints, earnPoints, reversePoints, issueVoucher, pickWeighted, WHEEL_SECTORS, SCRATCH_OUTCOMES, promoDayKey, getLoyaltySettings, LOYALTY_SETTINGS_DEFAULTS } };
