// Customer sign-in: SMS one-time codes and customer sessions.
const crypto = require('crypto');
const { authenticateCustomer, signCustomerToken } = require('../lib/auth');
const { createCustomerAccount, ensureReferralCode } = require('../lib/customers');
const { col } = require('../lib/db');
const { authLimiter, otpLimiter } = require('../lib/limiters');
const { OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_MS, OTP_TTL_MS, genOtp, hashOtp, otpScreenFallback, otpStore, sendOtpSms } = require('../lib/sms');
const { cleanPhone, isValidPhone } = require('../lib/util');

module.exports = function register(app) {
  app.post('/api/auth', authLimiter, async (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    try {
      const phoneClean = cleanPhone(phone);
      if (!isValidPhone(phoneClean)) return res.status(400).json({ error: 'Valid phone number required' });
      const existingCust = await col.customers.findOne({ phone: phoneClean });
      const prev = otpStore.get(phoneClean);
      const wait = prev ? OTP_RESEND_COOLDOWN_MS - (Date.now() - prev.lastSentAt) : 0;
      if (wait > 0) {
        return res.status(429).json({ success: false, otpRequired: true, returning: !!existingCust, phone: phoneClean, resendAfter: Math.ceil(wait / 1000), error: 'A code was just sent — please wait before requesting another.' });
      }
      const code = genOtp();
      otpStore.set(phoneClean, {
        codeHash: hashOtp(code, phoneClean),
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: Date.now()
      });
      const sentOk = await sendOtpSms(phoneClean, code);
      if (!sentOk && !otpScreenFallback()) {
        // Secure mode: no SMS, no sign-in. The cooldown entry stays so a script
        // can't burn SMS credit by hammering this endpoint.
        return res.status(503).json({
          success: false, smsDelivered: false, resendAfter: OTP_RESEND_COOLDOWN_MS / 1000,
          error: "We couldn't send your SMS code right now. Please try again in a minute."
        });
      }
      return res.json({
        success: false, otpRequired: true, returning: !!existingCust, phone: phoneClean,
        resendAfter: OTP_RESEND_COOLDOWN_MS / 1000,
        smsDelivered: sentOk,
        // Only while the temporary screen fallback is on (see otpScreenFallback).
        devOtp: sentOk ? undefined : code,
        message: sentOk
          ? 'We sent a 6-digit code — enter it to finish signing in.'
          : 'The SMS could not be delivered — use the code shown on screen to finish signing in.'
      });
    } catch (err) {
      console.error('auth error:', err);
      res.status(500).json({ error: 'Sign-in failed. Please try again.' });
    }
  });

  app.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
    const { phone, otp, name, referralCode } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and code required' });
    try {
      const phoneClean = cleanPhone(phone);
      const code = String(otp).trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code' });
      const entry = otpStore.get(phoneClean);
      if (!entry || !entry.codeHash) return res.status(400).json({ error: 'No pending code for this number — request a new one.' });
      if (Date.now() > entry.expiresAt) {
        otpStore.delete(phoneClean);
        return res.status(400).json({ error: 'Code expired — request a new one.' });
      }
      if (entry.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(phoneClean);
        return res.status(400).json({ error: 'Too many wrong attempts — request a new code.' });
      }
      const given = Buffer.from(hashOtp(code, phoneClean));
      const expected = Buffer.from(entry.codeHash);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        entry.attempts += 1; // stored entry is the same object — persists
        return res.status(400).json({ error: 'Incorrect code. Please try again.' });
      }
      // Verified! Burn the code (keeping the resend cooldown) and sign in.
      otpStore.set(phoneClean, { lastSentAt: entry.lastSentAt });
      const { referralBonus, existing } = await createCustomerAccount(name || '', phoneClean, referralCode);
      const cust = await col.customers.findOne({ phone: phoneClean });
      const myReferralCode = await ensureReferralCode(cust);
      const token = signCustomerToken(phoneClean, cust ? cust.tokenVersion : 0);
      const orderCount = await col.orders.countDocuments({ customerId: phoneClean });
      res.json({
        success: true, token, customerId: phoneClean, name: (cust && cust.name) || name || '',
        returning: existing || orderCount > 0, referralCode: myReferralCode,
        message: `Welcome ${name || ''}!`, referralBonus
      });
    } catch (err) {
      console.error('verify-otp error:', err);
      res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
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

};
