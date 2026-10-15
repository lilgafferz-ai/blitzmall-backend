// Staff accounts, sessions and branches.
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { auditLog, authenticate, authorize, forgetStaffSession, signStaffToken } = require('../lib/auth');
const { col } = require('../lib/db');
const { authLimiter } = require('../lib/limiters');
const { sendPushToStaff } = require('../lib/notifications');
const { idFilter } = require('../lib/util');
const {
  MFA_ROLES, ENROL_WINDOW_MS, MFA_PRIVATE_FIELDS, clearFailedAttempts, lockedForMs, lockedMessage, newEnrolment,
  newRecoveryCodes, noteFailedAttempt, readMfaPending, requireReauth, signMfaPending, totpStep, verifySecondFactor
} = require('../lib/mfa');
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
  const publicUser = (u) => ({ name: u.name, role: u.role, username: u.username, branchId: u.branchId || null, permissions: u.permissions || [], mfaEnabled: !!u.mfaEnabled });
  const withoutSecrets = ({ password, ...u }) => { for (const f of MFA_PRIVATE_FIELDS) delete u[f]; return u; };

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
  // minutes after 5 failures (persisted on the user, so a restart or a
  // botnet of IPs can't reset it), and every failure is audit-logged. Unknown
  // usernames still pay for a bcrypt compare so response timing doesn't reveal
  // which usernames exist. With two-step sign-in on, a correct password only
  // earns a 5-minute "mfa pending" token for /api/admin/login/mfa.
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
      const lockedFor = lockedForMs(user);
      if (lockedFor > 0) {
        auditLog(req, 'login_blocked_locked', `Sign-in attempt on locked account ${uname}`, uname);
        return res.status(429).json({ error: lockedMessage(lockedFor), locked: true });
      }
      const match = await bcrypt.compare(String(password), user ? user.password : DUMMY_HASH);
      if (!user || !match) {
        if (user) await noteFailedAttempt(req, user, 'login_failed', `Wrong password for "${uname}"`);
        else auditLog(req, 'login_failed', `Wrong username for "${uname}"`, uname);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (user.mfaEnabled) {
        // The failed-attempt count is only cleared once the code is right too,
        // so knowing the password doesn't buy unlimited code guesses.
        return res.json({ success: false, mfaRequired: true, mfaToken: signMfaPending(user), error: 'Enter the 6-digit code from your authenticator app.' });
      }
      await clearFailedAttempts(user);
      auditLog(req, 'login_success', `${user.username} (${user.role}) signed in`, user.username);
      res.json({ success: true, token: signStaffToken(user), user: publicUser(user) });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
  });

  // Second sign-in step: the 5-minute token from /api/admin/login plus a code
  // from the authenticator app (or a one-time recovery code). Wrong codes
  // count toward the same 5-try account lock as wrong passwords.
  app.post('/api/admin/login/mfa', authLimiter, async (req, res) => {
    const { mfaToken, code } = req.body || {};
    const pending = readMfaPending(mfaToken);
    const restart = { error: 'Sign-in timed out — enter your password again.', restart: true };
    if (!pending) return res.status(401).json(restart);
    try {
      const user = await col.users.findOne(idFilter(pending.mfaUid));
      if (!user || !user.mfaEnabled || (user.tokenVersion || 0) !== (pending.tv || 0)) return res.status(401).json(restart);
      const lockedFor = lockedForMs(user);
      if (lockedFor > 0) {
        auditLog(req, 'login_blocked_locked', `Code entered on locked account ${user.username}`, user.username);
        return res.status(429).json({ error: lockedMessage(lockedFor), locked: true });
      }
      if (!code) return res.status(400).json({ error: 'Enter the 6-digit code from your authenticator app.' });
      const r = await verifySecondFactor(user, code);
      if (!r.ok) {
        if (r.reused) return res.status(401).json({ error: 'That code was already used — wait for the next one.' });
        await noteFailedAttempt(req, user, 'login_mfa_failed', `Wrong sign-in code for "${user.username}"`);
        return res.status(401).json({ error: 'That code is wrong or expired.' });
      }
      await clearFailedAttempts(user);
      if (r.method === 'recovery') {
        auditLog(req, 'mfa_recovery_code_used', `${user.username} signed in with a recovery code (${r.recoveryLeft} left)`, user.username);
        sendPushToStaff('🔑 Recovery code used', `"${user.username}" signed in with a one-time recovery code (${r.recoveryLeft} left).`);
      }
      auditLog(req, 'login_success', `${user.username} (${user.role}) signed in with ${r.method === 'recovery' ? 'a recovery code' : 'an authenticator code'}`, user.username);
      res.json({ success: true, token: signStaffToken(user), user: publicUser(user), ...(r.method === 'recovery' ? { recoveryCodesLeft: r.recoveryLeft } : {}) });
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

  // ===== TWO-STEP SIGN-IN (TOTP) — Settings → Security =====
  // Owner: optional to start, mandatory once on (it can be moved to a new
  // phone, not switched off). Managers: optional. Other roles can't enrol.
  const mfaStatus = (u) => ({
    available: MFA_ROLES.includes(u.role),
    enabled: !!u.mfaEnabled,
    enabledAt: u.mfaEnabledAt || null,
    recoveryCodesLeft: u.mfaEnabled && Array.isArray(u.mfaRecoveryCodes) ? u.mfaRecoveryCodes.length : 0,
    canDisable: !!u.mfaEnabled && u.role !== 'owner'
  });
  const mfaRoleOnly = (req, res, next) => (MFA_ROLES.includes(req.user.role) ? next()
    : res.status(403).json({ error: 'Two-step sign-in is for the owner and managers.' }));

  app.get('/api/admin/me/mfa', authenticate, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true, ...mfaStatus(user) });
    } catch (e) { console.error('mfa status failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Step 1: confirm it's you, get a new secret as a QR code (and the key for
  // typing in). Only the encrypted secret is stored and it's never shown
  // again. Nothing changes until /activate proves the app has it, so a
  // half-done setup (or moving to a new phone) never locks anyone out.
  app.post('/api/admin/me/mfa/setup', authenticate, mfaRoleOnly, authLimiter, requireReauth, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      const e = await newEnrolment(user);
      await col.users.updateOne({ _id: user._id }, { $set: { mfaPendingSecret: e.encrypted, mfaPendingAt: new Date() } });
      auditLog(req, 'mfa_setup_started', `${user.username} started ${user.mfaEnabled ? 'moving two-step sign-in to a new authenticator' : 'setting up two-step sign-in'}`);
      res.json({ success: true, otpauthUrl: e.otpauthUrl, qr: e.qr, manualKey: e.manualKey });
    } catch (e) { console.error('mfa setup failed:', e); res.status(500).json({ error: 'Failed to start setup' }); }
  });

  // Step 2: the first code from the app switches it on. Recovery codes are
  // returned this once (only bcrypt hashes are kept), and every other device
  // is signed out because those sessions never passed the second step.
  app.post('/api/admin/me/mfa/activate', authenticate, mfaRoleOnly, authLimiter, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      const startedAt = user && user.mfaPendingAt ? new Date(user.mfaPendingAt).getTime() : 0;
      if (!user || !user.mfaPendingSecret || Date.now() - startedAt > ENROL_WINDOW_MS) {
        return res.status(400).json({ error: 'Setup expired — start again.', restart: true });
      }
      const step = await totpStep(user.mfaPendingSecret, (req.body || {}).code);
      if (step === null) {
        auditLog(req, 'mfa_setup_failed', `${user.username} entered a wrong code while setting up two-step sign-in`);
        return res.status(400).json({ error: 'That code is wrong or expired — check the time on your phone and try the newest code.' });
      }
      const { codes, hashes } = await newRecoveryCodes();
      const nextVersion = (user.tokenVersion || 0) + 1;
      const wasEnabled = !!user.mfaEnabled;
      await col.users.updateOne({ _id: user._id }, {
        $set: { mfaEnabled: true, mfaSecret: user.mfaPendingSecret, mfaEnabledAt: new Date(), mfaLastStep: step, mfaRecoveryCodes: hashes, tokenVersion: nextVersion },
        $unset: { mfaPendingSecret: '', mfaPendingAt: '' }
      });
      forgetStaffSession(user._id);
      auditLog(req, wasEnabled ? 'mfa_reset' : 'mfa_enabled', `${user.username} ${wasEnabled ? 'moved two-step sign-in to a new authenticator' : 'turned on two-step sign-in'}`);
      res.json({ success: true, recoveryCodes: codes, token: signStaffToken({ ...user, tokenVersion: nextVersion }) });
    } catch (e) { console.error('mfa activate failed:', e); res.status(500).json({ error: 'Failed to turn on two-step sign-in' }); }
  });

  // Fresh set of recovery codes (the old ones stop working).
  app.post('/api/admin/me/mfa/recovery-codes', authenticate, mfaRoleOnly, authLimiter, requireReauth, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      if (!user.mfaEnabled) return res.status(400).json({ error: 'Two-step sign-in is off.' });
      const { codes, hashes } = await newRecoveryCodes();
      await col.users.updateOne({ _id: user._id }, { $set: { mfaRecoveryCodes: hashes } });
      auditLog(req, 'mfa_recovery_codes_reset', `${user.username} made new recovery codes`);
      res.json({ success: true, recoveryCodes: codes });
    } catch (e) { console.error('mfa recovery codes failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  app.post('/api/admin/me/mfa/disable', authenticate, mfaRoleOnly, authLimiter, requireReauth, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.user.userId));
      if (!user.mfaEnabled) return res.json({ success: true });
      if (user.role === 'owner') return res.status(403).json({ error: 'The owner account must keep two-step sign-in. Use "Move to a new phone" instead.' });
      await col.users.updateOne({ _id: user._id }, { $set: { mfaEnabled: false }, $unset: { mfaSecret: '', mfaRecoveryCodes: '', mfaLastStep: '', mfaEnabledAt: '' } });
      forgetStaffSession(user._id);
      auditLog(req, 'mfa_disabled', `${user.username} turned off two-step sign-in`);
      res.json({ success: true });
    } catch (e) { console.error('mfa disable failed:', e); res.status(500).json({ error: 'Failed' }); }
  });

  // Create cashier/manager users (owner only, now with branchId)
  app.post('/api/admin/users', authenticate, authorize('owner'), requireReauth, async (req, res) => {
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
      res.json(users.map(withoutSecrets));
    } catch (e) { console.error('Failed to fetch users:', e); res.status(500).json({ error: 'Failed to fetch users' }); }
  });

  // Change a user's role / permissions / branch / password, or turn off a
  // manager's two-step sign-in (lost phone). Any change that affects access
  // also signs the user out of every device.
  app.put('/api/admin/users/:userId', authenticate, authorize('owner'), requireReauth, async (req, res) => {
    try {
      const user = await col.users.findOne(idFilter(req.params.userId));
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { name, role, branchId, permissions, password, resetMfa } = req.body || {};
      if (resetMfa && user.role === 'owner') return res.status(400).json({ error: 'The owner moves two-step sign-in from Settings → Security.' });
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
      const mfaReset = !!resetMfa && !!user.mfaEnabled;
      if (mfaReset) u.mfaEnabled = false;
      const accessChanged = mfaReset || u.role !== undefined || u.permissions !== undefined || u.branchId !== undefined || u.password !== undefined;
      const update = accessChanged ? { $set: u, $inc: { tokenVersion: 1 } } : { $set: u };
      if (mfaReset) update.$unset = { mfaSecret: '', mfaRecoveryCodes: '', mfaLastStep: '', mfaEnabledAt: '', mfaPendingSecret: '', mfaPendingAt: '' };
      await col.users.updateOne({ _id: user._id }, update);
      forgetStaffSession(user._id);
      if (mfaReset) auditLog(req, 'mfa_reset_by_owner', `Turned off two-step sign-in for ${user.username}`);
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
