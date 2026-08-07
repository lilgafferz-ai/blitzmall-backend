/* BlitzMall push notifications service worker (web/PC only).
 *
 * Loads the config from /firebase-config.js, then shows notification bubbles
 * for messages that arrive while the app/tab is in the background.
 */
importScripts('/firebase-config.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const cfg = (self.BLITZ_FIREBASE_CONFIG) || {};
if (cfg && cfg.apiKey && !firebase.apps.length) {
  firebase.initializeApp(cfg);
  firebase.messaging().onBackgroundMessage((payload) => {
    const title = (payload && payload.notification && payload.notification.title) || 'BlitzMall';
    const body = (payload && payload.notification && payload.notification.body) || '';
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      data: (payload && payload.data) || {}
    });
  });
}
