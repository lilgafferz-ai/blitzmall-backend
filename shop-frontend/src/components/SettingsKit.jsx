// Native-style building blocks shared by the customer app and Blitz Mall HQ:
// grouped settings lists, rows, switches, segmented controls and a sub-screen
// header. Purely presentational — every screen passes its own state in.
import React from 'react';
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
