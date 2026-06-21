import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import ErrorBoundary from './ErrorBoundary';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

CapacitorUpdater.notifyAppReady();

const isNativeApp = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

// Self-hosted over-the-air updates (native app only): ask our own server for the
// newest web bundle, download it in the background, and queue it to apply the
// next time the app is reopened — instant updates with no Play Store release.
async function checkForBundleUpdate() {
  if (!isNativeApp) return;
  try {
    const apiBase = (() => {
      try { return localStorage.getItem('blitz_api_url') || 'https://blitzmall-backend.onrender.com/api'; }
      catch (e) { return 'https://blitzmall-backend.onrender.com/api'; }
    })();
    const res = await fetch(`${apiBase}/native-update`);
    const latest = await res.json();
    if (!latest || !latest.version || !latest.url) return;
    const cur = await CapacitorUpdater.current();
    if (cur && cur.bundle && cur.bundle.version === latest.version) return; // up to date
    const bundle = await CapacitorUpdater.download({ url: latest.url, version: latest.version });
    await CapacitorUpdater.next({ id: bundle.id }); // applies on next reopen, no interruption
    console.log('OTA update ready, applies on next launch:', latest.version);
  } catch (e) {
    console.log('OTA check skipped:', (e && e.message) || e);
  }
}
checkForBundleUpdate();

// The service worker is for the web/PWA only. The native app already ships its
// assets bundled and updates via Capgo above, so registering a SW there would
// only risk serving stale files after an OTA swap.
if ('serviceWorker' in navigator && !isNativeApp) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('SW registered'))
      .catch(err => console.log('SW failed', err));
  });
}

reportWebVitals();