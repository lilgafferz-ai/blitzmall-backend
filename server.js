const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const MONGO_URI = 'mongodb+srv://RedMan:21Savage.@cluster0.bbn0afu.mongodb.net/?appName=Cluster0';
const client = new MongoClient(MONGO_URI);

let db, db_, products_, orders_, sales_, expenses_, credit_, reviews_, staff_;
client.connect().then(() => {
  db = client.db('my_shop');
  db_ = db;
  products_ = db.collection('products');
  orders_ = db.collection('orders');
  sales_ = db.collection('sales');
  expenses_ = db.collection('expenses');
  credit_ = db.collection('credit');
  reviews_ = db.collection('reviews');
  staff_ = db.collection('staff');
  console.log('✅ Connected to MongoDB');
}).catch(err => console.error('❌ MongoDB connection error:', err));

// ===== CUSTOMER =====
app.get('/api/products', async (req, res) => {
  try { res.json(await products_.find().toArray()); } catch { res.status(500).json({ error: 'Failed to fetch products' }); }
});
app.post('/api/auth', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  res.json({ success: true, customerId: phone, message: `Welcome ${name}!` });
});
app.post('/api/orders', async (req, res) => {
  const { customerId, items, customerName, paymentMethod } = req.body;
  if (!customerId || !items || !items.length) return res.status(400).json({ error: 'Missing data' });
  try {
    const order = {
      customerId, customerName, items,
      totalPrice: items.reduce((s, i) => s + i.price * i.quantity, 0),
      paymentMethod: paymentMethod || 'delivery', status: 'pending', createdAt: new Date(),
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

// ===== ADMIN AUTH =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ error: 'Invalid password' });
});

// ===== PRODUCTS (with expiry) =====
app.post('/api/admin/products', async (req, res) => {
  const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate } = req.body;
  if (!name || price === undefined || price === '') return res.status(400).json({ error: 'Name and selling price required' });
  try {
    const product = {
      name, category: (category || '').trim() || 'Other', barcode: (barcode || '').trim(),
      buyingPrice: parseFloat(buyingPrice) || 0, price: parseFloat(price) || 0, stock: parseInt(stock, 10) || 0,
      description: description || '', image: image || null,
      expiryDate: expiryDate ? new Date(expiryDate) : null, createdAt: new Date(),
    };
    const result = await products_.insertOne(product);
    res.json({ success: true, productId: result.insertedId, message: 'Product added!' });
  } catch { res.status(500).json({ error: 'Failed to add product' }); }
});
app.put('/api/admin/products/:productId', async (req, res) => {
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
app.delete('/api/admin/products/:productId', async (req, res) => {
  try { const r = await products_.deleteOne({ _id: new ObjectId(req.params.productId) }); if (!r.deletedCount) return res.status(404).json({ error: 'Product not found' }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed to delete product' }); }
});

// ===== ORDERS =====
app.get('/api/admin/orders', async (req, res) => { try { res.json(await orders_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/orders/:orderId', async (req, res) => {
  try { const r = await orders_.updateOne({ _id: new ObjectId(req.params.orderId) }, { $set: { status: req.body.status } }); if (!r.matchedCount) return res.status(404).json({ error: 'Order not found' }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});

// ===== POS SALES (with staff/cashier) =====
app.post('/api/admin/sales', async (req, res) => {
  const { items, paymentMethod, amountGiven, cashPart, mpesaPart, staff, customerPhone } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items in sale' });
  try {
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const profit = items.reduce((s, i) => s + (i.price - (i.buyingPrice || 0)) * i.qty, 0);
    const given = parseFloat(amountGiven) || 0;
    const sale = {
      items, total, profit, paymentMethod: paymentMethod || 'cash', amountGiven: given,
      cashPart: parseFloat(cashPart) || 0, mpesaPart: parseFloat(mpesaPart) || 0,
      change: paymentMethod === 'cash' && given > total ? +(given - total).toFixed(2) : 0,
      staff: staff || 'Owner', customerPhone: customerPhone || '', channel: 'pos', createdAt: new Date(),
    };
    const result = await sales_.insertOne(sale);
    for (const it of items) if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: -Math.abs(it.qty) } });
    console.log('🧾 SALE: KES', total, '| by', sale.staff);
    res.json({ success: true, saleId: result.insertedId, change: sale.change, total });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to record sale' }); }
});
app.get('/api/admin/sales', async (req, res) => { try { const l = parseInt(req.query.limit, 10) || 20; res.json(await sales_.find().sort({ createdAt: -1 }).limit(l).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/sales/:saleId', async (req, res) => {
  try {
    const sale = await sales_.findOne({ _id: new ObjectId(req.params.saleId) });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    for (const it of sale.items) if (it.productId && ObjectId.isValid(it.productId)) await products_.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty) } });
    await sales_.deleteOne({ _id: new ObjectId(req.params.saleId) });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to void sale' }); }
});

// ===== EXPENSES =====
app.post('/api/admin/expenses', async (req, res) => {
  const { description, amount } = req.body;
  if (!description || amount === undefined || amount === '') return res.status(400).json({ error: 'Description and amount required' });
  try { const r = await expenses_.insertOne({ description, amount: parseFloat(amount) || 0, createdAt: new Date() }); res.json({ success: true, expenseId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed to add expense' }); }
});
app.get('/api/admin/expenses', async (req, res) => { try { res.json(await expenses_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/expenses/:id', async (req, res) => { try { const r = await expenses_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

// ===== CREDIT =====
app.post('/api/admin/credit', async (req, res) => {
  const { customerName, phone, amount, note } = req.body;
  if (!customerName || amount === undefined || amount === '') return res.status(400).json({ error: 'Name and amount required' });
  try { const r = await credit_.insertOne({ customerName, phone: (phone || '').trim(), amount: parseFloat(amount) || 0, note: note || '', paid: false, createdAt: new Date(), paidAt: null }); res.json({ success: true, creditId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/credit', async (req, res) => { try { res.json(await credit_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.put('/api/admin/credit/:id/pay', async (req, res) => { try { const r = await credit_.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { paid: true, paidAt: new Date() } }); if (!r.matchedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/credit/:id', async (req, res) => { try { const r = await credit_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

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
app.get('/api/admin/reviews', async (req, res) => { try { res.json(await reviews_.find().sort({ createdAt: -1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/reviews/:id', async (req, res) => { try { const r = await reviews_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

// ===== STAFF (cashiers) =====
app.post('/api/admin/staff', async (req, res) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { const r = await staff_.insertOne({ name: name.trim(), role: role || 'Cashier', createdAt: new Date() }); res.json({ success: true, staffId: r.insertedId }); }
  catch { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/admin/staff', async (req, res) => { try { res.json(await staff_.find().sort({ createdAt: 1 }).toArray()); } catch { res.status(500).json({ error: 'Failed' }); } });
app.delete('/api/admin/staff/:id', async (req, res) => { try { const r = await staff_.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Failed' }); } });

// ===== SUMMARY (with expiry) =====
app.get('/api/admin/summary', async (req, res) => {
  try {
    const [sales, orders, expenses, products] = await Promise.all([sales_.find().toArray(), orders_.find().toArray(), expenses_.find().toArray(), products_.find().toArray()]);
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
      for (const o of orders) { if (!inP(o.createdAt, start)) continue; count++; revenue += o.totalPrice || 0; let op = 0; for (const it of (o.items || [])) { const q = it.quantity || it.qty || 0; op += ((it.price || 0) - (it.buyingPrice || 0)) * q; } profit += op; if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0; else cash += o.totalPrice || 0; }
      let exp = 0; for (const e of expenses) if (inP(e.createdAt, start)) exp += e.amount || 0;
      return { revenue, profit, expenses: exp, net: profit - exp, cash, mpesa, count };
    };
    const summary = {}; for (const k in periods) summary[k] = calc(periods[k]);
    const tally = {};
    for (const s of sales) for (const it of (s.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.qty || 0);
    for (const o of orders) for (const it of (o.items || [])) tally[it.name] = (tally[it.name] || 0) + (it.quantity || it.qty || 0);
    const best = Object.entries(tally).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 6);
    const low = products.filter(p => p.stock !== undefined && p.stock > 0 && p.stock < 2).map(p => ({ name: p.name, stock: p.stock }));
    const out = products.filter(p => p.stock !== undefined && p.stock <= 0).map(p => ({ name: p.name }));
    const soon = new Date(now.getTime() + 7 * 86400000);
    const expiringSoon = products.filter(p => p.expiryDate && new Date(p.expiryDate) >= now && new Date(p.expiryDate) <= soon).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
    const expired = products.filter(p => p.expiryDate && new Date(p.expiryDate) < now).map(p => ({ name: p.name, expiryDate: p.expiryDate }));
    res.json({ summary, best, low, out, expiringSoon, expired });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to build summary' }); }
});

// ===== EXPORT / BACKUP =====
app.get('/api/admin/export', async (req, res) => {
  try {
    const [products, orders, sales, expenses, credit, reviews, staff] = await Promise.all([
      products_.find().toArray(), orders_.find().toArray(), sales_.find().toArray(),
      expenses_.find().toArray(), credit_.find().toArray(), reviews_.find().toArray(), staff_.find().toArray(),
    ]);
    res.json({ shop: 'Brilliant / Blitz Mall', exportedAt: new Date(), products, orders, sales, expenses, credit, reviews, staff });
  } catch { res.status(500).json({ error: 'Failed to export' }); }
});


// ===== M-PESA STK PUSH =====
const MPESA_ENV = 'sandbox'; // change to 'production' when going live
const MPESA_BASE = MPESA_ENV === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

const MPESA_CONSUMER_KEY = 'VpH0nHGpoWhgoAjl9KsLgwRbXiPa3wh43YIx1sMGMNjzNXo7';
const MPESA_CONSUMER_SECRET = 'yAzAOBs49lN5yrzzNyap9h1bKqUDG1FluObamNEMrdXOZdaBZ0UjhuCx51HaGO4X';
const MPESA_SHORTCODE = '174379';
const MPESA_PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
// Replace this with your real deployed URL when going live:
const MPESA_CALLBACK_URL = process.env.CALLBACK_URL || 'https://your-deployed-url.com/api/mpesa/callback';

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
  return d.getFullYear().toString()
    + String(d.getMonth()+1).padStart(2,'0')
    + String(d.getDate()).padStart(2,'0')
    + String(d.getHours()).padStart(2,'0')
    + String(d.getMinutes()).padStart(2,'0')
    + String(d.getSeconds()).padStart(2,'0');
}

function formatPhone(phone) {
  let p = (phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

// Initiate STK Push (customer pays)
app.post('/api/mpesa/stk-push', async (req, res) => {
  const { phone, amount, orderId, saleId } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  try {
    const token = await getMpesaToken();
    const timestamp = mpesaTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const formattedPhone = formatPhone(phone);

    const body = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(parseFloat(amount)),
      PartyA: formattedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: 'Brilliant',
      TransactionDesc: 'Payment for goods',
    };

    const mpesaRes = await fetch(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const mpesaData = await mpesaRes.json();

    if (mpesaData.ResponseCode === '0') {
      // Save pending request so we can match it on callback
      if (db_) {
        await db_.collection('mpesa_requests').insertOne({
          checkoutRequestId: mpesaData.CheckoutRequestID,
          merchantRequestId: mpesaData.MerchantRequestID,
          phone: formattedPhone, amount: body.Amount,
          orderId: orderId || null, saleId: saleId || null,
          status: 'pending', createdAt: new Date(),
        });
      }
      res.json({ success: true, checkoutRequestId: mpesaData.CheckoutRequestID, message: 'M-Pesa prompt sent! Ask customer to enter PIN.' });
    } else {
      res.status(400).json({ success: false, error: mpesaData.errorMessage || mpesaData.ResultDesc || 'M-Pesa request failed' });
    }
  } catch (err) {
    console.error('STK Push error:', err);
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment' });
  }
});

// M-Pesa callback (Safaricom calls this after customer enters PIN)
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
          { checkoutRequestId },
          { $set: { status, resultCode, resultDesc, completedAt: new Date() } }
        );

        // If payment confirmed + linked to an online order, mark order payment confirmed
        if (status === 'confirmed' && req_.orderId && ObjectId.isValid(req_.orderId)) {
          await orders_.updateOne({ _id: new ObjectId(req_.orderId) }, { $set: { paymentStatus: 'paid', paymentMethod: 'mpesa' } });
        }
        console.log(status === 'confirmed' ? '✅ Payment confirmed' : '❌ Payment failed/cancelled');
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Success' }); // always respond OK to Safaricom
  }
});

// Check payment status (frontend polls this after sending STK push)
app.get('/api/mpesa/status/:checkoutRequestId', async (req, res) => {
  try {
    const req_ = await db_.collection('mpesa_requests').findOne({ checkoutRequestId: req.params.checkoutRequestId });
    if (!req_) return res.status(404).json({ error: 'Not found' });
    res.json({ status: req_.status, resultDesc: req_.resultDesc || '' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Query STK push status directly from Safaricom (as fallback)
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


const PORT = 5000;
app.listen(PORT, () => { console.log(`🚀 Shop backend running on http://localhost:${PORT}`); console.log(`📦 Connected to MongoDB`); });
