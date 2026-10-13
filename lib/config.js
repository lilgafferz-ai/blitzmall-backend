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
// Staff (owner/cashier/manager) stay logged in until they log out manually —
// the token effectively never expires, and the apps persist it across restarts.
// That is only safe because authenticate() re-checks the account in the
// database on every request: deleting a user, changing their role/permissions
// or revoking their sessions takes effect immediately, whatever the token says.
const JWT_EXPIRES = '3650d';
// Customer sessions (issued only after a verified OTP) last a year per device.
const CUSTOMER_JWT_EXPIRES = '365d';

// Shop GPS coordinates (Point A for delivery tracking)
const SHOP_COORDS = { lat: 0.8273, lng: 35.1207 }; // Matunda, Kakamega - Blitz Mall location
const PORT = process.env.PORT || 5000;

module.exports = { IS_TEST, ROOT, MONGO_URI, JWT_SECRET, JWT_EXPIRES, CUSTOMER_JWT_EXPIRES, SHOP_COORDS, PORT };
