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

export const getPendingCount = () => getQueuedSales().length;

// ===== SYNC ENGINE =====

export const syncQueuedSales = async (authHeaders) => {
  const queue = getQueuedSales();
  if (!queue.length) return { synced: 0, failed: 0 };

  let synced = 0;
  const remaining = [];
  let API_URL = 'https://blitzmall-backend.onrender.com/api';
  try {
    const saved = localStorage.getItem('blitz_api_url');
    if (saved) {
      API_URL = saved;
    }
  } catch (e) {
  }

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
          // Support the current field names and any sale queued by an older
          // app version (which used cashier/custPhone).
          staff: sale.staff || sale.cashier || 'Owner',
          customerPhone: sale.customerPhone || sale.custPhone || '',
          branchId: sale.branchId,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.success) {
        synced++;
      } else if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
        // A definitive rejection (invalid basket) will never succeed — park it
        // in the rejected list for the owner instead of retrying forever.
        try {
          const rejected = JSON.parse(localStorage.getItem(QUEUE_KEY + '_rejected') || '[]');
          rejected.push({ ...sale, _rejectedAt: new Date().toISOString(), _error: (d && d.error) || ('HTTP ' + r.status) });
          localStorage.setItem(QUEUE_KEY + '_rejected', JSON.stringify(rejected.slice(-50)));
        } catch (e) { /* storage full — nothing more we can do */ }
      } else {
        remaining.push(sale); // signed out / rate-limited / server error — retry later
      }
    } catch (e) {
      remaining.push(sale); // network error — keep it to retry later
    }
  }

  // Persist only the sales that still need syncing, so synced sales are
  // cleared and failed ones are never silently dropped.
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  if (synced > 0) {
    window.dispatchEvent(new CustomEvent(OFFLINE_EVENT, { detail: { synced } }));
  }
  return { synced, failed: remaining.length };
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
