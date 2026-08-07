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
  apiKey: '',
  authDomain: '',
  projectId: '',
  messagingSenderId: '',
  appId: '',
  vapidKey: ''
};
try { window.BLITZ_FIREBASE_CONFIG = BLITZ_FIREBASE_CONFIG; } catch (e) {}
try { self.BLITZ_FIREBASE_CONFIG = BLITZ_FIREBASE_CONFIG; } catch (e) {}
