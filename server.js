const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://RedMan:21Savage.@cluster0.bbn0afu.mongodb.net/?appName=Cluster0';
const client = new MongoClient(MONGO_URI);

let db, db_, products_, orders_, sales_, expenses_, credit_, reviews_, staff_, users_, loyalty_, coupons_, branches_;
let audit_logs_, shifts_, pricing_rules_, stock_transfers_, loyalty_rewards_, redemptions_, saved_baskets_, banners_;
const JWT_SECRET = process.env.JWT_SECRET || 'blitzmall_jwt_secret_change_in_prod_2024'; // ⚠️ SET JWT_SECRET env var in production!
const JWT_EXPIRES = '24h';
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

client.connect().then(async () => {
  db = client.db('my_shop');
  db_ = db;
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
  console.log('✅ Connected to MongoDB');
  await seedRewards();
  
  // Warn if M-Pesa env vars are not set
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
    console.warn('⚠️ M-Pesa environment variables (MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY) are not fully configured. M-Pesa payments will fail.');
  }
  if (MPESA_CALLBACK_URL === 'https://your-deployed-url.com/api/mpesa/callback') {
    console.warn('⚠️ CALLBACK_URL env var not set. M-Pesa callbacks will not reach your server.');
  }

  app.listen(PORT, () => {
    console.log(`🚀 Shop backend running on http://localhost:${PORT}`);
    console.log(`📦 MongoDB: my_shop database ready`);
  });
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  // Give logs time to flush, then exit — server is useless without a database
  setTimeout(() => process.exit(1), 500);
});

// ===== CUSTOMER =====
app.get('/api/products', async (req, res) => {
  try {
    const list = await products_.find().toArray();
    res.json(await applyPricingRules(list));
  } catch {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
app.get('/api/admin/products', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const list = await products_.find(filter).toArray();
    res.json(await applyPricingRules(list));
  } catch {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
app.post('/api/auth', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  try {
    const existingOrder = await orders_.findOne({ customerId: phone });
    res.json({ success: true, customerId: phone, returning: !!existingOrder, message: `Welcome ${name}!` });
  } catch (err) {
    res.json({ success: true, customerId: phone, returning: false, message: `Welcome ${name}!` });
  }
});
app.post('/api/orders', async (req, res) => {
  const { customerId, items, customerName, paymentMethod, deliveryLocation, deliveryFee, gpsCoords, couponCode, discount } = req.body;
  if (!customerId || !items || !items.length) return res.status(400).json({ error: 'Missing data' });
  try {
    const fee = parseFloat(deliveryFee) || 0;
    const discountAmt = parseFloat(discount) || 0;
    const order = {
      customerId, customerName, items,
      totalPrice: Math.max(0, items.reduce((s, i) => s + i.price * i.quantity, 0) + fee - discountAmt),
      paymentMethod: paymentMethod || 'delivery', status: 'pending', createdAt: new Date(),
      deliveryLocation: deliveryLocation || '',
      deliveryFee: fee,
      gpsCoords: gpsCoords || null,
      couponCode: couponCode || null,
      discount: discountAmt
    };
    const result = await orders_.insertOne(order);
    for (const it of items) { const id = it._id || it.id; if (id && ObjectId.isValid(id)) await products_.updateOne({ _id: new ObjectId(id) }, { $inc: { stock: -Math.abs(it.quantity) } }); }
    console.log('🔔 NEW ORDER:', order.customerName, 'KES', order.totalPrice);
    res.json({ success: true, orderId: result.insertedId, message: 'Order placed! Pay on delivery.' });
  } catch { res.status(500).json({ error: 'Failed to place order' }); }
});
app.get('/api/customer-orders/:customerId', async (req, res) => {
  try { res.json(await orders_.find({ customerId: req.params.customerId }).toArray()); } catch { res.status(500).json({ error: 'Failed to fetch orders' }); }
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
app.post('/api/admin/login', async (req, res) => {
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
  } catch { res.status(500).json({ error: 'Failed to fetch users' }); }
});

// Delete a user
app.delete('/api/admin/users/:userId', authenticate, authorize('owner'), async (req, res) => {
  try {
    const r = await users_.deleteOne({ _id: new ObjectId(req.params.userId) });
    if (!r.deletedCount) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete user' }); }
});

// ===== BRANCHES (owner only) =====
app.post('/api/admin/branches', authenticate, authorize('owner'), async (req, res) => {
  const { name, location, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Branch name required' });
  try {
    const r = await branches_.insertOne({ name: name.trim(), location: location || '', phone: phone || '', email: email || '', active: true, createdAt: new Date() });
    res.json({ success: true, branchId: r.insertedId });
  } catch { res.status(500).json({ error: 'Failed to create branch' }); }
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
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/branches/:id', authenticate, authorize('owner'), async (req, res) => {
  try { const r = await branches_.deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

// ===== PRODUCTS =====
app.post('/api/admin/products', authenticate, async (req, res) => {
  const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate, branchId } = req.body;
  if (!name || price === undefined || price === '') return res.status(400).json({ error: 'Name and selling price required' });
  try {
    const product = {
      name, category: (category || '').trim() || 'Other', barcode: (barcode || '').trim(),
      buyingPrice: parseFloat(buyingPrice) || 0, price: parseFloat(price) || 0, stock: parseInt(stock, 10) || 0,
      description: description || '', image: image || null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      branchId: branchId || req.user.branchId || null,
      createdAt: new Date(),
    };
    const result = await products_.insertOne(product);
    res.json({ success: true, productId: result.insertedId, message: 'Product added!' });
  } catch { res.status(500).json({ error: 'Failed to add product' }); }
});
app.put('/api/admin/products/:productId', authenticate, async (req, res) => {
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
    res.json({ success: true, message: 'Product updated!' });
  } catch { res.status(500).json({ error: 'Failed to update product' }); }
});
app.delete('/api/admin/products/:productId', authenticate, async (req, res) => {
  try { const r = await products_.deleteOne({ _id: new ObjectId(req.params.productId) }); if (!r.deletedCount) return res.status(404).json({ error: 'Product not found' }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed to delete product' }); }
});

// ===== ORDERS =====
app.get('/api/admin/orders', authenticate, async (req, res) => {
  try { const filter = branchFilter(req); res.json(await orders_.find(filter).sort({ createdAt: -1 }).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.put('/api/admin/orders/:orderId', authenticate, async (req, res) => {
  try {
    const { status, deliveryFee } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
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
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
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
app.delete('/api/admin/sales/:saleId', authenticate, async (req, res) => {
  try {
    const sale = await sales_.findOne({ _id: new ObjectId(req.params.saleId) });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    for (const it of sale.items) if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty) } });
    await sales_.deleteOne({ _id: new ObjectId(req.params.saleId) });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to void sale' }); }
});

// ===== EXPENSES =====
app.post('/api/admin/expenses', authenticate, async (req, res) => {
  const { description, amount, branchId } = req.body;
  if (!description || amount === undefined || amount === '') return res.status(400).json({ error: 'Description and amount required' });
  try { const r = await expenses_.insertOne({ description, amount: parseFloat(amount) || 0, createdBy: req.user.name, branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, expenseId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed to add expense' }); }
});
app.get('/api/admin/expenses', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await expenses_.find(filter).sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/expenses/:id', authenticate, async (req, res) => { try { const r = await expenses_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

// ===== CREDIT =====
app.post('/api/admin/credit', authenticate, async (req, res) => {
  const { customerName, phone, amount, note, branchId } = req.body;
  if (!customerName || amount === undefined || amount === '') return res.status(400).json({ error: 'Name and amount required' });
  try { const r = await credit_.insertOne({ customerName, phone: (phone || '').trim(), amount: parseFloat(amount) || 0, note: note || '', paid: false, branchId: branchId || req.user.branchId || null, createdAt: new Date(), paidAt: null }); res.json({ success: true, creditId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/credit', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await credit_.find(filter).sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/credit/:id/pay', authenticate, async (req, res) => { try { const r = await credit_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { paid: true, paidAt: new Date() } }); if (!r.matchedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/credit/:id', authenticate, async (req, res) => { try { const r = await credit_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

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
app.get('/api/admin/reviews', authenticate, async (req, res) => { try { res.json(await reviews_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/reviews/:id', authenticate, async (req, res) => { try { const r = await reviews_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

// ===== STAFF =====
app.post('/api/admin/staff', authenticate, authorize('owner', 'manager'), async (req, res) => {
  const { name, role, branchId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { const r = await staff_.insertOne({ name: name.trim(), role: role || 'Cashier', branchId: branchId || req.user.branchId || null, createdAt: new Date() }); res.json({ success: true, staffId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/staff', authenticate, async (req, res) => { try { const filter = branchFilter(req); res.json(await staff_.find(filter).sort({ createdAt: 1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/staff/:id', authenticate, authorize('owner', 'manager'), async (req, res) => { try { const r = await staff_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

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
  } catch { res.status(500).json({ error: 'Failed to export' }); }
});

// ===== LOYALTY & REWARDS =====
const earnPoints = async (phone, saleTotal) => {
  if (!phone || !saleTotal || saleTotal <= 0) return;
  try {
    const points = Math.floor(saleTotal / 100);
    if (points <= 0) return;
    const existing = await loyalty_.findOne({ phone });
    if (existing) {
      const newTotal = existing.totalSpent + saleTotal;
      const newPoints = existing.points + points;
      let tier = 'Bronze';
      if (newTotal >= 500000) tier = 'Platinum';
      else if (newTotal >= 100000) tier = 'Gold';
      else if (newTotal >= 25000) tier = 'Silver';
      await loyalty_.updateOne({ phone }, { $set: { totalSpent: newTotal, points: newPoints, tier, updatedAt: new Date() } });
    } else {
      let tier = 'Bronze';
      if (saleTotal >= 500000) tier = 'Platinum';
      else if (saleTotal >= 100000) tier = 'Gold';
      else if (saleTotal >= 25000) tier = 'Silver';
      await loyalty_.insertOne({ phone, customerName: '', totalSpent: saleTotal, points, tier, createdAt: new Date(), updatedAt: new Date() });
    }
  } catch (e) { console.error('Loyalty error:', e); }
};

app.get('/api/admin/loyalty/:phone', authenticate, async (req, res) => {
  try {
    const entry = await loyalty_.findOne({ phone: req.params.phone });
    if (!entry) return res.json({ exists: false, message: 'No loyalty record found' });
    res.json({ exists: true, phone: entry.phone, customerName: entry.customerName, totalSpent: entry.totalSpent, points: entry.points, tier: entry.tier });
  } catch { res.status(500).json({ error: 'Failed to lookup loyalty' }); }
});

app.put('/api/admin/loyalty/:phone', authenticate, async (req, res) => {
  try {
    const r = await loyalty_.updateOne({ phone: req.params.phone }, { $set: { customerName: req.body.customerName || '' } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to update' }); }
});

app.get('/api/admin/loyalty', authenticate, async (req, res) => {
  try { res.json(await loyalty_.find().sort({ totalSpent: -1 }).toArray()); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/loyalty/redeem', authenticate, async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'Phone and points required' });
  try {
    const entry = await loyalty_.findOne({ phone });
    if (!entry) return res.status(404).json({ error: 'Customer not found' });
    if (entry.points < points) return res.status(400).json({ error: 'Not enough points' });
    const cashback = Math.round(points * 5);
    await loyalty_.updateOne({ phone }, { $inc: { points: -points }, $set: { updatedAt: new Date() } });
    res.json({ success: true, cashback, message: `${cashback} KES cashback applied!` });
  } catch { res.status(500).json({ error: 'Failed to redeem' }); }
});

app.post('/api/admin/loyalty/add-points', async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'Phone and points required' });
  try {
    const existing = await loyalty_.findOne({ phone });
    if (existing) {
      const newPoints = (existing.points || 0) + parseInt(points);
      await loyalty_.updateOne({ phone }, { $set: { points: newPoints, updatedAt: new Date() } });
      res.json({ success: true, points: newPoints });
    } else {
      await loyalty_.insertOne({
        phone,
        customerName: '',
        totalSpent: 0,
        points: parseInt(points),
        tier: 'Bronze',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      res.json({ success: true, points: parseInt(points) });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add points' }); }
});

// ===== COUPONS =====
app.post('/api/admin/coupons', authenticate, async (req, res) => {
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
  } catch { res.status(500).json({ error: 'Failed to create coupon' }); }
});
app.get('/api/admin/coupons', authenticate, async (req, res) => { try { res.json(await coupons_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/coupons/:id', authenticate, async (req, res) => { try { const r = await coupons_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { active: req.body.active } }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/coupons/:id', authenticate, async (req, res) => { try { const r = await coupons_.deleteOne({ _id: new ObjectId(req.params.id) }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });
app.post('/api/coupons/validate', async (req, res) => {
  const { code, total } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    if (code.toUpperCase() === 'SHAKE15') {
      const discount = Math.min(total * 0.15, total);
      return res.json({ valid: true, code: 'SHAKE15', type: 'percent', value: 15, discount: Math.round(discount * 100) / 100 });
    }
    const coupon = await coupons_.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code', valid: false });
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return res.json({ valid: false, error: 'Coupon expired' });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) return res.json({ valid: false, error: 'Coupon usage limit reached' });
    if (total < coupon.minPurchase) return res.json({ valid: false, error: `Minimum purchase KES ${coupon.minPurchase} required` });
    let discount = coupon.type === 'percent' ? (total * coupon.value / 100) : coupon.value;
    discount = Math.min(discount, total);
    res.json({ valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount: Math.round(discount * 100) / 100, campaignId: coupon._id });
  } catch { res.status(500).json({ error: 'Failed to validate' }); }
});

// ===== M-PESA STK PUSH =====
const MPESA_ENV = process.env.MPESA_ENV || 'sandbox';
const MPESA_BASE = MPESA_ENV === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_CALLBACK_URL = process.env.CALLBACK_URL || 'https://your-deployed-url.com/api/mpesa/callback'; // ⚠️ SET CALLBACK_URL env var!

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json();
  return data.access_token;
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
  const { phone, amount, orderId, saleId } = req.body;
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

    const token = await getMpesaToken();
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const formattedPhone = formatPhone(phone);
    const body = {
      BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', Amount: Math.ceil(parseFloat(amount)),
      PartyA: formattedPhone, PartyB: MPESA_SHORTCODE, PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CALLBACK_URL, AccountReference: 'Brilliant', TransactionDesc: 'Payment for goods',
    };
    const mpesaRes = await fetch(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const mpesaData = await mpesaRes.json();
    if (mpesaData.ResponseCode === '0') {
      if (db_) {
        await db_.collection('mpesa_requests').insertOne({
          checkoutRequestId: mpesaData.CheckoutRequestID, merchantRequestId: mpesaData.MerchantRequestID,
          phone: formattedPhone, amount: body.Amount, orderId: orderId || null, saleId: saleId || null,
          status: 'pending', createdAt: new Date(),
        });
      }
      res.json({ success: true, checkoutRequestId: mpesaData.CheckoutRequestID, message: 'M-Pesa prompt sent! Ask customer to enter PIN.' });
    } else {
      res.status(400).json({ success: false, error: mpesaData.errorMessage || mpesaData.ResultDesc || 'M-Pesa request failed' });
    }
  } catch (err) { console.error('STK Push error:', err); res.status(500).json({ error: 'Failed to initiate M-Pesa payment' }); }
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
app.post('/api/admin/banners', authenticate, async (req, res) => {
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
app.put('/api/admin/banners/:id', authenticate, async (req, res) => {
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
app.delete('/api/admin/banners/:id', authenticate, async (req, res) => {
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
    res.json({ success: true, message: 'Flash sale updated!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update flash sale settings' });
  }
});

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
    res.json({ status: req_.status, resultDesc: req_.resultDesc || '' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/mpesa/query', async (req, res) => {
  const { checkoutRequestId } = req.body;
  try {
    const token = await getMpesaToken();
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const mpesaRes = await fetch(`${MPESA_BASE}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
    });
    const data = await mpesaRes.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Failed to query status' }); }
});

// Seed default loyalty rewards if collection is empty
const seedRewards = async () => {
  try {
    if (loyalty_rewards_) {
      const count = await loyalty_rewards_.countDocuments();
      if (count === 0) {
        await loyalty_rewards_.insertMany([
          { name: 'KES 100 Discount Coupon', pointsCost: 100, rewardType: 'coupon', rewardValue: 100, active: true },
          { name: 'KES 250 Discount Coupon', pointsCost: 200, rewardType: 'coupon', rewardValue: 250, active: true },
          { name: 'KES 750 Discount Coupon', pointsCost: 500, rewardType: 'coupon', rewardValue: 750, active: true },
          { name: 'Free Blitz Drink (In-Store)', pointsCost: 50, rewardType: 'gift', rewardValue: 0, active: true }
        ]);
        console.log('✅ Seeded default loyalty rewards');
      }
    }
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
  } catch {
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
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Failed to check active shift' });
  }
});

// Shift Management: Fetch shifts list
app.get('/api/admin/shifts', authenticate, async (req, res) => {
  try {
    const filter = branchFilter(req);
    const list = await shifts_.find(filter).sort({ startTime: -1 }).limit(100).toArray();
    res.json(list);
  } catch {
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Dynamic Pricing: Fetch active rules
app.get('/api/admin/pricing-rules', authenticate, async (req, res) => {
  try {
    res.json(await pricing_rules_.find().toArray());
  } catch {
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
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

// Dynamic Pricing: Delete pricing rule
app.delete('/api/admin/pricing-rules/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    await pricing_rules_.deleteOne({ _id: new ObjectId(req.params.id) });
    await logAction(req.user.userId, req.user.username, 'DELETE_PRICING_RULE', `Deleted rule ${req.params.id}`, req.user.branchId);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

// Inter-Branch Stock Transfers: Fetch transfers list
app.get('/api/admin/transfers', authenticate, async (req, res) => {
  try {
    const list = await stock_transfers_.find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/customer/baskets/:id', async (req, res) => {
  try {
    await saved_baskets_.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});
const PORT = process.env.PORT || 5000;
