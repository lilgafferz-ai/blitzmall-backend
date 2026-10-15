/* BlitzMall push notifications service worker (web/PC only).
 *
 * Loads the config from /firebase-config.js. When the tab is closed or in the
 * background, the Firebase SDK shows the push as a system notification by
 * itself (the server always sends a `notification` block), so we only draw one
 * for data-only messages — drawing it again here would show it twice.
 */
importScripts('/firebase-config.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const cfg = (self.BLITZ_FIREBASE_CONFIG) || {};
if (cfg && cfg.apiKey && !firebase.apps.length) {
  firebase.initializeApp(cfg);
  firebase.messaging().onBackgroundMessage((payload) => {
    if (payload && payload.notification) return; // already shown by the SDK
    const data = (payload && payload.data) || {};
    if (!data.title && !data.body) return;
    self.registration.showNotification(data.title || 'BlitzMall', {
      body: data.body || '',
      icon: '/logo192.png',
      badge: '/favicon.ico',
      data
    });
  });
}

// Tapping a notification the page drew (foreground pushes) focuses the open
// BlitzMall tab, or opens one. The SDK handles taps on its own notifications.
self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  if (data.FCM_MSG) return;
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) return win.focus();
    return self.clients.openWindow('/');
  })());
});
