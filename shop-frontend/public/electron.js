const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    title: "Blitz Mall HQ",
    icon: path.join(__dirname, 'logo512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Hide the default electron browser menu bar for a premium native look
  win.setMenuBarVisibility(false);

  // Load the built React index.html file
  // Since this file runs from the build/ directory in production,
  // __dirname points to the build/ directory.
  win.loadFile(path.join(__dirname, 'index.html')).catch((err) => {
    console.error("Failed to load index.html.", err);
  });
}

// Initialize Electron app when ready
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed on Windows and Linux
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
