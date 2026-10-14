// Profit and forecasting maths for the dashboard and assistant.
const { storedLineTotal } = require('./units');

// ===== SUMMARY =====
// Profit on an online order: goods at their sold price minus cost price, minus
// any voucher discount the shop absorbed. The transport fee goes to the rider
// and is not profit. Orders placed before cost prices were stored on each line
// fall back to the product's current cost price (they used to count as 100%
// profit).
function orderProfit(o, costById) {
  let p = 0;
  for (const it of (o.items || [])) {
    const q = it.quantity || it.qty || 0;
    const cost = (typeof it.buyingPrice === 'number') ? it.buyingPrice : (costById.get(String(it._id || it.id || it.productId)) || 0);
    p += storedLineTotal(it) - cost * q; // line total includes multi-buy deals
  }
  return p - (o.discount || 0);
}
const costMap = (products) => new Map(products.map(p => [String(p._id), parseFloat(p.buyingPrice) || 0]));
const liveSales = (sales) => sales.filter(s => !s.refunded); // refunded sales are not revenue

// ===== PREDICTIONS ENGINE =====
function generatePredictions(sales, orders, products, tally) {
  const now = new Date();
  const predictions = { restock: [], slowMoving: [], forecast: [] };

  // Build per-product sales velocity (units sold per day over last 30 days)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const recentSales = [...sales, ...orders].filter(s => new Date(s.createdAt) >= thirtyDaysAgo);
  const velocity = {}; // { productName: unitsPerDay }
  const productMap = {}; // { productName: product }
  for (const p of products) productMap[p.name] = p;

  for (const s of recentSales) {
    for (const it of (s.items || [])) {
      const name = it.name;
      const qty = it.qty || it.quantity || 0;
      if (!name) continue;
      velocity[name] = (velocity[name] || 0) + qty;
    }
  }

  // Calculate daily rate (units/day over 30 days)
  for (const name in velocity) {
    velocity[name] = velocity[name] / 30; // units per day
  }

  // Restock predictions: if stock will run out within 14 days at current rate
  for (const p of products) {
    const name = p.name;
    const stock = p.stock || 0;
    const rate = velocity[name] || 0;
    if (rate > 0 && stock > 0) {
      const daysLeft = stock / rate;
      if (daysLeft <= 14) {
        predictions.restock.push({
          name,
          currentStock: stock,
          dailyRate: Math.round(rate * 100) / 100,
          daysLeft: Math.round(daysLeft * 10) / 10,
          estimatedDate: new Date(now.getTime() + daysLeft * 86400000),
          priority: daysLeft <= 3 ? 'high' : daysLeft <= 7 ? 'medium' : 'low',
        });
      }
    } else if (stock <= 0 && rate > 0) {
      predictions.restock.push({
        name,
        currentStock: 0,
        dailyRate: Math.round(rate * 100) / 100,
        daysLeft: 0,
        estimatedDate: now,
        priority: 'critical',
      });
    }
  }

  // Sort restock by most urgent
  predictions.restock.sort((a, b) => a.daysLeft - b.daysLeft);

  // Slow-moving: products with rate < 1 unit per day and stock > 10
  for (const p of products) {
    const name = p.name;
    const stock = p.stock || 0;
    const rate = velocity[name] || 0;
    if (rate > 0 && rate < 1 && stock >= 10) {
      predictions.slowMoving.push({
        name,
        currentStock: stock,
        monthlyRate: Math.round(rate * 30),
      });
    }
  }
  predictions.slowMoving.sort((a, b) => a.monthlyRate - b.monthlyRate);

  // 7-day sales forecast: simple moving average
  const last7Days = [...sales, ...orders].filter(s => new Date(s.createdAt) >= new Date(now.getTime() - 7 * 86400000));
  const dailyRevenue = {};
  for (const s of last7Days) {
    const day = new Date(s.createdAt).toISOString().slice(0, 10);
    dailyRevenue[day] = (dailyRevenue[day] || 0) + (s.total || s.totalPrice || 0);
  }
  const dayValues = Object.values(dailyRevenue);
  const avgDaily = dayValues.length > 0 ? dayValues.reduce((a, b) => a + b, 0) / dayValues.length : 0;
  predictions.forecast = {
    next7Days: Math.round(avgDaily * 7),
    avgDaily: Math.round(avgDaily * 100) / 100,
    dataPoints: dayValues.length,
  };

  return predictions;
}

module.exports = { orderProfit, costMap, liveSales, generatePredictions };
