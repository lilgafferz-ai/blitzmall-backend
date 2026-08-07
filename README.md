# BlitzMall — Shop System

Online shop + POS + admin dashboard for Blitz Mall (Matunda, Kakamega).

- **Web app (customers + admin):** https://blitzmall-backend.onrender.com
- **Backend API:** https://blitzmall-backend.onrender.com/api
- **Source repo:** github.com/lilgafferz-ai/blitzmall-backend

---

## 📲 Android app (customers & shop phone)

**Install (first time):** download the latest APK and allow "Install from unknown sources" when prompted.

- Latest APK: **https://blitzmall-backend.onrender.com/apk/blitzmall-v5.apk**
- The in-app Share screen shows a QR code that always points at the newest APK (`/api/app-info`).

**Update (no reinstall needed):** the app checks for updates on every launch. If a newer web bundle exists, it downloads it in the background and applies it the next time you reopen the app — your data, login and basket are untouched. No Play Store, no APK reinstall, no data loss.

> Only install a new APK when the native layer changes (push notifications, the updater itself). Web changes arrive over-the-air automatically.

## 🖥️ PC app (Blitz Mall HQ — shop admin)

**Install (first time):** download `BlitzMall-Setup-*.exe` from the GitHub releases page:

- **https://github.com/lilgafferz-ai/blitzmall-backend/releases** (grab the newest `BlitzMall-Setup-0.1.x.exe`)

**Update (no reinstall needed):** the desktop app auto-checks for updates every 30 minutes. When a new version is found it downloads it silently, then shows **"Update Ready — Restart to apply."** Click Restart and the app updates itself in place — settings, login and data are kept.

---

## How updates work (so you never reinstall again)

| App | Update channel | Applies when |
|-----|----------------|--------------|
| Android | Self-hosted OTA bundle (`/api/native-update` → `/updates/`) | On next app open |
| PC | GitHub release + `electron-updater` | Restart after the "Update Ready" prompt |
| Web | Static hosting (deployed from this repo) | On next page load |

Shipping a new version is one command: **`git push`**. CI builds the web app, packages the OTA bundle, publishes the PC installer to GitHub Releases, and the backend redeploys on Render. All installed apps then update themselves.

---

## Developers

```bash
# Backend (API + serves the built web app)
npm install
npm start                 # http://localhost:5000 (uses .env for Atlas + M-Pesa)

# Frontend (customer app + admin)
cd shop-frontend
npm install
npm run build             # react-scripts build + OTA bundle → build/ and ota/
npm run start             # dev server

# Android APK (needs Android SDK + JDK; keystore.properties for release signing)
cd shop-frontend
npm run android:build     # build web + cap sync
cd android && ./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

### Project layout
- `server.js` — Express API, Mongo/Atlas, M-Pesa, push notifications, loyalty engine, OTA + APK serving
- `shop-frontend/src/` — React app (customer app + Admin.jsx dashboard)
- `shop-frontend/build/` — production web build (served at the root)
- `shop-frontend/ota/` — self-hosted OTA bundles (`latest.json` + zips)
- `shop-frontend/downloads/` — APK files served at `/apk/`
- `shop-frontend/android/` — Capacitor Android project
- `tests/` — backend jest tests (`npm test`)
