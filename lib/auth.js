// Staff and customer sessions, permission gates and the audit log.
const jwt = require('jsonwebtoken');
const { CUSTOMER_JWT_EXPIRES, JWT_EXPIRES, JWT_SECRET, STAFF_RENEW_AFTER_S, STAFF_SESSION_MAX_AGE_S } = require('./config');
const { col } = require('./db');
const { idFilter } = require('./util');

const bearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1] || null;
};
const verifyJwt = (token) => {
  // Pinned to HS256 (what we sign with) so a token can never pick its own algorithm.
  try { return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); } catch (e) { return null; }
};

// Short cache so a busy till doesn't hit the users collection on every scan,
// while a deleted/demoted account still loses access within seconds.
const STAFF_CACHE_MS = 15 * 1000;
const staffCache = new Map(); // userId -> { user, at }
const forgetStaffSession = (userId) => staffCache.delete(String(userId));
async function loadStaffUser(userId) {
  const key = String(userId || '');
  if (!key) return null;
  const hit = staffCache.get(key);
  if (hit && Date.now() - hit.at < STAFF_CACHE_MS) return hit.user;
  const user = col.users ? await col.users.findOne(idFilter(key)) : null;
  staffCache.set(key, { user, at: Date.now() });
  return user;
}

const signStaffToken = (user) => jwt.sign(
  { userId: String(user._id), username: user.username, role: user.role, tv: user.tokenVersion || 0 },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
);

// Staff tokens are judged by their issue time, not just `exp`: builds before
// v0.1.51 signed 10-year tokens, and those must die after 30 idle days too.
const staffTokenAge = (decoded) => Math.floor(Date.now() / 1000) - (decoded.iat || 0);

const RIDER_PATHS = [/^\/api\/admin\/me(\/|$)/, /^\/api\/admin\/rider\//];
const authenticate = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const decoded = verifyJwt(token);
  // Staff sessions carry no `type`: a customer session or a half-finished
  // two-step sign-in ("mfa_pending") must never open a staff route.
  if (!decoded || decoded.type || !decoded.userId) {
    // sessionRevoked: the apps sign out and show the login screen. A session
    // signed by another server (cloud vs the local dev server) lands here too.
    return res.status(401).json({ error: 'Your sign-in isn’t valid on this server — please sign in again.', sessionRevoked: true });
  }
  if (staffTokenAge(decoded) > STAFF_SESSION_MAX_AGE_S) {
    return res.status(401).json({ error: 'Your session has expired — please sign in again.', sessionRevoked: true });
  }
  try {
    const user = await loadStaffUser(decoded.userId);
    if (!user || (user.tokenVersion || 0) !== (decoded.tv || 0)) {
      return res.status(401).json({ error: 'Your session has ended — please sign in again.', sessionRevoked: true });
    }
    // Sliding session: hand an active device a fresh 30-day token.
    if (staffTokenAge(decoded) > STAFF_RENEW_AFTER_S) res.setHeader('X-Renewed-Token', signStaffToken(user));
    // Role, branch and permissions always come from the database, never from
    // the (possibly years-old) token.
    req.user = {
      userId: String(user._id), username: user.username, name: user.name, role: user.role,
      branchId: user.branchId || null, permissions: Array.isArray(user.permissions) ? user.permissions : [],
      mfaEnabled: !!user.mfaEnabled
    };
    // Riders get their own run sheet and their account — nothing else of the
    // staff API (no sales figures, customer lists or other orders).
    if (user.role === 'rider' && !RIDER_PATHS.some(rx => rx.test(String(req.originalUrl || '').split('?')[0]))) {
      return res.status(403).json({ error: 'Riders only have access to their deliveries' });
    }
    next();
  } catch (e) {
    console.error('authenticate failed:', e.message);
    res.status(500).json({ error: 'Could not verify your session' });
  }
};

// ===== CUSTOMER SESSIONS =====
// A customer signs in with their phone number and PIN, and only then
// receives a signed customer token. Every customer endpoint reads the phone
// number FROM THAT TOKEN — never from the URL or request body — so knowing
// someone's number is no longer enough to see or spend their account.
const signCustomerToken = (phone, tv) =>
  jwt.sign({ type: 'customer', phone, tv: tv || 0 }, JWT_SECRET, { expiresIn: CUSTOMER_JWT_EXPIRES, algorithm: 'HS256' });

async function customerFromRequest(req) {
  const decoded = verifyJwt(bearerToken(req));
  if (!decoded || decoded.type !== 'customer' || !decoded.phone) return null;
  const cust = col.customers ? await col.customers.findOne({ phone: String(decoded.phone) }) : null;
  if (!cust || (cust.tokenVersion || 0) !== (decoded.tv || 0)) return null;
  return String(cust.phone);
}

const CUSTOMER_AUTH_ERROR = { error: 'Please sign in again to continue.', authRequired: true };
const authenticateCustomer = async (req, res, next) => {
  try {
    const phone = await customerFromRequest(req);
    if (!phone) return res.status(401).json(CUSTOMER_AUTH_ERROR);
    req.customerPhone = phone;
    next();
  } catch (e) {
    console.error('authenticateCustomer failed:', e.message);
    res.status(500).json({ error: 'Could not verify your session' });
  }
};
// Same, but anonymous visitors are let through with req.customerPhone = null.
const optionalCustomer = async (req, res, next) => {
  try { req.customerPhone = await customerFromRequest(req); } catch (e) { req.customerPhone = null; }
  next();
};

// Helper: extract branchId from query/body/user
const branchFilter = (req) => {
  // If user is owner and no branch specified, return {} (view all)
  // If user is owner and branch specified, filter by it
  // If user is manager/cashier, filter by their branch
  if (req.user.role === 'owner') {
    const b = req.query.branchId || req.body?.branchId;
    return b ? { branchId: b } : {};
  }
  // Manager/cashier only see their branch
  return req.user.branchId ? { branchId: req.user.branchId } : {};
};

// ===== JWT AUTH MIDDLEWARE =====

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      if (req.user) logDenied(req, roles.join(' or '));
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Permission-based gate for routes the frontend already shows to staff.
// Owner always passes; anyone else must hold the named permission in their
// permissions array (the same list that decides which tabs staff see, e.g.
// the Inventory tab on the phone POS). Keeps the server consistent with the UI.
const hasPermission = (user, ...perms) => !!user && (user.role === 'owner' ||
  (Array.isArray(user.permissions) && perms.some(p => user.permissions.includes(p))));
// Access-denied events are audit-logged, once per account + route every 10
// minutes, so an app screen that polls (or a probing script) can't flood the log.
const DENIED_LOG_MS = 10 * 60 * 1000;
const deniedLogged = new Map();
function logDenied(req, needs) {
  const route = `${req.method} ${String(req.originalUrl || '').split('?')[0]}`;
  const key = `${req.user ? req.user.userId : '-'}|${route}`;
  const last = deniedLogged.get(key) || 0;
  if (Date.now() - last < DENIED_LOG_MS) return;
  deniedLogged.set(key, Date.now());
  if (deniedLogged.size > 5000) deniedLogged.clear();
  auditLog(req, 'permission_denied', `${route} (needs ${needs})`);
}
const requirePermission = (...perms) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasPermission(req.user, ...perms)) return next();
    logDenied(req, perms.join(' or '));
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

// Lightweight audit trail — every money/security-sensitive admin action is
// recorded (fire-and-forget so a logging hiccup can never break a request).
// Readable by the owner only (Staff tab); it can't be wiped from the Delete tab.
// `actor` names who acted when there is no session yet (e.g. a failed login).
async function auditLog(req, action, details, actor) {
  try {
    if (!col.audit_logs) return;
    await col.audit_logs.insertOne({
      action: String(action || '').slice(0, 80),
      details: String(details || '').slice(0, 400),
      by: actor ? String(actor).slice(0, 60) : req.user ? (req.user.name || req.user.username || 'unknown') : 'system',
      byRole: req.user ? (req.user.role || '') : (actor ? 'anonymous' : 'system'),
      userId: req.user ? req.user.userId || null : null,
      ip: (req.ip || '').slice(0, 64),
      createdAt: new Date(),
      timestamp: new Date()
    });
  } catch (e) { console.error('auditLog failed:', e.message); }
}

// Staff identity without failing the request (routes open to staff AND
// customers decide for themselves what each may do).
async function staffFromRequest(req) {
  const decoded = verifyJwt(bearerToken(req));
  if (!decoded || decoded.type || !decoded.userId) return null;
  if (staffTokenAge(decoded) > STAFF_SESSION_MAX_AGE_S) return null;
  const user = await loadStaffUser(decoded.userId);
  if (!user || (user.tokenVersion || 0) !== (decoded.tv || 0)) return null;
  return { userId: String(user._id), username: user.username, name: user.name, role: user.role, branchId: user.branchId || null, permissions: user.permissions || [] };
}

// Audit log helper
const logAction = async (userId, username, action, details, branchId = null) => {
  try {
    if (col.audit_logs) {
      await col.audit_logs.insertOne({
        userId,
        username,
        action,
        details,
        branchId,
        timestamp: new Date()
      });
    }
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
};

module.exports = { bearerToken, verifyJwt, STAFF_CACHE_MS, staffCache, forgetStaffSession, loadStaffUser, signStaffToken, authenticate, signCustomerToken, customerFromRequest, CUSTOMER_AUTH_ERROR, authenticateCustomer, optionalCustomer, branchFilter, authorize, hasPermission, requirePermission, auditLog, staffFromRequest, logAction };
