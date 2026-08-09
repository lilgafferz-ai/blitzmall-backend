// Preload bridge for the BlitzMall desktop app. The renderer runs with
// contextIsolation enabled and no Node access, so the in-app "Check for
// Updates" button talks to the native auto-updater through this safe bridge:
//   - checkForUpdates()  → ask main to run an update check right now
//   - onStatus(callback) → subscribe to live updater events (checking,
//                          available, downloaded, up-to-date, error)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blitzUpdater', {
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  onStatus: (callback) => {
    const listener = (_event, status) => {
      try { callback(status); } catch (e) { /* renderer handler error — ignore */ }
    };
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  }
});
