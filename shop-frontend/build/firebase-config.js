/* BlitzMall — Firebase config for web/PC push notifications.
 *
 * Paste your Firebase Web app's config here (Firebase console → Project settings
 * → Your apps → Web app → firebaseConfig), plus the VAPID key from
 * Project settings → Cloud Messaging → Web Push certificates.
 *
 * Until apiKey + vapidKey are filled in, web/PC push stays off. The Android app
 * is unaffected — it uses the native plugin + google-services.json instead.
 */
const BLITZ_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAgFr9nd1bcxGVCdyB_BFuEIBgo5cgQmRw',
  authDomain: 'blitzmall-0.firebaseapp.com',
  projectId: 'blitzmall-0',
  messagingSenderId: '253399944353',
  appId: '1:253399944353:web:bd5db707edfcadeef474e0',
  vapidKey: 'BA216clvwZ_Kj24WydOe7vieEjDNuWLzWseFTKzf9yHTWIiNUxfgJWTLBmpR2We-hwMIl-zW0rpJnd-i04cfJPg'
};
try { window.BLITZ_FIREBASE_CONFIG = BLITZ_FIREBASE_CONFIG; } catch (e) {}
try { self.BLITZ_FIREBASE_CONFIG = BLITZ_FIREBASE_CONFIG; } catch (e) {}
