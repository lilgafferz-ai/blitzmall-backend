// Staff two-step sign-in (TOTP, RFC 6238), recovery codes, the per-account
// lockout and step-up re-authentication for destructive owner actions.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const totp = require('@otplib/totp');
const { crypto: otpCrypto } = require('@otplib/plugin-crypto-node');
const { generateTOTP } = require('@otplib/uri');
const { JWT_SECRET, MFA_ENCRYPTION_KEY } = require('./config');
const { auditLog } = require('./auth');
const { col } = require('./db');
const { sendPushToStaff } = require('./notifications');
const { idFilter } = require('./util');

// Owner (mandatory once switched on) and managers (optional) can use it.
const MFA_ROLES = ['owner', 'manager'];
const ISSUER = 'BlitzMall';
// Accept the previous/next 30-second code too, for phone clock drift.
const EPOCH_TOLERANCE_S = 30;
const RECOVERY_CODE_COUNT = 10;
const ENROL_WINDOW_MS = 15 * 60 * 1000;
const MFA_PENDING_TTL = '5m';

// Staff-account brute-force lock (on top of the per-IP authLimiter). Wrong
// passwords, wrong sign-in codes and failed step-up checks all count.
const STAFF_MAX_FAILED_LOGINS = 5;
const STAFF_LOCK_MS = 15 * 60 * 1000;

// ===== Authenticator secrets, encrypted at rest (AES-256-GCM) =====
// MFA_ENCRYPTION_KEY should be its own random value: if the key is derived from
// JWT_SECRET, rotating JWT_SECRET makes every authenticator stop working
// (recovery codes still work, and the staff member then sets up again).
const ENC_KEY = Buffer.from(crypto.hkdfSync('sha256', MFA_ENCRYPTION_KEY || JWT_SECRET, 'blitzmall-mfa', 'totp-secret-v1', 32));
const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
};
const decryptSecret = (stored) => {
  try {
    const [v, iv, tag, ct] = String(stored || '').split('.');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  } catch (e) { return null; }
};

// RFC 4648 base32 (what authenticator apps and otpauth:// URIs expect).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (buf) => {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

// A fresh secret for enrolment: the encrypted copy is stored, the QR / key is
// shown once and never returned by the API again.
async function newEnrolment(user) {
  const secret = crypto.randomBytes(20);
  const key = base32(secret);
  const otpauthUrl = generateTOTP({ issuer: ISSUER, label: user.username, secret: key });
  return {
    encrypted: encryptSecret(secret),
    otpauthUrl,
    qr: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }),
    manualKey: key.match(/.{1,4}/g).join(' ')
  };
}

const sixDigits = (code) => {
  const s = String(code == null ? '' : code).replace(/\s+/g, '');
  return /^\d{6}$/.test(s) ? s : null;
};
// Time step the code belongs to, or null. `after` rejects replays of a code
// that was already accepted.
async function totpStep(encryptedSecret, code, after) {
  const token = sixDigits(code);
  const secret = decryptSecret(encryptedSecret);
  if (!token || !secret) return null;
  try {
    const r = await totp.verify({ secret, token, crypto: otpCrypto, epochTolerance: EPOCH_TOLERANCE_S, afterTimeStep: after });
    return r.valid ? r.timeStep : null;
  } catch (e) { return null; } // e.g. a last-used step ahead of this server's clock
}

// ===== Recovery codes (one-time, bcrypt-hashed) =====
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const normaliseRecovery = (code) => String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
async function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)]).join('');
    return raw.slice(0, 5) + '-' + raw.slice(5);
  });
  const hashes = await Promise.all(codes.map(c => bcrypt.hash(normaliseRecovery(c), 10)));
  return { codes, hashes };
}

// Checks an authenticator code or a recovery code for an MFA-enabled user and
// burns it (a TOTP step or recovery code is accepted once, even under a race).
// → { ok: true, method: 'totp' | 'recovery', recoveryLeft? } | { ok: false, reused? }
async function verifySecondFactor(user, code) {
  if (!user || !user.mfaEnabled) return { ok: false };
  const last = Number.isSafeInteger(user.mfaLastStep) ? user.mfaLastStep : undefined;
  if (sixDigits(code)) {
    const step = await totpStep(user.mfaSecret, code, last);
    if (step === null) {
      // Valid but already used (e.g. the code that just signed in): refuse,
      // but don't count it as a guess.
      const reused = last !== undefined && (await totpStep(user.mfaSecret, code)) !== null;
      return { ok: false, reused };
    }
    const claim = await col.users.updateOne(
      { _id: user._id, $or: [{ mfaLastStep: { $exists: false } }, { mfaLastStep: { $lt: step } }] },
      { $set: { mfaLastStep: step } }
    );
    return claim.matchedCount ? { ok: true, method: 'totp' } : { ok: false, reused: true };
  }
  const rc = normaliseRecovery(code);
  if (rc.length !== 10) return { ok: false };
  const hashes = Array.isArray(user.mfaRecoveryCodes) ? [...user.mfaRecoveryCodes] : [];
  for (const hash of hashes) {
    if (!(await bcrypt.compare(rc, hash))) continue;
    const claim = await col.users.updateOne({ _id: user._id, mfaRecoveryCodes: hash }, { $pull: { mfaRecoveryCodes: hash } });
    if (!claim.matchedCount) return { ok: false, reused: true };
    return { ok: true, method: 'recovery', recoveryLeft: hashes.length - 1 };
  }
  return { ok: false };
}

// ===== "Password OK, now the code" token (5 minutes) =====
// Deliberately not a staff session: it carries `type` and no `userId`, so
// authenticate() refuses it everywhere except /api/admin/login/mfa.
const signMfaPending = (user) => jwt.sign(
  { type: 'mfa_pending', mfaUid: String(user._id), tv: user.tokenVersion || 0 },
  JWT_SECRET, { expiresIn: MFA_PENDING_TTL, algorithm: 'HS256' }
);
const readMfaPending = (token) => {
  try {
    const d = jwt.verify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'] });
    return d && d.type === 'mfa_pending' && d.mfaUid ? d : null;
  } catch (e) { return null; }
};

// ===== Per-account lockout =====
const lockedForMs = (user) => (user && user.loginLockedUntil ? new Date(user.loginLockedUntil).getTime() - Date.now() : 0);
const lockedMessage = (ms) => `Too many wrong attempts. Try again in ${Math.ceil(ms / 60000)} min.`;
async function noteFailedAttempt(req, user, action, details) {
  auditLog(req, action, details, user.username);
  await col.users.updateOne({ _id: user._id }, { $inc: { failedLogins: 1 } });
  const fresh = await col.users.findOne({ _id: user._id });
  if ((fresh && fresh.failedLogins || 0) >= STAFF_MAX_FAILED_LOGINS) {
    await col.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, loginLockedUntil: new Date(Date.now() + STAFF_LOCK_MS) } });
    auditLog(req, 'account_locked', `${user.username} locked for 15 min after ${STAFF_MAX_FAILED_LOGINS} failed attempts`, user.username);
    sendPushToStaff('🔒 Account locked', `Staff account "${user.username}" was locked after ${STAFF_MAX_FAILED_LOGINS} failed sign-in attempts.`);
  }
}
const clearFailedAttempts = (user) => (user.failedLogins || user.loginLockedUntil)
  ? col.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { loginLockedUntil: '' } })
  : Promise.resolve();

// ===== Step-up re-authentication =====
// For destructive actions a stolen or unattended session isn't enough: the
// request body must carry the account's current password (`currentPassword`)
// and, when two-step sign-in is on, a fresh authenticator or recovery code
// (`mfaCode`). Failures count toward the account lockout. Use after authenticate.
async function requireReauth(req, res, next) {
  try {
    const user = await col.users.findOne(idFilter(req.user.userId));
    if (!user) return res.status(401).json({ error: 'Your session has ended — please sign in again.', sessionRevoked: true });
    const body = req.body || {};
    const need = { reauthRequired: true, mfaRequired: !!user.mfaEnabled };
    const locked = lockedForMs(user);
    if (locked > 0) return res.status(429).json({ error: lockedMessage(locked), locked: true, ...need });
    if (!body.currentPassword || (user.mfaEnabled && !body.mfaCode)) {
      return res.status(403).json({ error: user.mfaEnabled ? 'Confirm with your password and authenticator code.' : 'Confirm with your password.', ...need });
    }
    const route = `${req.method} ${String(req.originalUrl || '').split('?')[0]}`;
    if (!(await bcrypt.compare(String(body.currentPassword), user.password))) {
      await noteFailedAttempt(req, user, 'reauth_failed', `Wrong password confirming ${route}`);
      return res.status(403).json({ error: 'Your password is incorrect.', ...need });
    }
    if (user.mfaEnabled) {
      const r = await verifySecondFactor(user, body.mfaCode);
      if (!r.ok) {
        if (r.reused) return res.status(403).json({ error: 'That code was already used — wait for the next one.', ...need });
        await noteFailedAttempt(req, user, 'reauth_failed', `Wrong authenticator code confirming ${route}`);
        return res.status(403).json({ error: 'That code is wrong or expired.', ...need });
      }
      if (r.method === 'recovery') auditLog(req, 'mfa_recovery_code_used', `${user.username} used a recovery code for ${route} (${r.recoveryLeft} left)`);
    }
    await clearFailedAttempts(user);
    delete body.currentPassword;
    delete body.mfaCode;
    next();
  } catch (e) {
    console.error('requireReauth failed:', e.message);
    res.status(500).json({ error: 'Could not confirm it is you' });
  }
}

// Fields that must never leave the server in a user listing.
const MFA_PRIVATE_FIELDS = ['mfaSecret', 'mfaPendingSecret', 'mfaPendingAt', 'mfaRecoveryCodes', 'mfaLastStep'];

module.exports = {
  MFA_ROLES, RECOVERY_CODE_COUNT, ENROL_WINDOW_MS, STAFF_MAX_FAILED_LOGINS, STAFF_LOCK_MS, MFA_PRIVATE_FIELDS,
  encryptSecret, decryptSecret, newEnrolment, totpStep, newRecoveryCodes, verifySecondFactor,
  signMfaPending, readMfaPending, lockedForMs, lockedMessage, noteFailedAttempt, clearFailedAttempts, requireReauth
};
