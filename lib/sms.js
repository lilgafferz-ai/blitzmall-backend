// One-time sign-in codes and SMS delivery via Africa's Talking.
const crypto = require('crypto');
const { JWT_SECRET } = require('./config');

// Customer sign-in is keyed by PHONE NUMBER: every account's shopping record,
// loyalty points, vouchers and debts live under the phone they sign in with.
// Changing the number means a NEW account (bound to the new number).
//
// EVERY sign-in on a new device — first-time AND returning numbers — must prove
// ownership of the phone with a 6-digit SMS code. Only a verified code earns a
// signed customer token, and every customer endpoint trusts that token instead
// of a phone number in the request (knowing someone's number used to be enough
// to open their account). OTPs live in a short-lived in-memory store: hashed
// with the JWT secret, 10-minute expiry, 5 attempts max, 30s resend cooldown,
// single use.
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// Short on purpose: if the SMS never lands, the customer must not be stranded
// on the code screen — they get a fresh code (and a fresh delivery attempt)
// 30 seconds after the previous request.
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const otpStore = new Map();

// TEMPORARY escape hatch while SMS delivery is not live: when the SMS cannot be
// delivered the code is shown on screen instead, so customers are never locked
// out. That makes the OTP prove nothing (anyone can sign in as any number), so
// it is loudly logged at boot. Turn it OFF with OTP_SCREEN_FALLBACK=false as
// soon as Africa's Talking delivers codes.
function otpScreenFallback() {
  return String(process.env.OTP_SCREEN_FALLBACK || 'true').trim().toLowerCase() !== 'false';
}

const genOtp = () => String(crypto.randomInt(100000, 1000000));
const hashOtp = (code, phone) => crypto.createHmac('sha256', JWT_SECRET).update(`${phone}:${code}`).digest('hex');
// Local 07xxxxxxxx / 01xxxxxxxx -> +2547xxxxxxxx / +2541xxxxxxxx for the SMS
// gateway. Africa's Talking documents the `to` field in international format
// WITH the leading +, so it is emitted that way.
const toIntlPhone = (p) => {
  const d = String(p).replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('254')) return '+' + d;
  if (d.startsWith('0')) return '+254' + d.slice(1);
  return '+254' + d;
};
// Africa's Talking (Nairobi-based, KES billing) via its plain HTTP v1 API — no
// SDK, uses Node's global fetch.
const smsConfigured = () => !!(process.env.AT_USERNAME && process.env.AT_API_KEY);
// The sandbox lives on its own host — the username "sandbox" (or AT_SANDBOX=true)
// switches automatically so a test API key doesn't silently post to production.
const atMessagingUrl = () =>
  ((process.env.AT_SANDBOX === 'true' || process.env.AT_USERNAME === 'sandbox')
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging');
async function sendOtpSms(phone, code) {
  const to = toIntlPhone(phone);
  const message = `Your BlitzMall verification code is ${code}. It expires in 10 minutes. Do not share it.`;
  if (smsConfigured() && to) {
    try {
      const form = new URLSearchParams({ username: process.env.AT_USERNAME, to, message });
      // Kenyan networks only deliver from a REGISTERED alphanumeric Sender ID /
      // shortcode — Africa's Talking's shared default sender is dropped by the
      // network. Set AT_SENDER_ID to the approved ID (leave unset if the account
      // has no approved sender yet; AT will report the rejection).
      if (process.env.AT_SENDER_ID) form.set('from', process.env.AT_SENDER_ID);
      const res = await fetch(atMessagingUrl(), {
        method: 'POST',
        headers: {
          apiKey: process.env.AT_API_KEY,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      });
      const raw = await res.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch (e) { /* non-JSON error page */ }
      // Africa's Talking answers HTTP 200/201 even when the message FAILED per
      // recipient — the real result is in SMSMessageData.Recipients[].status
      // ("Success" | "Failed" with a statusCode: 101 invalid number,
      // 102 insufficient balance, 103 user inactive, 104 sender ID not allowed).
      // Only an explicit per-recipient "Success" counts as delivered.
      const recipients = (payload && payload.SMSMessageData && Array.isArray(payload.SMSMessageData.Recipients))
        ? payload.SMSMessageData.Recipients : [];
      const delivered = res.ok && recipients.some(r => String(r && r.status || '').toLowerCase() === 'success');
      if (!delivered) {
        const detail = recipients.length
          ? recipients.map(r => `${r.number || to}: ${r.status || 'Failed'} (code ${r.statusCode})`).join(', ')
          : `HTTP ${res.status} ${String(raw).slice(0, 200)}`;
        // The code itself is never logged — logs are readable by anyone with
        // dashboard access, and a logged code is a sign-in to that account.
        console.error(`[otp-sms-failed] ${phone} (${detail})`);
        return false;
      }
      console.log(`[otp-sms-sent] ${phone} (${(payload.SMSMessageData && payload.SMSMessageData.Message) || 'delivered'})`);
      return true;
    } catch (e) {
      console.error(`[otp-sms-failed] ${phone} (${e.message})`);
      return false;
    }
  }
  console.log(`[otp-sms-skipped] ${phone} (SMS provider not configured)`);
  return false;
}

module.exports = { OTP_TTL_MS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_MS, otpStore, otpScreenFallback, genOtp, hashOtp, toIntlPhone, smsConfigured, atMessagingUrl, sendOtpSms };
