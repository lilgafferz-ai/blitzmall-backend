// Placing, pricing and cancelling orders; till basket helpers.
const { ObjectId } = require('mongodb');
const { productCache } = require('./cache');
const { SHOP_COORDS } = require('./config');
const { genReferralCode } = require('./customers');
const { col } = require('./db');
const { earnPoints, reversePoints } = require('./loyalty');
const { scheduleAlertSweep, sendPushToPhone, sendPushToStaff } = require('./notifications');
const { applyPricingRules, pricedCatalog } = require('./pricing');
const { adjustWallet, moveWallet, recordWalletTx } = require('./wallet');
const { normalizeQty, priceLine, storedLineTotal } = require('./units');
const { resolveSlot } = require('./deliverySlots');
const { invoiceOrder, creditNoteFor } = require('./etims');

// ===== ORDERS (one code path for the app, the AI assistant and offline sync) =====
const STANDARD_DELIVERY_FEE = 150;
const FREE_DELIVERY_THRESHOLD = 1500;

// Provisional transport fee, mirroring what the app shows at checkout: Mall Area
// delivery and baskets of KES 1,500+ ride free, everything else KES 150. Staff
// confirm the real fee before dispatch (PUT /api/admin/orders/:id). No location
// at all means a pickup order.
function provisionalDeliveryFee({ deliveryArea, deliveryLocation, itemsTotal, freeDelivery }) {
  if (freeDelivery) return 0;
  const loc = String(deliveryLocation || '').trim();
  if (!loc && !deliveryArea) return 0;
  const area = deliveryArea || (/^mall area/i.test(loc) ? 'mall' : 'standard');
  if (area === 'mall' || itemsTotal >= FREE_DELIVERY_THRESHOLD) return 0;
  return STANDARD_DELIVERY_FEE;
}

// Server-side voucher check shared by checkout and /api/coupons/validate.
function couponProblem(coupon, phone, itemsTotal) {
  if (!coupon) return 'Invalid coupon code';
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return 'Coupon expired';
  if (coupon.ownerPhone && String(coupon.ownerPhone) !== String(phone || '')) return 'This voucher is linked to a different account';
  if (phone && Array.isArray(coupon.usedBy) && coupon.usedBy.includes(phone)) return 'This voucher was already used';
  if (coupon.maxUses > 0 && (coupon.usedCount || 0) >= coupon.maxUses) return 'Coupon usage limit reached';
  if (itemsTotal < (coupon.minPurchase || 0)) return `Minimum purchase KES ${coupon.minPurchase} required`;
  return null;
}
const couponDiscount = (coupon, itemsTotal) => {
  let d = 0;
  if (coupon.type === 'percent') d = itemsTotal * (coupon.value || 0) / 100;
  else if (coupon.type === 'fixed') d = coupon.value || 0;
  return Math.round(Math.min(d, itemsTotal) * 100) / 100;
};

// Only a real coordinate pair is stored (the request body is never saved raw).
function cleanGps(g) {
  if (!g || typeof g !== 'object') return null;
  const lat = parseFloat(g.lat), lng = parseFloat(g.lng);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  const acc = parseFloat(g.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}

async function releaseStock(lines) {
  for (const it of lines) {
    if (it.reserved && ObjectId.isValid(it._id)) {
      await col.products.updateOne({ _id: new ObjectId(it._id) }, { $inc: { stock: Math.abs(it.quantity) } });
    }
  }
}

// Places an order for a VERIFIED phone. Returns { status, body } so the HTTP
// route and the AI assistant share one implementation (prices, stock, coupons,
// wallet and notifications can no longer drift apart).
async function placeOrder({ phone, customerName, items, paymentMethod, deliveryLocation, deliveryArea, gpsCoords, couponCode, useWallet, via, deliverySlot }) {
  if (!phone) return { status: 400, body: { error: 'Valid phone number required' } };
  if (!Array.isArray(items) || !items.length) return { status: 400, body: { error: 'Missing data' } };
  if (items.length > 100) return { status: 400, body: { error: 'Invalid basket' } };

  // ===== PRICE VERIFICATION =====
  // Every cart line MUST resolve to a real product in the live catalogue, and
  // the price is ALWAYS the server's (discounted) catalogue price — a tampered
  // request ("price: 1", a stripped _id) is ignored or rejected.
  const catalog = await pricedCatalog();
  const findInCatalog = (raw) => {
    const id = raw._id || raw.id;
    if (id && ObjectId.isValid(id)) return catalog.find(p => p && String(p._id) === String(id)) || null;
    const name = String(raw.name || '').trim().toLowerCase();
    if (!name) return null;
    return catalog.find(p => p && String(p.name || '').trim().toLowerCase() === name) || null;
  };
  const byId = new Map();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const product = findInCatalog(raw);
    if (!product) {
      return { status: 400, body: { error: `One of the items in your basket is not in the catalogue ("${String(raw.name || raw._id || 'unknown').slice(0, 40)}"). Please refresh the shop and add it again.` } };
    }
    const key = String(product._id);
    const line = byId.get(key);
    const qty = normalizeQty(product, line ? line.quantity + (parseFloat(raw.quantity) || 1) : raw.quantity);
    if (line) { line.quantity = qty; continue; }
    byId.set(key, {
      _id: key, id: key,
      name: String(product.name || raw.name || '').slice(0, 120),
      category: product.category || '',
      price: Math.min(Math.max(0, parseFloat(product.price) || 0), 1000000),
      originalPrice: parseFloat(product.originalPrice) || parseFloat(product.price) || 0,
      // Cost price travels with the line so profit reports stay honest even if
      // the product is later edited or deleted.
      buyingPrice: Math.max(0, parseFloat(product.buyingPrice) || 0),
      unit: product.unit || 'pcs',
      quantity: qty,
      stockTracked: typeof product.stock === 'number',
      priceVerified: true,
      _product: product
    });
  }
  const cleanItems = [...byId.values()];
  if (!cleanItems.length) return { status: 400, body: { error: 'Your basket is empty' } };
  // Multi-buy deals ("6 for KES 300") are priced per line on the server.
  for (const line of cleanItems) { Object.assign(line, priceLine(line._product, line.price, line.quantity)); delete line._product; }
  const itemsTotal = Math.round(cleanItems.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;

  // ===== 1-MINUTE DUPLICATE-ORDER GUARD =====
  // The same phone may not place the SAME basket twice within 60 seconds
  // (double-tap / paying twice for the same thing).
  const sig = (list) => (list || [])
    .map(i => `${i._id || i.id || i.name}|${Math.abs(parseFloat(i.quantity) || 1)}`)
    .sort().join('::');
  try {
    const recent = await col.orders.find({ customerId: phone, createdAt: { $gt: new Date(Date.now() - 60 * 1000) } }).toArray();
    if (recent.find(o => o && o.status !== 'cancelled' && o.items && sig(o.items) === sig(cleanItems))) {
      return { status: 429, body: { success: false, error: 'You placed this exact order a moment ago — please wait at least 1 minute before ordering the same items again.' } };
    }
  } catch (e) { /* guard is best-effort — never block a real order on a DB error */ }

  // ===== DELIVERY SLOT ("Tomorrow 9am – 12pm"), capacity-checked =====
  let slot = null;
  try { slot = await resolveSlot(deliverySlot); }
  catch (e) { if (e.slotError) return { status: 409, body: { error: e.message, slotError: true } }; throw e; }

  // ===== VOUCHER (recomputed + consumed atomically on the server) =====
  let coupon = null;
  let discountAmt = 0;
  let freeDelivery = false;
  if (couponCode) {
    coupon = await col.coupons.findOne({ code: String(couponCode).toUpperCase(), active: true });
    const problem = couponProblem(coupon, phone, itemsTotal);
    if (problem) return { status: 400, body: { error: `Voucher not applied: ${problem}. Remove it and try again.` } };
    if (coupon.type === 'free_delivery') freeDelivery = true;
    discountAmt = couponDiscount(coupon, itemsTotal);
  }
  const fee = provisionalDeliveryFee({ deliveryArea, deliveryLocation, itemsTotal, freeDelivery });
  const baseTotal = Math.max(0, Math.round((itemsTotal + fee - discountAmt) * 100) / 100);

  // Claim the voucher first: the conditional update only matches while it is
  // still unused by this phone and under its use limit, so two simultaneous
  // checkouts can never both spend a single-use voucher.
  let couponConsumed = false;
  if (coupon) {
    const filter = { _id: coupon._id, active: true, usedBy: { $ne: phone } };
    if (coupon.maxUses > 0) filter.usedCount = { $lt: coupon.maxUses };
    const r = await col.coupons.updateOne(filter, { $inc: { usedCount: 1 }, $push: { usedBy: phone } });
    if (!r.matchedCount) return { status: 409, body: { error: 'That voucher was just used up — remove it and try again.' } };
    couponConsumed = true;
  }
  const releaseCoupon = async () => {
    if (couponConsumed) await col.coupons.updateOne({ _id: coupon._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: phone } });
  };

  // ===== STOCK RESERVATION =====
  // Decrement only while enough stock is left; if any line can't be covered,
  // everything reserved so far is put back and the order is refused.
  for (const line of cleanItems) {
    if (!line.stockTracked) continue;
    const r = await col.products.updateOne(
      { _id: new ObjectId(line._id), stock: { $gte: line.quantity } },
      { $inc: { stock: -line.quantity } }
    );
    if (!r.matchedCount) {
      await releaseStock(cleanItems);
      await releaseCoupon();
      const p = catalog.find(x => String(x._id) === line._id);
      const left = Math.max(0, (p && p.stock) || 0);
      return { status: 409, body: { error: left > 0 ? `Only ${left} × ${line.name} left in stock — please reduce the quantity.` : `${line.name} just sold out — please remove it from your basket.` } };
    }
    line.reserved = true;
  }

  // ===== WALLET (atomic: only spends money that is really there) =====
  // The ledger entry is written once the order exists (so it can name it).
  let walletApplied = 0;
  let walletBalanceAfter = null;
  if (useWallet && baseTotal > 0) {
    try {
      const loyalty = await col.loyalty.findOne({ phone });
      const want = Math.round(Math.min(Math.max(0, (loyalty && loyalty.walletBalance) || 0), baseTotal) * 100) / 100;
      if (want > 0) {
        walletBalanceAfter = await adjustWallet(phone, -want);
        if (walletBalanceAfter !== null) walletApplied = want;
      }
    } catch (e) { console.error('Failed to apply wallet balance:', e); }
  }

  const totalPrice = Math.max(0, Math.round((baseTotal - walletApplied) * 100) / 100);
  const order = {
    customerId: phone, customerName: String(customerName || '').slice(0, 80),
    items: cleanItems.map(({ reserved, stockTracked, ...rest }) => rest),
    itemsTotal,
    totalPrice,
    walletApplied,
    amountPaid: 0,
    paymentMethod: paymentMethod === 'mpesa' ? 'mpesa' : 'delivery',
    paymentStatus: totalPrice <= 0 ? 'paid' : 'pending',
    status: 'pending',
    createdAt: new Date(),
    deliveryLocation: String(deliveryLocation || '').slice(0, 300),
    deliverySlot: slot,
    deliveryFee: fee,
    deliveryFeeConfirmed: freeDelivery, // provisional until the shop sets it
    deliveryFeeSetBy: freeDelivery ? 'shop (free delivery voucher)' : null,
    gpsCoords: cleanGps(gpsCoords),
    gpsAccuracy: cleanGps(gpsCoords) ? cleanGps(gpsCoords).accuracy : null,
    shopCoords: SHOP_COORDS,
    couponCode: coupon ? coupon.code : null,
    couponConsumed,
    discount: discountAmt,
    deliveryProgress: 0,
    dispatchedAt: null,
    deliveredAt: null,
    ...(via ? { via } : {})
  };
  let result;
  try {
    result = await col.orders.insertOne(order);
  } catch (e) {
    // Never keep the customer's stock, voucher or wallet cash for an order
    // that was not saved.
    await releaseStock(cleanItems);
    await releaseCoupon();
    if (walletApplied > 0) await adjustWallet(phone, walletApplied);
    throw e;
  }
  if (walletApplied > 0) {
    await recordWalletTx({ phone, type: 'order_payment', amount: -walletApplied, balanceAfter: walletBalanceAfter, refId: result.insertedId, note: 'Wallet cash used on order' });
  }
  scheduleAlertSweep(); // stock changed — alert staff about out-of-stock / low items

  try {
    const cust = await col.customers.findOne({ phone });
    if (cust) {
      await col.customers.updateOne({ phone }, {
        $inc: { orderCount: 1, totalSpent: totalPrice },
        $set: { lastOrderAt: new Date(), lastLoginAt: new Date() }
      });
    } else {
      await col.customers.insertOne({
        phone, name: order.customerName, orderCount: 1, totalSpent: totalPrice, lastOrderAt: new Date(),
        createdAt: new Date(), lastLoginAt: new Date(), tokenVersion: 0, referralCode: genReferralCode()
      });
    }
  } catch (e) { console.error('Failed to update customer record:', e); }

  console.log('🔔 NEW ORDER:', order.customerName, 'KES', order.totalPrice);
  // Staff feed/push stays PII-free (the PC feed endpoint is unauthenticated).
  sendPushToStaff('🛒 New Order', `New order received — KES ${order.totalPrice}`, { tab: 'orders' });
  sendPushToPhone(phone, '✅ Order received', `Your BlitzMall order is confirmed — KES ${order.totalPrice}. We'll let you know when it's on the way.`, { screen: 'orders' });
  return {
    status: 200,
    body: {
      success: true, orderId: result.insertedId, message: 'Order placed! Pay on delivery.',
      totalPrice, itemsTotal, deliveryFee: fee, discount: discountAmt, walletApplied, items: order.items.map(publicLine)
    }
  };
}

// Cancels an order exactly once and gives everything back: stock, the wallet
// cash and voucher it used, and any loyalty points it earned. Money paid by
// M-Pesa can't be reversed automatically, so it is flagged as a refund due and
// staff are alerted. Shared by the customer app, both AI assistants and the
// admin Orders tab.
async function cancelOrderAndRestore(orderId, { by = 'system' } = {}) {
  const oid = ObjectId.isValid(orderId) ? new ObjectId(orderId) : orderId;
  const order = await col.orders.findOne({ _id: oid });
  if (!order) return { ok: false, error: 'Order not found' };
  const flip = await col.orders.updateOne(
    { _id: oid, status: { $ne: 'cancelled' } },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: String(by).slice(0, 60) } }
  );
  if (!flip.matchedCount) return { ok: true, alreadyCancelled: true, order };

  for (const it of (order.items || [])) {
    const id = it._id || it.id;
    if (id && ObjectId.isValid(id)) await col.products.updateOne({ _id: new ObjectId(id) }, { $inc: { stock: Math.abs(it.quantity || it.qty || 0) } });
  }
  productCache.del('all_products');
  const phone = order.customerId;
  if ((order.walletApplied || 0) > 0 && phone) {
    await moveWallet(phone, order.walletApplied, { type: 'order_refund', refId: order._id, note: 'Order cancelled — wallet cash returned' });
  }
  // Orders from before couponConsumed existed only ever stored a coupon code
  // when it qualified, so the code alone is enough to restore it.
  if (order.couponCode && order.couponConsumed !== false && phone) {
    await col.coupons.updateOne({ code: order.couponCode, usedBy: phone }, { $inc: { usedCount: -1 }, $pull: { usedBy: phone } });
  }
  if (order.pointsAwardedAt && phone) await reversePoints(phone, order.pointsBase || order.totalPrice || 0, order.pointsAwarded);
  creditNoteFor('order', order._id); // only if it was already invoiced (tax on)
  const refundDue = Math.max(0, order.amountPaid || 0);
  if (refundDue > 0) {
    await col.orders.updateOne({ _id: oid }, { $set: { refundDue, refundStatus: 'due' } });
    sendPushToStaff('↩️ Refund due', `A cancelled order was already paid KES ${refundDue} by M-Pesa — refund the customer.`);
  }
  if (phone) {
    const extra = [
      order.walletApplied > 0 ? `KES ${order.walletApplied} is back in your wallet.` : '',
      refundDue > 0 ? `Your M-Pesa payment of KES ${refundDue} will be refunded by the shop.` : ''
    ].filter(Boolean).join(' ');
    sendPushToPhone(phone, '❌ Order cancelled', `Your BlitzMall order was cancelled.${extra ? ' ' + extra : ''}`, { screen: 'orders' });
  }
  try {
    await col.customers.updateOne({ phone }, { $inc: { orderCount: -1, totalSpent: -(order.totalPrice || 0) } });
  } catch (e) { /* stats only */ }
  return { ok: true, order, refundDue };
}
const ORDER_STATUSES = ['pending', 'packed', 'on_the_way', 'delivered', 'cancelled'];
const orderItemsTotal = (order) => (typeof order.itemsTotal === 'number')
  ? order.itemsTotal
  : (order.items || []).reduce((s, i) => s + storedLineTotal(i), 0);
// Points are earned on the goods the customer actually paid for — not on the
// rider's transport fee, and not on wallet cash (which itself came from points).
const orderPointsBase = (order) => Math.max(0, orderItemsTotal(order) - (order.discount || 0) - (order.walletApplied || 0));
// What a customer may see of their order: everything except the shop's cost
// prices (buyingPrice travels on each line for honest profit reports).
const publicLine = ({ buyingPrice, priceVerified, ...line }) => line;
const publicOrder = (order) => ({ ...order, items: (order.items || []).map(publicLine) });
const paymentStatusFor = (amountPaid, total) => (total <= 0 || amountPaid >= total) ? 'paid' : (amountPaid > 0 ? 'partial' : 'pending');

// ===== POS SALES =====
// Cleans a till basket: sane quantities and prices, and the cost price taken
// from the catalogue (never the client) so profit reports can be trusted.
// Staff may still ring up a custom price — that is a till decision.
async function cleanPosItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 200) return null;
  const ids = items.map(i => i && i.productId).filter(id => id && ObjectId.isValid(id));
  const products = ids.length ? await col.products.find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).toArray() : [];
  const byId = new Map(products.map(p => [String(p._id), p]));
  // The price the shelf/app shows right now (flash sales, happy hours applied),
  // to flag lines rung up below it.
  const shelf = new Map((await applyPricingRules(products)).map(p => [String(p._id), parseFloat(p.price) || 0]));
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const qty = Math.abs(parseFloat(raw.qty));
    const price = parseFloat(raw.price);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 10000) return null;
    if (!Number.isFinite(price) || price < 0 || price > 1000000) return null;
    const p = raw.productId && byId.get(String(raw.productId));
    out.push({
      productId: p ? String(p._id) : null,
      name: String((p && p.name) || raw.name || 'Item').slice(0, 120),
      price: Math.round(price * 100) / 100,
      qty,
      buyingPrice: p ? Math.max(0, parseFloat(p.buyingPrice) || 0) : Math.max(0, parseFloat(raw.buyingPrice) || 0),
      unit: (p && p.unit) || 'pcs',
      ...priceLine(p || {}, Math.round(price * 100) / 100, qty),
      ...(raw.category ? { category: String(raw.category).slice(0, 60) } : {}),
      ...(p && shelf.get(String(p._id)) - price > 0.5 ? { priceOverride: { catalogPrice: shelf.get(String(p._id)) } } : {})
    });
  }
  return out.length ? out : null;
}
const saleTotals = (items) => ({
  total: Math.round(items.reduce((s, i) => s + storedLineTotal(i), 0) * 100) / 100,
  profit: Math.round(items.reduce((s, i) => s + storedLineTotal(i) - (i.buyingPrice || 0) * i.qty, 0) * 100) / 100
});

// ===== STAFF STATUS / FEE CHANGES =====
// Shared by the Orders tab and the rider app: status moves (with the
// dispatched/delivered timestamps, customer pushes, loyalty points once and
// the tax invoice), and the transport fee confirmed by whoever processes it.
// Returns { status, body } like placeOrder.
// Status rules: pending / packed / on_the_way may move freely between each
// other (staff fix mistakes); "delivered" is final — the goods are gone, the
// points are paid — so it can't be moved back, and only the OWNER may cancel a
// delivered order (a return: stock, wallet cash and points come back). A
// cancelled order can never be reopened.
async function updateOrderStatus(orderId, { status, deliveryFee, deliveryProgress }, by = 'staff', { role } = {}) {
  if (!ObjectId.isValid(orderId)) return { status: 400, body: { error: 'Invalid order ID' } };
  const oid = new ObjectId(orderId);
  const existing = await col.orders.findOne({ _id: oid });
  if (!existing) return { status: 404, body: { error: 'Order not found' } };
  if (status !== undefined && !ORDER_STATUSES.includes(status)) return { status: 400, body: { error: 'Unknown order status' } };
  if (existing.status === 'cancelled' && status !== undefined && status !== 'cancelled') {
    return { status: 400, body: { error: "A cancelled order can't be reopened — its stock and vouchers were already returned. Ask the customer to order again." } };
  }
  if (existing.status === 'cancelled' && deliveryFee !== undefined) {
    return { status: 400, body: { error: "A cancelled order's transport fee can't be changed." } };
  }
  if (existing.status === 'delivered' && status !== undefined && status !== 'delivered') {
    if (status !== 'cancelled') return { status: 400, body: { error: 'This order was already delivered — it can\'t be moved back.' } };
    if (role !== 'owner') return { status: 403, body: { error: 'Only the owner can cancel an order that was already delivered.' } };
  }
  if (status === 'cancelled') {
    const r = await cancelOrderAndRestore(orderId, { by });
    if (!r.ok) return { status: 404, body: { error: r.error } };
    return { status: 200, body: { success: true, refundDue: r.refundDue || 0 }, cancelled: true, refundDue: r.refundDue || 0 };
  }
  // Snapshot before writing (the offline mock hands back the live document).
  const prevStatus = existing.status;
  const update = {};
  let feeNotify = null;
  if (status !== undefined) {
    update.status = status;
    if (status === 'on_the_way' && !existing.dispatchedAt) { update.dispatchedAt = new Date(); update.deliveryProgress = 0; }
    if (status === 'delivered') { update.deliveredAt = new Date(); update.deliveryProgress = 100; }
  }
  if (deliveryProgress !== undefined) update.deliveryProgress = Math.max(0, Math.min(100, parseFloat(deliveryProgress) || 0));
  if (deliveryFee !== undefined) {
    const fee = Math.min(Math.max(0, parseFloat(deliveryFee) || 0), 100000);
    update.deliveryFee = fee;
    update.deliveryFeeConfirmed = true;
    update.deliveryFeeSetBy = by;
    update.deliveryFeeSetAt = new Date();
    const newTotal = Math.max(0, orderItemsTotal(existing) + fee - (existing.discount || 0) - (existing.walletApplied || 0));
    update.totalPrice = Math.round(newTotal * 100) / 100;
    update.paymentStatus = paymentStatusFor(existing.amountPaid || 0, update.totalPrice);
    feeNotify = { fee, total: update.totalPrice, due: Math.max(0, Math.round((update.totalPrice - (existing.amountPaid || 0)) * 100) / 100) };
  }
  if (Object.keys(update).length) {
    // Only write while the order is still in the state this decision was based
    // on: a cancel (or delivery) racing this request must not be overwritten —
    // e.g. "delivered" landing on top of a cancel whose stock and wallet cash
    // were already returned.
    const filter = (status !== undefined && status !== prevStatus) ? { _id: oid, status: prevStatus } : { _id: oid, status: { $ne: 'cancelled' } };
    const w = await col.orders.updateOne(filter, { $set: update });
    if (!w.matchedCount) return { status: 409, body: { error: 'This order was just changed by someone else — refresh and try again.' } };
  }
  try {
    const updated = await col.orders.findOne({ _id: oid });
    if (updated && updated.customerId) {
      if (status === 'on_the_way' && prevStatus !== 'on_the_way') sendPushToPhone(updated.customerId, '🛵 On the way!', 'Your BlitzMall order is out for delivery — it will arrive soon.', { screen: 'orders' });
      else if (status === 'delivered' && prevStatus !== 'delivered') {
        sendPushToPhone(updated.customerId, '✅ Delivered!', 'Your BlitzMall order has been delivered. Enjoy!', { screen: 'orders' });
        // Loyalty points: awarded ONCE per delivered order (atomic marker).
        const base = orderPointsBase(updated);
        if (base > 0) {
          const claim = await col.orders.updateOne({ _id: oid, pointsAwardedAt: { $exists: false } }, { $set: { pointsAwardedAt: new Date(), pointsBase: base } });
          if (claim.matchedCount) {
            const pts = await earnPoints(updated.customerId, base);
            // Remember exactly what was paid so a later return reverses that, not a recomputed guess.
            if (pts > 0) await col.orders.updateOne({ _id: oid }, { $set: { pointsAwarded: pts } });
            // Farm-proof referral payout: credits both sides on the first real order.
            require('./customers').creditReferralFirstOrder(updated.customerId).catch(() => {});
          }
        }
        invoiceOrder(updated); // tax invoice once the goods are handed over (when tax is on)
      }
      if (feeNotify) sendPushToPhone(updated.customerId, '🚚 Transport fee set', `Your delivery transport fee is KES ${feeNotify.fee}. Final amount due: KES ${feeNotify.due}.`, { screen: 'orders' });
    }
  } catch (e) { console.error('Order status push failed:', e.message); }
  return { status: 200, body: { success: true }, feeNotify };
}

module.exports = { publicOrder, updateOrderStatus, STANDARD_DELIVERY_FEE, FREE_DELIVERY_THRESHOLD, provisionalDeliveryFee, couponProblem, couponDiscount, releaseStock, placeOrder, cancelOrderAndRestore, ORDER_STATUSES, orderItemsTotal, orderPointsBase, paymentStatusFor, cleanPosItems, saleTotals };
