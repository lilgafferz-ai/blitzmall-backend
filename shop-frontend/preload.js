// Preload bridge for the BlitzMall desktop app. The renderer runs with
// contextIsolation enabled and no Node access, so the in-app "Check for
// Updates" button talks to the native auto-updater through this safe bridge:
//   - checkForUpdates()  → ask main to run an update check right now
//   - onStatus(callback) → subscribe to live updater events (checking,
//                          available, downloaded, up-to-date, error)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blitzUpdater', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  // Guaranteed fallback: reads the raw latest.yml (no GitHub API / no rate
  // limits) and returns { currentVersion, version, downloadUrl }.
  latest: () => ipcRenderer.invoke('updater:latest'),
  // Opens the newest installer in the default browser — always works even if
  // the in-app auto-updater is being throttled or blocked.
  openDownload: (url) => ipcRenderer.invoke('updater:openDownload', url),
  // Apply a downloaded update right now (the "Restart to update" button):
  // quits the app and relaunches the new version immediately.
  install: () => ipcRenderer.invoke('updater:install'),
  onStatus: (callback) => {
    const listener = (_event, status) => {
      try { callback(status); } catch (e) { /* renderer handler error — ignore */ }
    };
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  }
});
