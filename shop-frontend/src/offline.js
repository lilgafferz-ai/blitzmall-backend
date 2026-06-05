// Offline storage & sync utility for BlitzMall
// Uses localStorage for simplicity, works on both mobile and PC

const PRODUCTS_KEY = 'bm_cached_products';
const QUEUE_KEY = 'bm_offline_queue';
const OFFLINE_EVENT = 'bm_offline_sync';

// ===== PRODUCT CACHE =====

export const cacheProducts = (products) => {
  try {
    localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products));
  } catch (e) { console.error('Failed to cache products:', e); }
};

export const getCachedProducts = () => {
  try {
    const data = localStorage.getItem(PRODUCTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) { return []; }
};

// ===== SALE QUEUE =====

export const queueSale = (saleData) => {
  try {
    const queue = getQueuedSales();
    queue.push({ ...saleData, _queuedAt: new Date().toISOString(), _syncStatus: 'pending' });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch (e) { console.error('Failed to queue sale:', e); return false; }
};

export const getQueuedSales = () => {
  try {
    const data = localStorage.getItem(QUEUE_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) { return []; }
};

const clearSynced = () => {
  localStorage.removeItem(QUEUE_KEY);
};

export const getPendingCount = () => getQueuedSales().length;

// ===== SYNC ENGINE =====

export const syncQueuedSales = async (authHeaders) => {
  const queue = getQueuedSales();
  if (!queue.length) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;
  const API_URL = 'https://blitzmall-backend.onrender.com/api';

  for (const sale of queue) {
    try {
      const r = await fetch(API_URL + '/admin/sales', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          items: sale.items,
          paymentMethod: sale.paymentMethod || 'cash',
          amountGiven: sale.amountGiven || 0,
          cashPart: sale.cashPart || 0,
          mpesaPart: sale.mpesaPart || 0,
          staff: sale.cashier || 'Owner',
          customerPhone: sale.custPhone || '',
        }),
      });
      const d = await r.json();
      if (d.success) {
        synced++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
  }

  if (synced > 0) {
    clearSynced();
    window.dispatchEvent(new CustomEvent(OFFLINE_EVENT, { detail: { synced } }));
  }
  return { synced, failed };
};

// ===== ONLINE/OFFLINE DETECTION =====

export const isOnline = () => navigator.onLine;

export const onOnline = (callback) => {
  window.addEventListener('online', callback);
  return () => window.removeEventListener('online', callback);
};

export const onOffline = (callback) => {
  window.addEventListener('offline', callback);
  return () => window.removeEventListener('offline', callback);
};

export const onSyncEvent = (callback) => {
  window.addEventListener(OFFLINE_EVENT, callback);
  return () => window.removeEventListener(OFFLINE_EVENT, callback);
};
