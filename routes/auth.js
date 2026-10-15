// Customer sign-in: phone + PIN (M-Pesa style) with security-question recovery.
//
// SMS one-time codes were REMOVED — they cost money BlitzMall doesn't have, and
// the "show the code on screen when SMS fails" fallback was a sign-in hole
// (anyone who typed a number was shown its code). A customer now proves
// themselves with a private PIN. The PIN and the recovery answer are slow-hashed
// server-side (lib/customerAuth) and the shop owner can RESET a locked-out
// customer from the admin — never read their PIN. The account always lives under
// the phone number, so a reset never loses wallet money, points or orders.
const { authenticateCustomer, signCustomerToken } = require('../lib/auth');
const { createCustomerAccount, ensureReferralCode } = require('../lib/customers');
const { clearAttempts, hashSecret, isValidPin, lockMsLeft, normalizeAnswer, registerFailedAttempt, verifySecret } = require('../lib/customerAuth');
const { col } = require('../lib/db');
const { authLimiter } = require('../lib/limiters');
const { cleanPhone, isValidPhone } = require('../lib/util');

module.exports = function register(app) {
  // Does this number already have an account / a PIN? Lets the app show the right
  // screen (enter your PIN vs create one). Returns no secrets.
  app.post('/api/auth/check', authLimiter, async (req, res) => {
    try {
      const phone = cleanPhone(req.body.phone);
      if (!isValidPhone(phone)) return res.status(400).json({ error: 'Valid phone number required' });
      const cust = await col.customers.findOne({ phone });
      // Only what the sign-in UI needs — never the name (unauthenticated PII leak
      // + an oracle for targeting money-holding accounts without a PIN). The name
      // is greeted after a successful login (GET /api/auth/me) instead.
      res.json({ exists: !!cust, hasPin: !!(cust && cust.pinHash) });
    } catch (e) { console.error('auth/check error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Create the account's PIN + recovery question. Used for a brand-new sign-up
  // and for an old OTP-era account setting a PIN for the first time. Refuses to
  // overwrite a PIN that already exists: an already-protected account can only be
  // changed by its signed-in owner or reset from the admin — never re-claimed here.
  app.post('/api/auth/enroll', authLimiter, async (req, res) => {
    const { phone, name, pin, securityQuestion, securityAnswer, referralCode } = req.body;
    try {
      const phoneClean = cleanPhone(phone);
      if (!isValidPhone(phoneClean)) return res.status(400).json({ error: 'Valid phone number required' });
      if (!String(name || '').trim()) return res.status(400).json({ error: 'Your name is required' });
      if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
      if (!String(securityQuestion || '').trim() || !normalizeAnswer(securityAnswer)) {
        return res.status(400).json({ error: 'A security question and answer are required' });
      }
      const existing = await col.customers.findOne({ phone: phoneClean });
      if (existing && existing.pinHash) {
        return res.status(409).json({ error: 'This number already has a PIN. Sign in, or use "Forgot PIN".', hasPin: true });
      }
      // Creates the account (new) or refreshes it (legacy OTP account), and runs
      // referral bonuses exactly once for a genuinely new account.
      const { referralBonus } = await createCustomerAccount(name, phoneClean, referralCode);
      const [pinHash, securityAnswerHash] = await Promise.all([
        hashSecret(pin),
        hashSecret(normalizeAnswer(securityAnswer))
      ]);
      await col.customers.updateOne(
        { phone: phoneClean },
        {
          $set: {
            pinHash, pinSetAt: new Date(),
            securityQuestion: String(securityQuestion).trim().slice(0, 120),
            securityAnswerHash, failedPinAttempts: 0, lastLoginAt: new Date()
          },
          $unset: { lockedUntil: '' }
        }
      );
      const cust = await col.customers.findOne({ phone: phoneClean });
      const referralCodeOut = await ensureReferralCode(cust);
      const token = signCustomerToken(phoneClean, cust ? cust.tokenVersion : 0);
      res.json({
        success: true, token, customerId: phoneClean,
        name: (cust && cust.name) || name, referralCode: referralCodeOut, referralBonus
      });
    } catch (e) { console.error('auth/enroll error:', e); res.status(500).json({ error: 'Could not create your PIN. Please try again.' }); }
  });

  // Sign in with phone + PIN. A persistent per-account lockout (lib/customerAuth)
  // stops PIN guessing even across server restarts.
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { phone, pin } = req.body;
    try {
      const phoneClean = cleanPhone(phone);
      if (!isValidPhone(phoneClean) || !isValidPin(pin)) return res.status(400).json({ error: 'Enter your phone number and PIN' });
      const cust = await col.customers.findOne({ phone: phoneClean });
      if (!cust || !cust.pinHash) return res.status(404).json({ error: 'No PIN set for this number — create one.', needsEnroll: true });
      const lockLeft = lockMsLeft(cust);
      if (lockLeft > 0) {
        return res.status(429).json({ error: `Too many wrong tries. Try again in ${Math.ceil(lockLeft / 60000)} min.`, locked: true, retryAfterSec: Math.ceil(lockLeft / 1000) });
      }
      const ok = await verifySecret(pin, cust.pinHash);
      if (!ok) {
        const r = await registerFailedAttempt(phoneClean);
        if (r.locked) return res.status(429).json({ error: 'Too many wrong tries — PIN locked for 15 minutes. Use "Forgot PIN" or ask the shop to reset it.', locked: true, retryAfterSec: r.retryAfterSec });
        return res.status(401).json({ error: `Wrong PIN. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.`, attemptsLeft: r.attemptsLeft });
      }
      await clearAttempts(phoneClean);
      await col.customers.updateOne({ phone: phoneClean }, { $set: { lastLoginAt: new Date() } });
      const referralCode = await ensureReferralCode(cust);
      const token = signCustomerToken(phoneClean, cust.tokenVersion || 0);
      res.json({ success: true, token, customerId: phoneClean, name: cust.name || '', referralCode });
    } catch (e) { console.error('auth/login error:', e); res.status(500).json({ error: 'Sign-in failed. Please try again.' }); }
  });

  // Forgot PIN — step 1: fetch the account's security question to answer.
  app.post('/api/auth/recover', authLimiter, async (req, res) => {
    try {
      const phone = cleanPhone(req.body.phone);
      if (!isValidPhone(phone)) return res.status(400).json({ error: 'Valid phone number required' });
      const cust = await col.customers.findOne({ phone });
      if (!cust || !cust.securityQuestion) {
        return res.status(404).json({ error: 'No recovery question is set for this number. Please contact the shop to recover your account.' });
      }
      res.json({ success: true, securityQuestion: cust.securityQuestion });
    } catch (e) { console.error('auth/recover error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Forgot PIN — step 2: answer the question and set a new PIN. Shares the login
  // lockout; a successful reset bumps tokenVersion so any old/stolen session is
  // signed out. The account (wallet, points, orders) is untouched.
  app.post('/api/auth/reset', authLimiter, async (req, res) => {
    const { phone, securityAnswer, newPin } = req.body;
    try {
      const phoneClean = cleanPhone(phone);
      if (!isValidPhone(phoneClean)) return res.status(400).json({ error: 'Valid phone number required' });
      if (!isValidPin(newPin)) return res.status(400).json({ error: 'New PIN must be 4 to 6 digits' });
      const cust = await col.customers.findOne({ phone: phoneClean });
      if (!cust || !cust.securityAnswerHash) return res.status(404).json({ error: 'No recovery is set for this number. Please contact the shop.' });
      const lockLeft = lockMsLeft(cust);
      if (lockLeft > 0) {
        return res.status(429).json({ error: `Too many wrong tries. Try again in ${Math.ceil(lockLeft / 60000)} min.`, locked: true, retryAfterSec: Math.ceil(lockLeft / 1000) });
      }
      const ok = await verifySecret(normalizeAnswer(securityAnswer), cust.securityAnswerHash);
      if (!ok) {
        const r = await registerFailedAttempt(phoneClean);
        if (r.locked) return res.status(429).json({ error: 'Too many wrong answers — locked for 15 minutes. Please contact the shop to recover your account.', locked: true, retryAfterSec: r.retryAfterSec });
        return res.status(401).json({ error: `Wrong answer. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.`, attemptsLeft: r.attemptsLeft });
      }
      const pinHash = await hashSecret(newPin);
      await col.customers.updateOne(
        { phone: phoneClean },
        { $set: { pinHash, pinSetAt: new Date(), failedPinAttempts: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: '' }, $inc: { tokenVersion: 1 } }
      );
      const fresh = await col.customers.findOne({ phone: phoneClean });
      const referralCode = await ensureReferralCode(fresh);
      const token = signCustomerToken(phoneClean, fresh.tokenVersion || 0);
      res.json({ success: true, token, customerId: phoneClean, name: fresh.name || '', referralCode });
    } catch (e) { console.error('auth/reset error:', e); res.status(500).json({ error: 'Reset failed. Please try again.' }); }
  });

  // Who am I? Lets the app confirm its stored session is still valid.
  app.get('/api/auth/me', authenticateCustomer, async (req, res) => {
    const cust = await col.customers.findOne({ phone: req.customerPhone });
    res.json({ success: true, customerId: req.customerPhone, name: (cust && cust.name) || '' });
  });

  // "Sign out of all devices" — every existing customer token stops working.
  app.post('/api/auth/logout-all', authenticateCustomer, async (req, res) => {
    try {
      await col.customers.updateOne({ phone: req.customerPhone }, { $inc: { tokenVersion: 1 } });
      res.json({ success: true });
    } catch (e) { console.error('logout-all failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Change the PIN while signed in (from the app-lock "Change PIN" / first setup).
  // Keeps this device's session alive — same person, same device — so no
  // tokenVersion bump. Lets a legacy (OTP-era) account set its first server PIN.
  app.post('/api/auth/change-pin', authenticateCustomer, async (req, res) => {
    try {
      const { currentPin, newPin } = req.body;
      if (!isValidPin(newPin)) return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
      const cust = await col.customers.findOne({ phone: req.customerPhone });
      if (!cust) return res.status(404).json({ error: 'Account not found' });
      // Changing an EXISTING PIN requires proving the current one, so a stolen
      // session token alone can't silently take over the account. Setting the
      // FIRST PIN (legacy OTP-era account) needs no current PIN.
      if (cust.pinHash) {
        if (!isValidPin(currentPin) || !(await verifySecret(currentPin, cust.pinHash))) {
          return res.status(401).json({ error: 'Current PIN is incorrect' });
        }
      }
      const pinHash = await hashSecret(newPin);
      await col.customers.updateOne(
        { phone: req.customerPhone },
        { $set: { pinHash, pinSetAt: new Date(), failedPinAttempts: 0 }, $unset: { lockedUntil: '' }, $inc: { tokenVersion: 1 } }
      );
      const fresh = await col.customers.findOne({ phone: req.customerPhone });
      // Bumping tokenVersion signs out other devices; hand THIS device a fresh
      // token so the person who just changed their PIN stays signed in here.
      const token = signCustomerToken(req.customerPhone, fresh.tokenVersion || 0);
      res.json({ success: true, token });
    } catch (e) { console.error('change-pin error:', e); res.status(500).json({ error: 'Failed' }); }
  });
};
