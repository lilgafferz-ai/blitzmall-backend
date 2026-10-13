// Customer orders, admin order processing and delivery tracking.
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authenticateCustomer, authorize, branchFilter, requirePermission } = require('../lib/auth');
const { SHOP_COORDS } = require('../lib/config');
const { col } = require('../lib/db');
const { orderLimiter } = require('../lib/limiters');
const { earnPoints } = require('../lib/loyalty');
const { sendPushToPhone } = require('../lib/notifications');
const { ORDER_STATUSES, cancelOrderAndRestore, orderItemsTotal, orderPointsBase, paymentStatusFor, placeOrder } = require('../lib/orders');
const { samePhone } = require('../lib/util');

module.exports = function register(app) {
  app.post('/api/orders', authenticateCustomer, orderLimiter, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await placeOrder({
        phone: req.customerPhone, customerName: b.customerName, items: b.items,
        paymentMethod: b.paymentMethod, deliveryLocation: b.deliveryLocation, deliveryArea: b.deliveryArea,
        gpsCoords: b.gpsCoords, couponCode: b.couponCode, useWallet: !!b.useWallet
      });
      res.status(r.status).json(r.body);
    } catch (e) { console.error('Failed to place order:', e); res.status(500).json({ error: 'Failed to place order' }); }
  });

  app.get('/api/customer-orders/:customerId', authenticateCustomer, async (req, res) => {
    if (!samePhone(req.params.customerId, req.customerPhone)) return res.status(403).json({ error: 'Not your account' });
    try {
      res.json(await col.orders.find({ customerId: req.customerPhone }).sort({ createdAt: -1 }).toArray());
    } catch (e) { console.error('Failed to fetch orders:', e); res.status(500).json({ error: 'Failed to fetch orders' }); }
  });

  // ===== ORDERS =====
  app.get('/api/admin/orders', authenticate, async (req, res) => {
    try { const filter = branchFilter(req); res.json(await col.orders.find(filter).sort({ createdAt: -1 }).toArray()); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });

  app.put('/api/admin/orders/:orderId', authenticate, requirePermission('orders'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order ID' });
      const oid = new ObjectId(req.params.orderId);
      const existing = await col.orders.findOne({ _id: oid });
      if (!existing) return res.status(404).json({ error: 'Order not found' });
      const { status, deliveryFee, deliveryProgress } = req.body;
      if (status !== undefined && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown order status' });
      if (existing.status === 'cancelled' && status !== undefined && status !== 'cancelled') {
        return res.status(400).json({ error: "A cancelled order can't be reopened — its stock and vouchers were already returned. Ask the customer to order again." });
      }

      // Cancelling gives back stock, wallet cash, the voucher and any points.
      if (status === 'cancelled') {
        const r = await cancelOrderAndRestore(req.params.orderId, { by: req.user.name || req.user.username || 'staff' });
        if (!r.ok) return res.status(404).json({ error: r.error });
        auditLog(req, 'order_cancelled', `Order ${req.params.orderId} cancelled${r.refundDue ? ' — M-Pesa refund due KES ' + r.refundDue : ''}`);
        return res.json({ success: true, refundDue: r.refundDue || 0 });
      }

      const update = {};
      let feeNotify = null; // { fee, total } — pushed to the customer after a confirmed fee change
      if (status !== undefined) {
        update.status = status;
        if (status === 'on_the_way' && !existing.dispatchedAt) {
          update.dispatchedAt = new Date();
          update.deliveryProgress = 0;
        }
        if (status === 'delivered') {
          update.deliveredAt = new Date();
          update.deliveryProgress = 100;
        }
      }
      if (deliveryProgress !== undefined) update.deliveryProgress = Math.max(0, Math.min(100, parseFloat(deliveryProgress) || 0));
      // ===== TRANSPORT FEE — SET BY THE PERSON PROCESSING THE ORDER =====
      // Whoever processes the order (owner, staff or a hired boda-boda rider)
      // types the fee they will charge. The server marks it confirmed, recomputes
      // the total (discount and wallet cash included), re-checks whether what the
      // customer already paid still covers it, and pushes the final amount due.
      if (deliveryFee !== undefined) {
        const fee = Math.min(Math.max(0, parseFloat(deliveryFee) || 0), 100000);
        update.deliveryFee = fee;
        update.deliveryFeeConfirmed = true;
        update.deliveryFeeSetBy = req.user.name || req.user.username || 'admin';
        update.deliveryFeeSetAt = new Date();
        const newTotal = Math.max(0, orderItemsTotal(existing) + fee - (existing.discount || 0) - (existing.walletApplied || 0));
        update.totalPrice = Math.round(newTotal * 100) / 100;
        update.paymentStatus = paymentStatusFor(existing.amountPaid || 0, update.totalPrice);
        feeNotify = { fee, total: update.totalPrice, due: Math.max(0, Math.round((update.totalPrice - (existing.amountPaid || 0)) * 100) / 100) };
      }
      await col.orders.updateOne({ _id: oid }, { $set: update });
      try {
        const updated = await col.orders.findOne({ _id: oid });
        if (updated && updated.customerId) {
          if (status === 'on_the_way' && existing.status !== 'on_the_way') sendPushToPhone(updated.customerId, '🛵 On the way!', 'Your BlitzMall order is out for delivery — it will arrive soon.');
          else if (status === 'delivered' && existing.status !== 'delivered') {
            sendPushToPhone(updated.customerId, '✅ Delivered!', 'Your BlitzMall order has been delivered. Enjoy!');
            // Loyalty points: 1 pt per KES 200 of goods, awarded ONCE per
            // delivered order. The atomic marker makes a double-tap harmless.
            const base = orderPointsBase(updated);
            if (base > 0) {
              const claim = await col.orders.updateOne({ _id: oid, pointsAwardedAt: { $exists: false } }, { $set: { pointsAwardedAt: new Date(), pointsBase: base } });
              if (claim.matchedCount) await earnPoints(updated.customerId, base);
            }
          }
          // Tell the customer the FINAL transport fee + amount due.
          if (feeNotify) {
            sendPushToPhone(updated.customerId, '🚚 Transport fee set', `Your delivery transport fee is KES ${feeNotify.fee}. Final amount due: KES ${feeNotify.due}.`);
          }
        }
      } catch (e) { console.error('Order status push failed:', e.message); }
      auditLog(req, 'order_updated', `Order ${req.params.orderId} updated${status ? ' → ' + status : ''}${feeNotify ? ' — transport fee set to KES ' + feeNotify.fee : ''}`);
      res.json({ success: true });
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
        deliveryLocation: order.deliveryLocation
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
