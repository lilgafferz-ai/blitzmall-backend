// Real OS-level push notifications (the kind other apps send), shared by the
// customer app and the admin/staff app.
//
// Android app: Capacitor push plugin → FCM token. Pushes that arrive while the
// app is open are still shown as a system banner (capacitor.config sets
// PushNotifications.presentationOptions), and tapping one opens the app.
// Browser / PWA: Firebase JS SDK + /firebase-messaging-sw.js → FCM web token.
//
// getPushToken() returns a real token, or null with a reason — never a fake
// token, so the server only stores tokens FCM can actually deliver to.

export const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const pushPlatform = () => (isNativeApp() ? 'android' : (/electron/i.test(navigator.userAgent || '') ? 'pc' : 'web'));

// Importance 4 = HIGH: heads-up banner + the phone's default notification
// sound (leave `sound` unset — the plugin treats it as a res/raw file name).
const CHANNEL = { id: 'blitzmall_alerts', name: 'BlitzMall Alerts', description: 'Orders, payments and offers', importance: 4, visibility: 1, vibration: true };

let webApp = null;
let webSwReg = null;
let nativeListenersAdded = false;
let webListenerAdded = false;
const tapHandlers = new Set();

// Has the user already been asked (and said yes)? Lets callers refresh the
// token silently on launch without ever popping a permission prompt.
export async function pushPermission() {
  try {
    if (isNativeApp()) {
      const { PushNotifications } = await import('@capacitor/push-notifications');
      const p = await PushNotifications.checkPermissions();
      return p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'prompt';
    }
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission === 'default' ? 'prompt' : Notification.permission;
  } catch (e) { return 'unsupported'; }
}

// Called when the user taps a notification: receives the push's data object
// (e.g. { screen: 'orders' }). Returns an unsubscribe function.
export function onPushTap(fn) {
  tapHandlers.add(fn);
  return () => tapHandlers.delete(fn);
}
const fireTap = (data) => tapHandlers.forEach(fn => { try { fn(data || {}); } catch (e) {} });

async function nativeToken({ prompt }) {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive !== 'granted') {
    if (!prompt || perm.receive === 'denied') return { token: null, reason: perm.receive === 'denied' ? 'denied' : 'not_asked' };
    perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return { token: null, reason: 'denied' };
  }
  // Create the channel BEFORE registering so the very first push already lands
  // in it (heads-up banner + sound), not in Android's silent default channel.
  try { await PushNotifications.createChannel(CHANNEL); } catch (e) {}
  if (!nativeListenersAdded) {
    nativeListenersAdded = true;
    PushNotifications.addListener('pushNotificationActionPerformed', (a) => fireTap(a && a.notification && a.notification.data));
  }
  const token = await new Promise(resolve => {
    const subs = [];
    let done = false;
    const finish = (t) => {
      if (done) return; done = true;
      subs.forEach(s => Promise.resolve(s).then(h => h && h.remove && h.remove()).catch(() => {}));
      resolve(t);
    };
    subs.push(PushNotifications.addListener('registration', (r) => finish(r && r.value)));
    subs.push(PushNotifications.addListener('registrationError', () => finish(null)));
    setTimeout(() => finish(null), 15000);
    PushNotifications.register().catch(() => finish(null));
  });
  return token ? { token } : { token: null, reason: 'error' };
}

async function webToken({ prompt }) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return { token: null, reason: 'unsupported' };
  if (Notification.permission === 'denied') return { token: null, reason: 'denied' };
  if (Notification.permission !== 'granted') {
    if (!prompt) return { token: null, reason: 'not_asked' };
    const p = await Notification.requestPermission();
    if (p !== 'granted') return { token: null, reason: 'denied' };
  }
  const cfg = window.BLITZ_FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !cfg.vapidKey) return { token: null, reason: 'not_configured' };
  const { initializeApp, getApps } = await import('firebase/app');
  const { getMessaging, getToken, onMessage, isSupported } = await import('firebase/messaging');
  if (isSupported && !(await isSupported())) return { token: null, reason: 'unsupported' };
  if (!webApp) {
    webApp = getApps().find(a => a.name === 'blitzmallWeb') || initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId }, 'blitzmallWeb');
  }
  const messaging = getMessaging(webApp);
  if (!webSwReg) webSwReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const token = await getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: webSwReg });
  if (!webListenerAdded) {
    webListenerAdded = true;
    // Tab is open and focused: FCM hands the message to the page instead of
    // the service worker, so show the system notification ourselves.
    onMessage(messaging, (payload) => {
      const n = (payload && payload.notification) || {};
      try {
        webSwReg.showNotification(n.title || 'BlitzMall', { body: n.body || '', icon: '/logo192.png', badge: '/favicon.ico', data: (payload && payload.data) || {} });
      } catch (e) {}
    });
  }
  return token ? { token } : { token: null, reason: 'error' };
}

// prompt=false refreshes silently (only if permission was already granted).
export async function getPushToken({ prompt = true } = {}) {
  try {
    return isNativeApp() ? await nativeToken({ prompt }) : await webToken({ prompt });
  } catch (e) {
    console.warn('Push registration failed:', e);
    return { token: null, reason: 'error' };
  }
}
