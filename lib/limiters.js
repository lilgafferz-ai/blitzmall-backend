// Rate limiters (per-IP / per-phone caps for every sensitive endpoint).
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { IS_TEST } = require('./config');

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Lift the per-IP cap under Jest too (see IS_TEST note above): the whole
  // suite shares one IP and one cached server instance, so the global budget
  // of 200 requests is exhausted mid-suite and later tests (e.g. the OTP
  // referral test) get a bare 429 with no body fields. Production keeps 200.
  max: IS_TEST ? 100000 : 200, // Limit each IP to 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_TEST ? 1000 : 20, // Strict limit for auth routes
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP verification is the money route of phone-verified sign-in — cap it per
// IP so a scripted client can't brute-force 6-digit codes (each code also has
// its own 5-attempt cap server-side).
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_TEST ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

// ---- Anti-abuse limiters for the money/value endpoints ----
// Spinning/scratching is free money if spammed — one promo attempt per 10
// seconds per IP, and wallet conversions are capped per minute so a scripted
// client can't brute-force the conversion repeatedly.
// Under Jest, the whole suite shares one IP and fires requests in bursts, so
// the per-IP caps are lifted (the per-phone/duplicate logic still applies).
// (IS_TEST is hoisted near the top — see above.)
const promosLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: IS_TEST ? 1000 : 2, // 2 promo attempts per 10s per IP (one tap + one accidental double-tap)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many promo attempts. Please wait a moment.' }
});
const walletLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: IS_TEST ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wallet operations. Please try again shortly.' }
});
// Tight per-phone guard on placing orders (the 60s duplicate check below also
// applies; this stops a scripted client from spraying orders from many phones).
const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: IS_TEST ? 1000 : 12, // 12 orders/min — plenty for a real shopper, brutal for a bot
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders from this device. Please wait a moment.' },
  // Key by the signed-in shopper's phone (so a school/hotel/office sharing one
  // IP never trips the cap), falling back to IP.
  keyGenerator: (req) => req.customerPhone || ipKeyGenerator(req.ip || 'unknown')
});

// ---- Rate limiter for public image search endpoint ----
const searchImagesLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image searches. Please wait a moment.', images: [] }
});

// ===== REVIEWS =====
const reviewLimiter = rateLimit({ windowMs: 60 * 1000, max: IS_TEST ? 1000 : 5, standardHeaders: true, legacyHeaders: false });

const mpesaPushLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_TEST ? 1000 : 6, // a real checkout needs one or two prompts a minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many payment requests. Please wait a moment.' }
});

const mpesaStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_TEST ? 1000 : 60, // apps poll every 2s for up to 2 minutes
  standardHeaders: true,
  legacyHeaders: false,
});

const aiChatLimiter = rateLimit({ windowMs: 60 * 1000, max: IS_TEST ? 1000 : 30, standardHeaders: true, legacyHeaders: false });

const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // one poller every ~20s per device — plenty of headroom
  standardHeaders: true,
  legacyHeaders: false,
});

const notifRegisterLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Lifted under Jest (whole suite shares one IP — see IS_TEST note near the top).
  max: IS_TEST ? 1000 : 10, // 10 token registrations per minute per IP — stops token stuffing
  standardHeaders: true,
  legacyHeaders: false,
});

// Voucher checks: enough for a shopper typing a code a few times, too few to
// guess other people's codes.
const couponCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_TEST ? 1000 : 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, error: 'Too many voucher checks. Please wait a minute.' }
});

module.exports = { couponCheckLimiter, globalLimiter, authLimiter, otpLimiter, promosLimiter, walletLimiter, orderLimiter, searchImagesLimiter, reviewLimiter, mpesaPushLimiter, mpesaStatusLimiter, aiChatLimiter, feedLimiter, notifRegisterLimiter };
