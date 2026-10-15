# BlitzMall security audit and runbook (October 2026)

This covers the Express/MongoDB backend (`server.js`, `lib/`, `routes/`), the React web/PC/Android
client (`shop-frontend/`), and M-Pesa (Daraja STK push). It records what was found, what was changed,
how it was tested, and what still needs a person to do. It does not claim the system is "secure".
Everything listed as fixed has a regression test in `tests/audit2026.test.js` unless it says otherwise.

## Stack and trust boundaries

- **Staff** (owner, manager, cashier, staff, rider) sign in with a username and password (bcrypt).
  The owner and managers can add a TOTP authenticator code as a second step (see "Two-step sign-in and
  step-up" below). They get a 30-day HS256 JWT. Every request re-reads the account's role, permissions and `tokenVersion`.
- **Customers** sign in with a phone number and a PIN (bcrypt, 5 tries then a 15-minute lock).
  They get a customer JWT. Customer routes take the phone number from the token, never from the URL or body.
- **Money**: wallet cash sits on `loyalty.walletBalance`. Every movement goes through the append-only
  `wallet_transactions` ledger (`lib/wallet.js`), and the owner can reconcile the two.
  M-Pesa results are confirmed only by Safaricom's STK query. The callback is just a nudge to check.
- **Database**: MongoDB Atlas (production). The offline mock (`MOCK_DB=1`) is used only for tests.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | Any staff login, including a cashier with only `sales`, could read every order (addresses, GPS), every loyalty card (wallet balances), all coupon codes, credit/debt records, expenses, shifts, loyalty stats, pricing rules, reviews and **the audit log** | Fixed. Each route now needs the permission of the tab that shows it, and the audit log is owner-only. Tested |
| 2 | High | The admin AI chat bypassed every permission. Any staff member could ask for customer lookups, credit lists, profit or coupon lists. AI write actions were not audit-logged, and its "order_action" skipped the order rules | Fixed. Intents are mapped to permissions, every AI write is audit-logged, and order changes go through `updateOrderStatus`. Tested |
| 3 | High | A points award (`earnPoints`, `addLoyaltyPoints`, `reversePoints`, manual/owner points) was read-then-`$set`. A wallet conversion landing in between was undone, so the points were spent twice. Points convert to wallet cash (5 pts = KES 1) | Fixed. All point writes use atomic `$inc`. Tested with a concurrent conversion |
| 4 | High | A manager could rewrite the whole loyalty economy (earn rate, prize odds, redemption values) and mint unlimited points for any phone. Manual point changes were not audit-logged. The settings endpoint accepted any field (mass assignment) | Fixed. Settings are owner-only with whitelisted, range-checked fields. Managers can add at most 1,000 points per change. Every change is audit-logged. Tested |
| 5 | High | Production dependencies had a critical `proxy-addr` advisory (Express client-IP handling, which drives rate limiting) and high advisories in `@grpc/grpc-js`, `@fastify/busboy` and `ip-address` | Fixed. `npm audit fix` was run with npm 10, and production deps now report 0 vulnerabilities. CI now fails on new high/critical ones |
| 6 | Medium | Order status could move anywhere: delivered back to pending, or any staff member cancelling a delivered order, which returns wallet cash and stock. A "delivered" racing a cancel could resurrect a cancelled order | Fixed. Delivered is final, and only the owner can cancel a delivered order (a return). Writes are conditional on the prior status. Tested |
| 7 | Medium | Spin/scratch prizes unlocked on *non-cancelled* orders, so two unpaid pending orders unlocked prizes and could then be cancelled | Fixed. Only delivered orders count. Tested |
| 8 | Medium | Voiding a till sale hard-deleted it with no audit log, and a double void restored the stock twice | Fixed. The sale is archived in `voided_sales` and audit-logged. Stock is restored only by the request that deleted the sale. Tested |
| 9 | Medium | Till prices are client-supplied, so a cashier could ring up any item for KES 1 with no trace | **Detective control only.** A line below the current shelf price gets `priceOverride` on the sale and an audit entry. It is not blocked, because haggling and damaged stock are legitimate and offline sales replay later. Tested |
| 10 | Medium | Staff login had no per-account lockout. Failures weren't logged. Unknown usernames answered faster (timing enumeration). New passwords could be 6 characters | Fixed. 5 wrong passwords lock the account for 15 minutes, staff get a push alert, failures and logins are audited, a dummy bcrypt runs for unknown users, and new passwords need 8+ characters. Tested |
| 11 | Medium | Wiping "Loyalty" from the Delete tab erased customers' wallet cash, including M-Pesa top-ups, along with its ledger. The audit log itself was wipeable | Fixed. The wipe is refused while any card holds cash (use the archived per-customer delete instead), and `audit_logs` is no longer a wipeable type. Tested |
| 12 | Medium | `MPESA_MOCK_ENABLED=true` auto-confirms every payment, including wallet top-ups (free money). Nothing stopped it in production | Fixed. The mock is ignored when `NODE_ENV=production` (set in `render.yaml`). Tested |
| 13 | Medium | Flash-sale discount and pricing-rule percentages were unbounded (100%+ means free goods). Price, cost and stock edits weren't audit-logged | Fixed. Discounts are capped at 90%, and edits are logged with before → after values. Tested |
| 14 | Low | Customers received the shop's cost price (`buyingPrice`) on every order line | Fixed. Tested |
| 15 | Low | M-Pesa callback receipts weren't kept, and a paid amount differing from the request went unnoticed | Fixed. `callbackMeta` (receipt, amount) is stored and `amountMismatch` flagged. The callback still never marks anything paid. Tested |
| 16 | Low | Riders could start STK pushes for till sales and other riders' orders. Non-owners could book till sales to another branch | Fixed. Tested |
| 17 | Low | JWT algorithm not pinned. No `Cache-Control` on API responses. Coupon check unthrottled. Order `paymentMethod`/`gpsCoords` stored raw. Transfer quantities unvalidated (NaN corrupts stock). STK error leaked internal messages | Fixed (HS256 pinned, `no-store`, 15/min limiter, whitelisted and sanitised, validated, generic error) |
| 18 | Low | `/api/auth/check` and `/api/auth/recover` reveal whether a phone number has an account | **Accepted** (the PIN sign-in screen needs it). Both are behind `authLimiter` |
| 19 | Low | `xlsx` (admin product import) has prototype-pollution/ReDoS advisories with no npm fix. Frontend build tooling (react-scripts) has many advisories | **Not fixed.** Only staff upload spreadsheets, and the build tooling isn't shipped. SheetJS publishes fixed builds at cdn.sheetjs.com (move when convenient) |
| 20 | High | No second factor for staff: a phished or reused owner password opened HQ (customer wipes, loyalty economy, staff accounts). A stolen or unattended session could run every destructive action with no re-check | Fixed. TOTP two-step sign-in for owner/managers, plus step-up re-auth (password + code) on destructive owner routes. Tested in `tests/mfa.test.js` |

## Two-step sign-in and step-up (added October 2026)

**Two-step sign-in (TOTP, RFC 6238)** — `lib/mfa.js`, `routes/staff.js`, HQ → Settings → Security.
- Available to the **owner** (optional to start, then mandatory: it can be moved to a new phone but not
  switched off) and **managers** (optional; they can switch it off, and the owner can reset it from
  HQ → Staff → "reset 2-step" for a lost phone). Other roles can't enrol.
- Codes come from `@otplib/totp` (maintained otplib v13, Node crypto plugin). SHA-1, 6 digits, 30 s,
  ±1 step for clock drift. A code is accepted once: the last-used time step is stored and claimed with a
  conditional update, so a replayed code (even in a race) fails.
- Enrolment: `POST /api/admin/me/mfa/setup` (needs the password, and the current code when moving phones)
  returns an `otpauth://` URI, a QR data-URL and the key for typing in. Only an AES-256-GCM encrypted copy
  of the secret is stored, and the API never returns it again. `POST /api/admin/me/mfa/activate` with the
  first code switches it on, returns 10 one-time **recovery codes** once (bcrypt-hashed at rest), and signs
  out every other device. `POST /me/mfa/recovery-codes` replaces them, `POST /me/mfa/disable` turns it off
  (managers only).
- Sign-in: with two-step on, `POST /api/admin/login` answers a correct password with
  `{ mfaRequired, mfaToken }`, a 5-minute signed token that is **not** a session (it carries `type:
  'mfa_pending'` and no `userId`, and `authenticate` now refuses any token with a `type`).
  `POST /api/admin/login/mfa` with that token and an authenticator or recovery code returns the normal
  staff JWT. Wrong codes count toward the same 5-try / 15-minute account lock as wrong passwords, and the
  count is only cleared once the code is right, so knowing the password doesn't buy unlimited guesses.
- Audit log: `mfa_setup_started`, `mfa_enabled`, `mfa_reset`, `mfa_setup_failed`, `mfa_disabled`,
  `mfa_reset_by_owner`, `mfa_recovery_codes_reset`, `login_mfa_failed`, `mfa_recovery_code_used` (also a
  staff push), `account_locked`.
- Encryption key: `MFA_ENCRYPTION_KEY` (32+ random characters). Without it the key is derived from
  `JWT_SECRET`, and rotating `JWT_SECRET` then breaks every authenticator (recovery codes still work, and
  the staff member sets up again). Production logs a warning while it's unset.

**Step-up re-authentication** — `requireReauth` in `lib/mfa.js`. These routes need the account's current
password in the body (`currentPassword`) and, when two-step is on, a fresh authenticator or recovery code
(`mfaCode`): `POST /api/admin/customers/wipe` (real run; the dry-run preview doesn't), `POST
/api/admin/customers/:phone/delete`, `POST /api/admin/customers/:phone/reset-pin`, `DELETE
/api/admin/records`, `PUT /api/admin/loyalty/settings`, `POST /api/admin/users`, `PUT
/api/admin/users/:id`, and the MFA setup/recovery/disable routes. A missing credential answers `403 {
reauthRequired, mfaRequired }`. Wrong passwords or codes are audit-logged (`reauth_failed`) and count toward
the account lock, and a locked account can't step up. The HQ app asks in a React modal (`ReauthSheet` in
`components/SettingsKit.jsx`), since the Electron app has no `window.prompt`. The "delete all customers"
phrase prompt was moved into that modal too.

Already solid before this audit (verified, not changed): server-side order pricing, stock
reservation and atomic coupon claims; atomic wallet debits; STK-query-only payment confirmation;
customer IDOR checks; NoSQL key stripping; CORS allowlist and CSP; signed OTA updates; Electron
`contextIsolation`; no secrets committed. The Firebase *web* config is public by design, so restrict
that API key in Google Cloud.

## Tests

- `tests/audit2026.test.js`: 42 attack/regression tests for findings 1–17.
- `tests/mfa.test.js`: 23 tests for finding 20. Enrolment stores only an encrypted secret, login needs
  the code, the pending token isn't a session, codes can't be replayed, a recovery code works once,
  wrong codes lock the account, managers can turn it off and the owner can't, every step-up route refuses
  without re-auth, and with two-step on step-up needs password **and** code. The shared test owner is
  enrolled and restored inside the file.
- Full suite: **205/205 passing** (`MOCK_DB=1 NODE_ENV=test npx jest --runInBand`; inside a
  `.claude/` worktree add `--testMatch '**/tests/*.test.js'`).
- Existing tests send the owner's password (`REAUTH` in `tests/helpers.js`) on step-up routes.
- Existing tests updated for the new rules: promos deliver orders before spinning, cost prices are read
  from the admin view, and the records wipe no longer lists `audit_logs`.
- The HQ screens for two-step sign-in were smoke-tested in a browser against the offline test DB
  (enrol → QR/key → activate → recovery codes, step-up modal with a wrong then a right password, password +
  code on a records delete, two-step login with a wrong code then a recovery code). Not tested on Android
  or in the Electron build.
- **Not tested:** real Safaricom/Daraja calls, real MongoDB Atlas (multi-document behaviour), the rebuilt
  React UI in a browser, and load/DoS behaviour. No dynamic scan (DAST) was run.

## Not implemented (needs a decision or more work)

- **Two-step sign-in is not forced on.** The owner is nudged in Settings but can stay password-only until
  they enrol. Forcing enrolment at first sign-in (and for managers) is a policy decision.
- **WebAuthn / passkeys** (phishing-resistant) were not added; TOTP codes can still be phished in real time.
- **Step-up does not cover every sensitive route.** Deleting staff, revoking sessions, manual points,
  coupons, refunds/voids and branch edits still need only the session. Extend `requireReauth` if wanted.
- **No step-up grace window.** Every protected action asks again, and each TOTP code works once, so two
  actions inside the same 30 seconds need a recovery code or a short wait.
- **Money in integer cents.** Amounts are JS numbers rounded to 2 dp everywhere, and the ledger
  reconciles. Moving to integer minor units is a data migration.
- **Multi-document transactions.** For example, the wallet move and its ledger entry, or an order and its
  stock. Atlas supports them, but the offline mock doesn't. A gap shows up in `/api/admin/wallet/reconcile`.
- **Blocking (not just flagging) till price overrides** would need a `price_override` permission and a
  plan for offline sales.
- **Unusual-activity alerts** beyond the existing pushes and the new account-locked push.
- **Data retention** (e.g. pruning `ai_chats` and `audit_logs` after N months) and a customer data-export/deletion request flow.

## Before / after deploying

1. Push to `main` (Render redeploys). All server fixes take effect without a frontend rebuild.
2. Rebuild the web bundle (`npm run build` in `shop-frontend`, which also makes the OTA bundle) to ship the
   small UI changes: 8-character password hints, no "Audit Logs" in the Delete tab, and the till no longer
   polling orders for staff without Orders access.
3. **Render env**: confirm `NODE_ENV=production`. Do not rely on `MPESA_MOCK_ENABLED` (it is now ignored
   in production), so set real Daraja credentials and `MPESA_CALLBACK_SECRET` (append `?secret=` to `CALLBACK_URL`).
4. **Two-step sign-in**: set `MFA_ENCRYPTION_KEY` on Render (`openssl rand -hex 32`) **before** anyone
   enrols, then keep it. Changing it later breaks existing authenticators, and they need recovery codes or a reset.
   Then the owner enrols in HQ → Settings → Security and stores the recovery codes off the device.
   Old app builds can't complete the code step, so ship the rebuilt web/OTA/PC bundle first.
5. Check the Render logs for `SECURITY: JWT_SECRET is weak`. If it appears, set a new 32+ character
   random secret (`openssl rand -hex 32`). Everyone signs in again once.
6. Staff with only `sales` no longer see orders, loyalty, coupons or financial totals. Give managers the
   permissions they need in HQ → Staff.
7. **MongoDB Atlas**: restrict *Network Access* to Render's outbound IPs (not 0.0.0.0/0), use a
   database user limited to this database (readWrite, no admin), and enable backups (see below).

## Backups and recovery

- **Check the Atlas tier.** Free M0 clusters have *no* automated backups. Use a tier with snapshots,
  or schedule `mongodump --uri "$MONGODB_URI" --archive=blitz-$(date +%F).gz --gzip` to encrypted storage,
  kept off the Render box.
- **Test a restore** each quarter into a *separate* cluster/database (`mongorestore --nsFrom 'my_shop.*' --nsTo 'restore_test.*'`),
  then run `/api/admin/wallet/reconcile` against it. Never restore over production to test.
- **Customer wipes** are archived in `customer_wipe_archive`, and voided sales in `voided_sales`.
- **Lost owner password**: there is no self-service reset for staff. Someone with Atlas access must set a new
  bcrypt hash on the owner's `users` document and bump `tokenVersion`.
- **Owner lost the authenticator phone**: sign in with a recovery code, then Settings → Security → "Move to a
  new phone". With no recovery codes left, someone with Atlas access sets `mfaEnabled: false`, removes
  `mfaSecret`, `mfaRecoveryCodes` and `mfaLastStep` on the owner's `users` document, and bumps `tokenVersion`.
  A manager's two-step is reset by the owner (HQ → Staff → "reset 2-step").
- **Suspected breach**: rotate `JWT_SECRET` (signs out everyone), bump the affected staff's `tokenVersion`
  (HQ → Staff → Sign out everywhere), rotate Daraja/Atlas/FCM credentials, export `audit_logs`, and run wallet reconciliation.

## Regulatory items for expert review (not legal advice)

- **Stored value / wallet.** Customers can top up a BlitzMall wallet with M-Pesa and spend it only at the
  shop (no withdrawals or transfers). Ask a payments lawyer or the CBK whether this closed-loop wallet falls
  under the National Payment System Act 2011 and its e-money rules, before promoting top-ups widely.
  Don't add withdrawals or transfers without that answer.
- **Data Protection Act 2019 / ODPC.** The shop processes phone numbers, names, delivery locations (GPS),
  purchase history and AI-chat transcripts. Check whether the business must register with the ODPC as a data
  controller (small businesses may be exempt, but some purposes, such as direct marketing, are not). Publish a
  privacy notice that mentions the AI-chat logging and push notifications. Define how long each kind of data is kept.
- **KRA eTIMS.** The integration is queued but unconfirmed against KRA's spec (see `lib/etims.js`).
