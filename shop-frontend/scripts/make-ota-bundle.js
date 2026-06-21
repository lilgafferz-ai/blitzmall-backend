/*
 * Packages the freshly built web app (build/) into an over-the-air update
 * bundle that the native app downloads on launch (self-hosted Capgo update).
 *
 * Runs automatically as part of `npm run build`. Output goes to ../ota/:
 *   - bundle-<version>.zip   the zipped contents of build/ (index.html at root)
 *   - latest.json            { version, fileName } read by /api/native-update
 *
 * The version is derived from a hash of build/asset-manifest.json, so it changes
 * on every real code change and stays identical for an unchanged build.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const OUT_DIR = path.join(ROOT, 'ota');

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

  fs.writeFileSync(
    path.join(OUT_DIR, 'latest.json'),
    JSON.stringify({ version, fileName }, null, 2)
  );
  const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
  console.log(`[ota] Bundle ready: ${fileName} (${sizeKb} KB, version ${version})`);
}

main().catch((e) => { console.error('[ota] Failed:', e); process.exit(1); });
