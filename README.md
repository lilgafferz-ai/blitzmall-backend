# BlitzMall — Shop System

Online shop + POS + admin dashboard for Blitz Mall (Matunda, Kakamega).

- **Web app (customers + admin):** https://blitzmall-backend.onrender.com
- **Backend API:** https://blitzmall-backend.onrender.com/api
- **Source repo:** github.com/yrngaffer/blitzmall-backend

---

## 📲 Android app (customers & shop phone)

**Install (first time):** download the latest APK and allow "Install from unknown sources" when prompted.

- Latest APK: **https://blitzmall-backend.onrender.com/api/app-info** (returns the newest `apkUrl`)
- The in-app Share screen shows a QR code that always points at the newest APK. Old APK links (`/apk/blitzmall-v3.apk` etc.) redirect to the newest build.

**Update (no reinstall needed):** the app checks for updates on every launch. If a newer web bundle exists, it downloads it in the background and applies it the next time you reopen the app — your data, login and basket are untouched.

> Only install a new APK when the native layer changes (push notifications, the updater itself). Web changes arrive over-the-air automatically.

## 🖥️ PC app (Blitz Mall HQ — shop admin)

**Install (first time):** download `BlitzMall-Setup-*.exe` from https://github.com/yrngaffer/blitzmall-backend/releases

**Update (no reinstall needed):** the desktop app checks for new releases on launch and every few minutes (via the server's `/api/pc-update`, which points at this repo's GitHub releases; set `PC_RELEASES_REPO` on Render if the repo ever moves), downloads new versions silently and installs them on restart.

---

## Sign-in and security model

- **Customers** sign in with their phone number and a 6-digit SMS code — on every new device, returning customers included. The server then issues a **customer session token**; every customer endpoint (orders, wallet, points, promos, vouchers, notifications) reads the phone number from that token, never from the request. Customers can "sign out of all devices".
- **Staff** sign in with username + password. Sessions stay logged in until Exit, but every request re-checks the account in the database: deleting a user, changing their role/permissions or tapping **sign out** (Staff tab) ends their sessions immediately.
- **M-Pesa:** the server sets the amount to charge (the order's unpaid balance, or the till basket it priced itself). Safaricom callbacks are treated as a nudge only — nothing is marked paid until Safaricom's own STK-query endpoint confirms it.
- **Production never runs on the offline file database.** If MongoDB is unreachable at boot the server retries, then exits so Render restarts it.

### Required / important environment variables (Render → Environment)

| Variable | Purpose |
|---|---|
| `MONGODB_URI`, `JWT_SECRET` | Mandatory — the server will not start without them |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | Africa's Talking SMS for sign-in codes |
| `OTP_SCREEN_FALLBACK` | **Temporary.** `true` (default) shows the code on screen when an SMS fails — anyone can then sign in to any account. Set `false` once SMS delivers. |
| `MPESA_*`, `CALLBACK_URL` | Daraja credentials and callback URL |
| `MPESA_CALLBACK_SECRET` | Random string; append `?secret=<value>` to `CALLBACK_URL` |
| `MPESA_MOCK_ENABLED` | Development only — auto-confirms every payment. Never `true` in production |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service account (raw or base64) for real device push |
| `ETIMS_VSCU_URL`, `ETIMS_VSCU_KEY` | KRA eTIMS connection (after KRA onboarding). Empty = tax invoices are numbered and queued in Admin → Tax, and sent automatically once set |
| `TZ` | Defaults to `Africa/Nairobi` (reports, happy hours and M-Pesa timestamps use shop time) |

### Shop features (v0.1.51)

- **Wallet top-up by M-Pesa** (customer wallet → Top up). Credited only after Safaricom confirms.
- **Delivery time slots** with per-slot capacity and a cut-off (Admin → Deliveries).
- **Riders:** a `rider` staff role sees only their own run sheet; they start, share live GPS (the customer sees the rider on the map) and mark orders delivered. Every other staff endpoint answers 403.
- **Multi-buy deals and loose items** (e.g. "6 for KES 300", sugar per 0.5 kg). App, till and server all price them the same way.
- **KRA eTIMS tax invoices and credit notes** for sales and delivered orders (Admin → Tax). They queue until `ETIMS_VSCU_URL` is set.
- **Daily closing report** pushed to the owner (and optionally sent by SMS) at the set time (Admin → Records).
- **Suppliers, re-order suggestions and purchase orders**. Receiving an order adds the stock and updates buying prices.
- **Stock-take mode**. Sales made during the count are kept.
- **Kiswahili** for the main customer screens (Me → Settings → Language).
- **Product reviews** from verified buyers, which staff can hide.

---

## How releases reach users

| App | Update channel | Applies when |
|-----|----------------|--------------|
| Web | `shop-frontend/build/` **committed to the repo**, served by the backend | Next page load after Render redeploys |
| Android | `shop-frontend/ota/` bundle **committed to the repo** (`/api/native-update`) | Next app open |
| PC | GitHub release built by `.github/workflows/release.yml` | Restart after the update downloads |

Render only runs `npm install` and serves what is committed, so a web/Android change ships like this:

```bash
cd shop-frontend
npm run build:strict          # lint-as-errors check (same as CI)
npm run build                 # builds build/ AND the OTA bundle in ota/
cd ..
git add -A && git commit && git push origin main   # Render redeploys main
```

Bump `shop-frontend/package.json` `version` for every release — the PC release workflow publishes that version to GitHub Releases. Check what is live with `curl https://blitzmall-backend.onrender.com/api/health` (shows `version`, `bundle` and `commit`).

---

## Developers

```bash
# Backend (API + serves the built web app)
npm install
npm start                 # http://localhost:5000 (uses .env)
npm test                  # backend jest suite (MOCK_DB=1 runs without MongoDB)

# Frontend (customer app + admin)
cd shop-frontend
npm install
npm run start             # dev server
npm run build             # react-scripts build + OTA bundle → build/ and ota/

# Android APK (needs Android SDK + JDK; keystore.properties for release signing)
cd shop-frontend
npm run android:build     # build web + cap sync
cd android && ./gradlew assembleRelease
```

### Project layout
- `server.js` — app wiring: middleware, route registration, boot
- `lib/` — shared logic: `db` (MongoDB + offline mock), `auth` (staff/customer sessions), `orders`, `pricing`, `loyalty` (points + promos), `mpesa`, `notifications` (FCM + PC feed + stock alerts), `sms` (sign-in codes), `ai`, `seed`, …
- `routes/` — HTTP endpoints, one file per area (`orders`, `catalog`, `pos`, `loyalty`, `mpesa`, `staff`, …)
- `shop-frontend/src/` — React app (`App.jsx` customer app, `Admin.jsx` dashboard)
- `shop-frontend/build/` — production web build (served at the root)
- `shop-frontend/ota/` — self-hosted OTA bundle (`latest.json` + zip)
- `shop-frontend/downloads/` — the current APK, served at `/apk/`
- `shop-frontend/android/` — Capacitor Android project
- `tests/` — backend jest tests (`npm test`); `tests/attacks.test.js` replays every security hole fixed in the October 2026 review
