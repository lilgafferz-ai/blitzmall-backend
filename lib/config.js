// Environment-derived settings shared by every module.

// Under Jest the whole suite shares one IP and fires requests in bursts, so the
// per-IP caps are lifted (the per-phone/duplicate logic still applies). Hoisted
// here because the auth/OTP limiters below also need it.
const IS_TEST = !!process.env.JEST_WORKER_ID;
const path = require('path');
const ROOT = path.join(__dirname, '..'); // project root (shop-frontend/, local_db_fallback.json)

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/my_shop';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not defined.');
  process.exit(1);
}
// Every session in the shop is signed with this one secret: a short or
// example value can be guessed offline and then any staff/customer token forged.
if (process.env.NODE_ENV === 'production' && (JWT_SECRET.length < 32 || /change_me|secret|password/i.test(JWT_SECRET))) {
  console.error('⚠️ SECURITY: JWT_SECRET is weak (use 32+ random characters, e.g. `openssl rand -hex 32`). Rotating it signs everyone out once.');
}
// Encrypts staff authenticator (TOTP) secrets at rest. Falls back to a key
// derived from JWT_SECRET; a separate value means rotating JWT_SECRET after a
// leak doesn't also break everyone's two-step sign-in.
const MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '';
if (process.env.NODE_ENV === 'production' && MFA_ENCRYPTION_KEY.length < 32) {
  console.warn('⚠️ SECURITY: MFA_ENCRYPTION_KEY is not set (32+ random characters) — staff authenticator secrets are encrypted with a key derived from JWT_SECRET.');
}
// Staff (owner/cashier/manager) sessions slide: a token lives 30 days, and any
// signed-in request made with a token older than STAFF_RENEW_AFTER_S gets a
// fresh one back (X-Renewed-Token header, saved by the apps). Staff who open
// the app at least once a month never see a login screen, while a leaked or
// forgotten token dies on its own. authenticate() also re-checks the account
// in the database on every request, so deleting a user, changing their
// role/permissions or revoking their sessions still takes effect immediately.
const JWT_EXPIRES = '30d';
const STAFF_SESSION_MAX_AGE_S = 30 * 24 * 3600; // also caps pre-v0.1.51 10-year tokens
const STAFF_RENEW_AFTER_S = 12 * 3600;
// Customer sessions (issued only after a verified OTP) last a year per device.
const CUSTOMER_JWT_EXPIRES = '365d';

// Shop GPS coordinates (Point A for delivery tracking)
const SHOP_COORDS = { lat: 0.825155, lng: 35.121834 }; // Blitz Mall, Matunda (owner GPS pin)
const PORT = process.env.PORT || 5000;

module.exports = { IS_TEST, ROOT, MONGO_URI, JWT_SECRET, MFA_ENCRYPTION_KEY, JWT_EXPIRES, STAFF_SESSION_MAX_AGE_S, STAFF_RENEW_AFTER_S, CUSTOMER_JWT_EXPIRES, SHOP_COORDS, PORT };
