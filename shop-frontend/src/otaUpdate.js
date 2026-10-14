// Signed over-the-air updates (native app only).
//
// /api/native-update describes the newest web bundle: { version, url,
// appVersion, sha256, signature }. Before downloading anything the app checks
// that the description was signed by the shop's OTA private key (the public
// half is compiled in, see scripts/ota-keygen.js), and that it isn't an older
// app version. The native updater then refuses the zip unless its SHA-256
// matches the signed hash. Net effect: only bundles built and signed on the
// owner's machine can ever run inside the app — a hacked server, a spoofed
// API URL or a tampered download can't push code to customers' phones.
import { OTA_PUBLIC_KEY_SPKI } from './otaPublicKey';
import { APP_VERSION } from './version.generated';

// Must stay byte-identical to otaSignedMessage() in scripts/make-ota-bundle.js.
export const otaSignedMessage = ({ version, appVersion, sha256 }) => `blitzmall-ota:v1\n${version}\n${appVersion}\n${sha256}`;

const b64ToBytes = (b64) => Uint8Array.from(atob(String(b64)), c => c.charCodeAt(0));

// '0.1.9' < '0.1.10' — numeric, part by part.
export const versionLess = (a, b) => {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
};

// Throws with a human-readable reason when the update must not be installed.
export async function verifyOtaManifest(latest, {
  publicKey = OTA_PUBLIC_KEY_SPKI,
  currentAppVersion = APP_VERSION,
  subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null
} = {}) {
  if (!latest || !latest.version || !latest.url) throw new Error('No update available');
  if (!/^[0-9a-f]{64}$/.test(latest.sha256 || '') || !latest.signature || !latest.appVersion) {
    throw new Error('Update is not signed — refusing to install it');
  }
  if (versionLess(latest.appVersion, currentAppVersion)) throw new Error('Update is older than this app — refusing to downgrade');
  if (!subtle) throw new Error('This device cannot verify updates');
  const key = await subtle.importKey('spki', b64ToBytes(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64ToBytes(latest.signature), new TextEncoder().encode(otaSignedMessage(latest))
  );
  if (!ok) throw new Error('Update signature is invalid — refusing to install it');
}

// Verify, then download with the signed hash so the native side checks the zip.
export async function downloadVerifiedBundle(CapacitorUpdater, latest) {
  await verifyOtaManifest(latest);
  return CapacitorUpdater.download({ url: latest.url, version: latest.version, checksum: latest.sha256 });
}
