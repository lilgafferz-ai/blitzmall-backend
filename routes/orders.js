// Customer orders, admin order processing and delivery tracking.
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authenticateCustomer, authorize, branchFilter, requirePermission } = require('../lib/auth');
const { SHOP_COORDS } = require('../lib/config');
const { col } = require('../lib/db');
const { orderLimiter } = require('../lib/limiters');
const { cancelOrderAndRestore, placeOrder, publicOrder, updateOrderStatus } = require('../lib/orders');
const { samePhone, sendJsonCached } = require('../lib/util');

module.exports = function register(app) {
  app.post('/api/orders', authenticateCustomer, orderLimiter, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await placeOrder({
        phone: req.customerPhone, customerName: b.customerName, items: b.items,
        paymentMethod: b.paymentMethod, deliveryLocation: b.deliveryLocation, deliveryArea: b.deliveryArea,
        gpsCoords: b.gpsCoords, couponCode: b.couponCode, useWallet: !!b.useWallet,
        deliverySlot: b.deliverySlot
      });
      res.status(r.status).json(r.body);
    } catch (e) { console.error('Failed to place order:', e); res.status(500).json({ error: 'Failed to place order' }); }
  });

  app.get('/api/customer-orders/:customerId', authenticateCustomer, async (req, res) => {
    if (!samePhone(req.params.customerId, req.customerPhone)) return res.status(403).json({ error: 'Not your account' });
    try {
      res.json((await col.orders.find({ customerId: req.customerPhone }).sort({ createdAt: -1 }).limit(200).toArray()).map(publicOrder));
    } catch (e) { console.error('Failed to fetch orders:', e); res.status(500).json({ error: 'Failed to fetch orders' }); }
  });

  // ===== ORDERS =====
  app.get('/api/admin/orders', authenticate, requirePermission('orders', 'deliveries'), async (req, res) => {
    try { const filter = branchFilter(req); sendJsonCached(req, res, await col.orders.find(filter).sort({ createdAt: -1 }).toArray()); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });

  // Status moves and the confirmed transport fee — the logic lives in
  // lib/orders.js updateOrderStatus (shared with the rider app).
  app.put('/api/admin/orders/:orderId', authenticate, requirePermission('orders'), async (req, res) => {
    try {
      const { status, deliveryFee, deliveryProgress } = req.body;
      const r = await updateOrderStatus(req.params.orderId, { status, deliveryFee, deliveryProgress }, req.user.name || req.user.username || 'staff', { role: req.user.role });
      if (r.status === 200) {
        if (r.cancelled) auditLog(req, 'order_cancelled', `Order ${req.params.orderId} cancelled${r.refundDue ? ' — M-Pesa refund due KES ' + r.refundDue : ''}`);
        else auditLog(req, 'order_updated', `Order ${req.params.orderId} updated${status ? ' → ' + status : ''}${r.feeNotify ? ' — transport fee set to KES ' + r.feeNotify.fee : ''}`);
      }
      res.status(r.status).json(r.body);
    } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
  });
  app.delete('/api/admin/orders/:orderId', authenticate, authorize('owner'), async (req, res) => {
    try {
      const r = await col.orders.deleteOne({ _id: new ObjectId(req.params.orderId) });
      if (!r.deletedCount) return res.status(404).json({ error: 'Not found' });
      auditLog(req, 'order_deleted', `Order ${req.params.orderId} deleted`);
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Delivery tracking — only for the customer who placed the order (it carries
  // their home GPS position).
  app.get('/api/orders/:orderId/tracking', authenticateCustomer, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await col.orders.findOne({ _id: new ObjectId(req.params.orderId), customerId: req.customerPhone });
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
        deliveryLocation: order.deliveryLocation,
        deliverySlot: order.deliverySlot || null,
        // Live rider GPS, only while fresh (a stale dot is worse than none).
        riderLocation: order.riderLocation && order.riderLocation.at && Date.now() - new Date(order.riderLocation.at).getTime() < 10 * 60 * 1000 ? order.riderLocation : null,
        riderName: order.rider ? order.rider.name : null
      });
    } catch (e) { console.error('Failed to fetch tracking:', e); res.status(500).json({ error: 'Failed to fetch tracking' }); }
  });

  // Customer cancel order endpoint — only the signed-in owner of a pending order.
  app.post('/api/customer-orders/:orderId/cancel', authenticateCustomer, async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!ObjectId.isValid(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
      const order = await col.orders.findOne({ _id: new ObjectId(orderId), customerId: req.customerPhone });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.status !== 'pending') return res.status(400).json({ error: `Cannot cancel an order that is already ${order.status}` });
      const r = await cancelOrderAndRestore(orderId, { by: 'customer' });
      if (!r.ok) return res.status(404).json({ error: r.error });
      res.json({
        success: true,
        walletRefunded: order.walletApplied || 0,
        refundDue: r.refundDue || 0,
        message: r.refundDue ? `Order cancelled. The shop will refund your M-Pesa payment of KES ${r.refundDue}.` : 'Order cancelled successfully'
      });
    } catch (err) {
      console.error('Customer cancel failed:', err);
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  });

};
