// Customer PIN + security-answer credentials and a per-account lockout.
//
// A customer's PIN and recovery answer are the keys to their wallet money, so
// they are slow-hashed with bcrypt (NEVER the fast OTP HMAC in sms.js) and
// stored only as a hash — nobody, not even the shop owner, can read them back;
// recovery is "reset", not "reveal". The wrong-guess lockout lives ON the
// customer document so it survives a server restart (an in-memory counter, like
// the old OTP store, would reset on every redeploy and be trivially bypassed).
const bcrypt = require('bcryptjs');
const { col } = require('./db');

const PIN_RE = /^\d{4,6}$/;           // 4–6 digit PIN, M-Pesa style
const PIN_MAX_ATTEMPTS = 5;           // wrong tries before the account locks
const PIN_LOCK_MS = 15 * 60 * 1000;   // 15-minute lock after too many wrong tries
const BCRYPT_COST = 10;               // same work factor staff passwords use (routes/staff.js)

const isValidPin = (pin) => PIN_RE.test(String(pin || ''));
// Security answers compare case/space-insensitively, so "Nairobi" === " nairobi ".
const normalizeAnswer = (a) => String(a || '').trim().toLowerCase().replace(/\s+/g, ' ');

const hashSecret = (plain) => bcrypt.hash(String(plain), BCRYPT_COST);
const verifySecret = async (plain, hash) => {
  if (!hash) return false;
  try { return await bcrypt.compare(String(plain), hash); } catch (e) { return false; }
};

// Milliseconds remaining on an active lock (0 when not locked).
const lockMsLeft = (cust) => {
  const until = cust && cust.lockedUntil ? new Date(cust.lockedUntil).getTime() : 0;
  return until > Date.now() ? until - Date.now() : 0;
};

// Record a wrong PIN/answer. $inc is atomic in Mongo and the mock DB; the
// read-back may over-count under concurrent guesses, which only trips the lock
// sooner (the safe direction). Returns { locked, attemptsLeft, retryAfterSec }.
async function registerFailedAttempt(phone) {
  await col.customers.updateOne({ phone }, { $inc: { failedPinAttempts: 1 } });
  const doc = await col.customers.findOne({ phone });
  const attempts = (doc && doc.failedPinAttempts) || 0;
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await col.customers.updateOne(
      { phone },
      { $set: { lockedUntil: new Date(Date.now() + PIN_LOCK_MS), failedPinAttempts: 0 } }
    );
    return { locked: true, attemptsLeft: 0, retryAfterSec: Math.ceil(PIN_LOCK_MS / 1000) };
  }
  return { locked: false, attemptsLeft: Math.max(0, PIN_MAX_ATTEMPTS - attempts), retryAfterSec: 0 };
}

// Clear the counter + any lock after a correct PIN/answer.
async function clearAttempts(phone) {
  try { await col.customers.updateOne({ phone }, { $set: { failedPinAttempts: 0 }, $unset: { lockedUntil: '' } }); } catch (e) { /* non-fatal */ }
}

module.exports = {
  PIN_MAX_ATTEMPTS, PIN_LOCK_MS,
  isValidPin, normalizeAnswer, hashSecret, verifySecret,
  lockMsLeft, registerFailedAttempt, clearAttempts
};
