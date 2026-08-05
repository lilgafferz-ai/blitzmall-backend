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
    title: "Blitz Mall HQ",
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

  // Harden the auto-updater: checkForUpdatesAndNotify() fails silently on
  // network errors or GitHub API rate-limit 403s (which burn the hourly
  // quota). Retry later instead of giving up, and surface errors in the log.
  const checkForUpdates = () => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] Update check failed:', err && err.message);
      setTimeout(checkForUpdates, 30 * 60 * 1000); // retry in 30 min
    });
  };
  autoUpdater.on('error', (err) => console.error('[updater] Auto-updater error:', err && err.message));
  // Give the window a moment to boot before hitting the update server
  setTimeout(checkForUpdates, 10 * 1000);

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of BlitzMall has been downloaded. Restart the app to apply the updates.',
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
