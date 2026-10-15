import React, { useState, useEffect, useRef, useCallback } from 'react';
import { setPin, verifyPin, setLockConfig, getLockConfig, biometricVerify } from './appLock';

// Full-screen app lock. Modes:
//   'setup'  — create the first PIN (enables the lock)
//   'change' — change an existing PIN: verify the CURRENT PIN, then set a new one
//   'unlock' — fingerprint (auto, when available) + PIN entry to clear the lock
// scope: 'customer' (default) or 'admin' — picks which stored PIN this lock uses.
// pinMin/pinMax: allowed PIN length (customer 4–6; the admin/staff lock is fixed 4).
// onDone(newPin, currentPin) fires after setup/change (currentPin only for change);
// onUnlock() after a successful unlock. The caller uses the PINs to keep the
// server account-PIN in sync.
export default function LockScreen({ mode, hasBiometric, logo, onDone, onUnlock, onCancel, allowCancel, cancelLabel = 'Cancel', scope = 'customer', pinMin = 4, pinMax = 6 }) {
  const PIN_MIN = pinMin;
  const PIN_MAX = pinMax;
  const [entry, setEntry] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [curPin, setCurPin] = useState('');
  const initialStage = mode === 'change' ? 'current' : (mode === 'setup' ? 'create' : 'enter');
  const [stage, setStage] = useState(initialStage); // current | create | confirm | enter
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Fingerprint is only offered on the unlock screen; setup/change always use the pad.
  const [showPin, setShowPin] = useState(mode !== 'unlock' || !hasBiometric);
  const triedBio = useRef(false);

  const runBiometric = useCallback(async () => {
    setBusy(true); setError('');
    const ok = await biometricVerify();
    setBusy(false);
    if (ok) { onUnlock && onUnlock(); } else { setShowPin(true); }
  }, [onUnlock]);

  // Auto-fire the fingerprint prompt once, on an unlock screen that has it.
  useEffect(() => {
    if (mode !== 'unlock' || !hasBiometric || triedBio.current) return;
    triedBio.current = true;
    runBiometric();
  }, [mode, hasBiometric, runBiometric]);

  const submit = useCallback(async (pin) => {
    if (pin.length < PIN_MIN) { setError(`Enter at least ${PIN_MIN} digits`); return; }
    setBusy(true); setError('');
    try {
      if (mode === 'change' && stage === 'current') {
        const ok = await verifyPin(pin, scope);
        if (!ok) { setError('Wrong current PIN'); setEntry(''); setBusy(false); return; }
        setCurPin(pin); setEntry(''); setStage('create'); setBusy(false); return;
      }
      if (mode === 'setup' || mode === 'change') {
        if (stage === 'create') {
          setFirstPin(pin); setEntry(''); setStage('confirm'); setBusy(false); return;
        }
        // confirm
        if (pin !== firstPin) {
          setError('PINs did not match — start again'); setEntry(''); setFirstPin(''); setStage('create'); setBusy(false); return;
        }
        await setPin(pin, scope);
        const cfg = getLockConfig(scope) || {};
        setLockConfig({ ...cfg, enabled: true, biometric: !!hasBiometric }, scope);
        setBusy(false);
        onDone && onDone(pin, mode === 'change' ? curPin : undefined);
        return;
      }
      // unlock
      const ok = await verifyPin(pin, scope);
      setBusy(false);
      if (ok) { onUnlock && onUnlock(); }
      else { setError('Wrong PIN — try again'); setEntry(''); }
    } catch (e) {
      setBusy(false); setError('Something went wrong — try again'); setEntry('');
    }
  }, [mode, stage, firstPin, curPin, hasBiometric, onDone, onUnlock, PIN_MIN, scope]);

  const press = (digit) => {
    if (busy) return;
    setError('');
    setEntry(prev => {
      if (prev.length >= PIN_MAX) return prev;
      const next = prev + digit;
      // Auto-submit only at the max length; shorter PINs are confirmed with ✓.
      if (next.length === PIN_MAX) setTimeout(() => submit(next), 90);
      return next;
    });
  };
  const backspace = () => { if (!busy) setEntry(prev => prev.slice(0, -1)); };

  const title = mode === 'unlock'
    ? 'Enter your PIN'
    : stage === 'current' ? 'Enter your current PIN'
      : stage === 'create' ? 'Create your new PIN'
        : 'Confirm your PIN';
  const subtitle = mode === 'unlock'
    ? 'Locks every time you leave the app'
    : stage === 'current' ? 'Confirm it’s you before changing your PIN'
      : stage === 'create' ? 'Set a 4–6 digit PIN — you’ll use it to sign in and unlock the app'
        : 'Type it again to confirm';

  const showFingerprintView = mode === 'unlock' && hasBiometric && !showPin;

  return (
    <div className="screen center-screen applock-screen">
      <div className="ambient ambient-a" /><div className="ambient ambient-b" />
      <div className="login-card applock-card">
        {logo}
        <h1 className="brand">BLITZ<span>MALL</span></h1>

        {showFingerprintView ? (
          <>
            <div className="applock-fingerprint">👆</div>
            <h2 className="applock-title">Unlock BlitzMall</h2>
            <p className="applock-sub">{busy ? 'Waiting for your fingerprint…' : 'Touch the fingerprint sensor'}</p>
            <button className="btn-ghost applock-alt" onClick={runBiometric} disabled={busy}>Try fingerprint again</button>
            <button className="btn-ghost applock-alt" onClick={() => setShowPin(true)}>Enter PIN instead</button>
          </>
        ) : (
          <>
            <div className="applock-lockicon">🔒</div>
            <h2 className="applock-title">{title}</h2>
            <p className="applock-sub">{subtitle}</p>
            <div className="applock-dots">
              {Array.from({ length: PIN_MAX }).map((_, i) => (
                <span key={i} className={`applock-dot ${i < entry.length ? 'filled' : ''}`} />
              ))}
            </div>
            {error && <div className="applock-error">{error}</div>}
            <div className="applock-pad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                <button key={n} type="button" className="applock-key" disabled={busy} onClick={() => press(String(n))}>{n}</button>
              ))}
              <button type="button" className="applock-key applock-key-ok" disabled={busy || entry.length < PIN_MIN} onClick={() => submit(entry)}>✓</button>
              <button type="button" className="applock-key" disabled={busy} onClick={() => press('0')}>0</button>
              <button type="button" className="applock-key applock-key-back" disabled={busy || !entry} onClick={backspace}>⌫</button>
            </div>
            {mode === 'unlock' && hasBiometric && (
              <button className="btn-ghost applock-alt" onClick={() => { triedBio.current = false; setShowPin(false); runBiometric(); }}>Use fingerprint</button>
            )}
          </>
        )}

        {allowCancel && (
          <button className="btn-ghost applock-alt applock-cancel" onClick={() => onCancel && onCancel()}>{cancelLabel}</button>
        )}
      </div>
    </div>
  );
}
