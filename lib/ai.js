// Rule-based shop/admin assistants (with optional local Ollama).
const { ObjectId } = require('mongodb');
const { col } = require('./db');
const { addLoyaltyPoints, earnPoints, reversePoints, tierFromPoints } = require('./loyalty');
const { sendPushToPhone } = require('./notifications');
const { cancelOrderAndRestore, orderPointsBase, placeOrder } = require('./orders');
const { costMap, generatePredictions, liveSales, orderProfit } = require('./reports');

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
        const r = await cancelOrderAndRestore(pending._id, { by: 'customer (AI chat)' });
        if (!r.ok) return '⚠️ Failed to cancel order. Please try from My Orders page.';
        const extras = [
          pending.walletApplied > 0 ? `KES ${pending.walletApplied} is back in your wallet.` : '',
          r.refundDue ? `The shop will refund your M-Pesa payment of KES ${r.refundDue}.` : ''
        ].filter(Boolean).join(' ');
        return `❌ **Order Cancelled:**\n\nOrder #${pending._id.toString().slice(-6)} has been cancelled.${extras ? ' ' + extras : ''}\n\nNeed anything else?`;
      } catch (err) {
        return '⚠️ Failed to cancel order. Please try from My Orders page.';
      }
    }
    case 'complaint': {
      if (customerId) {
        try {
          await col.reviews.insertOne({ customerId, customerName: 'Customer', rating: 1, message: `[AI Complaint] ${message}`, createdAt: new Date() });
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
      if (!loyalty) return '🎁 Join our loyalty program! Earn 1 point for every KES 200 you spend.\n\nBronze → Silver (200 pts) → Gold (600 pts) → Platinum (1,500 pts)\nEvery 5 points = KES 1 — redeem them for discount coupons or wallet cash!';
      return `🎁 **Your Loyalty Card:**\n\n• Tier: **${tierFromPoints(loyalty.points)}**\n• Points: **${loyalty.points || 0}** PTS\n• Wallet: KES ${(loyalty.walletBalance || 0).toLocaleString()}\n• Points worth: KES ${Math.floor((loyalty.points || 0) / 5).toLocaleString()} (5 pts = KES 1)`;
    }
    case 'delivery':
      return `🚚 **Delivery Options:**\n\n• **Mall Area:** FREE delivery!\n• **Standard:** from KES 150 — the shop confirms the final transport fee for your location before dispatch\n• **Free Delivery:** baskets of KES 1,500+\n\n📍 GPS pinning available at checkout.`;
    case 'discount': {
      let couponInfo = '';
      try {
        const activeCoupons = await col.coupons.find({ active: true }).toArray();
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
      let cust = null;
      try { cust = await col.customers.findOne({ phone: customerId }); } catch (e) { cust = null; }
      const placed = await placeOrder({
        phone: customerId, customerName: (cust && cust.name) || 'Customer',
        items: inStock.map(p => ({ _id: String(p._id), quantity: 1 })),
        paymentMethod: 'delivery', via: 'ai_chat'
      });
      if (placed.status !== 200) return `😅 I couldn't place that order: ${placed.body.error || 'please try again from the shop.'}`;
      const { items, totalPrice } = placed.body;
      intent.orderResult = { orderId: String(placed.body.orderId), total: totalPrice };
      return `🛍️ **Order placed!**\n\n${items.map(i => `• ${i.name} ×${i.quantity} — KES ${(i.price * i.quantity).toLocaleString()}`).join('\n')}\n\n**Total: KES ${totalPrice.toLocaleString()}** — pay on pickup or delivery (the shop confirms any transport fee).\n\nSay "track my order" for updates!`;
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
    col.sales.find(branchQ).toArray(),
    col.orders.find(branchQ).toArray(),
    col.expenses.find(branchQ).toArray(),
    col.products.find(branchQ).toArray(),
    col.staff.find(branchQ).toArray(),
    col.loyalty.find({}).toArray(),
    col.coupons.find({}).toArray()
  ]);

  const costById = costMap(allProducts);
  const calc = (start) => {
    let revenue = 0, profit = 0, cash = 0, mpesa = 0, count = 0;
    for (const s of allSales) { if (s.refunded || !inP(s.createdAt, start)) continue; count++; revenue += s.total || 0; profit += s.profit || 0; if (s.paymentMethod === 'cash') cash += s.total || 0; else if (s.paymentMethod === 'mpesa') mpesa += s.total || 0; else if (s.paymentMethod === 'split') { cash += s.cashPart || 0; mpesa += s.mpesaPart || 0; } }
    for (const o of allOrders) { if (o.status === 'cancelled' || !inP(o.createdAt, start)) continue; count++; revenue += o.totalPrice || 0; profit += orderProfit(o, costById); if (o.paymentMethod === 'mpesa') mpesa += o.totalPrice || 0; else cash += o.totalPrice || 0; }
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
        const live = liveSales(allSales);
        const liveOrders = allOrders.filter(o => o.status !== 'cancelled');
        for (const s of live) for (const it of (s.items || [])) tallyPred[it.name] = (tallyPred[it.name] || 0) + (it.qty || 0);
        for (const o of liveOrders) for (const it of (o.items || [])) tallyPred[it.name] = (tallyPred[it.name] || 0) + (it.quantity || it.qty || 0);
        const preds = generatePredictions(live, liveOrders, allProducts, tallyPred);
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
      await col.products.updateOne({ _id: p._id }, { $inc: { stock: qty } });
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
      if (order.status === 'cancelled' && status !== 'cancelled') return `⚠️ Order **#${String(order._id).slice(-6)}** was cancelled and can't be reopened.`;
      if (status === 'cancelled') {
        const r = await cancelOrderAndRestore(order._id, { by: userName || 'AI assistant' });
        intent.didWrite = true;
        return `❌ Order **#${String(order._id).slice(-6)}** cancelled — stock, wallet cash and voucher returned${r.refundDue ? `. ⚠️ Refund the customer's M-Pesa payment of KES ${r.refundDue}` : ''}.`;
      }
      const update = { status };
      if (status === 'on_the_way' && !order.dispatchedAt) { update.dispatchedAt = new Date(); update.deliveryProgress = 0; }
      if (status === 'delivered') { update.deliveredAt = new Date(); update.deliveryProgress = 100; }
      await col.orders.updateOne({ _id: order._id }, { $set: update });
      if (order.customerId && status !== order.status) {
        if (status === 'on_the_way') sendPushToPhone(order.customerId, '🛵 On the way!', 'Your BlitzMall order is out for delivery — it will arrive soon.');
        if (status === 'delivered') {
          sendPushToPhone(order.customerId, '✅ Delivered!', 'Your BlitzMall order has been delivered. Enjoy!');
          const base = orderPointsBase(order);
          if (base > 0) {
            const claim = await col.orders.updateOne({ _id: order._id, pointsAwardedAt: { $exists: false } }, { $set: { pointsAwardedAt: new Date(), pointsBase: base } });
            if (claim.matchedCount) await earnPoints(order.customerId, base);
          }
        }
      }
      intent.didWrite = true;
      return `✅ Order **#${String(order._id).slice(-6)}** marked **${status.replace('_', ' ').toUpperCase()}**.`;
    }
    case 'add_expense': {
      const amtM = text.match(/(?:kes|ksh)?\s*(\d+(?:\.\d+)?)/i);
      const amt = amtM ? parseFloat(amtM[1]) : 0;
      if (!amt) return '🤖 Say e.g. "add expense 500 for transport".';
      const desc = text.replace(/(add|record|log|expense|cost|gharama|kes|ksh|for|\d+(\.\d+)?)/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!desc) return '🤖 Say e.g. "add expense 500 for transport".';
      await col.expenses.insertOne({ description: desc, amount: amt, createdBy: userName || 'AI Assistant', branchId: branchId || null, createdAt: new Date() });
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
      const flag = deltaPct <= -25 ? '🚨 **ALERT:**' : deltaPct >= 25 ? '🎉 **Strong day:**' : '📊 **Status:**';
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
      await col.products.insertOne({
        name, price, buyingPrice: 0, stock: stM ? parseInt(stM[1], 10) : 0,
        category: catM ? catM[1].trim() : 'General', barcode: '', description: '', image: [],
        expiryDate: null, branchId: branchId || null, createdAt: new Date()
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
      await col.products.updateOne({ _id: p._id }, { $set: { price } });
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
      await col.products.updateOne({ _id: p._id }, { $set: { flashSale: true, flashSaleDiscount: pct, discountPercent: pct, flashSaleExpires: new Date(Date.now() + 24 * 3600 * 1000) } });
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
      await col.products.updateOne({ _id: p._id }, absolute ? { $set: { stock: qty } } : { $inc: { stock: qty } });
      intent.didWrite = true;
      return absolute ? `📦 **Stock set:** ${p.name} → ${qty}.` : `📦 **Stock updated:** ${p.name} +${qty} → now ${(p.stock || 0) + qty}.`;
    }
    case 'customer_lookup': {
      const phoneM = text.match(/(\d{9,12})/);
      if (!phoneM) return '🤖 Say e.g. "find customer 0712345678".';
      const phone = phoneM[1];
      const [cust, loyalty] = await Promise.all([col.customers.findOne({ phone }), col.loyalty.findOne({ phone })]);
      const credits = await col.credit.find({ phone }).toArray();
      const orderCount = cust ? (cust.orderCount || 0) : await col.orders.countDocuments({ customerId: phone });
      const totalSpent = cust ? (cust.totalSpent || 0) : 0;
      const owed = credits.filter(c => !c.paid).reduce((s, c) => s + (c.amount || 0), 0);
      const name = (cust && cust.name) || (loyalty && loyalty.customerName) || '—';
      return `👤 **${name}** (${phone})\n\n• Orders: ${orderCount}\n• Total spent: KES ${totalSpent.toLocaleString()}\n• Loyalty: ${loyalty ? loyalty.points : 0} pts (${loyalty ? loyalty.tier : 'None'})\n• Credit owed: KES ${owed.toLocaleString()}\n• Last order: ${cust && cust.lastOrderAt ? new Date(cust.lastOrderAt).toLocaleDateString() : '—'}`;
    }
    case 'credit_list': {
      const owed = await col.credit.find({ paid: { $ne: true } }).toArray();
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
      const existing = await col.loyalty.findOne({ phone });
      await addLoyaltyPoints(phone, points);
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
      const existing = await col.coupons.findOne({ code });
      if (existing) return `⚠️ Coupon **${code}** already exists.`;
      await col.coupons.insertOne({ code, type: isPct ? 'percent' : 'fixed', value, minPurchase: 0, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), maxUses: 0, usedCount: 0, active: true, createdAt: new Date() });
      intent.didWrite = true;
      return `🎟️ **Coupon created:** ${code} — ${isPct ? value + '% off' : 'KES ' + value} (30 days, unlimited uses).`;
    }
    case 'disable_coupon': {
      const m = text.match(/(?:disable|deactivate|stop|remove|turn off)\s+coupon\s+([A-Z0-9]+)/i) || text.match(/coupon\s+([A-Z0-9]+)\s+(?:disable|deactivate|stop|remove|off)/i);
      if (!m) return '🤖 Say e.g. "disable coupon BLITZ20".';
      const code = m[1].toUpperCase();
      const r = await col.coupons.updateOne({ code }, { $set: { active: false } });
      if (!r.matchedCount) return `🔍 Coupon **${code}** not found.`;
      intent.didWrite = true;
      return `🚫 **Coupon disabled:** ${code} can no longer be used.`;
    }
    case 'coupon_redemptions': {
      const todayReds = await col.redemptions.find({ createdAt: { $gte: startToday } }).toArray();
      const totalReds = await col.redemptions.countDocuments({});
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
      await col.staff.insertOne({ name, role, branchId: branchId || null, createdAt: new Date() });
      intent.didWrite = true;
      return `👥 **Staff added:** ${name} (${role}).`;
    }
    case 'working_today': {
      const open = await col.shifts.find({ status: 'open' }).toArray();
      if (!open.length) return '🕐 No one is on shift right now.';
      return `🕐 **On shift now (${open.length}):**\n\n${open.map(sh => `• ${sh.cashierName || sh.cashierId} — since ${new Date(sh.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${sh.startingCash ? ' (start KES ' + sh.startingCash.toLocaleString() + ')' : ''}`).join('\n')}`;
    }
    case 'shift_summary': {
      const todayShifts = await col.shifts.find({ startTime: { $gte: startToday } }).toArray();
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
      const flip = await col.sales.updateOne({ _id: sale._id, refunded: { $ne: true } }, { $set: { refunded: true, refundedAt: new Date(), refundedBy: userName || null } });
      if (!flip.matchedCount) return `⚠️ Sale #${String(sale._id).slice(-6)} is already refunded.`;
      if (sale.customerPhone && sale.total) await reversePoints(sale.customerPhone, sale.total);
      for (const it of (sale.items || [])) { if (it.productId && ObjectId.isValid(it.productId)) await col.products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: Math.abs(it.qty || 1) } }); }
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
      await col.sales.insertOne({ items: [{ name: desc || 'Manual sale', price: total, qty: 1, productId: null, buyingPrice: 0 }], total, profit: 0, paymentMethod, amountGiven: paymentMethod === 'cash' ? total : 0, cashPart: paymentMethod === 'cash' ? total : 0, mpesaPart: paymentMethod === 'mpesa' ? total : 0, change: 0, staff: userName || 'Owner', cashierUserId: null, customerPhone: '', channel: 'ai', branchId: branchId || null, createdAt: new Date() });
      intent.didWrite = true;
      return `🧾 **Sale recorded:** KES ${total.toLocaleString()} (${paymentMethod})${desc ? ' — ' + desc : ''}.`;
    }
    default:
      return '\ud83e\udd16 **I can help with your business data.**\n\nTry:\n\u2022 "How are sales today?"\n\u2022 "What\'s my profit this month?"\n\u2022 "Any out of stock items?"\n\u2022 "Show pending orders"\n\u2022 "Best selling products"\n\u2022 "Restock predictions"\n\u2022 "Cash vs M-Pesa today"\n\u2022 "Business overview"\n\nI have access to all your store data! \ud83d\udcca\n\n\u26a1 **Try:** "add product [name] price [amount]", "update [product] price to [amount]", "discount [product] by 10%", "add 5 to [product] stock", "create coupon [CODE] 20% off", "find customer [phone]", "who owes credit?", "add staff [name] as [role]", "refund sale #[id]", "record cash sale 500", "any anomalies?"';
  }
}

module.exports = { OLLAMA_URL, OLLAMA_MODEL, ollamaOk, ollamaCheckedAt, ollamaReady, askOllama, SW_TO_EN, expandSwahili, normalizeAiText, findMatchingProducts, detectAiIntent, generateAiResponse, customerLlmSystem, adminLlmSystem, detectAdminIntent, generateAdminAiResponse };
