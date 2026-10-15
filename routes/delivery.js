// Delivery: time slots (customers pick one at checkout), rider assignment and
// live rider GPS for the customer's tracking map.
const { ObjectId } = require('mongodb');
const { col } = require('../lib/db');
const { authenticate, authorize, requirePermission, auditLog } = require('../lib/auth');
const { getSetting, saveSetting } = require('../lib/settings');
const { listSlots, sanitizeDeliverySettings } = require('../lib/deliverySlots');
const { updateOrderStatus } = require('../lib/orders');
const { sendPushToPhone, sendPushToStaffUser } = require('../lib/notifications');

const ACTIVE = ['pending', 'packed', 'on_the_way'];
const sendErr = (res, e, fallback) => { console.error(fallback, e); return res.status(500).json({ error: fallback }); };
// Run a status change through the shared order logic; answer like it did.
const moveOrder = async (res, orderId, status, by, role) => {
  const r = await updateOrderStatus(String(orderId), { status }, by, { role });
  if (r.status !== 200) { res.status(r.status).json(r.body); return false; }
  return true;
};
// A rider may only act on orders assigned to them; owners/managers on any.
const canActOn = (req, order) => req.user.role === 'owner' || req.user.role === 'manager'
  || (order.rider && order.rider.userId === req.user.userId);

module.exports = function register(app) {
  // ===== SLOTS =====
  app.get('/api/delivery/slots', async (req, res) => {
    try { res.json(await listSlots()); }
    catch (e) { console.error('slots failed:', e); res.status(500).json({ error: 'Failed to load delivery slots' }); }
  });

  app.get('/api/admin/delivery/settings', authenticate, async (req, res) => {
    try { res.json(await getSetting('delivery')); } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });
  app.put('/api/admin/delivery/settings', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      const next = sanitizeDeliverySettings(req.body || {}, await getSetting('delivery'));
      const saved = await saveSetting('delivery', next);
      auditLog(req, 'delivery_settings_saved', `${saved.slots.length} slots, ${saved.slotsEnabled ? 'on' : 'off'}`);
      res.json({ success: true, settings: saved });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to save delivery settings' }); }
  });

  // ===== RIDERS =====
  // Rider logins (role "rider") the Orders tab can assign.
  app.get('/api/admin/riders', authenticate, requirePermission('orders'), async (req, res) => {
    try {
      const riders = await col.users.find({ role: 'rider' }).toArray();
      res.json(riders.map(r => ({ _id: String(r._id), name: r.name, username: r.username })));
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
  });

  app.put('/api/admin/orders/:orderId/assign', authenticate, requirePermission('orders'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await col.orders.findOne({ _id: new ObjectId(req.params.orderId) });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!ACTIVE.includes(order.status)) return res.status(400).json({ error: `This order is already ${order.status}` });
      let rider = null;
      if (req.body.riderUserId) {
        if (!ObjectId.isValid(req.body.riderUserId)) return res.status(400).json({ error: 'Invalid rider' });
        const u = await col.users.findOne({ _id: new ObjectId(req.body.riderUserId), role: 'rider' });
        if (!u) return res.status(404).json({ error: 'Rider not found' });
        rider = { userId: String(u._id), name: u.name, username: u.username, assignedAt: new Date() };
      }
      await col.orders.updateOne({ _id: order._id }, { $set: { rider } });
      if (rider) sendPushToStaffUser(rider.username, '🛵 New delivery', `Order #${String(order._id).slice(-6)} — ${order.deliveryLocation || 'see the app'}`, { tab: 'deliveries' });
      auditLog(req, 'rider_assigned', `Order ${req.params.orderId} → ${rider ? rider.name : 'unassigned'}`);
      res.json({ success: true, rider });
    } catch (e) { sendErr(res, e, 'Failed to assign rider'); }
  });

  // The rider's own run sheet (owners/managers see every active delivery).
  app.get('/api/admin/rider/orders', authenticate, requirePermission('deliveries', 'orders'), async (req, res) => {
    try {
      const filter = { status: { $in: ACTIVE } };
      if (req.user.role === 'rider') filter['rider.userId'] = req.user.userId;
      const list = await col.orders.find(filter).sort({ createdAt: 1 }).toArray();
      // Riders see what they need to deliver — not the customer's spend history.
      res.json(list.map(o => ({
        _id: o._id, status: o.status, customerName: o.customerName, customerPhone: o.customerId,
        deliveryLocation: o.deliveryLocation, gpsCoords: o.gpsCoords, deliverySlot: o.deliverySlot || null,
        items: (o.items || []).map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit || 'pcs' })),
        totalPrice: o.totalPrice, paymentStatus: o.paymentStatus, balanceDue: o.balanceDue ?? (o.paymentStatus === 'paid' ? 0 : o.totalPrice),
        rider: o.rider || null, riderLocation: o.riderLocation || null, createdAt: o.createdAt
      })));
    } catch (e) { sendErr(res, e, 'Failed to load deliveries'); }
  });

  const riderAction = (handler) => async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await col.orders.findOne({ _id: new ObjectId(req.params.orderId) });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!canActOn(req, order)) return res.status(403).json({ error: 'This delivery is assigned to another rider' });
      await handler(req, res, order);
    } catch (e) { sendErr(res, e, 'Delivery update failed'); }
  };
  const by = (req) => req.user.name || req.user.username || 'rider';

  app.post('/api/admin/rider/orders/:orderId/start', authenticate, requirePermission('deliveries', 'orders'), riderAction(async (req, res, order) => {
    if (!(await moveOrder(res, order._id, 'on_the_way', by(req), req.user.role))) return;
    res.json({ success: true });
  }));

  // Live GPS from the rider's phone (sent every ~15s while delivering).
  app.post('/api/admin/rider/orders/:orderId/location', authenticate, requirePermission('deliveries', 'orders'), riderAction(async (req, res, order) => {
    const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return res.status(400).json({ error: 'Invalid location' });
    if (order.status !== 'on_the_way') return res.status(400).json({ error: 'Start the delivery first' });
    await col.orders.updateOne({ _id: order._id }, { $set: { riderLocation: { lat, lng, accuracy: parseFloat(req.body.accuracy) || null, at: new Date() } } });
    res.json({ success: true });
  }));

  app.post('/api/admin/rider/orders/:orderId/delivered', authenticate, requirePermission('deliveries', 'orders'), riderAction(async (req, res, order) => {
    if (!(await moveOrder(res, order._id, 'delivered', by(req), req.user.role))) return;
    await col.orders.updateOne({ _id: order._id }, { $set: { riderLocation: null } });
    res.json({ success: true });
  }));

  // Rider couldn't reach the customer — tell them, keep the order open.
  app.post('/api/admin/rider/orders/:orderId/arrived', authenticate, requirePermission('deliveries', 'orders'), riderAction(async (req, res, order) => {
    sendPushToPhone(order.customerId, '📍 Your rider is here', 'Your BlitzMall rider has arrived — please come out to collect your order.', { screen: 'orders' });
    res.json({ success: true });
  }));
};
