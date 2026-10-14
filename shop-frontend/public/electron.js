const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Set the application name and App User Model ID for proper Windows taskbar grouping and branding
app.name = "BlitzMall";
if (process.platform === 'win32') {
  app.setAppUserModelId("com.blitzmall.app");
}

// ===== Path resolution =====
// This file is BOTH the repo's entry point (package.json "main": "main.js")
// AND the shipped desktop entry point: electron-builder auto-applies its
// create-react-app preset, which rewrites the packaged "main" to
// "build/electron.js" — and react-scripts copies public/electron.js into
// build/electron.js during `npm run build`. So the SAME code must run
// correctly from two different __dirname locations:
//   1) repo root          -> ./build/index.html, ./preload.js
//   2) app.asar/build/    -> ./index.html,       ../preload.js
const runningFromBuild = fs.existsSync(path.join(__dirname, 'index.html'))
  && !fs.existsSync(path.join(__dirname, 'build'));
const APP_ROOT  = runningFromBuild ? path.join(__dirname, '..') : __dirname;
const BUILD_DIR = runningFromBuild ? __dirname : path.join(__dirname, 'build');

const indexHtmlPath = path.join(BUILD_DIR, 'index.html');
const preloadPath = path.join(APP_ROOT, 'preload.js');
const iconPath = fs.existsSync(path.join(BUILD_DIR, 'app-icon.ico'))
  ? path.join(BUILD_DIR, 'app-icon.ico')
  : path.join(APP_ROOT, 'public', 'app-icon.ico');

// ===== Window state (size, position, maximized) remembered between launches =====
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch (e) { return {}; }
}
function trackWindowState(win) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (win.isDestroyed()) return;
        const state = { ...(win.isMaximized() ? loadWindowState() : win.getBounds()), maximized: win.isMaximized() };
        fs.writeFileSync(windowStatePath(), JSON.stringify(state));
      } catch (e) { /* never block the app on this */ }
    }, 400);
  };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach(ev => win.on(ev, save));
}

// ===== Desktop preferences (Settings → Desktop app, and the tray menu) =====
const DEFAULT_PREFS = { closeToTray: true };
const prefsPath = () => path.join(app.getPath('userData'), 'desktop-settings.json');
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) }; } catch (e) { return { ...DEFAULT_PREFS }; }
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try { fs.writeFileSync(prefsPath(), JSON.stringify(next)); } catch (e) { /* never block the app on this */ }
  return next;
}

// A silent update installed while the app sat in the tray relaunches it
// hidden again (this flag file survives the installer), so a background
// update never pops a window up in the cashier's face.
const hiddenRelaunchFlag = () => path.join(app.getPath('userData'), 'relaunch-hidden.flag');
function consumeHiddenRelaunch() {
  try { fs.unlinkSync(hiddenRelaunchFlag()); return true; } catch (e) { return false; }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateDownloaded = false;
let trayHintShown = false;
// Assigned once the updater is set up (inside app.whenReady).
let installUpdateNow = () => false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Right-click menu: Electron ships none, so without this there is no
// copy / paste / spelling fix anywhere in the app.
function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const template = [];
    const flags = params.editFlags || {};
    if (params.misspelledWord) {
      for (const word of (params.dictionarySuggestions || []).slice(0, 5)) {
        template.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
      }
      if (!template.length) template.push({ label: 'No spelling suggestions', enabled: false });
      template.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      template.push({ type: 'separator' });
    }
    if (params.isEditable) {
      template.push(
        { label: 'Undo', role: 'undo', enabled: !!flags.canUndo },
        { label: 'Redo', role: 'redo', enabled: !!flags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: !!flags.canCut },
        { label: 'Copy', role: 'copy', enabled: !!flags.canCopy },
        { label: 'Paste', role: 'paste', enabled: !!flags.canPaste },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll' }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ label: 'Copy', role: 'copy' });
    }
    if (params.linkURL && /^(https?:|mailto:|tel:)/i.test(params.linkURL)) {
      if (template.length) template.push({ type: 'separator' });
      template.push(
        { label: 'Open link in browser', click: () => shell.openExternal(params.linkURL).catch(() => {}) },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) }
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy image', click: () => win.webContents.copyImageAt(params.x, params.y) });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function createWindow({ hidden = false } = {}) {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    ...(Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1024,
    minHeight: 720,
    title: "Blitz Mall HQ v" + app.getVersion(),
    icon: iconPath,
    show: false,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Safe bridge for the in-app "Check for Updates" button (Settings →
      // App Updates) — exposes only the auto-updater, nothing else.
      preload: preloadPath
    }
  });

  win.setMenuBarVisibility(false);
  mainWindow = win;
  if (saved.maximized) win.maximize();
  trackWindowState(win);
  attachContextMenu(win);

  // Closing the window keeps BlitzMall running in the system tray (unless
  // turned off in Settings), so new-order and stock alerts keep arriving.
  win.on('close', (event) => {
    if (isQuitting || !tray || !loadPrefs().closeToTray) return;
    event.preventDefault();
    win.hide();
    // A downloaded update applies now, quietly, while nobody is looking.
    if (updateDownloaded) { installUpdateNow({ hidden: true }); return; }
    if (!trayHintShown) {
      trayHintShown = true;
      showNativeToast('BlitzMall is still running', 'Alerts keep coming in. Right-click the tray icon and choose Quit to close it completely.', { silent: true });
    }
  });
  win.on('focus', () => { try { win.flashFrame(false); } catch (e) {} });
  // Windows logging off / shutting down: let the window close for real.
  win.on('query-session-end', () => { isQuitting = true; });
  win.on('session-end', () => { isQuitting = true; });

  // Links meant for the outside world (WhatsApp, maps, phone, GitHub
  // downloads) open in the user's real browser/app — never inside the shop window.
  const isExternal = (url) => /^(https?:|mailto:|tel:)/i.test(url) && !url.startsWith('file:');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) { event.preventDefault(); shell.openExternal(url).catch(() => {}); }
  });

  // Branded loading splash while React boots up
  win.webContents.on('did-start-loading', () => {
    win.webContents.insertCSS(`
      #electron-splash {
        position: fixed; inset: 0; z-index: 99999;
        background: radial-gradient(circle at 50% 40%, #1a1206 0%, #0a0a0c 60%);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        font-family: 'Segoe UI', system-ui, sans-serif;
        transition: opacity 0.5s ease;
      }
      #electron-splash .logo-glow {
        width: 260px; height: 260px; border-radius: 50%;
        background: radial-gradient(circle, rgba(255,122,26,.3), transparent 70%);
        position: absolute; filter: blur(40px);
        animation: splashPulse 2.4s ease-in-out infinite;
      }
      #electron-splash img {
        width: 120px; height: 120px; position: relative;
        filter: drop-shadow(0 0 30px rgba(255,170,0,.5));
        animation: splashFloat 2.8s ease-in-out infinite;
      }
      #electron-splash h1 {
        margin-top: 18px; font-weight: 800; font-size: 2.2rem;
        letter-spacing: 2px; position: relative;
        background: linear-gradient(135deg, #ff7a1a 0%, #ffb800 50%, #ff7a1a 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      #electron-splash h1 span { font-weight: 400; }
      #electron-splash p {
        color: #666; margin-top: 6px; font-size: 0.85rem;
        letter-spacing: 1px; position: relative;
      }
      #electron-splash .loader {
        margin-top: 32px; width: 44px; height: 44px;
        border: 3px solid rgba(255,170,0,.15); border-top-color: #ffaa00;
        border-radius: 50%; position: relative;
        animation: splashSpin 0.8s linear infinite;
      }
      @keyframes splashPulse { 0%,100%{transform:scale(1);opacity:.7} 50%{transform:scale(1.15);opacity:1} }
      @keyframes splashFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
      @keyframes splashSpin { to{transform:rotate(360deg)} }
    `);
  });

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(`
      if (!document.getElementById('electron-splash')) {
        const splash = document.createElement('div');
        splash.id = 'electron-splash';
        splash.innerHTML = \`
          <div class="logo-glow"></div>
          <img src="./app-icon.png" alt="BlitzMall" />
          <h1>BLITZ<span>MALL</span></h1>
          <p>Loading your store...</p>
          <div class="loader"></div>
        \`;
        document.body.prepend(splash);
      }
    `);
  });

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents.executeJavaScript(`
        const splash = document.getElementById('electron-splash');
        if (splash) {
          splash.style.opacity = '0';
          setTimeout(() => splash.remove(), 500);
        }
      `);
    }, 800);
  });

  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });

  win.loadFile(indexHtmlPath).catch((err) => {
    console.error("Failed to load index.html. Make sure the React app is built first.", err);
  });
}

// One running copy only: launching the app again just brings the open window
// to the front (two copies would double every notification and sale prompt).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return; // a second copy — it is quitting
  createWindow({ hidden: consumeHiddenRelaunch() });

  // Harden the auto-updater. Two gotchas fixed here:
  //  1) checkForUpdatesAndNotify() fails silently on network errors or GitHub
  //     API rate-limit 403s (which burn the hourly quota), so we ALWAYS
  //     re-schedule the next check — success or failure — instead of only
  //     retrying on error. Previously a successful "no update" check meant the
  //     app never looked again until a full restart, which is exactly why the
  //     PC app sat on an old build while newer releases were already live.
  //  2) Log the current version + every updater event so a stuck install can
  //     be diagnosed from the log file.
  console.log('[updater] BlitzMall desktop version:', app.getVersion());
  const CHECK_INTERVAL_MS = 10 * 60 * 1000; // re-check every 10 min

  // ===== FULLY HANDS-OFF UPDATES =====
  // Updates download SILENTLY in the background and apply AUTOMATICALLY when
  // the user quits the app — no dialog to miss, no manual installer to run,
  // ever. (autoInstallOnAppQuit is what makes closing the app apply the new
  // version; autoDownload starts the background download the moment an update
  // is found.)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Use the direct GitHub release-download feed (a plain file URL served from
  // the release assets) instead of the api.github.com JSON API. The API is
  // rate-limited to 60 req/hr per IP and can fail silently — the raw file URL
  // is a static CDN download that is never throttled. This is the same URL we
  // already use for the guaranteed "Download New Version" fallback.
  const GITHUB_REPO = 'lilgafferz-ai/blitzmall-backend';
  const GITHUB_DL_FEED = `https://github.com/${GITHUB_REPO}/releases/latest/download`;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: GITHUB_DL_FEED });
    console.log('[updater] feed switched to direct release-download URL (no API rate limits)');
  } catch (e) {
    console.error('[updater] setFeedURL failed (will keep packaged app-update.yml):', e && e.message);
  }

  // Stream updater events to the renderer so the in-app "Check for Updates"
  // button (Settings → App Updates) shows real status instead of a silent
  // background check that gives the user no feedback. Every event is ALSO
  // appended to a log file so a stuck install can be diagnosed afterwards:
  //   %APPDATA%\BlitzMall\logs\updater.log
  const updaterLogPath = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
  const logUpdater = (line) => {
    try {
      const fs = require('fs');
      const p = updaterLogPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
    } catch (e) { /* logging must never break the updater */ }
  };
  logUpdater(`app start, installed version v${app.getVersion()}, feed=${GITHUB_DL_FEED}`);
  const broadcastUpdaterStatus = (status) => {
    logUpdater(`event: ${status.status}${status.newVersion ? ' (new ' + status.newVersion + ')' : ''}${status.message ? ' — ' + status.message : ''}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('updater:status', { ...status, version: app.getVersion() });
    }
  };
  autoUpdater.on('error', (err) => { console.error('[updater] Auto-updater error:', err && err.message); broadcastUpdaterStatus({ status: 'error', message: err && err.message }); });
  autoUpdater.on('checking-for-update', () => broadcastUpdaterStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => { console.log('[updater] Update found:', info && info.version); broadcastUpdaterStatus({ status: 'available', newVersion: info && info.version }); });
  autoUpdater.on('update-not-available', () => { console.log('[updater] Already up to date'); broadcastUpdaterStatus({ status: 'up-to-date' }); });
  autoUpdater.on('download-progress', (p) => {
    if (p && (p.percent % 25 < 2)) console.log('[updater] Download progress:', Math.round(p.percent) + '%');
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    broadcastUpdaterStatus({ status: 'downloaded', newVersion: info && info.version });
    // Window tucked away in the tray? Nobody is mid-sale — apply it right now.
    if (tray && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      setTimeout(() => installUpdateNow({ hidden: true }), 5000);
      return;
    }
    // Non-intrusive toast: the update applies on quit regardless (see
    // autoInstallOnAppQuit above), so no modal blocks the user's work.
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        new Notification({
          title: 'BlitzMall update ready',
          body: `v${info.version} downloaded — the app will restart itself to finish updating.`,
          silent: true
        }).show();
      }
    } catch (e) {}
  });

  // Belt-and-suspenders update source: read the raw `latest.yml` asset from
  // the GitHub release (a plain file download — NO api.github.com rate limits
  // and no JSON API at all), so we ALWAYS know the newest published version
  // even if the electron-updater API check is being throttled or fails.
  const LATEST_YML_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.yml`;
  const fetchLatestReleaseInfo = async () => {
    try {
      // Hard 10s timeout so a stalled network can never hang the IPC call.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(LATEST_YML_URL, { redirect: 'follow', headers: { Accept: 'text/plain' }, signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const txt = await r.text();
        const ver = (txt.match(/^version:\s*(\S+)/m) || [])[1];
        const file = (txt.match(/^path:\s*(\S+)/m) || [])[1];
        if (!ver || !file) throw new Error('unparseable latest.yml');
        return {
          version: ver,
          fileName: file,
          downloadUrl: `https://github.com/${GITHUB_REPO}/releases/latest/download/${encodeURIComponent(file)}`
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { error: (e && e.message) || 'failed' };
    }
  };

  const checkForUpdates = () => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .then(() => console.log('[updater] Update check finished (next in 10 min)'))
      .catch((err) => {
        console.error('[updater] Update check failed:', err && err.message);
        // Surface the failure in the UI too — never fail silently.
        broadcastUpdaterStatus({ status: 'error', message: (err && err.message) || 'update check failed' });
      })
      .finally(() => setTimeout(checkForUpdates, CHECK_INTERVAL_MS));
  };
  // Give the window a moment to boot before hitting the update server
  setTimeout(checkForUpdates, 10 * 1000);

  // In-app "Check for Updates" — invoked from Settings → App Updates. Runs the
  // same updater; events flow back through broadcastUpdaterStatus().
  let manualCheckInFlight = false;
  ipcMain.handle('updater:check', async () => {
    if (manualCheckInFlight) return { version: app.getVersion(), status: 'checking' };
    manualCheckInFlight = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      console.error('[updater] manual check failed:', e && e.message);
      broadcastUpdaterStatus({ status: 'error', message: e && e.message });
    } finally {
      manualCheckInFlight = false;
    }
    return { version: app.getVersion() };
  });

  // Raw latest.yml lookup — guaranteed path that never depends on the GitHub
  // API or electron-updater: returns the newest published version + a direct
  // installer download URL for the "Download new version" fallback button.
  ipcMain.handle('updater:latest', async () => {
    const info = await fetchLatestReleaseInfo();
    return { currentVersion: app.getVersion(), ...info };
  });

  // Open the newest installer in the default browser (guaranteed download).
  // Defense-in-depth: only ever open our own GitHub release URLs.
  ipcMain.handle('updater:openDownload', async (_evt, url) => {
    const githubHost = `https://github.com/${GITHUB_REPO}`;
    const target = typeof url === 'string' && url.startsWith(githubHost)
      ? url
      : `${githubHost}/releases/latest`;
    await shell.openExternal(target);
    return { ok: true };
  });

  // Apply a downloaded update right now (the "Restart to update" button).
  // Apply the downloaded update NOW: silent install + force relaunch, so the
  // app swaps itself to the new build without the user running anything.
  // ===== Settings bridge (preload: window.blitzDesktop) =====
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron
  }));
  ipcMain.handle('app:getOpenAtLogin', async () => {
    try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
  });
  ipcMain.handle('app:setOpenAtLogin', async (_evt, on) => {
    try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { /* unsupported platform */ }
    refreshTrayMenu();
    try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
  });
  ipcMain.handle('app:getCloseToTray', async () => !!loadPrefs().closeToTray);
  ipcMain.handle('app:setCloseToTray', async (_evt, on) => {
    const prefs = savePrefs({ closeToTray: !!on });
    refreshTrayMenu();
    return !!prefs.closeToTray;
  });

  // ===== System tray =====
  const isOpenAtLogin = () => { try { return !!app.getLoginItemSettings().openAtLogin; } catch (e) { return false; } };
  function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open BlitzMall', click: showMainWindow },
      { label: 'Check for updates', click: () => { showMainWindow(); autoUpdater.checkForUpdates().catch(() => {}); } },
      { type: 'separator' },
      { label: 'Keep running when closed', type: 'checkbox', checked: !!loadPrefs().closeToTray,
        click: (item) => { savePrefs({ closeToTray: item.checked }); } },
      { label: 'Open when Windows starts', type: 'checkbox', checked: isOpenAtLogin(),
        click: (item) => { try { app.setLoginItemSettings({ openAtLogin: item.checked }); } catch (e) {} } },
      { type: 'separator' },
      { label: 'Quit BlitzMall', click: () => { isQuitting = true; app.quit(); } }
    ]));
  }
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('BlitzMall HQ');
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    refreshTrayMenu();
  } catch (e) {
    tray = null; // no tray on this desktop — closing the window simply quits
    console.error('[tray] unavailable:', e && e.message);
  }

  installUpdateNow = ({ hidden = false } = {}) => {
    try {
      logUpdater(`applying update: quitAndInstall(silent, relaunch)${hidden ? ' — relaunching to tray' : ''}`);
      if (hidden) { try { fs.writeFileSync(hiddenRelaunchFlag(), '1'); } catch (e) {} }
      isQuitting = true;
      autoUpdater.quitAndInstall(true, true);
      return true;
    } catch (e) {
      isQuitting = false;
      if (hidden) consumeHiddenRelaunch();
      console.error('[updater] quitAndInstall failed:', e && e.message);
      logUpdater('quitAndInstall failed: ' + (e && e.message));
      return false;
    }
  };
  ipcMain.handle('updater:install', async () => ({ ok: installUpdateNow() }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Real quits (tray → Quit, Windows shutdown, the updater) must not be turned
// into "hide to tray" by the window's close handler.
app.on('before-quit', () => { isQuitting = true; });

// ===== Native notification bridge =====
// Electron cannot do web push (no PushManager API), so the desktop app polls a
// small event feed on the backend and shows native Windows toasts for shop
// events (new orders, admin broadcasts). Polling — not a WebSocket — because
// the Render server sleeps when idle; polling wakes it and survives sleep.
const NOTIF_FEED_URL = 'https://blitzmall-backend.onrender.com/api/notifications/feed';
let notifSince = null; // null => prime the cursor on the first poll (no backlog toasts)
const shownNotifIds = new Set(); // in-session dedup so a failed cursor save can't re-toast

function showNativeToast(title, body, { silent = false } = {}) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const n = new Notification({ title: String(title || 'BlitzMall'), body: String(body || ''), silent, icon: iconPath });
      n.on('click', showMainWindow); // clicking a toast opens the app
      n.show();
    }
    // Blink the taskbar button so an alert is not missed behind other windows.
    if (!silent && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
  } catch (e) { console.error('[notif] toast failed:', e && e.message); }
}

const pollNotifications = async () => {
  try {
    const statePath = path.join(app.getPath('userData'), 'notif-feed.json');
    if (notifSince === null) {
      // First poll: start from the saved cursor (if any), otherwise from now —
      // never toast a backlog of events that happened while the app was closed.
      try {
        const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        notifSince = (st && st.since) || new Date().toISOString();
      } catch (e) { notifSince = new Date().toISOString(); }
    }
    const url = `${NOTIF_FEED_URL}?admin=1&since=${encodeURIComponent(notifSince)}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return;
    let newest = notifSince;
    for (const it of items) {
      const ts = it && it.createdAt ? new Date(it.createdAt).toISOString() : null;
      if (ts && ts > newest) newest = ts;
      if (!it || it.audience === 'customer') continue; // customer pushes belong on phones
      const key = it.id || `${it.title}|${it.body}|${it.createdAt}`;
      if (shownNotifIds.has(key)) continue;
      shownNotifIds.add(key);
      showNativeToast(it.title, it.body);
    }
    if (newest !== notifSince) {
      notifSince = newest;
      try { fs.writeFileSync(statePath, JSON.stringify({ since: notifSince })); } catch (e) {}
    }
  } catch (e) { /* server asleep or offline — retry next tick */ }
};
setTimeout(pollNotifications, 15 * 1000);
setInterval(pollNotifications, 20 * 1000);
console.log('[notif] PC notification bridge active (polls every 20s)');

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
