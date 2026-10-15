// Native-style building blocks shared by the customer app and Blitz Mall HQ:
// grouped settings lists, rows, switches, segmented controls and a sub-screen
// header. Purely presentational — every screen passes its own state in.
import React, { useCallback, useState } from 'react';
import './SettingsKit.css';

export function ScreenHeader({ title, onBack, right, subtitle }) {
  return (
    <header className="ui-header">
      {onBack ? (
        <button type="button" className="ui-header-back" onClick={onBack} aria-label="Back">‹</button>
      ) : <span className="ui-header-spacer" />}
      <div className="ui-header-titles">
        <h2>{title}</h2>
        {subtitle && <small>{subtitle}</small>}
      </div>
      <div className="ui-header-right">{right}</div>
    </header>
  );
}

export function SettingsGroup({ title, footer, children }) {
  return (
    <section className="ui-group">
      {title && <h3 className="ui-group-title">{title}</h3>}
      <div className="ui-group-card">{children}</div>
      {footer && <p className="ui-group-footer">{footer}</p>}
    </section>
  );
}

// One row. Pass `onClick` for a tappable row (adds a chevron unless
// `chevron={false}`), `right` for a control (switch, button, badge) and
// `value` for a muted trailing value.
export function SettingsRow({ icon, label, sub, value, right, onClick, danger, disabled, chevron, tone }) {
  const tappable = !!onClick && !disabled;
  const Tag = tappable ? 'button' : 'div';
  return (
    <Tag
      type={tappable ? 'button' : undefined}
      className={`ui-row${tappable ? ' tappable' : ''}${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`}
      onClick={tappable ? onClick : undefined}
    >
      {icon && <span className={`ui-row-icon${tone ? ' tone-' + tone : ''}`}>{icon}</span>}
      <span className="ui-row-text">
        <span className="ui-row-label">{label}</span>
        {sub && <span className="ui-row-sub">{sub}</span>}
      </span>
      {value !== undefined && value !== null && value !== '' && <span className="ui-row-value">{value}</span>}
      {right}
      {tappable && chevron !== false && !right && <span className="ui-row-chevron">›</span>}
    </Tag>
  );
}

export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={`ui-toggle${checked ? ' on' : ''}`}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!checked); }}
    >
      <span className="ui-toggle-knob" />
    </button>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="ui-segmented" role="radiogroup">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={(e) => { e.stopPropagation(); onChange(o.value); }}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function PillButton({ children, onClick, disabled, kind = 'primary' }) {
  return (
    <button type="button" className={`ui-pill ${kind}`} onClick={(e) => { e.stopPropagation(); onClick && onClick(e); }} disabled={disabled}>
      {children}
    </button>
  );
}

// A small confirmation sheet — replaces window.confirm, which looks foreign
// inside a native app and is blocked in some WebViews.
export function ConfirmSheet({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="ui-sheet-backdrop" onClick={onCancel}>
      <div className="ui-sheet" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        <div className="ui-sheet-actions">
          <button type="button" className="ui-pill ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className={`ui-pill ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// "Confirm it's you" sheet for destructive owner actions (step-up re-auth).
// The server wants the account password, plus an authenticator/recovery code
// when two-step sign-in is on. `run(creds)` makes the real request; while the
// server answers "reauthRequired" (wrong password, code needed, locked) the
// sheet stays open with the error, otherwise it closes and resolves
// { res, data }. Cancel resolves null. A real modal — the Electron app has no
// window.prompt. `typeToConfirm` also asks for an exact phrase (sent as creds.typed).
export function ReauthSheet({ title, message, confirmLabel = 'Confirm', needCode: needCodeInitially, typeToConfirm, run, onDone }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [needCode, setNeedCode] = useState(!!needCodeInitially);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = password && (!needCode || code.trim()) && (!typeToConfirm || typed.trim() === typeToConfirm);
  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      const res = await run({ currentPassword: password, ...(needCode ? { mfaCode: code.trim() } : {}), ...(typeToConfirm ? { typed: typed.trim() } : {}) });
      const data = await res.json().catch(() => ({}));
      if (data && data.reauthRequired) {
        if (data.mfaRequired) setNeedCode(true);
        setCode('');
        setError(data.error || 'Could not confirm it is you.');
        setBusy(false);
        return;
      }
      onDone({ res, data });
    } catch (err) {
      setError('Network error — try again.');
      setBusy(false);
    }
  };
  return (
    <div className="ui-sheet-backdrop" onClick={() => !busy && onDone(null)}>
      <form className="ui-sheet" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h3>{title}</h3>
        <p>{message ? message + ' ' : ''}Enter your password{needCode ? ' and the code from your authenticator app (or a recovery code)' : ''} to confirm.</p>
        {typeToConfirm && (
          <div className="ui-field" style={{ padding: '0 0 12px', border: 'none' }}>
            <label>Type {typeToConfirm}</label>
            <input type="text" autoComplete="off" autoFocus value={typed} onChange={e => setTyped(e.target.value)} />
          </div>
        )}
        <div className="ui-field" style={{ padding: '0 0 12px', border: 'none' }}>
          <label>Your password</label>
          <input type="password" autoComplete="current-password" autoFocus={!typeToConfirm} value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {needCode && (
          <div className="ui-field" style={{ padding: '0 0 12px', border: 'none' }}>
            <label>Authenticator code</label>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={e => setCode(e.target.value)} />
          </div>
        )}
        {error && <p style={{ color: 'var(--red, #ff4d4f)', margin: '0 0 12px' }}>{error}</p>}
        <div className="ui-sheet-actions">
          <button type="button" className="ui-pill ghost" disabled={busy} onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="ui-pill danger" disabled={!ready || busy}>{busy ? 'Checking…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

// const [askReauth, reauthSheet] = useReauth(); render {reauthSheet}, then
// const out = await askReauth({ title, needCode, run: (creds) => fetch… });
// if (!out) return; // cancelled — otherwise out.res / out.data
export function useReauth() {
  const [request, setRequest] = useState(null);
  const ask = useCallback((opts) => new Promise(resolve => setRequest({ ...opts, resolve })), []);
  const sheet = request ? (
    <ReauthSheet {...request} onDone={(out) => { request.resolve(out); setRequest(null); }} />
  ) : null;
  return [ask, sheet];
}
