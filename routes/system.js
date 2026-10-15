// App/OTA update info, old-APK redirects and the health probe.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, SHOP_COORDS } = require('../lib/config');
const { col } = require('../lib/db');

const APK_DIR = path.join(ROOT, 'shop-frontend/downloads');
const OTA_LATEST = path.join(ROOT, 'shop-frontend/ota/latest.json');

// Newest downloadable APK. Picks by filename version first (blitzmall-v8.apk →
// 8), mtime second: on a fresh Render checkout every file shares the deploy
// mtime, so sorting by mtime alone could serve an OLD apk as "latest".
function latestApk() {
  const apks = fs.readdirSync(APK_DIR)
    .filter(f => f.toLowerCase().endsWith('.apk'))
    .map(f => {
      const m = f.match(/[vV](\d+)/);
      return { f, t: fs.statSync(path.join(APK_DIR, f)).mtimeMs, v: m ? parseInt(m[1], 10) : 0 };
    })
    .sort((a, b) => (b.v - a.v) || (b.t - a.t));
  return apks[0] || null;
}

// SHA-256 of the newest APK, so anyone sideloading it can check the download
// (published on the Share screen / /api/app-info). Cached per file + mtime.
let apkHashCache = { key: '', sha256: null };
function apkSha256(latest) {
  const key = `${latest.f}:${latest.t}`;
  if (apkHashCache.key !== key) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(APK_DIR, latest.f))).digest('hex');
    apkHashCache = { key, sha256 };
  }
  return apkHashCache.sha256;
}

const APP_VERSION = (() => {
  try { return require(path.join(ROOT, 'shop-frontend/package.json')).version; } catch (e) { return 'unknown'; }
})();
const otaVersion = () => {
  try { return JSON.parse(fs.readFileSync(OTA_LATEST, 'utf8')).version || null; } catch (e) { return null; }
};

module.exports = function register(app) {
  // Reports the newest downloadable APK so the in-app Share/QR screen always
  // links to the latest build automatically — drop a new blitzmall-vN.apk into
  // shop-frontend/downloads/ on release and the app picks it up.
  app.get('/api/app-info', (req, res) => {
    try {
      const latest = latestApk();
      if (!latest) return res.json({ apkUrl: null });
      const base = `${req.protocol}://${req.get('host')}`;
      res.json({
        apkUrl: `${base}/apk/${encodeURIComponent(latest.f)}`,
        fileName: latest.f,
        version: new Date(latest.t).toISOString().slice(0, 10),
        sha256: apkSha256(latest),
      });
    } catch (e) {
      console.error('app-info error:', e);
      res.json({ apkUrl: null });
    }
  });

  // Old APK links (shared invites pointed at blitzmall-v3.apk, the README at
  // v7…) keep working after old builds are removed: any APK that no longer
  // exists redirects to the newest one. Existing files are served by the
  // static /apk middleware before this route is reached.
  app.get('/apk/:file', (req, res, next) => {
    try {
      if (!/\.apk$/i.test(req.params.file)) return next();
      const latest = latestApk();
      if (!latest) return next();
      res.redirect(302, `/apk/${encodeURIComponent(latest.f)}`);
    } catch (e) { next(); }
  });

  // Reports the newest over-the-air web bundle for the native app. The mobile app
  // calls this on launch; if the version differs from what it's running, it
  // downloads the bundle and applies it on the next reopen. The bundle + its
  // latest.json are produced by `npm run build` (see scripts/make-ota-bundle.js).
  // The app installs it only if `signature` verifies against the public key
  // compiled into it and the zip matches `sha256` (src/otaUpdate.js) — this
  // endpoint just relays what the signed build wrote.
  app.get('/api/native-update', (req, res) => {
    try {
      if (!fs.existsSync(OTA_LATEST)) return res.json({ version: null });
      const info = JSON.parse(fs.readFileSync(OTA_LATEST, 'utf8'));
      if (!info.fileName || !info.version) return res.json({ version: null });
      const base = `${req.protocol}://${req.get('host')}`;
      res.json({
        version: info.version,
        url: `${base}/updates/${encodeURIComponent(info.fileName)}`,
        appVersion: info.appVersion || null,
        sha256: info.sha256 || null,
        signature: info.signature || null
      });
    } catch (e) {
      console.error('native-update error:', e);
      res.json({ version: null });
    }
  });

  // Public shop contact for the apps' Help & support screens. Set SHOP_PHONE /
  // SHOP_WHATSAPP / SHOP_LOCATION on the server, or the first active branch's
  // phone and location are used. Nothing is shown when no number is known.
  app.get('/api/shop-info', async (req, res) => {
    try {
      let branch = null;
      try { branch = await col.branches.findOne({ active: true }); } catch (e) { branch = null; }
      const phone = process.env.SHOP_PHONE || (branch && branch.phone) || '';
      res.json({
        name: process.env.SHOP_NAME || 'Blitz Mall',
        phone,
        whatsapp: process.env.SHOP_WHATSAPP || phone,
        location: process.env.SHOP_LOCATION || (branch && branch.location) || 'Matunda, Kakamega',
        coords: SHOP_COORDS
      });
    } catch (e) {
      console.error('shop-info error:', e);
      res.json({ name: 'Blitz Mall', phone: '', whatsapp: '', location: 'Matunda, Kakamega', coords: SHOP_COORDS });
    }
  });

  // Health/version probe: confirms which build is actually live after a deploy
  // (`curl /api/health`). Render sets RENDER_GIT_COMMIT on every deploy.
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      version: APP_VERSION,
      bundle: otaVersion(),
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      db: col.db && typeof col.db.collection('orders').createIndex === 'function' ? 'mongodb' : 'offline-file',
      // SMS sign-in config (no secrets) — so we can see whether real codes can be
      // delivered. screenFallback:true means the code is shown on screen when SMS
      // fails (insecure — anyone can sign in); it should be false in production.
      sms: {
        configured: !!(process.env.AT_USERNAME && process.env.AT_API_KEY),
        senderId: !!process.env.AT_SENDER_ID,
        screenFallback: String(process.env.OTP_SCREEN_FALLBACK || 'true').trim().toLowerCase() !== 'false'
      },
      time: new Date().toISOString()
    });
  });
};
