// Which BlitzMall server the apps talk to.
//   1. The server picked on the HQ login screen (localStorage blitz_api_url).
//   2. A page served by the local dev server itself (`npm run dev`, opened at
//      http://localhost:5000) uses that same server, so testing locally never
//      falls through to the live shop by accident.
//   3. Otherwise the live cloud server.
// Capacitor (https://localhost) and Electron (file://) builds skip step 2; the
// React dev server (port 3000) has no API, so it keeps the cloud default.
export const CLOUD_API_URL = 'https://blitzmall-backend.onrender.com/api';

export const getDefaultApiUrl = () => {
  try {
    const saved = localStorage.getItem('blitz_api_url');
    if (saved) return saved;
  } catch (e) { /* storage blocked */ }
  try {
    const { protocol, hostname, port, origin } = window.location;
    if (protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(hostname) && port && port !== '3000') {
      return origin + '/api';
    }
  } catch (e) { /* no window */ }
  return CLOUD_API_URL;
};
