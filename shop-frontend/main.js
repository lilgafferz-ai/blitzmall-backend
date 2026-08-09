const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Set the application name and App User Model ID for proper Windows taskbar grouping and branding
app.name = "BlitzMall";
if (process.platform === 'win32') {
  app.setAppUserModelId("com.blitzmall.app");
}

function createWindow() {
  const iconPath = fs.existsSync(path.join(__dirname, 'build', 'app-icon.ico'))
    ? path.join(__dirname, 'build', 'app-icon.ico')
    : path.join(__dirname, 'public', 'app-icon.ico');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(path.join(__dirname, 'build', 'index.html')).catch((err) => {
    console.error("Failed to load index.html. Make sure the React app is built first.", err);
  });
}

app.whenReady().then(() => {
  createWindow();

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

  // Stream updater events to the renderer so the in-app "Check for Updates"
  // button (Settings → App Updates) shows real status instead of a silent
  // background check that gives the user no feedback.
  const broadcastUpdaterStatus = (status) => {
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
    broadcastUpdaterStatus({ status: 'downloaded', newVersion: info && info.version });
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'BlitzMall v' + info.version + ' has been downloaded. Restart the app to apply the updates.',
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  // Belt-and-suspenders update source: read the raw `latest.yml` asset from
  // the GitHub release (a plain file download — NO api.github.com rate limits
  // and no JSON API at all), so we ALWAYS know the newest published version
  // even if the electron-updater API check is being throttled or fails.
  const GITHUB_REPO = 'lilgafferz-ai/blitzmall-backend';
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ===== Native notification bridge =====
// Electron cannot do web push (no PushManager API), so the desktop app polls a
// small event feed on the backend and shows native Windows toasts for shop
// events (new orders, admin broadcasts). Polling — not a WebSocket — because
// the Render server sleeps when idle; polling wakes it and survives sleep.
const NOTIF_FEED_URL = 'https://blitzmall-backend.onrender.com/api/notifications/feed';
let notifSince = null; // null => prime the cursor on the first poll (no backlog toasts)
const shownNotifIds = new Set(); // in-session dedup so a failed cursor save can't re-toast

const showNativeToast = (title, body) => {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({ title: String(title || 'BlitzMall'), body: String(body || ''), silent: false }).show();
    }
  } catch (e) { console.error('[notif] toast failed:', e && e.message); }
};

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
