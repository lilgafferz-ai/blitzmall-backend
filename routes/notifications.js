// Device push registration, the notification feed and owner broadcasts.
const { CUSTOMER_AUTH_ERROR, auditLog, authenticate, authorize, customerFromRequest, staffFromRequest } = require('../lib/auth');
const { col } = require('../lib/db');
const { feedLimiter, notifRegisterLimiter } = require('../lib/limiters');
const { fcmConfigured, fcmProject, sendPushToAll, sendPushToPhone, sendPushToStaffUser } = require('../lib/notifications');
const { samePhone } = require('../lib/util');

module.exports = function register(app) {
  // Polled by the Electron PC app (admin=1) — returns events newer than `since`.
  // The admin feed is deliberately PII-free (the desktop shell polls it without
  // a session). A customer's own feed (order totals, prizes, vouchers) needs
  // their signed-in session.
  app.get('/api/notifications/feed', feedLimiter, async (req, res) => {
    try {
      let since = null;
      if (req.query.since) { const d = new Date(String(req.query.since)); if (!isNaN(d.getTime())) since = d; }
      const wantAdmin = req.query.admin === '1';
      let phone = null;
      if (!wantAdmin) {
        phone = await customerFromRequest(req);
        if (!phone) return res.status(401).json(CUSTOMER_AUTH_ERROR);
        if (req.query.phone && !samePhone(req.query.phone, phone)) return res.status(403).json({ error: 'Not your account' });
      }
      const q = { createdAt: { $gt: since || new Date(Date.now() - 7 * 24 * 3600 * 1000) } };
      if (wantAdmin) q.audience = { $in: ['admin', 'all'] };
      else q.$or = [{ phone }, { audience: 'all' }];
      const items = await col.notifications_feed.find(q).sort({ createdAt: 1 }).limit(100).toArray();
      res.json(items.map(d => ({
        id: String(d._id), title: d.title, body: d.body,
        audience: d.audience, phone: d.phone || null, createdAt: d.createdAt
      })));
    } catch (e) {
      console.error('notifications/feed error:', e);
      res.status(500).json({ error: 'Failed to load feed' });
    }
  });

  // Identity for the device-token routes: staff register with their staff
  // session (those tokens receive order/payment/stock pushes), customers with
  // their customer session. The username/phone in the body is no longer trusted
  // — anyone who knew the owner's username could otherwise subscribe their own
  // phone to staff alerts, or switch the owner's alerts off.
  async function pushIdentity(req) {
    if (req.body && req.body.role === 'staff') {
      const staff = await staffFromRequest(req);
      return staff ? { kind: 'staff', staff } : null;
    }
    const phone = await customerFromRequest(req);
    return phone ? { kind: 'customer', phone } : null;
  }

  app.post('/api/notifications/register', notifRegisterLimiter, async (req, res) => {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    // Placeholder tokens from old app builds can never receive a push — accept
    // the call (the in-app feed still works) but don't store them.
    if (/^MOCK_/.test(String(token))) return res.json({ success: true, stored: false });
    try {
      const who = await pushIdentity(req);
      if (!who) return res.status(401).json(req.body.role === 'staff' ? { error: 'Staff sign-in required' } : CUSTOMER_AUTH_ERROR);
      await col.notification_tokens.deleteMany({ token: String(token) }); // one token belongs to one device/account
      if (who.kind === 'staff') {
        await col.notification_tokens.insertOne({
          role: 'staff', staffUser: who.staff.username, staffRole: who.staff.role,
          token: String(token), platform: platform || 'android', updatedAt: new Date()
        });
      } else {
        await col.notification_tokens.insertOne({ phone: who.phone, token: String(token), platform: platform || 'android', updatedAt: new Date() });
      }
      res.json({ success: true });
    } catch (e) {
      console.error('notifications/register error:', e);
      res.status(500).json({ error: 'Failed to register notification token' });
    }
  });

  // Forget a device's token (customer turns notifications off, or staff logs out).
  // With the device token, only that device is removed; without it, all of the
  // signed-in account's devices.
  app.post('/api/notifications/unregister', notifRegisterLimiter, async (req, res) => {
    try {
      const who = await pushIdentity(req);
      if (!who) return res.status(401).json(req.body.role === 'staff' ? { error: 'Staff sign-in required' } : CUSTOMER_AUTH_ERROR);
      const filter = who.kind === 'staff' ? { role: 'staff', staffUser: who.staff.username } : { phone: who.phone };
      if (req.body.token) filter.token = String(req.body.token);
      await col.notification_tokens.deleteMany(filter);
      res.json({ success: true });
    } catch (e) {
      console.error('notifications/unregister error:', e);
      res.status(500).json({ error: 'Failed to unregister' });
    }
  });

  // Send a test push to THIS device/account — the in-app "Send test
  // notification" buttons call this so the owner can verify push works on any
  // phone, PC or browser instantly. Customer tests also write a feed event
  // (audience customer) so the desktop app's feed poller confirms it too.
  app.post('/api/notifications/test', notifRegisterLimiter, async (req, res) => {
    try {
      const who = await pushIdentity(req);
      if (!who) return res.status(401).json(req.body.role === 'staff' ? { error: 'Staff sign-in required' } : CUSTOMER_AUTH_ERROR);
      if (who.kind === 'staff') {
        const result = await sendPushToStaffUser(who.staff.username, '🔔 Test notification', 'Push notifications are working on this device!');
        return res.json({ success: true, ...result, message: 'Test push sent to this staff device.' });
      }
      await sendPushToPhone(who.phone, '🔔 Test notification', 'Push notifications are working on this device!');
      res.json({ success: true, inApp: true, message: 'Test push sent — check this device.' });
    } catch (e) {
      console.error('notifications/test error:', e);
      res.status(500).json({ error: 'Failed to send test push' });
    }
  });

  // Public status — lets the app and admin panel self-diagnose push setup.
  // Real device push only fires when FCM_SERVICE_ACCOUNT_JSON is set in the
  // server env; the in-app feed (polled toasts) works without it.
  app.get('/api/notifications/status', async (req, res) => {
    let registeredTokens = 0;
    try { registeredTokens = await col.notification_tokens.countDocuments({}); } catch (e) {}
    res.json({
      serverFcmConfigured: fcmConfigured(),
      fcmProjectId: fcmProject() || null,
      registeredTokens
    });
  });

  // Owner sends a push to one customer (phone) or to every registered device.
  // ALWAYS delivers to the in-app notification feed (PC toasts + app inbox) so
  // the Notify tab works out of the box; real OS-level device push fires too
  // once FCM_SERVICE_ACCOUNT_JSON is configured on the server.
  app.post('/api/admin/notifications/send', authenticate, authorize('owner'), async (req, res) => {
    const { title, body, phone } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and message required' });
    try {
      const cleanPhone = phone ? String(phone).replace(/[^0-9]/g, '') : '';
      // sendPushToPhone / sendPushToAll write the feed event first and only then
      // attempt real FCM delivery — so in-app delivery happens regardless of
      // whether the service account is configured.
      const result = cleanPhone ? await sendPushToPhone(cleanPhone, title, body) : await sendPushToAll(title, body);
      const configured = fcmConfigured();
      auditLog(req, 'notification_sent', `Sent "${String(title).slice(0, 60)}" ${cleanPhone ? 'to ' + cleanPhone : 'to everyone'}`);
      res.json({
        success: true,
        ...result,
        inApp: true,
        serverFcmConfigured: configured,
        message: configured
          ? `✅ Delivered in-app ${result.sent ? `+ pushed to ${result.sent} device(s)` : '(no devices registered yet)'}.`
          : `✅ Delivered to the in-app feed${result.sent ? ` + ${result.sent} device(s)` : ''}. Real device push is OFF — add FCM_SERVICE_ACCOUNT_JSON to the server to switch it on.`
      });
    } catch (e) {
      console.error('notifications/send error:', e);
      res.status(500).json({ error: 'Failed to send notification' });
    }
  });

};
