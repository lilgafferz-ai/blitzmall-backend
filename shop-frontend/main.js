const { app, BrowserWindow, dialog } = require('electron');
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
      contextIsolation: true
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
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // re-check every 30 min
  const checkForUpdates = () => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .then(() => console.log('[updater] Update check finished (next in 30 min)'))
      .catch((err) => console.error('[updater] Update check failed:', err && err.message))
      .finally(() => setTimeout(checkForUpdates, CHECK_INTERVAL_MS));
  };
  autoUpdater.on('error', (err) => console.error('[updater] Auto-updater error:', err && err.message));
  autoUpdater.on('update-available', (info) => console.log('[updater] Update found:', info && info.version));
  autoUpdater.on('update-not-available', () => console.log('[updater] Already up to date'));
  autoUpdater.on('download-progress', (p) => {
    if (p && (p.percent % 25 < 2)) console.log('[updater] Download progress:', Math.round(p.percent) + '%');
  });
  // Give the window a moment to boot before hitting the update server
  setTimeout(checkForUpdates, 10 * 1000);

  autoUpdater.on('update-downloaded', (info) => {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
