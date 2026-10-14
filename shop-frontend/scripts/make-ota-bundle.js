/*
 * Packages the freshly built web app (build/) into an over-the-air update
 * bundle that the native app downloads on launch (self-hosted Capgo update).
 *
 * Runs automatically as part of `npm run build`. Output goes to ../ota/:
 *   - bundle-<version>.zip   the zipped contents of build/ (index.html at root)
 *   - latest.json            { version, fileName, appVersion, sha256, signature }
 *                            read by /api/native-update
 *
 * The version is derived from a hash of build/asset-manifest.json, so it changes
 * on every real code change and stays identical for an unchanged build.
 *
 * Integrity: sha256 is the zip's hash (the native updater refuses a download
 * that doesn't match it) and signature is an ECDSA P-256 signature over
 * otaSignedMessage() made with the private key from scripts/ota-keygen.js. The
 * app verifies it with the public key compiled into src/otaPublicKey.js before
 * downloading anything. No key → the build fails, unless OTA_ALLOW_UNSIGNED=1
 * (that bundle will then be refused by every signature-checking app).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const OUT_DIR = path.join(ROOT, 'ota');
const KEY_PATH = process.env.OTA_SIGNING_KEY || path.join(os.homedir(), '.blitzmall', 'ota-signing-key.pem');

// Must stay byte-identical to otaSignedMessage() in src/otaUpdate.js.
const otaSignedMessage = ({ version, appVersion, sha256 }) => `blitzmall-ota:v1\n${version}\n${appVersion}\n${sha256}`;

function signManifest(fields) {
  if (!fs.existsSync(KEY_PATH)) {
    if (process.env.OTA_ALLOW_UNSIGNED === '1') {
      console.warn('[ota] WARNING: no signing key — bundle is UNSIGNED and signature-checking apps will refuse it.');
      return null;
    }
    console.error(`[ota] No OTA signing key at ${KEY_PATH}.`);
    console.error('[ota] Run `node scripts/ota-keygen.js` once (or set OTA_SIGNING_KEY to the backed-up key file).');
    process.exit(1);
  }
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
  return crypto.sign('sha256', Buffer.from(otaSignedMessage(fields)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

async function main() {
  if (!fs.existsSync(BUILD_DIR)) {
    console.error('[ota] No build/ folder found — run the web build first.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Version = short hash of the asset manifest (changes whenever the build does)
  const manifestPath = path.join(BUILD_DIR, 'asset-manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath)
    : Buffer.from(String(Date.now()));
  const hash = crypto.createHash('sha256').update(manifest).digest('hex').slice(0, 10);
  const pkg = require(path.join(ROOT, 'package.json'));
  const version = `${pkg.version}-${hash}`;

  // Remove any previous bundle zips so only the current one is served
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.zip')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const fileName = `bundle-${version}.zip`;
  const zipPath = path.join(OUT_DIR, fileName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    // Zip the CONTENTS of build/ (index.html at the zip root, as the updater
    // requires), but EXCLUDE the bundled APK that CRA copies in from public/ —
    // the OTA bundle must stay small so it downloads fast on mobile data.
    archive.glob('**/*', { cwd: BUILD_DIR, dot: false, ignore: ['**/*.apk', '**/*.map'] });
    archive.finalize();
  });

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  const appVersion = pkg.version;
  const signature = signManifest({ version, appVersion, sha256 });
  fs.writeFileSync(
    path.join(OUT_DIR, 'latest.json'),
    JSON.stringify({ version, fileName, appVersion, sha256, signature }, null, 2)
  );
  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`[ota] Bundle ready: ${fileName} (${sizeKb} KB, version ${version}, ${signature ? 'signed' : 'UNSIGNED'})`);
}

main().catch((e) => { console.error('[ota] Failed:', e); process.exit(1); });
