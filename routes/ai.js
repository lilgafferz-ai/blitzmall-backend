// Shop and admin AI assistant chat endpoints.
const { adminLlmSystem, askOllama, customerLlmSystem, detectAdminIntent, detectAiIntent, generateAdminAiResponse, generateAiResponse } = require('../lib/ai');
const { auditLog, authenticate, hasPermission, optionalCustomer } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { aiChatLimiter } = require('../lib/limiters');
const { scheduleAlertSweep } = require('../lib/notifications');
const { pricedCatalog } = require('../lib/pricing');

// The admin assistant reads and writes the same data as the admin screens, so
// it obeys the same permissions: each intent needs the permission of the tab
// that shows/edits that data (owner always passes). Anything not listed here
// is treated as a business-figures question and needs Records access.
const AI_OPEN_INTENTS = new Set(['greeting', 'general']);
const AI_INTENT_PERMISSIONS = {
  out_of_stock: ['inventory', 'sales'], low_stock: ['inventory', 'sales'], expiring: ['inventory', 'sales'],
  inventory_count: ['inventory', 'sales'], inventory_summary: ['inventory', 'sales'],
  pending_orders: ['orders', 'records'], delivered_orders: ['orders', 'records'], cancelled_orders: ['orders', 'records'], orders_summary: ['orders', 'records'],
  loyalty_summary: ['loyalty'], coupons_summary: ['loyalty'], coupon_redemptions: ['loyalty'], list_coupons: ['loyalty'], repeat_customers: ['loyalty'],
  customer_lookup: ['loyalty', 'credit'], credit_list: ['credit'],
  expenses: ['expenses', 'records'],
  // writes (also need the owner or manager role — see AI_WRITE_INTENTS)
  add_product: ['inventory'], update_price: ['inventory'], set_discount: ['inventory'], adjust_stock: ['inventory'], restock: ['inventory'],
  add_points: ['loyalty'], create_coupon: ['loyalty'], disable_coupon: ['loyalty'],
  record_sale: ['sales'], order_action: ['orders'], add_expense: ['expenses'],
  add_staff: ['records'], refund_sale: ['records']
};
const AI_WRITE_INTENTS = new Set(['add_product', 'update_price', 'set_discount', 'adjust_stock', 'add_points', 'create_coupon', 'disable_coupon', 'add_staff', 'refund_sale', 'record_sale', 'restock', 'order_action', 'add_expense']);

module.exports = function register(app) {
  app.post('/api/ai/chat', aiChatLimiter, optionalCustomer, async (req, res) => {
    const { message, conversationHistory } = req.body;
    // Only a signed-in customer can look up, place or cancel orders.
    const customerId = req.customerPhone;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
    try {
      const text = String(message).trim().slice(0, 1000);
      const [products, customerOrders, loyaltyRecord] = await Promise.all([
        pricedCatalog(),
        customerId ? col.orders.find({ customerId }).sort({ createdAt: -1 }).toArray() : [],
        customerId ? col.loyalty.findOne({ phone: customerId }) : null
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
      // Log the conversation turn for a signed-in customer so the owner can read
      // it in Admin → Customers (fire-and-forget: never block or fail the reply).
      if (customerId && col.ai_chats) {
        col.ai_chats.insertOne({ phone: customerId, message: text, response: String(response || '').slice(0, 4000), createdAt: new Date() })
          .catch(e => console.error('ai_chats log failed:', e.message));
      }
      res.json({ response, action });
    } catch (err) {
      console.error('AI chat error:', err);
      res.json({ response: 'Sorry, I encountered an error. Please try again.', action: null });
    }
  });

  app.post('/api/admin/ai/chat', authenticate, async (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
    try {
      const text = String(message).trim().slice(0, 1000);
      const intent = detectAdminIntent(text);
      // Write commands require owner/manager access - mirrors the role gates on the admin UI.
      if (AI_WRITE_INTENTS.has(intent.type) && req.user.role !== 'owner' && req.user.role !== 'manager') {
        auditLog(req, 'permission_denied', `AI assistant: ${intent.type}`);
        return res.status(403).json({ response: '🔒 That action needs **owner or manager** access. Please ask the shop owner to do it.', action: null });
      }
      if (!AI_OPEN_INTENTS.has(intent.type) && !hasPermission(req.user, ...(AI_INTENT_PERMISSIONS[intent.type] || ['records']))) {
        auditLog(req, 'permission_denied', `AI assistant: ${intent.type}`);
        return res.status(403).json({ response: '🔒 Your account doesn\'t have access to that information. Please ask the shop owner.', action: null });
      }
      let response = await generateAdminAiResponse(intent, text, req.user.branchId || null, req.user.name, req.user);
      // Every change the assistant makes is audit-logged like the same change made on screen.
      if (intent.didWrite) auditLog(req, 'ai_' + intent.type, `AI assistant: "${text.slice(0, 200)}" → ${String(response || '').replace(/\*\*/g, '').slice(0, 180)}`);
      if (intent.type === 'general') {
        const llm = await askOllama(adminLlmSystem(), text);
        if (llm) response = llm;
      }
      if (intent.didWrite) { productCache.del('all_products'); scheduleAlertSweep(); }
      res.json({ response, action: intent.didWrite ? { type: 'refresh' } : null });
    } catch (err) {
      console.error('Admin AI chat error:', err);
      res.json({ response: 'Sorry, I encountered an error processing your request.' });
    }
  });

};
