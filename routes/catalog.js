// Products, categories, banners, flash sales, pricing rules and stock transfers.
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authorize, branchFilter, logAction, requirePermission } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { autoFetchProductImage, isMobileUA, searchProductImages, upgradeImagesForClient } = require('../lib/images');
const { searchImagesLimiter } = require('../lib/limiters');
const { scheduleAlertSweep, sendPushToAll } = require('../lib/notifications');
const { applyPricingRules } = require('../lib/pricing');
const { sanitizeUnitFields } = require('../lib/units');
const { TAX_CATEGORIES } = require('../lib/etims');

// Selling unit, multi-buy deals, supplier and tax category (Inventory form).
const extraProductFields = (b = {}) => {
  const out = sanitizeUnitFields(b);
  if (b.supplierId !== undefined) out.supplierId = b.supplierId ? String(b.supplierId).slice(0, 24) : null;
  if (b.taxCategory !== undefined) out.taxCategory = TAX_CATEGORIES[b.taxCategory] ? b.taxCategory : null;
  return out;
};
// Shoppers never see cost prices or internal alert markers.
const PRIVATE_FIELDS = ['buyingPrice', 'cost', 'alertedOutAt', 'alertedLowAt', 'alertedExpiryAt', 'alertedExpiredAt', 'supplierId', 'taxCategory'];
const publicProduct = (p) => { const out = { ...p }; for (const k of PRIVATE_FIELDS) delete out[k]; return out; };
// Star ratings from product reviews (hidden ones excluded).
async function withRatings(list) {
  try {
    const reviews = col.product_reviews ? await col.product_reviews.find({ hidden: { $ne: true } }).toArray() : [];
    const agg = {};
    for (const r of reviews) { const a = agg[r.productId] || (agg[r.productId] = { sum: 0, n: 0 }); a.sum += r.rating; a.n++; }
    return list.map(p => { const a = agg[String(p._id)]; return a ? { ...p, ratingAvg: Math.round((a.sum / a.n) * 10) / 10, ratingCount: a.n } : p; });
  } catch (e) { return list; }
}

module.exports = function register(app) {
  // ===== CUSTOMER =====
  app.get('/api/products', async (req, res) => {
    try {
      const cacheKey = 'all_products';
      let priced = productCache.get(cacheKey);
      if (!priced) {
        const list = await col.products.find().toArray();
        priced = (await withRatings(await applyPricingRules(list))).map(publicProduct);
        productCache.set(cacheKey, priced);
      }
      // 4K image upgrade happens PER REQUEST (after cache) so phone customers
      // keep the stored URLs while PC/desktop-web customers see full-res photos.
      res.json(upgradeImagesForClient(priced, isMobileUA(req.headers['user-agent'])));
    } catch (e) {
      console.error('Failed to fetch products:', e);
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });
  app.get('/api/admin/products', authenticate, async (req, res) => {
    try {
      const filter = branchFilter(req);
      const list = await col.products.find(filter).toArray();
      const priced = await applyPricingRules(list);
      res.json(upgradeImagesForClient(priced, isMobileUA(req.headers['user-agent'])));
    } catch (e) {
      console.error('Failed to fetch products:', e);
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });

  // ---- Staff endpoint: search product images online by barcode or name ----
  app.post('/api/products/search-images', authenticate, searchImagesLimiter, async (req, res) => {
    const { name, barcode } = req.body;
    if (!name && !barcode) return res.status(400).json({ error: 'Product name or barcode required', images: [] });

    try {
      const images = await searchProductImages(name, barcode);
      res.json({ images });
    } catch (e) {
      console.error('Image search failed:', e.message);
      res.json({ images: [] }); // no fake/AI images — real photos only
    }
  });

  // ===== PRODUCTS =====
  app.post('/api/admin/products', authenticate, requirePermission('inventory'), async (req, res) => {
    const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate, branchId } = req.body;
    if (!name || price === undefined || price === '') return res.status(400).json({ error: 'Name and selling price required' });
    try {

      const product = {
        name: String(name).trim().slice(0, 120), category: String(category || '').trim().slice(0, 60) || 'Other', barcode: String(barcode || '').trim().slice(0, 64),
        buyingPrice: parseFloat(buyingPrice) || 0, price: parseFloat(price) || 0, stock: Math.max(0, Math.round((parseFloat(stock) || 0) * 100) / 100),
        description: String(description || '').slice(0, 2000), image: image || await autoFetchProductImage(name, barcode),
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        branchId: branchId || req.user.branchId || null,
        ...extraProductFields(req.body),
        createdAt: new Date(),
      };
      if (!(product.price >= 0 && product.price <= 10000000)) return res.status(400).json({ error: 'Enter a valid selling price' });
      const result = await col.products.insertOne(product);
      auditLog(req, 'product_created', `${product.name}: price KES ${product.price}, cost KES ${product.buyingPrice}, stock ${product.stock}`);
      productCache.del('all_products');
      scheduleAlertSweep(); // a product added with 0 / low stock should alert immediately
      res.json({ success: true, productId: result.insertedId, message: 'Product added!' });
    } catch (e) { console.error('Failed to add product:', e); res.status(500).json({ error: 'Failed to add product' }); }
  });
  app.put('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
    const { name, category, barcode, buyingPrice, price, stock, description, image, expiryDate } = req.body;
    try {
      if (!ObjectId.isValid(req.params.productId)) return res.status(400).json({ error: 'Invalid product' });
      // Copied: the offline mock DB hands back the live document, which the update below would change.
      const found = await col.products.findOne({ _id: new ObjectId(req.params.productId) });
      const before = found ? { ...found } : null;
      if (!before) return res.status(404).json({ error: 'Product not found' });
      const u = {};
      if (name !== undefined) u.name = String(name).trim().slice(0, 120);
      if (category !== undefined) u.category = String(category || '').trim().slice(0, 60) || 'Other';
      if (barcode !== undefined) u.barcode = String(barcode || '').trim().slice(0, 64);
      if (buyingPrice !== undefined) u.buyingPrice = parseFloat(buyingPrice) || 0;
      if (price !== undefined) u.price = parseFloat(price) || 0;
      if (stock !== undefined) u.stock = Math.max(0, Math.round((parseFloat(stock) || 0) * 100) / 100);
      if (description !== undefined) u.description = String(description || '').slice(0, 2000);
      if (u.price !== undefined && !(u.price >= 0 && u.price <= 10000000)) return res.status(400).json({ error: 'Enter a valid selling price' });
      if (image !== undefined) u.image = image;
      if (expiryDate !== undefined) u.expiryDate = expiryDate ? new Date(expiryDate) : null;
      Object.assign(u, extraProductFields(req.body));
      const r = await col.products.updateOne({ _id: new ObjectId(req.params.productId) }, { $set: u });
      if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
      // Price, cost and stock edits are where shrinkage hides — record each change.
      const changes = ['price', 'buyingPrice', 'stock']
        .filter(k => u[k] !== undefined && u[k] !== before[k])
        .map(k => `${k} ${before[k] === undefined ? '—' : before[k]} → ${u[k]}`);
      if (changes.length) auditLog(req, 'product_updated', `${before.name}: ${changes.join(', ')}`);
      productCache.del('all_products');
      scheduleAlertSweep(); // stock/expiry may have changed — re-check alerts immediately
      res.json({ success: true, message: 'Product updated!' });
    } catch (e) { console.error('Failed to update product:', e); res.status(500).json({ error: 'Failed to update product' }); }
  });
  app.delete('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
    try { if (!ObjectId.isValid(req.params.productId)) return res.status(400).json({ error: 'Invalid product' }); const p = await col.products.findOne({ _id: new ObjectId(req.params.productId) }); const r = await col.products.deleteOne({ _id: new ObjectId(req.params.productId) }); if (!r.deletedCount) return res.status(404).json({ error: 'Product not found' }); auditLog(req, 'product_deleted', `${p ? p.name : req.params.productId} (stock ${p ? p.stock : '?'}, price KES ${p ? p.price : '?'})`); productCache.del('all_products'); res.json({ success: true });} catch (e) { console.error('Failed to delete product:', e); res.status(500).json({ error: 'Failed to delete product' }); }
  });

  // ===== CATEGORIES =====
  app.get('/api/admin/categories', authenticate, async (req, res) => {
    try {
      const list = await col.categories.find().sort({ name: 1 }).toArray();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  app.post('/api/admin/categories', authenticate, requirePermission('inventory'), async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
    const trimmedName = name.trim();
    try {
      // Database-agnostic case-insensitive duplicate check to support FileCollection
      const allCats = await col.categories.find().toArray();
      const exists = allCats.some(c => c.name.toLowerCase() === trimmedName.toLowerCase());
      if (exists) return res.status(400).json({ error: 'Category already exists' });

      const category = {
        name: trimmedName,
        createdAt: new Date()
      };
      const result = await col.categories.insertOne(category);
      res.json({ success: true, category: { _id: result.insertedId, name: trimmedName } });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add category' });
    }
  });

  app.delete('/api/admin/categories/:id', authenticate, requirePermission('inventory'), async (req, res) => {
    try {
      const r = await col.categories.deleteOne({ _id: new ObjectId(req.params.id) });
      if (!r.deletedCount) return res.status(404).json({ error: 'Category not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete category' });
    }
  });

  // Banners GET (Customer view - only active ones)
  app.get('/api/banners', async (req, res) => {
    try {
      const list = await col.banners.find({ active: true }).sort({ createdAt: 1 }).toArray();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch banners' });
    }
  });

  // Banners GET (Admin view - all)
  app.get('/api/admin/banners', authenticate, async (req, res) => {
    try {
      const list = await col.banners.find().sort({ createdAt: -1 }).toArray();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch banners' });
    }
  });

  // Banner POST (Create)
  app.post('/api/admin/banners', authenticate, authorize('owner', 'manager'), async (req, res) => {
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
      const r = await col.banners.insertOne(banner);
      // "Offers arrival" — every customer device hears about a new live offer.
      sendPushToAll('🚀 New offer!', `${banner.title}${banner.text ? ' — ' + banner.text : ''}`);
      res.json({ success: true, bannerId: r.insertedId });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create banner' });
    }
  });

  // Banner PUT (Toggle active or edit)
  app.put('/api/admin/banners/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
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

      const r = await col.banners.updateOne({ _id: new ObjectId(id) }, { $set: u });
      if (!r.matchedCount) return res.status(404).json({ error: 'Banner not found' });
      // Re-activating a banner announces the offer to every customer device.
      // Creation already announces, and re-announcing on every edit (even a typo
      // fix) would spam customers.
      if (active === true) {
        const banner = await col.banners.findOne({ _id: new ObjectId(id) });
        if (banner && banner.active) sendPushToAll('🚀 New offer!', `${banner.title}${banner.text ? ' — ' + banner.text : ''}`);
      }
      res.json({ success: true, message: 'Banner updated successfully!' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update banner' });
    }
  });

  // Banner DELETE
  app.delete('/api/admin/banners/:id', authenticate, authorize('owner', 'manager'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid banner ID' });
      const r = await col.banners.deleteOne({ _id: new ObjectId(id) });
      if (!r.deletedCount) return res.status(404).json({ error: 'Banner not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete banner' });
    }
  });

  // Product Flash Sale Toggle/Set
  app.post('/api/admin/products/:productId/flash-sale', authenticate, requirePermission('inventory'), async (req, res) => {
    const { flashSale, flashSaleDiscount, durationHours } = req.body;
    try {
      const { productId } = req.params;
      if (!ObjectId.isValid(productId)) return res.status(400).json({ error: 'Invalid product ID' });

      let u = {};
      if (flashSale !== undefined) u.flashSale = !!flashSale;
      // Capped at 90%: a 100% (or bigger) discount would give goods away for free.
      if (flashSaleDiscount !== undefined) u.flashSaleDiscount = Math.min(90, Math.max(0, parseFloat(flashSaleDiscount) || 0));

      if (flashSale) {
        const duration = Math.min(24 * 30, Math.max(0.25, parseFloat(durationHours) || 24)); // default 24 hours, max 30 days
        u.flashSaleExpires = new Date(Date.now() + duration * 60 * 60 * 1000);
      } else {
        u.flashSaleExpires = null;
      }

      const r = await col.products.updateOne({ _id: new ObjectId(productId) }, { $set: u });
      if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
      auditLog(req, 'flash_sale_set', `Product ${productId}: ${flashSale ? `${u.flashSaleDiscount}% off until ${u.flashSaleExpires.toISOString()}` : 'flash sale off'}`);
      productCache.del('all_products');
      // Turning a flash sale ON announces it to every customer device.
      if (flashSale) {
        const product = await col.products.findOne({ _id: new ObjectId(productId) });
        if (product) {
          const disc = Math.round((u.flashSaleDiscount || 0) * 100) / 100;
          sendPushToAll('🔥 Flash sale!', `${product.name} — ${disc}% off for ${parseFloat(durationHours) || 24}h. Hurry!`);
        }
      }
      res.json({ success: true, message: 'Flash sale updated!' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update flash sale settings' });
    }
  });

  // Dynamic Pricing: Fetch active rules
  app.get('/api/admin/pricing-rules', authenticate, requirePermission('inventory'), async (req, res) => {
    try {
      res.json(await col.pricing_rules.find().toArray());
    } catch (e) {
      console.error('Failed to fetch rules:', e);
      res.status(500).json({ error: 'Failed to fetch rules' });
    }
  });

  // Dynamic Pricing: Save active rule
  app.post('/api/admin/pricing-rules', authenticate, authorize('owner'), async (req, res) => {
    const { name, type, discountPercent, conditionValue, startHour, endHour, active } = req.body;
    if (!name || !type || !discountPercent) return res.status(400).json({ error: 'Missing pricing fields' });
    if (!['happy_hour', 'expiry'].includes(type)) return res.status(400).json({ error: 'Rule type must be happy_hour or expiry' });
    if (!(parseFloat(discountPercent) > 0 && parseFloat(discountPercent) <= 90)) return res.status(400).json({ error: 'Discount must be between 1% and 90%' });
    try {
      const rule = {
        name: String(name).slice(0, 80),
        type,
        discountPercent: parseFloat(discountPercent),
        conditionValue: parseInt(conditionValue) || 0,
        startHour: startHour || null,
        endHour: endHour || null,
        active: active !== false,
        createdAt: new Date()
      };
      await col.pricing_rules.insertOne(rule);
      await logAction(req.user.userId, req.user.username, 'CREATE_PRICING_RULE', `Created rule ${name} (${type})`, req.user.branchId);
      res.json({ success: true });
    } catch (e) {
      console.error('Failed to save rule:', e);
      res.status(500).json({ error: 'Failed to save rule' });
    }
  });

  // Dynamic Pricing: Update active rule status
  app.put('/api/admin/pricing-rules/:id', authenticate, authorize('owner'), async (req, res) => {
    try {
      const { active, discountPercent } = req.body;
      const update = {};
      if (active !== undefined) update.active = active;
      if (discountPercent !== undefined) {
        const d = parseFloat(discountPercent);
        if (!(d > 0 && d <= 90)) return res.status(400).json({ error: 'Discount must be between 1% and 90%' });
        update.discountPercent = d;
      }
      if (update.active !== undefined) update.active = !!update.active;
      await col.pricing_rules.updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
      await logAction(req.user.userId, req.user.username, 'UPDATE_PRICING_RULE', `Updated rule ${req.params.id}`, req.user.branchId);
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Dynamic Pricing: Delete pricing rule
  app.delete('/api/admin/pricing-rules/:id', authenticate, authorize('owner'), async (req, res) => {
    try {
      await col.pricing_rules.deleteOne({ _id: new ObjectId(req.params.id) });
      await logAction(req.user.userId, req.user.username, 'DELETE_PRICING_RULE', `Deleted rule ${req.params.id}`, req.user.branchId);
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Inter-Branch Stock Transfers: Fetch transfers list
  app.get('/api/admin/transfers', authenticate, requirePermission('inventory'), async (req, res) => {
    try {
      const list = await col.stock_transfers.find().sort({ createdAt: -1 }).toArray();
      res.json(list);
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Inter-Branch Stock Transfers: Request transfer
  app.post('/api/admin/transfers', authenticate, authorize('owner'), async (req, res) => {
    const { fromBranchId, toBranchId, items } = req.body;
    if (!fromBranchId || !toBranchId || !Array.isArray(items) || !items.length || items.length > 200) {
      return res.status(400).json({ error: 'Invalid transfer details' });
    }
    // Whole positive quantities of real product ids only: a NaN or negative
    // qty would corrupt both branches' stock when the transfer completes.
    const cleanItems = items.map(it => ({ productId: String((it && it.productId) || ''), qty: parseInt(it && it.qty, 10) }));
    if (cleanItems.some(it => !ObjectId.isValid(it.productId) || !(it.qty > 0 && it.qty <= 100000))) {
      return res.status(400).json({ error: 'Each transfer line needs a product and a positive quantity' });
    }
    try {
      const transfer = {
        fromBranchId: String(fromBranchId).slice(0, 40),
        toBranchId: String(toBranchId).slice(0, 40),
        items: cleanItems,
        status: 'pending',
        createdAt: new Date(),
        createdBy: req.user.username
      };
      await col.stock_transfers.insertOne(transfer);
      await logAction(req.user.userId, req.user.username, 'TRANSFER_CREATE', `Created transfer from ${fromBranchId} to ${toBranchId}`, req.user.branchId);
      res.json({ success: true });
    } catch (e) {
      console.error('API error:', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Inter-Branch Stock Transfers: Complete transfer
  app.post('/api/admin/transfers/:id/complete', authenticate, authorize('owner'), async (req, res) => {
    try {
      const transfer = await col.stock_transfers.findOne({ _id: new ObjectId(req.params.id) });
      if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
      if (transfer.status === 'completed') return res.status(400).json({ error: 'Already completed' });

      // Claim the transfer first so two clicks can't move the stock twice.
      const claim = await col.stock_transfers.updateOne({ _id: transfer._id, status: { $ne: 'completed' } }, { $set: { status: 'completed', completedAt: new Date() } });
      if (!claim.matchedCount) return res.status(400).json({ error: 'Already completed' });
      for (const it of transfer.items) {
        const qty = parseInt(it.qty, 10);
        if (!(qty > 0) || !ObjectId.isValid(it.productId)) continue; // old malformed line — skip rather than corrupt stock
        const prod = await col.products.findOne({ _id: new ObjectId(it.productId) });
        if (prod) {
          const targetProd = await col.products.findOne({ name: prod.name, branchId: transfer.toBranchId });
          if (targetProd) {
            await col.products.updateOne({ _id: targetProd._id }, { $inc: { stock: qty } });
          } else {
            const { _id, ...cleanProd } = prod;
            await col.products.insertOne({
              ...cleanProd,
              branchId: transfer.toBranchId,
              stock: qty
            });
          }
          await col.products.updateOne({ _id: prod._id }, { $inc: { stock: -qty } });
        }
      }

      await logAction(req.user.userId, req.user.username, 'TRANSFER_COMPLETE', `Completed transfer ${transfer._id}`, req.user.branchId);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed' });
    }
  });

};
