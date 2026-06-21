const CACHE = 'blitzmall-v' + new Date().toISOString().slice(0, 10); // Daily versioning: blitzmall-v2026-06-05
const API_CACHE = 'blitzmall-api-v' + new Date().toISOString().slice(0, 10);
const SHELL_URLS = ['/', '/index.html'];

// Install: pre-cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

// Activate: purge ALL old caches (any cache not matching current date-version)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API, stale-while-revalidate for assets
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  // API requests: network-first, cache fallback
  if (request.url.includes('/api/')) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(API_CACHE).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || new Response(JSON.stringify({ error: 'Offline', offline: true }), { headers: { 'Content-Type': 'application/json' }, status: 503 })))
    );
    return;
  }

  // App shell & assets: network-first with cache fallback
  e.respondWith(
    fetch(request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(request, clone));
        return res;
      })
      .catch(() => caches.match(request))
  );
});
