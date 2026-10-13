// Products, categories, banners, flash sales, pricing rules and stock transfers.
const { ObjectId } = require('mongodb');
const { authenticate, authorize, branchFilter, logAction, requirePermission } = require('../lib/auth');
const { productCache } = require('../lib/cache');
const { col } = require('../lib/db');
const { autoFetchProductImage, isMobileUA, searchProductImages, upgradeImagesForClient } = require('../lib/images');
const { searchImagesLimiter } = require('../lib/limiters');
const { scheduleAlertSweep, sendPushToAll } = require('../lib/notifications');
const { applyPricingRules } = require('../lib/pricing');

module.exports = function register(app) {
  // ===== CUSTOMER =====
  app.get('/api/products', async (req, res) => {
    try {
      const cacheKey = 'all_products';
      let priced = productCache.get(cacheKey);
      if (!priced) {
        const list = await col.products.find().toArray();
        priced = await applyPricingRules(list);
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
        name, category: (category || '').trim() || 'Other', barcode: (barcode || '').trim(),
        buyingPrice: parseFloat(buyingPrice) || 0, price: parseFloat(price) || 0, stock: parseInt(stock, 10) || 0,
        description: description || '', image: image || await autoFetchProductImage(name, barcode),
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        branchId: branchId || req.user.branchId || null,
        createdAt: new Date(),
      };
      const result = await col.products.insertOne(product);
      productCache.del('all_products');
      scheduleAlertSweep(); // a product added with 0 / low stock should alert immediately
      res.json({ success: true, productId: result.insertedId, message: 'Product added!' });
    } catch (e) { console.error('Failed to add product:', e); res.status(500).json({ error: 'Failed to add product' }); }
  });
  app.put('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
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
      const r = await col.products.updateOne({ _id: new ObjectId(req.params.productId) }, { $set: u });
      if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
      productCache.del('all_products');
      scheduleAlertSweep(); // stock/expiry may have changed — re-check alerts immediately
      res.json({ success: true, message: 'Product updated!' });
    } catch (e) { console.error('Failed to update product:', e); res.status(500).json({ error: 'Failed to update product' }); }
  });
  app.delete('/api/admin/products/:productId', authenticate, requirePermission('inventory'), async (req, res) => {
    try { const r = await col.products.deleteOne({ _id: new ObjectId(req.params.productId) }); if (!r.deletedCount) return res.status(404).json({ error: 'Product not found' }); productCache.del('all_products'); res.json({ success: true });} catch (e) { console.error('Failed to delete product:', e); res.status(500).json({ error: 'Failed to delete product' }); }
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
      if (flashSaleDiscount !== undefined) u.flashSaleDiscount = parseFloat(flashSaleDiscount) || 0;

      if (flashSale) {
        const duration = parseFloat(durationHours) || 24; // default 24 hours
        u.flashSaleExpires = new Date(Date.now() + duration * 60 * 60 * 1000);
      } else {
        u.flashSaleExpires = null;
      }

      const r = await col.products.updateOne({ _id: new ObjectId(productId) }, { $set: u });
      if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
      productCache.del('all_products');
      // Turning a flash sale ON announces it to every customer device.
      if (flashSale) {
        const product = await col.products.findOne({ _id: new ObjectId(productId) });
        if (product) {
          const disc = Math.round((parseFloat(flashSaleDiscount) || 0) * 100) / 100;
          sendPushToAll('🔥 Flash sale!', `${product.name} — ${disc}% off for ${parseFloat(durationHours) || 24}h. Hurry!`);
        }
      }
      res.json({ success: true, message: 'Flash sale updated!' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update flash sale settings' });
    }
  });

  // Dynamic Pricing: Fetch active rules
  app.get('/api/admin/pricing-rules', authenticate, async (req, res) => {
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
    try {
      const rule = {
        name,
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
      if (discountPercent !== undefined) update.discountPercent = parseFloat(discountPercent);
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
  app.get('/api/admin/transfers', authenticate, async (req, res) => {
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
    if (!fromBranchId || !toBranchId || !items || !items.length) {
      return res.status(400).json({ error: 'Invalid transfer details' });
    }
    try {
      const transfer = {
        fromBranchId,
        toBranchId,
        items,
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

      for (const it of transfer.items) {
        const prod = await col.products.findOne({ _id: new ObjectId(it.productId) });
        if (prod) {
          const targetProd = await col.products.findOne({ name: prod.name, branchId: transfer.toBranchId });
          if (targetProd) {
            await col.products.updateOne({ _id: targetProd._id }, { $inc: { stock: parseInt(it.qty) } });
          } else {
            const { _id, ...cleanProd } = prod;
            await col.products.insertOne({
              ...cleanProd,
              branchId: transfer.toBranchId,
              stock: parseInt(it.qty)
            });
          }
          await col.products.updateOne({ _id: prod._id }, { $inc: { stock: -parseInt(it.qty) } });
        }
      }

      await col.stock_transfers.updateOne({ _id: transfer._id }, { $set: { status: 'completed', completedAt: new Date() } });
      await logAction(req.user.userId, req.user.username, 'TRANSFER_COMPLETE', `Completed transfer ${transfer._id}`, req.user.branchId);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed' });
    }
  });

};
