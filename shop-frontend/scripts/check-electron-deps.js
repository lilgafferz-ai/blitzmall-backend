/*
 * Release guard for the PC app. electron-builder only packs "dependencies"
 * into app.asar (the web app is already bundled by webpack, so everything else
 * lives in devDependencies). If the Electron main process requires a package
 * that isn't a dependency, or the packaging config excludes node_modules, the
 * installed app dies at launch with "Cannot find module" (v0.1.61 shipped that
 * way for electron-updater). Run in CI before publishing.
 *
 *   node scripts/check-electron-deps.js
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies || {});
const problems = [];

const files = (pkg.build && pkg.build.files) || [];
if (files.some(f => /^!node_modules/.test(f))) problems.push('build.files excludes node_modules — runtime dependencies would not be packed');

for (const entry of ['main.js', 'preload.js', 'public/electron.js']) {
  const file = path.join(root, entry);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)) {
    const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
    if (name === 'electron' || builtinModules.includes(name) || name.startsWith('node:')) continue;
    if (!deps.includes(name)) problems.push(`${entry} requires "${name}", which is not in "dependencies"`);
  }
}

if (problems.length) {
  console.error('[check-electron-deps] The PC installer would be broken:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`[check-electron-deps] OK — Electron main process needs only: ${deps.join(', ') || '(nothing)'}`);
