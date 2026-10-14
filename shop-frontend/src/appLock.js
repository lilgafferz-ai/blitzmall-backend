// App-lock helpers (M-Pesa-style fingerprint / PIN gate).
//
// Design:
//  - The PIN path is PURE JS (localStorage + Web Crypto) so it ships to every
//    existing install over-the-air (OTA) with no reinstall.
//  - Fingerprint uses the native @capgo/capacitor-native-biometric plugin and is
//    FEATURE-DETECTED at runtime: it only activates on a native APK that actually
//    bundled the plugin. On web, the PC app, or an older APK it is simply absent
//    and the gate falls back to the PIN. So the same JS works everywhere.
//  - The lock is a device-convenience gate. The real security boundary stays the
//    server-side OTP / customer token; a rooted device can bypass a local lock.
import { Capacitor } from '@capacitor/core';

const LOCK_KEY = 'blitz_app_lock'; // { enabled:true, biometric:bool }
const PIN_KEY = 'blitz_app_pin';   // { salt, hash, v }

export const isNativeApp = () => {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  catch { return false; }
};

// ---- lock config + PIN storage ----
export function getLockConfig() { try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || null; } catch { return null; } }
export function setLockConfig(cfg) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(cfg || {})); } catch {} }
export function isLockEnabled() { const c = getLockConfig(); return !!(c && c.enabled); }
export function hasPin() { try { const p = JSON.parse(localStorage.getItem(PIN_KEY)); return !!(p && p.hash); } catch { return false; } }
export function disableLock() { try { localStorage.removeItem(LOCK_KEY); localStorage.removeItem(PIN_KEY); } catch {} }

function toHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(str) {
  try {
    if (window.crypto && window.crypto.subtle) {
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return toHex(digest);
    }
  } catch {}
  // Fallback for a non-secure context (crypto.subtle unavailable): still salted,
  // still never stores the raw PIN.
  let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return 'f' + h.toString(16);
}
function randomSalt() {
  try { const a = new Uint8Array(16); window.crypto.getRandomValues(a); return toHex(a.buffer); }
  catch { return String(Date.now()) + Math.random().toString(16).slice(2); }
}
export async function setPin(pin) {
  const salt = randomSalt();
  const hash = await sha256Hex(salt + '|' + pin);
  try { localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash, v: 1 })); } catch {}
}
export async function verifyPin(pin) {
  let rec; try { rec = JSON.parse(localStorage.getItem(PIN_KEY)); } catch { rec = null; }
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = await sha256Hex(rec.salt + '|' + pin);
  return h === rec.hash;
}

// ---- biometric (native, feature-detected) ----
export function biometricPluginPresent() {
  try { return isNativeApp() && !!Capacitor.isPluginAvailable && Capacitor.isPluginAvailable('NativeBiometric'); }
  catch { return false; }
}
// Returns { usable, isFingerprint, deviceIsSecure }. isFingerprint is what gates
// "fingerprint phones use biometrics; everyone else uses the PIN".
export async function biometricCapability() {
  if (!biometricPluginPresent()) return { usable: false, isFingerprint: false, deviceIsSecure: false };
  try {
    const mod = await import('@capgo/capacitor-native-biometric');
    const NativeBiometric = mod.NativeBiometric;
    const BiometryType = mod.BiometryType || {};
    const r = await NativeBiometric.isAvailable({ useFallback: false }).catch(() => null);
    if (!r) return { usable: false, isFingerprint: false, deviceIsSecure: false };
    const FP = BiometryType.FINGERPRINT !== undefined ? BiometryType.FINGERPRINT : 3;
    const MULTI = BiometryType.MULTIPLE !== undefined ? BiometryType.MULTIPLE : 6;
    const isFingerprint = !!r.isAvailable && (r.biometryType === FP || r.biometryType === MULTI);
    return { usable: !!r.isAvailable, isFingerprint, deviceIsSecure: !!r.deviceIsSecure };
  } catch { return { usable: false, isFingerprint: false, deviceIsSecure: false }; }
}
export async function biometricVerify() {
  if (!biometricPluginPresent()) return false;
  try {
    const mod = await import('@capgo/capacitor-native-biometric');
    await mod.NativeBiometric.verifyIdentity({
      reason: 'Unlock BlitzMall',
      title: 'Unlock BlitzMall',
      subtitle: 'Confirm your fingerprint',
      description: '',
      useFallback: false,
      maxAttempts: 5,
    });
    return true; // verifyIdentity resolves on success, rejects on fail/cancel
  } catch { return false; }
}

// ---- background detection: fire cb() the moment the app leaves the foreground ----
// Native Android: @capacitor/app appStateChange is bound to the Activity
// lifecycle (reliable). Web/PWA/old-APK: visibilitychange + pagehide fallback.
export function onAppBackground(cb) {
  const cleanups = [];
  if (isNativeApp()) {
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', (st) => { if (st && st.isActive === false) cb('appstate'); })
        .then(h => cleanups.push(() => { try { h.remove(); } catch {} }))
        .catch(() => {});
    }).catch(() => {});
  }
  const onVis = () => { try { if (document.hidden) cb('visibility'); } catch {} };
  const onHide = () => cb('pagehide');
  try { document.addEventListener('visibilitychange', onVis); } catch {}
  try { window.addEventListener('pagehide', onHide); } catch {}
  cleanups.push(() => { try { document.removeEventListener('visibilitychange', onVis); } catch {} });
  cleanups.push(() => { try { window.removeEventListener('pagehide', onHide); } catch {} });
  return () => cleanups.forEach(fn => { try { fn(); } catch {} });
}
