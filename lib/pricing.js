// Live shop prices (flash sales, expiry discounts, happy hours).
const { col } = require('./db');

// Every product the shop sells, at the price the customer is SHOWN (flash
// sales, expiry discounts and happy-hour rules applied). Checkout charges the
// same price — the display and the bill can no longer disagree.
const pricedCatalog = async () => applyPricingRules(await col.products.find().toArray());

// Dynamic pricing calculation helper
const applyPricingRules = async (prods) => {
  try {
    if (!col.pricing_rules) return prods;
    const rules = await col.pricing_rules.find({ active: true }).toArray();

    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const currentTimeString = `${String(currentHour).padStart(2,'0')}:${String(currentMin).padStart(2,'0')}`;

    return prods.map(p => {
      let finalPrice = p.price;
      let appliedRules = [];

      // 1. Expiry Check (Auto Flash Sale for items expiring within 7 days)
      let isFlashSale = false;
      let flashSaleDiscount = 0;
      let flashSaleExpires = null;
      let flashSaleReason = '';

      if (p.expiryDate) {
        const exp = new Date(p.expiryDate);
        const diffTime = exp - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 7) {
          isFlashSale = true;
          flashSaleDiscount = 50; // 50% discount for expiring goods
          flashSaleExpires = p.expiryDate;
          flashSaleReason = `Expiring soon (${diffDays} days left)`;
        }
      }

      // 2. Manual Flash Sale
      if (!isFlashSale && p.flashSale && p.flashSaleExpires) {
        const expires = new Date(p.flashSaleExpires);
        if (expires > now) {
          isFlashSale = true;
          flashSaleDiscount = parseFloat(p.flashSaleDiscount) || 0;
          flashSaleExpires = p.flashSaleExpires;
          flashSaleReason = 'Special Flash Sale!';
        }
      }

      if (isFlashSale && flashSaleDiscount > 0) {
        finalPrice = finalPrice * (1 - (flashSaleDiscount / 100));
        appliedRules.push(`Flash Sale (${flashSaleDiscount}% Off)`);
      } else if (rules.length) {
        for (const rule of rules) {
          if (rule.type === 'happy_hour') {
            if (rule.startHour && rule.endHour) {
              if (currentTimeString >= rule.startHour && currentTimeString <= rule.endHour) {
                finalPrice = finalPrice * (1 - (rule.discountPercent / 100));
                appliedRules.push(rule.name);
              }
            }
          } else if (rule.type === 'expiry' && p.expiryDate) {
            const exp = new Date(p.expiryDate);
            const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays <= rule.conditionValue) {
              finalPrice = finalPrice * (1 - (rule.discountPercent / 100));
              appliedRules.push(rule.name);
            }
          }
        }
      }

      return {
        ...p,
        originalPrice: p.price,
        price: Math.round(finalPrice),
        discountApplied: appliedRules.length > 0,
        appliedRules,
        isFlashSale,
        flashSaleDiscount,
        flashSaleExpires,
        flashSaleReason
      };
    });
  } catch (err) {
    console.error('Error in applyPricingRules:', err);
    return prods;
  }
};

module.exports = { pricedCatalog, applyPricingRules };
