// Blitz Mall HQ → Settings. One place for everything about THIS device and
// THIS staff account (the other tabs are about the shop): account & security,
// notifications, display, server connection, updates and about.
import React, { useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow, Toggle, PillButton, ConfirmSheet } from '../components/SettingsKit';
import { APP_VERSION } from '../version.generated';

const LIVE_API = 'https://blitzmall-backend.onrender.com/api';
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const desktop = () => (typeof window !== 'undefined' ? window.blitzDesktop : null);
const updater = () => (typeof window !== 'undefined' ? window.blitzUpdater : null);
const ROLE_LABEL = { owner: '👑 Owner', manager: '🧭 Manager', cashier: '🧾 Cashier', staff: '🧰 Staff' };

export default function AdminSettings({ ctx }) {
  const {
    API_URL, user, branchName, authGet, authPost, logout, onTokenRefreshed, onExit,
    muted, setMuted, showBanner, setShowBanner, perfMode, setPerfMode,
    pushStatus, sendStaffTestPush, staffPushRegistered
  } = ctx;

  // ----- account & security -----
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  // ----- wallet ledger check (owner) -----
  const [walletAudit, setWalletAudit] = useState(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const runWalletAudit = async () => {
    setWalletBusy(true);
    try {
      const r = await authGet(API_URL + '/admin/wallet/reconcile');
      const d = await r.json();
      setWalletAudit(r.ok ? d : { error: d.error || 'Check failed' });
    } catch (e) { setWalletAudit({ error: 'Could not reach the server' }); }
    setWalletBusy(false);
  };

  const changePassword = async () => {
    setPwMsg('');
    if (pw.next.length < 6) { setPwMsg('New password must be at least 6 characters.'); return; }
    if (pw.next !== pw.confirm) { setPwMsg('The new passwords do not match.'); return; }
    setPwBusy(true);
    try {
      const r = await authPost(API_URL + '/admin/me/password', { currentPassword: pw.current, newPassword: pw.next });
      const d = await r.json().catch(() => ({}));
      if (d.success && d.token) {
        onTokenRefreshed(d.token);
        setPw({ current: '', next: '', confirm: '' });
        setPwOpen(false);
        setPwMsg('✅ ' + (d.message || 'Password changed.'));
      } else {
        setPwMsg('❌ ' + (d.error || 'Could not change the password.'));
      }
    } catch (e) { setPwMsg('❌ Network error — try again.'); }
    setPwBusy(false);
  };

  const signOutEverywhere = async () => {
    try { await authPost(API_URL + '/admin/me/logout-all', {}); } catch (e) {}
    logout();
  };

  // ----- desktop notifications (PC / browser) -----
  const [osPermission, setOsPermission] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));
  const askOsPermission = async () => {
    try { const p = await Notification.requestPermission(); setOsPermission(p); } catch (e) {}
  };

  // ----- updates -----
  const [desktopInfo, setDesktopInfo] = useState(null);
  const [openAtLogin, setOpenAtLogin] = useState(null);
  const [closeToTray, setCloseToTray] = useState(null);
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateReady, setUpdateReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [server, setServer] = useState(null);

  useEffect(() => {
    const d = desktop();
    if (d) {
      d.info().then(setDesktopInfo).catch(() => {});
      d.getOpenAtLogin().then(setOpenAtLogin).catch(() => {});
      // Older desktop builds have no tray — the row stays hidden there.
      if (typeof d.getCloseToTray === 'function') d.getCloseToTray().then(setCloseToTray).catch(() => {});
    }
    const u = updater();
    let off = null;
    if (u && typeof u.onStatus === 'function') {
      off = u.onStatus((st) => {
        if (!st) return;
        const s = st.status || st.state || st.type;
        if (s === 'checking') setUpdateStatus('Checking for updates…');
        else if (s === 'available') setUpdateStatus(`Downloading v${st.newVersion || ''}…`);
        else if (s === 'downloaded') { setUpdateStatus(`v${st.newVersion || ''} is ready — restart to finish`); setUpdateReady(true); setChecking(false); }
        else if (s === 'not-available' || s === 'up-to-date') { setUpdateStatus('You have the latest version'); setChecking(false); }
        else if (s === 'progress' && st.percent != null) setUpdateStatus(`Downloading… ${Math.round(st.percent)}%`);
        else if (s === 'error') { setUpdateStatus('Update check failed — try again later'); setChecking(false); }
      });
    }
    fetch(API_URL + '/health').then(r => r.json()).then(setServer).catch(() => setServer({ ok: false }));
    return () => { try { off && off(); } catch (e) {} };
  }, [API_URL]);

  const checkUpdates = async () => {
    setChecking(true);
    const u = updater();
    try {
      if (u) {
        setUpdateStatus('Checking for updates…');
        await u.checkForUpdates();
        setTimeout(() => setChecking(false), 30000);
        return;
      }
      if (isNative()) {
        const res = await fetch(API_URL + '/native-update');
        const latest = await res.json();
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        const cur = await CapacitorUpdater.current();
        if (!latest || !latest.version || (cur && cur.bundle && cur.bundle.version === latest.version)) {
          setUpdateStatus('You have the latest version');
        } else {
          setUpdateStatus('Downloading the update…');
          const bundle = await CapacitorUpdater.download({ url: latest.url, version: latest.version });
          await CapacitorUpdater.next({ id: bundle.id });
          setUpdateStatus('Update ready — it applies the next time you open the app');
          setUpdateReady(true);
        }
      } else {
        setUpdateStatus('The web version is always up to date — reloading…');
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (e) {
      setUpdateStatus('Update check failed — try again later');
    }
    setChecking(false);
  };

  const applyUpdate = async () => {
    const u = updater();
    if (u && typeof u.install === 'function') { await u.install(); return; }
    if (isNative()) {
      try { const { CapacitorUpdater } = await import('@capgo/capacitor-updater'); await CapacitorUpdater.reload(); } catch (e) { window.location.reload(); }
      return;
    }
    window.location.reload();
  };

  const toggleOpenAtLogin = async (on) => {
    const d = desktop();
    if (!d) return;
    try { setOpenAtLogin(await d.setOpenAtLogin(on)); } catch (e) {}
  };
  const toggleCloseToTray = async (on) => {
    const d = desktop();
    if (!d || typeof d.setCloseToTray !== 'function') return;
    try { setCloseToTray(await d.setCloseToTray(on)); } catch (e) {}
  };

  const switchServer = (url) => {
    try { localStorage.setItem('blitz_api_url', url); } catch (e) {}
    window.location.reload();
  };

  const platform = updater() ? 'Windows desktop app' : isNative() ? 'Android app' : 'Web browser';

  return (
    <div className="ui-page" style={{ maxWidth: 820 }}>
      <SettingsGroup title="My account">
        <SettingsRow icon="👤" tone="orange" label={user?.name || user?.username} sub={`@${user?.username}${branchName ? ' · ' + branchName : ''}`} value={ROLE_LABEL[user?.role] || user?.role} />
        <SettingsRow icon="🔑" tone="gold" label="Change password" sub="Signs you out on every other device" onClick={() => { setPwOpen(o => !o); setPwMsg(''); }} />
        {pwOpen && (
          <>
            <div className="ui-field"><label>Current password</label><input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw(p => ({ ...p, current: e.target.value }))} /></div>
            <div className="ui-field"><label>New password</label><input type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw(p => ({ ...p, next: e.target.value }))} /></div>
            <div className="ui-field"><label>Repeat new password</label><input type="password" autoComplete="new-password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} /></div>
            <SettingsRow label="" right={<PillButton onClick={changePassword} disabled={pwBusy || !pw.current || !pw.next}>{pwBusy ? 'Saving…' : 'Save new password'}</PillButton>} />
          </>
        )}
        {pwMsg && <SettingsRow label={pwMsg} />}
      </SettingsGroup>

      <SettingsGroup title="Notifications" footer="New orders, M-Pesa payments and stock alerts reach staff devices that have notifications on.">
        <SettingsRow icon="🔔" tone="gold" label="Alert sounds" sub="Chime when a new order or alert arrives"
          right={<Toggle checked={!muted} label="Alert sounds" onChange={(on) => setMuted(!on)} />} />
        <SettingsRow icon="📢" tone="orange" label="Stock alert banner" sub="Out-of-stock, low-stock and expiry strip under the header"
          right={<Toggle checked={showBanner} label="Stock alert banner" onChange={setShowBanner} />} />
        {osPermission !== 'unsupported' && !isNative() && (
          <SettingsRow icon="🖥️" tone="blue" label="Desktop pop-ups" sub={osPermission === 'granted' ? 'Allowed on this computer' : osPermission === 'denied' ? 'Blocked — allow notifications in Windows/browser settings' : 'Not enabled yet'}
            right={osPermission === 'default' ? <PillButton onClick={askOsPermission}>Allow</PillButton> : null} />
        )}
        <SettingsRow icon="📲" tone="green" label="Push on this device" sub={staffPushRegistered ? 'Registered for staff alerts' : (pushStatus && !pushStatus.serverFcmConfigured ? 'Server push not configured yet — the in-app feed still works' : 'Registers automatically after sign-in')}
          right={<PillButton kind="ghost" onClick={sendStaffTestPush}>Send test</PillButton>} />
      </SettingsGroup>

      <SettingsGroup title="Display">
        <SettingsRow icon="🏎️" tone="purple" label="Performance mode" sub="Turns off blur and animations — faster on older PCs and phones"
          right={<Toggle checked={perfMode} label="Performance mode" onChange={setPerfMode} />} />
      </SettingsGroup>

      {desktop() && (
        <SettingsGroup title="Desktop app">
          <SettingsRow icon="🚀" tone="orange" label="Open when Windows starts" sub="Blitz Mall HQ launches automatically at login"
            right={openAtLogin === null ? null : <Toggle checked={openAtLogin} label="Open at login" onChange={toggleOpenAtLogin} />} />
          {closeToTray !== null && (
            <SettingsRow icon="📥" tone="blue" label="Keep running when closed" sub="Closing the window tucks BlitzMall into the system tray so order and stock alerts keep arriving"
              right={<Toggle checked={closeToTray} label="Keep running when closed" onChange={toggleCloseToTray} />} />
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title="Server connection" footer="Only switch to the local server when developing. Changing it reloads the app.">
        <SettingsRow icon="☁️" tone="blue" label="Live cloud server" sub="blitzmall-backend.onrender.com"
          right={API_URL === LIVE_API ? <span className="ui-row-value">✓ In use</span> : <PillButton kind="ghost" onClick={() => switchServer(LIVE_API)}>Use</PillButton>} />
        {!isNative() && (
          <SettingsRow icon="💻" label="Local development server" sub={API_URL !== LIVE_API ? API_URL.replace(/^https?:\/\//, '').replace(/\/api$/, '') : `${window.location.hostname || 'localhost'}:5000`}
            right={API_URL !== LIVE_API ? <span className="ui-row-value">✓ In use</span> : <PillButton kind="ghost" onClick={() => switchServer(`http://${window.location.hostname || 'localhost'}:5000/api`)}>Use</PillButton>} />
        )}
        <SettingsRow icon={server && server.ok ? '🟢' : server ? '🔴' : '⏳'} label="Server status"
          value={server ? (server.ok ? `Online · v${server.version || '?'}${server.commit ? ' · ' + server.commit : ''}` : 'Unreachable') : 'Checking…'} />
      </SettingsGroup>

      <SettingsGroup title="App & updates" footer={updateStatus || null}>
        <SettingsRow icon="🔄" tone="blue" label="Check for updates" sub={updater() ? 'Downloads silently and installs on restart' : isNative() ? 'Applies the next time you open the app' : 'Reloads the latest version'}
          right={<PillButton onClick={checkUpdates} disabled={checking}>{checking ? 'Checking…' : 'Check'}</PillButton>} />
        {updateReady && (
          <SettingsRow icon="✅" tone="green" label="Restart to update" right={<PillButton kind="success" onClick={applyUpdate}>Restart now</PillButton>} />
        )}
        <SettingsRow icon="🏷️" label="Version" value={`v${APP_VERSION}${desktopInfo && desktopInfo.version ? ` · desktop ${desktopInfo.version}` : ''}`} />
        <SettingsRow icon="💡" label="Running as" value={platform} />
      </SettingsGroup>

      {user?.role === 'owner' && (
        <SettingsGroup title="Wallet ledger" footer="Every shilling of customer wallet cash is recorded in an append-only ledger. The check confirms each wallet balance matches its history.">
          <SettingsRow icon="🧾" tone="green" label="Check wallet balances"
            sub={walletAudit && !walletAudit.error
              ? `${walletAudit.accounts} wallet(s) · KES ${Number(walletAudit.totalBalance || 0).toLocaleString()} held · ${walletAudit.entries} ledger entries`
              : 'Compare every balance with its transaction history'}
            right={<PillButton onClick={runWalletAudit} disabled={walletBusy}>{walletBusy ? 'Checking…' : 'Check'}</PillButton>} />
          {walletAudit && walletAudit.error && <SettingsRow icon="⚠️" label={walletAudit.error} />}
          {walletAudit && !walletAudit.error && walletAudit.ok && <SettingsRow icon="✅" tone="green" label="All wallets match the ledger" />}
          {walletAudit && !walletAudit.error && !walletAudit.ok && walletAudit.mismatches.slice(0, 20).map(m => (
            <SettingsRow key={m.phone} icon="❗" danger label={m.phone}
              sub={`Balance KES ${m.balance} · ledger KES ${m.ledger}${m.cardMissing ? ' · loyalty card missing' : ''}`}
              value={`${m.difference > 0 ? '+' : ''}${m.difference}`} />
          ))}
        </SettingsGroup>
      )}

      {onExit && (
        <SettingsGroup title="Switch">
          <SettingsRow icon="🛍️" tone="orange" label="Open the customer shop" sub="You stay signed in to HQ" onClick={onExit} />
        </SettingsGroup>
      )}

      <SettingsGroup title="Session" footer="Signing out everywhere ends your sessions on every phone and PC — handy if a device is lost.">
        <SettingsRow icon="↩️" label="Sign out" danger onClick={() => setConfirm('signout')} />
        <SettingsRow icon="🛡️" label="Sign out of all my devices" danger onClick={() => setConfirm('everywhere')} />
      </SettingsGroup>

      <p className="ui-group-footer" style={{ textAlign: 'center', marginTop: 18 }}>Blitz Mall HQ v{APP_VERSION}</p>

      <ConfirmSheet open={confirm === 'signout'} title="Sign out of Blitz Mall HQ?" confirmLabel="Sign out" danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); logout(); }} />
      <ConfirmSheet open={confirm === 'everywhere'} title="Sign out of all your devices?" message="Every phone and PC signed in as you will need your password again." confirmLabel="Sign out everywhere" danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); signOutEverywhere(); }} />
    </div>
  );
}
