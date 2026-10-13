// Customer accounts and referral codes.
const crypto = require('crypto');
const { col } = require('./db');
const { REFEREE_BONUS_POINTS, REFERRER_BONUS_POINTS, addLoyaltyPoints } = require('./loyalty');
const { sendPushToPhone } = require('./notifications');
const { cleanPhone } = require('./util');

// Referral codes are random (BM + 6 chars). They used to be the phone number
// itself, which meant every shared invite leaked the sharer's account key.
// Old phone-number codes still credit the referrer (harmless now that a phone
// number alone no longer opens an account).
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genReferralCode = () => 'BM' + Array.from(crypto.randomBytes(6), b => REFERRAL_ALPHABET[b % REFERRAL_ALPHABET.length]).join('');
async function ensureReferralCode(cust) {
  if (!cust) return null;
  if (cust.referralCode) return cust.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = genReferralCode();
    if (await col.customers.findOne({ referralCode: code })) continue;
    await col.customers.updateOne({ phone: cust.phone }, { $set: { referralCode: code } });
    return code;
  }
  return null;
}
async function findReferrer(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (!text) return null;
  if (/^BM[A-Z0-9]{6}$/.test(text)) return col.customers.findOne({ referralCode: text });
  const digits = cleanPhone(text);
  return digits ? col.customers.findOne({ phone: digits }) : null;
}

// Shared account creation (referral-aware). A first sign-in only reaches this
// AFTER the OTP was verified, so referral bonuses are only ever awarded to
// phone-verified accounts. Idempotent: if the account already exists (race),
// it just refreshes the name/lastLogin instead of creating a duplicate.
async function createCustomerAccount(name, phoneClean, referralCodeRaw) {
  const existingCust = await col.customers.findOne({ phone: phoneClean });
  if (existingCust) {
    await col.customers.updateOne(
      { phone: phoneClean },
      { $set: { name: (name || existingCust.name || '').trim(), lastLoginAt: new Date(), phoneVerifiedAt: new Date() } }
    );
    return { existing: true, referralBonus: 0 };
  }
  const newCust = {
    phone: phoneClean, name: (name || '').trim(),
    createdAt: new Date(), lastLoginAt: new Date(), phoneVerifiedAt: new Date(),
    orderCount: 0, totalSpent: 0, tokenVersion: 0, referralCode: genReferralCode()
  };
  let referralBonus = 0;
  // Referral: when a new shopper signs in with a friend's code, BOTH earn bonus
  // loyalty points (once per referred phone — no double dips).
  try {
    const referrer = await findReferrer(referralCodeRaw);
    if (referrer && referrer.phone !== phoneClean && !(Array.isArray(referrer.referrals) && referrer.referrals.includes(phoneClean))) {
      newCust.referredBy = referrer.phone;
      await addLoyaltyPoints(referrer.phone, REFERRER_BONUS_POINTS);
      await col.customers.updateOne(
        { phone: referrer.phone },
        { $addToSet: { referrals: phoneClean }, $inc: { referralCount: 1 } }
      );
      sendPushToPhone(referrer.phone, '🎁 Referral bonus!', `You earned ${REFERRER_BONUS_POINTS} bonus points for referring a friend!`);
    }
  } catch (e) { console.error('Referral award failed:', e); }
  await col.customers.insertOne(newCust);
  if (newCust.referredBy) {
    await addLoyaltyPoints(phoneClean, REFEREE_BONUS_POINTS);
    referralBonus = REFEREE_BONUS_POINTS;
    sendPushToPhone(phoneClean, '🎉 Welcome bonus!', `You got ${REFEREE_BONUS_POINTS} bonus points from your referral code!`);
  }
  return { existing: false, referralBonus };
}

module.exports = { REFERRAL_ALPHABET, genReferralCode, ensureReferralCode, findReferrer, createCustomerAccount };
