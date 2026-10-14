// Customer-app building blocks: delivery slot picker, M-Pesa wallet top-up,
// product star ratings and reviews. `api` is { API_URL, custFetch } from App.
import React, { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

export function Stars({ value = 0, size = '0.9rem', onPick }) {
  const v = Math.round(Number(value) || 0);
  return (
    <span className="stars" style={{ fontSize: size }} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(n => (
        <span key={n} className={n <= v ? 'on' : ''} role={onPick ? 'button' : undefined}
          onClick={onPick ? () => onPick(n) : undefined}>★</span>
      ))}
    </span>
  );
}

// ===== DELIVERY SLOTS =====
export function SlotPicker({ api, value, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    fetch(`${api.API_URL}/delivery/slots`).then(r => r.json()).then(d => {
      if (!alive) return;
      setData(d);
      // Pre-select the first open slot so checkout is one tap.
      if (d && d.enabled && !value && d.days[0]) {
        const first = d.days[0].slots.find(s => s.available);
        if (first) onChange({ date: d.days[0].date, id: first.id, label: `${d.days[0].label} ${first.label}` });
      }
    }).catch(() => alive && setError(t('Could not load delivery times')));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <div className="slot-note">{error}</div>;
  if (!data) return <div className="slot-note">{t('Loading delivery times…')}</div>;
  if (!data.enabled) return null;
  if (!data.days.length) return <div className="slot-note">{t('No delivery slots left — we will call you to arrange delivery.')}</div>;
  return (
    <div className="slot-picker">
      <div className="slot-title">🕒 {t('Delivery time')}</div>
      {data.days.map(day => (
        <div key={day.date} className="slot-day">
          <div className="slot-day-label">{t(day.label)}</div>
          <div className="slot-chips">
            {day.slots.map(s => {
              const on = value && value.date === day.date && value.id === s.id;
              return (
                <button type="button" key={s.id} disabled={!s.available}
                  className={`slot-chip ${on ? 'on' : ''}`}
                  onClick={() => onChange({ date: day.date, id: s.id, label: `${day.label} ${s.label}` })}>
                  {s.label}
                  {!s.available ? <small>{s.reason === 'full' ? t('Full') : t('Closed')}</small>
                    : s.remaining !== null && s.remaining <= 3 ? <small>{s.remaining} {t('left')}</small> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ===== WALLET TOP-UP (M-Pesa) =====
export function WalletTopUp({ api, phone, onDone, showToast }) {
  const [amount, setAmount] = useState('');
  const [payPhone, setPayPhone] = useState(phone || '');
  const [state, setState] = useState('idle'); // idle | sending | waiting | done | failed
  const [message, setMessage] = useState('');
  const pollRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const start = async () => {
    const amt = Math.round(parseFloat(amount));
    if (!(amt >= 10)) { setMessage(t('Enter at least KES 10')); return; }
    setState('sending'); setMessage('');
    try {
      const r = await api.custFetch(`${api.API_URL}/wallet/topup`, { method: 'POST', body: JSON.stringify({ amount: amt, phone: payPhone }) });
      const d = await r.json().catch(() => ({}));
      if (!d.success) { setState('failed'); setMessage(d.error || t('Could not start the top-up')); return; }
      setState('waiting'); setMessage(t('Check your phone and enter your M-Pesa PIN.'));
      let tries = 0;
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        tries++;
        try {
          const s = await (await fetch(`${api.API_URL}/mpesa/status/${d.checkoutRequestId}`)).json();
          if (s.status === 'confirmed') {
            clearInterval(pollRef.current);
            setState('done'); setMessage(`✅ KES ${amt} ${t('added to your wallet')}`);
            if (showToast) showToast(`💰 KES ${amt} ${t('added to your wallet')}`);
            if (onDone) onDone();
          } else if (s.status === 'failed') {
            clearInterval(pollRef.current);
            setState('failed'); setMessage(s.resultDesc || t('Payment was not completed'));
          }
        } catch (e) { /* keep polling */ }
        if (tries > 40) { clearInterval(pollRef.current); setState('failed'); setMessage(t('No confirmation yet — if you paid, your wallet will update shortly.')); }
      }, 3000);
    } catch (e) { setState('failed'); setMessage(t('Network error')); }
  };

  return (
    <div className="wallet-topup">
      <div className="wallet-topup-title">📲 {t('Top up with M-Pesa')}</div>
      <div className="wallet-topup-quick">
        {[100, 200, 500, 1000].map(v => (
          <button type="button" key={v} className={String(v) === amount ? 'on' : ''} onClick={() => setAmount(String(v))}>KES {v}</button>
        ))}
      </div>
      <input className="field" type="number" min="10" max="20000" placeholder={t('Amount (KES)')} value={amount} onChange={e => setAmount(e.target.value)} />
      <input className="field" type="tel" placeholder={t('M-Pesa number')} value={payPhone} onChange={e => setPayPhone(e.target.value)} />
      <button type="button" className="btn-neon" disabled={state === 'sending' || state === 'waiting'} onClick={start}>
        {state === 'waiting' ? t('Waiting for PIN…') : state === 'sending' ? t('Sending…') : t('Top up')}
      </button>
      {message && <div className={`wallet-topup-msg ${state}`}>{message}</div>}
    </div>
  );
}

// ===== PRODUCT REVIEWS =====
export function ProductReviews({ api, productId, signedIn, showToast }) {
  const [data, setData] = useState(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const r = await api.custFetch(`${api.API_URL}/products/${productId}/reviews`);
      const d = await r.json();
      setData(d);
      if (d.myReview) { setRating(d.myReview.rating); setComment(d.myReview.comment || ''); }
    } catch (e) { setData({ count: 0, reviews: [] }); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [productId]);

  const submit = async () => {
    if (!rating) { showToast && showToast(t('Tap the stars to rate')); return; }
    setBusy(true);
    try {
      const r = await api.custFetch(`${api.API_URL}/products/${productId}/reviews`, { method: 'POST', body: JSON.stringify({ rating, comment }) });
      const d = await r.json();
      if (d.success) { showToast && showToast(t('Thanks for your review!')); load(); }
      else showToast && showToast(d.error || t('Could not save your review'));
    } finally { setBusy(false); }
  };

  if (!data) return null;
  return (
    <div className="product-reviews">
      <div className="pr-head">
        <b>{t('Reviews')}</b>
        {data.count > 0 ? <span><Stars value={data.average} /> {data.average} · {data.count} {data.count === 1 ? t('review') : t('reviews')}</span>
          : <span className="muted">{t('No reviews yet')}</span>}
      </div>
      {signedIn && data.canReview && (
        <div className="pr-form">
          <div>{data.myReview ? t('Update your review') : t('You bought this — how was it?')}</div>
          <Stars value={rating} size="1.6rem" onPick={setRating} />
          <textarea className="field" rows="2" maxLength="500" placeholder={t('Say something about it (optional)')} value={comment} onChange={e => setComment(e.target.value)} />
          <button type="button" className="btn-neon small" disabled={busy} onClick={submit}>{busy ? t('Saving…') : t('Post review')}</button>
        </div>
      )}
      {data.reviews.map(r => (
        <div key={r._id} className="pr-item">
          <div className="pr-item-top"><Stars value={r.rating} /> <b>{r.name}</b> <span className="pr-verified">✔ {t('Verified buyer')}</span></div>
          {r.comment && <div className="pr-comment">{r.comment}</div>}
          <div className="pr-date">{new Date(r.createdAt).toLocaleDateString('en-KE')}</div>
        </div>
      ))}
    </div>
  );
}
