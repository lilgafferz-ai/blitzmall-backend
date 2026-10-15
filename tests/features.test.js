const request = require('supertest');

process.env.JWT_SECRET = 'test_secret_key';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/blitzmall_test';
process.env.MPESA_MOCK_ENABLED = 'true'; // the 3-second simulator (allowed outside production)

const { app, connectDb, client } = require('../server');
const { getOwnerToken, customerToken, bearer, REAUTH } = require('./helpers');
const { bestLineTotal, normalizeQty } = require('../lib/units');

// Unique Kenyan-style phone per call (clock + counter + random).
let phoneSeq = 0;
const freshPhone = () => { phoneSeq += 1; return '07' + String((Date.now() + phoneSeq * 7919 + Math.floor(Math.random() * 1e8)) % 1e8).padStart(8, '0'); };
const signInCustomer = (request, app, phone, name) => customerToken(request, app, phone, name);

let ownerToken;
const auth = () => bearer(ownerToken);
const uniq = (s) => `${s} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createProduct = async (fields) => {
  const r = await request(app).post('/api/admin/products').set(auth()).send({ price: 100, buyingPrice: 70, stock: 50, image: [], ...fields, name: uniq(fields.name || 'FT-Item') });
  expect(r.body.success).toBe(true);
  return String(r.body.productId);
};
const staff = async (role, permissions) => {
  const username = `ft_${role}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const c = await request(app).post('/api/admin/users').set(auth()).send({ username, password: 'staffpass123', name: 'FT ' + role, role, permissions, ...REAUTH });
  const l = await request(app).post('/api/admin/login').send({ username, password: 'staffpass123' });
  return { userId: String(c.body.userId), token: l.body.token };
};
const waitFor = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 250)); }
  return fn();
};

beforeAll(async () => {
  await connectDb();
  ownerToken = await getOwnerToken(request, app);
});
afterAll(async () => { delete process.env.MPESA_MOCK_ENABLED; if (client) await client.close(); });

describe('Multi-buy deals and loose items (8)', () => {
  it('prices a basket with the cheapest mix of deals', () => {
    const deals = [{ qty: 6, price: 300 }, { qty: 3, price: 160 }];
    expect(bestLineTotal(60, 1, deals)).toBe(60);
    expect(bestLineTotal(60, 3, deals)).toBe(160);
    expect(bestLineTotal(60, 6, deals)).toBe(300);
    expect(bestLineTotal(60, 7, deals)).toBe(360);
    expect(bestLineTotal(60, 9, deals)).toBe(460);
    expect(bestLineTotal(50, 6, [{ qty: 6, price: 400 }])).toBe(300); // a "deal" that costs more is ignored
  });

  it('snaps loose quantities to the product step', () => {
    expect(normalizeQty({ unit: 'kg', soldLoose: true, qtyStep: 0.25 }, 1.3)).toBe(1.25);
    expect(normalizeQty({ unit: 'pcs' }, 2.7)).toBe(3);
  });

  it('checkout charges the deal price and sells sugar by the kg', async () => {
    const soda = await createProduct({ name: 'FT-Soda', price: 60, bulkDeals: [{ qty: 6, price: 300 }] });
    const sugar = await createProduct({ name: 'FT-Sugar', price: 180, unit: 'kg', soldLoose: true, qtyStep: 0.5, stock: 20 });
    const token = await signInCustomer(request, app, freshPhone());
    const r = await request(app).post('/api/orders').set(bearer(token)).send({ items: [{ _id: soda, quantity: 7 }, { _id: sugar, quantity: 1.5 }] });
    expect(r.body.success).toBe(true);
    expect(r.body.itemsTotal).toBe(360 + 270); // 6-pack deal + 1 single; 1.5 kg × 180
    const prods = (await request(app).get('/api/admin/products').set(auth())).body;
    expect(prods.find(p => String(p._id) === sugar).stock).toBe(18.5);
  });

  it('the till applies the same deals', async () => {
    const soda = await createProduct({ name: 'FT-Till Soda', price: 60, bulkDeals: [{ qty: 6, price: 300 }] });
    const r = await request(app).post('/api/admin/sales').set(auth()).send({ items: [{ productId: soda, name: 'x', price: 60, qty: 6 }], paymentMethod: 'cash', amountGiven: 300 });
    expect(r.body.total).toBe(300);
  });
});

describe('Delivery slots (6)', () => {
  it('lists slots, books one at checkout and refuses a full slot', async () => {
    // A fresh slot id per run: the test DB persists bookings between runs.
    const slotId = 't' + Date.now().toString(36);
    await request(app).put('/api/admin/delivery/settings').set(auth()).send({
      slotsEnabled: true, daysAhead: 1, cutoffMinutes: 0,
      slots: [{ id: 'late', label: 'Late', start: '23:58', end: '23:59', capacity: 1 }, { id: slotId, label: 'Morning', start: '09:00', end: '12:00', capacity: 1 }]
    });
    const slots = (await request(app).get('/api/delivery/slots')).body;
    expect(slots.enabled).toBe(true);
    const tomorrow = slots.days.find(d => d.label === 'Tomorrow');
    expect(tomorrow).toBeTruthy();
    const choice = { date: tomorrow.date, id: slotId };
    const product = await createProduct({ name: 'FT-Slot Item' });

    const a = await request(app).post('/api/orders').set(bearer(await signInCustomer(request, app, freshPhone()))).send({ items: [{ _id: product, quantity: 1 }], deliverySlot: choice });
    expect(a.body.success).toBe(true);
    const b = await request(app).post('/api/orders').set(bearer(await signInCustomer(request, app, freshPhone()))).send({ items: [{ _id: product, quantity: 1 }], deliverySlot: choice });
    expect(b.statusCode).toBe(409);
    expect(b.body.error).toMatch(/slot/i);
    await request(app).put('/api/admin/delivery/settings').set(auth()).send({ slotsEnabled: false });
  });
});

describe('Wallet top-up by M-Pesa (5)', () => {
  it('credits the wallet only after the payment is confirmed', async () => {
    const phone = freshPhone();
    const token = await signInCustomer(request, app, phone);
    const bad = await request(app).post('/api/wallet/topup').set(bearer(token)).send({ amount: 5 });
    expect(bad.statusCode).toBe(400);
    const r = await request(app).post('/api/wallet/topup').set(bearer(token)).send({ amount: 200, phone: '0712345678' });
    expect(r.body.success).toBe(true);
    const balance = async () => (await request(app).get('/api/customers/' + phone).set(bearer(token))).body.walletBalance;
    expect(await balance()).toBe(0);
    expect(await waitFor(async () => (await balance()) === 200)).toBe(true);
    expect((await request(app).post('/api/wallet/topup').send({ amount: 200 })).statusCode).toBe(401);

    // The top-up goes through the wallet ledger, so the books still balance.
    const hist = (await request(app).get('/api/customer/wallet/history').set(bearer(token))).body;
    expect(hist.balance).toBe(200);
    expect(hist.transactions.filter(t => t.type === 'topup').map(t => t.amount)).toEqual([200]);
    const recon = (await request(app).get('/api/admin/wallet/reconcile').set(auth())).body;
    expect(recon.mismatches.find(m => m.phone === phone)).toBeUndefined();
  });
});

describe('Rider deliveries (7)', () => {
  it('only the assigned rider can share GPS, and the customer sees it', async () => {
    const product = await createProduct({ name: 'FT-Rider Item', price: 400 });
    const phone = freshPhone();
    const token = await signInCustomer(request, app, phone);
    const order = await request(app).post('/api/orders').set(bearer(token)).send({ items: [{ _id: product, quantity: 1 }], deliveryLocation: 'Matunda' });
    const rider = await staff('rider');
    const other = await staff('rider');
    await request(app).put(`/api/admin/orders/${order.body.orderId}/assign`).set(auth()).send({ riderUserId: rider.userId });

    const mine = (await request(app).get('/api/admin/rider/orders').set(bearer(rider.token))).body;
    expect(mine.some(o => String(o._id) === String(order.body.orderId))).toBe(true);
    expect((await request(app).get('/api/admin/rider/orders').set(bearer(other.token))).body.length).toBe(0);

    expect((await request(app).post(`/api/admin/rider/orders/${order.body.orderId}/start`).set(bearer(other.token))).statusCode).toBe(403);
    expect((await request(app).post(`/api/admin/rider/orders/${order.body.orderId}/start`).set(bearer(rider.token))).body.success).toBe(true);
    expect((await request(app).post(`/api/admin/rider/orders/${order.body.orderId}/location`).set(bearer(rider.token)).send({ lat: 0.83, lng: 35.12 })).body.success).toBe(true);

    const track = await request(app).get(`/api/orders/${order.body.orderId}/tracking`).set(bearer(token));
    expect(track.body.status).toBe('on_the_way');
    expect(track.body.riderLocation).toMatchObject({ lat: 0.83, lng: 35.12 });

    expect((await request(app).post(`/api/admin/rider/orders/${order.body.orderId}/delivered`).set(bearer(rider.token))).body.success).toBe(true);
    // Delivered by the rider earns the customer their points, exactly once.
    const points = async () => (await request(app).get('/api/customers/' + phone).set(bearer(token))).body.loyaltyPoints;
    expect(await points()).toBe(2); // KES 400 at 1 point per KES 200
    await request(app).post(`/api/admin/rider/orders/${order.body.orderId}/delivered`).set(bearer(rider.token));
    expect(await points()).toBe(2);
    // A rider can't use the wider staff API.
    expect((await request(app).get('/api/admin/export').set(bearer(rider.token))).statusCode).toBe(403);
    // ...nor the shop's figures, other orders or customers.
    expect((await request(app).get('/api/admin/summary').set(bearer(rider.token))).statusCode).toBe(403);
    expect((await request(app).get('/api/admin/orders').set(bearer(rider.token))).statusCode).toBe(403);
    expect((await request(app).get('/api/admin/me').set(bearer(rider.token))).statusCode).toBe(200);
  });
});

describe('Tax invoices / eTIMS (9)', () => {
  it('needs a KRA PIN, then invoices sales with a VAT breakdown and credit-notes voids', async () => {
    expect((await request(app).put('/api/admin/tax/settings').set(auth()).send({ enabled: true, kraPin: 'nope' })).statusCode).toBe(400);
    const on = await request(app).put('/api/admin/tax/settings').set(auth()).send({ enabled: true, kraPin: 'P051234567X', defaultCategory: 'B' });
    expect(on.body.success).toBe(true);

    const product = await createProduct({ name: 'FT-Taxed', price: 116 });
    const sale = await request(app).post('/api/admin/sales').set(auth()).send({ items: [{ productId: product, name: 'x', price: 116, qty: 1 }], paymentMethod: 'cash', amountGiven: 116 });
    const inv = await waitFor(async () => (await request(app).get('/api/admin/tax/invoices').set(auth())).body.invoices.find(i => i.sourceId === String(sale.body.saleId) && i.type === 'invoice'));
    expect(inv).toBeTruthy();
    expect(inv.totalTax).toBe(16);           // 116 incl. 16% VAT → 100 + 16
    expect(inv.totalTaxable).toBe(100);
    expect(inv.status).toBe('not_connected'); // queued until a VSCU is configured

    await request(app).delete('/api/admin/sales/' + sale.body.saleId).set(auth());
    const cn = await waitFor(async () => (await request(app).get('/api/admin/tax/invoices').set(auth())).body.invoices.find(i => i.sourceId === String(sale.body.saleId) && i.type === 'credit_note'));
    expect(cn.originalInvoiceNo).toBe(inv.invoiceNo);
    expect(cn.invoiceNo).toBeGreaterThan(inv.invoiceNo);
    await request(app).put('/api/admin/tax/settings').set(auth()).send({ enabled: false });
  });
});

describe('Daily closing report (10)', () => {
  it('builds today\'s report with sales and stock figures', async () => {
    const r = await request(app).get('/api/admin/reports/daily').set(auth());
    expect(r.statusCode).toBe(200);
    expect(r.body.report).toHaveProperty('revenue');
    expect(r.body.report).toHaveProperty('outOfStock');
    expect(r.body.text).toMatch(/closing report/i);
    const send = await request(app).post('/api/admin/reports/daily/send').set(auth()).send({});
    expect(send.body.success).toBe(true);
    const hist = await request(app).get('/api/admin/reports/daily/history').set(auth());
    expect(hist.body.length).toBeGreaterThan(0);
  });
});

describe('Suppliers and purchase orders (11)', () => {
  it('suggests a re-order, and receiving it adds stock exactly once', async () => {
    const sup = await request(app).post('/api/admin/suppliers').set(auth()).send({ name: uniq('FT Supplier'), phone: '0711000000' });
    const product = await createProduct({ name: 'FT-Low', stock: 1, buyingPrice: 40, supplierId: String(sup.body.supplierId) });
    const suggest = await request(app).get('/api/admin/purchase-orders/suggest').set(auth());
    const group = suggest.body.suppliers.find(g => g.supplierId === String(sup.body.supplierId));
    expect(group.items.find(i => i.productId === product)).toBeTruthy();

    const po = await request(app).post('/api/admin/purchase-orders').set(auth()).send({ supplierId: sup.body.supplierId, items: [{ productId: product, qty: 10, unitCost: 45 }] });
    expect(po.body.purchaseOrder.total).toBe(450);
    const rec = await request(app).post(`/api/admin/purchase-orders/${po.body.purchaseOrder._id}/receive`).set(auth()).send({ recordExpense: true });
    expect(rec.body.receivedTotal).toBe(450);
    const again = await request(app).post(`/api/admin/purchase-orders/${po.body.purchaseOrder._id}/receive`).set(auth()).send({});
    expect(again.statusCode).toBe(400);
    const p = (await request(app).get('/api/admin/products').set(auth())).body.find(x => String(x._id) === product);
    expect(p.stock).toBe(11);
    expect(p.buyingPrice).toBe(45);
  });
});

describe('Stock-take (12)', () => {
  it('applies counted-minus-expected, keeping sales made during the count', async () => {
    const product = await createProduct({ name: 'FT-Count', stock: 10 });
    const take = (await request(app).post('/api/admin/stock-takes').set(auth()).send({})).body.stockTake;
    await request(app).put(`/api/admin/stock-takes/${take._id}/count`).set(auth()).send({ productId: product, counted: 8 });
    // A sale happens while the count is open.
    await request(app).post('/api/admin/sales').set(auth()).send({ items: [{ productId: product, name: 'x', price: 100, qty: 1 }], paymentMethod: 'cash', amountGiven: 100 });
    const applied = await request(app).post(`/api/admin/stock-takes/${take._id}/apply`).set(auth()).send({});
    expect(applied.body.success).toBe(true);
    expect(applied.body.variances.find(v => v.productId === product).delta).toBe(-2);
    const p = (await request(app).get('/api/admin/products').set(auth())).body.find(x => String(x._id) === product);
    expect(p.stock).toBe(7); // 8 counted − 1 sold since
    expect((await request(app).post(`/api/admin/stock-takes/${take._id}/apply`).set(auth()).send({})).statusCode).toBe(400);
  });
});

describe('Product reviews (14)', () => {
  it('only buyers can review; the catalogue shows the rating', async () => {
    const product = await createProduct({ name: 'FT-Reviewed' });
    const buyer = await signInCustomer(request, app, freshPhone(), 'Amina Otieno');
    const stranger = await signInCustomer(request, app, freshPhone());
    expect((await request(app).post(`/api/products/${product}/reviews`).set(bearer(stranger)).send({ rating: 1 })).statusCode).toBe(403);

    const o = await request(app).post('/api/orders').set(bearer(buyer)).send({ items: [{ _id: product, quantity: 1 }] });
    await request(app).put('/api/admin/orders/' + o.body.orderId).set(auth()).send({ status: 'delivered' });
    const ok = await request(app).post(`/api/products/${product}/reviews`).set(bearer(buyer)).send({ rating: 4, comment: 'Fresh!' });
    expect(ok.body.success).toBe(true);
    await request(app).post(`/api/products/${product}/reviews`).set(bearer(buyer)).send({ rating: 5, comment: 'Even better' }); // edits, not a 2nd review

    const list = (await request(app).get(`/api/products/${product}/reviews`)).body;
    expect(list.count).toBe(1);
    expect(list.average).toBe(5);
    expect(list.reviews[0].name).toBe('Amina O.');
    expect(JSON.stringify(list)).not.toMatch(/07\d{8}/); // no phone numbers leak
    const shown = (await request(app).get('/api/products')).body.find(p => String(p._id) === product);
    expect(shown.ratingAvg).toBe(5);
    expect(shown.ratingCount).toBe(1);
  });
});
