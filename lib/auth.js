// Staff and customer sessions, permission gates and the audit log.
const jwt = require('jsonwebtoken');
const { CUSTOMER_JWT_EXPIRES, JWT_SECRET } = require('./config');
const { col } = require('./db');
const { idFilter } = require('./util');

const bearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1] || null;
};
const verifyJwt = (token) => {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
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

const RIDER_PATHS = [/^\/api\/admin\/me(\/|$)/, /^\/api\/admin\/rider\//];
const authenticate = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const decoded = verifyJwt(token);
  // A customer session must never open a staff route.
  if (!decoded || decoded.type === 'customer' || !decoded.userId) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const user = await loadStaffUser(decoded.userId);
    if (!user || (user.tokenVersion || 0) !== (decoded.tv || 0)) {
      return res.status(401).json({ error: 'Your session has ended — please sign in again.', sessionRevoked: true });
    }
    // Role, branch and permissions always come from the database, never from
    // the (possibly years-old) token.
    req.user = {
      userId: String(user._id), username: user.username, name: user.name, role: user.role,
      branchId: user.branchId || null, permissions: Array.isArray(user.permissions) ? user.permissions : []
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
// A customer proves they own their phone number with an SMS code, and only then
// receives a signed customer token. Every customer endpoint reads the phone
// number FROM THAT TOKEN — never from the URL or request body — so knowing
// someone's number is no longer enough to see or spend their account.
const signCustomerToken = (phone, tv) =>
  jwt.sign({ type: 'customer', phone, tv: tv || 0 }, JWT_SECRET, { expiresIn: CUSTOMER_JWT_EXPIRES });

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
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Permission-based gate for routes the frontend already shows to staff.
// Owner always passes; anyone else must hold the named permission in their
// permissions array (the same list that decides which tabs staff see, e.g.
// the Inventory tab on the phone POS). Keeps the server consistent with the UI.
const requirePermission = (...perms) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'owner') return next();
    if (Array.isArray(req.user.permissions) && perms.some(p => req.user.permissions.includes(p))) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

// Lightweight audit trail — every money/security-sensitive admin action is
// recorded (fire-and-forget so a logging hiccup can never break a request).
// Readable from the Admin → Delete tab (audit_logs record type).
async function auditLog(req, action, details) {
  try {
    if (!col.audit_logs) return;
    await col.audit_logs.insertOne({
      action: String(action || '').slice(0, 80),
      details: String(details || '').slice(0, 400),
      by: req.user ? (req.user.name || req.user.username || 'unknown') : 'system',
      byRole: req.user ? (req.user.role || '') : 'system',
      ip: (req.ip || '').slice(0, 64),
      createdAt: new Date()
    });
  } catch (e) { console.error('auditLog failed:', e.message); }
}

// Staff identity without failing the request (routes open to staff AND
// customers decide for themselves what each may do).
async function staffFromRequest(req) {
  const decoded = verifyJwt(bearerToken(req));
  if (!decoded || decoded.type === 'customer' || !decoded.userId) return null;
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

module.exports = { bearerToken, verifyJwt, STAFF_CACHE_MS, staffCache, forgetStaffSession, loadStaffUser, authenticate, signCustomerToken, customerFromRequest, CUSTOMER_AUTH_ERROR, authenticateCustomer, optionalCustomer, branchFilter, authorize, requirePermission, auditLog, staffFromRequest, logAction };
