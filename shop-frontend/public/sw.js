// BlitzMall service worker
// Goal: instant launch on every device + automatic offline mode, while always
// preferring the live online server when a connection is available.
//
//  • App shell / page loads  -> network-first (latest build on reopen, cache if offline)
//  • API GET requests        -> network-first (fresh data, last-known data if offline)
//  • Hashed JS/CSS/images     -> stale-while-revalidate (served instantly, refreshed in bg)
//
// A short network timeout means slow/low-end connections fall back to cache
// quickly instead of hanging on a blank screen.

const BUILD = 'blitzmall-v' + new Date().toISOString().slice(0, 10); // daily cache bust
const SHELL = BUILD + '-shell';
const ASSETS = BUILD + '-assets';
const API_CACHE = BUILD + '-api';
const SHELL_URLS = ['/', '/index.html', '/manifest.json'];
const NET_TIMEOUT = 3500; // ms before falling back to cache on a slow network

// Install: pre-cache the core app shell so the very first offline open works.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

// Activate: drop any caches from previous builds, then take control immediately.
self.addEventListener('activate', (e) => {
  const keep = [SHELL, ASSETS, API_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const offlineJson = () => new Response(
  JSON.stringify({ error: 'Offline', offline: true }),
  { headers: { 'Content-Type': 'application/json' }, status: 503 }
);

// Try the network first; if it is slow, serve the cached copy after a timeout;
// if it fails entirely, serve cache (or the provided fallback).
const networkFirst = (request, cacheName, fallback) => {
  const fromNetwork = fetch(request).then((res) => {
    const clone = res.clone();
    caches.open(cacheName).then((c) => c.put(request, clone)).catch(() => {});
    return res;
  });
  const cacheOnTimeout = new Promise((resolve) => {
    setTimeout(() => caches.match(request).then((c) => { if (c) resolve(c); }), NET_TIMEOUT);
  });
  return Promise.race([fromNetwork, cacheOnTimeout])
    .catch(() => caches.match(request).then((c) => c || (fallback ? fallback() : Response.error())));
};

// Serve cache immediately (fast), update the cache in the background.
const staleWhileRevalidate = (request, cacheName) =>
  caches.match(request).then((cached) => {
    const network = fetch(request).then((res) => {
      const clone = res.clone();
      caches.open(cacheName).then((c) => c.put(request, clone)).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  });

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  // API: always go to the live server first, fall back to the last response.
  if (url.pathname.includes('/api/')) {
    e.respondWith(networkFirst(request, API_CACHE, offlineJson));
    return;
  }

  // Page loads / navigations: network-first so reopening shows the newest build.
  if (request.mode === 'navigate' || SHELL_URLS.includes(url.pathname)) {
    e.respondWith(networkFirst(request, SHELL, () =>
      caches.match('/index.html').then((c) => c || caches.match('/'))
    ));
    return;
  }

  // Everything else (hashed bundles, images, fonts): instant cache + bg refresh.
  e.respondWith(staleWhileRevalidate(request, ASSETS));
});
