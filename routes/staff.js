// Staff accounts, sessions and branches.
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authorize, forgetStaffSession, signStaffToken } = require('../lib/auth');
const { col } = require('../lib/db');
const { authLimiter } = require('../lib/limiters');
const { sendPushToStaff } = require('../lib/notifications');
const { idFilter } = require('../lib/util');

// Staff-account brute-force lock (on top of the per-IP authLimiter).
const STAFF_MAX_FAILED_LOGINS = 5;
const STAFF_LOCK_MS = 15 * 60 * 1000;
// Compared against when the username doesn't exist, so a miss costs the same
// bcrypt time as a wrong password (no username enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('blitzmall-timing-equaliser', 10);
// New staff passwords: 8+ characters (bcrypt only reads the first 72 bytes).
const MIN_PASSWORD = 8;
const passwordProblem = (pw) => {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (Buffer.byteLength(s) > 72) return 'Password is too long (max 72 characters)';
  return null;
};

module.exports = function register(app) {
  // Helper branchFilter definition moved to top level

  // ===== USERS & JWT AUTH =====

  const VALID_PERMISSIONS = ['sales', 'inventory', 'orders', 'records', 'expenses', 'credit', 'reviews', 'loyalty', 'deliveries', 'suppliers', 'stocktake', 'tax'];
  const DEFAULT_PERMISSIONS = {
    cashier: ['sales'],
    staff: ['inventory', 'orders', 'expenses', 'reviews', 'loyalty'],
    manager: ['sales', 'inventory', 'orders', 'records', 'expenses', 'credit', 'reviews', 'loyalty', 'deliveries', 'suppliers', 'stocktake'],
    // Riders only see their delivery run sheet.
    rider: ['deliveries']
  };
  const STAFF_ROLES = ['cashier', 'manager', 'staff', 'rider'];
  const publicUser = (u) => ({ name: u.name, role: u.role, username: u.username, branchId: u.branchId || null, permissions: u.permissions || [] });

  // Seed / create first owner. Only possible while the (real) database has no
  // owner — production no longer falls back to an empty file DB (see connectDb).
  app.post('/api/admin/setup', authLimiter, async (req, res) => {
    const { username, password, name } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (passwordProblem(password)) return res.status(400).json({ error: passwordProblem(password) });
    try {
      const existing = await col.users.findOne({ role: 'owner' });
      if (existing) return res.status(400).json({ error: 'Owner already exists. Login instead.' });
      const hashed = await bcrypt.hash(String(password), 10);
      await col.users.insertOne({
        username: String(username).toLowerCase().trim(),
        password: hashed,
        name: String(name || username).trim(),
        role: 'owner',
        branchId: null, // owner has no branch
        tokenVersion: 0,
        createdAt: new Date(),
      });
      console.log('👑 Owner account created:', username);
      res.json({ success: true, message: 'Owner account created! You can now login.' });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create owner' }); }
  });

  // JWT Login. Besides the per-IP authLimiter, each account locks for 15
  // minutes after 5 wrong passwords (persisted on the user, so a restart or a
  // botnet of IPs can't reset it), and every failure is audit-logged. Unknown
  // usernames still pay for a bcrypt compare so response timing doesn't reveal
  // which usernames exist.
  app.post('/api/admin/login', authLimiter, async (req, res) => {
    let { username, password } = req.body;
    if (!username && password) {
      username = 'owner';
    }
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const uname = String(username).toLowerCase().trim().slice(0, 60);
    try {
      const userCount = await col.users.countDocuments();
      if (userCount === 0) {
        return res.status(401).json({ error: 'No owner account found. Create one first.', needsSetup: true });
      }
      const user = await col.users.findOne({ username: uname });
      const lockedFor = user && user.loginLockedUntil ? new Date(user.loginLockedUntil).getTime() - Date.now() : 0;
      if (lockedFor > 0) {
        auditLog(req, 'login_blocked_locked', `Sign-in attempt on locked account ${uname}`, uname);
        return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(lockedFor / 60000)} min.`, locked: true });
      }
      const match = await bcrypt.compare(String(password), user ? user.password : DUMMY_HASH);
      if (!user || !match) {
        auditLog(req, 'login_failed', `Wrong ${user ? 'password' : 'username'} for "${uname}"`, uname);
        if (user) {
          await col.users.updateOne({ _id: user._id }, { $inc: { failedLogins: 1 } });
          const fresh = await col.users.findOne({ _id: user._id });
          if ((fresh && fresh.failedLogins || 0) >= STAFF_MAX_FAILED_LOGINS) {
            await col.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, loginLockedUntil: new Date(Date.now() + STAFF_LOCK_MS) } });
            auditLog(req, 'account_locked', `${uname} locked for 15 min after ${STAFF_MAX_FAILED_LOGINS} wrong passwords`, uname);
            sendPushToStaff('🔒 Account locked', `Staff account "${uname}" was locked after ${STAFF_MAX_FAILED_LOGINS} wrong passwords.`);
          }
        }
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (user.failedLogins || user.loginLockedUntil) await col.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { loginLockedUntil: '' } });
      auditLog(req, 'login_success', `${user.username} (${user.role}) signed in`, user.username);
      res.json({ success: true, token: signStaffToken(user), user: publicUser(user) });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
  });

  // Verify token (role/permissions are read fresh from the database)
  app.get('/api/admin/me', authenticate, async (req, res) => {
    res.json({ success: true, user: publicUser(req.user) });
  });

  // Settings → My account: change my own password. Every other device is
  // signed out; this device gets a fresh token so it stays signed in.
  app.post('/api/admin/me/password', authenticate, authLimiter, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (passwordProblem(newPassword)) return res.status(400).json({ error: 'New ' + passwordProblem(newPassword).toLowerCase() });
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      if (!user || !(await bcrypt.compare(String(currentPassword), user.password))) {
        return res.status(400).json({ error: 'Your current password is incorrect' });
      }
      const nextVersion = (user.tokenVersion || 0) + 1;
      await col.users.updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(String(newPassword), 10), tokenVersion: nextVersion, passwordChangedAt: new Date() } });
      forgetStaffSession(user._id);
      auditLog(req, 'password_changed', `${user.username} changed their password`);
      res.json({ success: true, token: signStaffToken({ ...user, tokenVersion: nextVersion }), message: 'Password changed — other devices were signed out.' });
    } catch (e) { console.error('Change password failed:', e); res.status(500).json({ error: 'Failed to change password' }); }
  });

  // Settings → Security: sign me out of every device (including this one).
  app.post('/api/admin/me/logout-all', authenticate, async (req, res) => {
    try {
      await col.users.updateOne(idFilter(req.user.userId), { $inc: { tokenVersion: 1 } });
      forgetStaffSession(req.user.userId);
      await col.notification_tokens.deleteMany({ role: 'staff', staffUser: req.user.username });
      auditLog(req, 'sessions_revoked', `${req.user.username} signed out of all devices`);
      res.json({ success: true });
    } catch (e) { console.error('logout-all failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Create cashier/manager users (owner only, now with branchId)
  app.post('/api/admin/users', authenticate, authorize('owner'), async (req, res) => {
    const { username, password, name, role, branchId, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (passwordProblem(password)) return res.status(400).json({ error: passwordProblem(password) });
    if (role && !STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Role must be cashier, manager, staff or rider' });
    const userPermissions = Array.isArray(permissions)
      ? [...new Set(permissions.filter(p => VALID_PERMISSIONS.includes(p)))]
      : (DEFAULT_PERMISSIONS[role] || ['sales']);

    try {
      const existing = await col.users.findOne({ username: String(username).toLowerCase().trim() });
      if (existing) return res.status(400).json({ error: 'Username already exists' });
      const hashed = await bcrypt.hash(String(password), 10);
      const r = await col.users.insertOne({
        username: String(username).toLowerCase().trim(),
        password: hashed,
        name: String(name || username).trim(),
        role: role || 'cashier',
        branchId: branchId || null,
        permissions: userPermissions,
        tokenVersion: 0,
        createdAt: new Date(),
      });
      auditLog(req, 'user_created', `Created ${role || 'cashier'} ${username}`);
      res.json({ success: true, userId: r.insertedId, message: `${role || 'cashier'} created!` });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create user' }); }
  });

  // List all users
  app.get('/api/admin/users', authenticate, authorize('owner'), async (req, res) => {
    try {
      const users = await col.users.find({}, { projection: { password: 0 } }).sort({ createdAt: 1 }).toArray();
      res.json(users.map(({ password, ...u }) => u));
    } catch (e) { console.error('Failed to fetch users:', e); res.status(500).json({ error: 'Failed to fetch users' }); }
  });

  // Change a user's role / permissions / branch / password. Any change that
  // affects access also signs the user out of every device.
  app.put('/api/admin/users/:userId', authenticate, authorize('owner'), async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.params.userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { name, role, branchId, permissions, password } = req.body || {};
      const u = {};
      if (name !== undefined) u.name = String(name).trim();
      if (role !== undefined && user.role !== 'owner') {
        if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Role must be cashier, manager, staff or rider' });
        u.role = role;
      }
      if (branchId !== undefined) u.branchId = branchId || null;
      if (Array.isArray(permissions)) u.permissions = [...new Set(permissions.filter(p => VALID_PERMISSIONS.includes(p)))];
      if (password !== undefined) {
        if (passwordProblem(password)) return res.status(400).json({ error: passwordProblem(password) });
        u.password = await bcrypt.hash(String(password), 10);
      }
      const accessChanged = u.role !== undefined || u.permissions !== undefined || u.branchId !== undefined || u.password !== undefined;
      await col.users.updateOne({ _id: user._id }, accessChanged ? { $set: u, $inc: { tokenVersion: 1 } } : { $set: u });
      forgetStaffSession(user._id);
      auditLog(req, 'user_updated', `Updated ${user.username}${accessChanged ? ' (sessions revoked)' : ''}`);
      res.json({ success: true, sessionsRevoked: accessChanged });
    } catch (e) { console.error('Failed to update user:', e); res.status(500).json({ error: 'Failed to update user' }); }
  });

  // Sign a user out of every device right now (lost phone, suspicious activity).
  app.post('/api/admin/users/:userId/revoke-sessions', authenticate, authorize('owner'), async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.params.userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      await col.users.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
      forgetStaffSession(user._id);
      await col.notification_tokens.deleteMany({ role: 'staff', staffUser: user.username });
      auditLog(req, 'sessions_revoked', `Signed ${user.username} out of all devices`);
      res.json({ success: true });
    } catch (e) { console.error('Failed to revoke sessions:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Delete a user — their existing tokens die with the account.
  app.delete('/api/admin/users/:userId', authenticate, authorize('owner'), async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.params.userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (String(user._id) === String(req.user.userId)) return res.status(400).json({ error: "You can't delete your own account" });
      await col.users.deleteOne({ _id: user._id });
      forgetStaffSession(user._id);
      await col.notification_tokens.deleteMany({ role: 'staff', staffUser: user.username });
      auditLog(req, 'user_deleted', `Deleted ${user.username}`);
      res.json({ success: true });
    } catch (e) { console.error('Failed to delete user:', e); res.status(500).json({ error: 'Failed to delete user' }); }
  });

  // ===== BRANCHES (owner only) =====
  app.post('/api/admin/branches', authenticate, authorize('owner'), async (req, res) => {
    const { name, location, phone, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Branch name required' });
    try {
      const r = await col.branches.insertOne({ name: name.trim(), location: location || '', phone: phone || '', email: email || '', active: true, createdAt: new Date() });
      res.json({ success: true, branchId: r.insertedId });
    } catch (e) { console.error('Failed to create branch:', e); res.status(500).json({ error: 'Failed to create branch' }); }
  });

  app.get('/api/admin/branches', authenticate, async (req, res) => {
    try { res.json(await col.branches.find().sort({ name: 1 }).toArray()); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });

  app.put('/api/admin/branches/:id', authenticate, authorize('owner'), async (req, res) => {
    try {
      const { name, location, phone, email, active } = req.body;
      const u = {};
      if (name !== undefined) u.name = name.trim();
      if (location !== undefined) u.location = location;
      if (phone !== undefined) u.phone = phone;
      if (email !== undefined) u.email = email;
      if (active !== undefined) u.active = active;
      await col.branches.updateOne({ _id: new ObjectId(req.params.id) }, { $set: u });
      res.json({ success: true });
    } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Failed' }); }
  });

  app.delete('/api/admin/branches/:id', authenticate, authorize('owner'), async (req, res) => {
    try { const r = await col.branches.deleteOne({ _id: new ObjectId(req.params.id) }); if (!r.deletedCount) return res.status(404).json({ error: 'Branch not found' }); res.json({ success: true }); }
    catch { res.status(500).json({ error: 'Failed' }); }
  });

};
