// Shop and admin AI assistant chat endpoints.
const { adminLlmSystem, askOllama, customerLlmSystem, detectAdminIntent, detectAiIntent, generateAdminAiResponse, generateAiResponse } = require('../lib/ai');
const { authenticate, optionalCustomer } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { aiChatLimiter } = require('../lib/limiters');
const { scheduleAlertSweep } = require('../lib/notifications');
const { pricedCatalog } = require('../lib/pricing');

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
      res.json({ response, action });
    } catch (err) {
      console.error('AI chat error:', err);
      res.json({ response: 'Sorry, I encountered an error. Please try again.', action: null });
    }
  });

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
      if (intent.didWrite) { productCache.del('all_products'); scheduleAlertSweep(); }
      res.json({ response, action: intent.didWrite ? { type: 'refresh' } : null });
    } catch (err) {
      console.error('Admin AI chat error:', err);
      res.json({ response: 'Sorry, I encountered an error processing your request.' });
    }
  });

};
