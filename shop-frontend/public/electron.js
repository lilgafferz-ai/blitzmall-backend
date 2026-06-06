const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    title: "Blitz Mall HQ",
    icon: path.join(__dirname, 'app-icon.ico'),
    show: false,               // Don't show until ready
    backgroundColor: '#0a0a0c', // Match app dark background - no white flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Hide the default electron browser menu bar for a premium native look
  win.setMenuBarVisibility(false);

  // Show a branded loading screen while React boots up
  win.webContents.on('did-start-loading', () => {
    // Inject a loading splash into the page immediately
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

  // Once DOM is ready, inject splash HTML
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

  // Hide splash once React has rendered (page fully loaded)
  win.webContents.on('did-finish-load', () => {
    // Give React a moment to render the actual splash screen
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

  // Show window once content is ready (no black screen)
  win.once('ready-to-show', () => {
    win.show();
  });

  // Load the built React index.html file
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
