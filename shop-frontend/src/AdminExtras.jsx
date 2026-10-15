// Staff-app screens for: selling units & deals (Inventory form), deliveries &
// riders, suppliers & purchase orders, stock-take, tax invoices (eTIMS), the
// nightly closing report and product-review moderation.
// `api` is { API_URL, authGet, authPost, authPut, authDelete } from Admin.jsx.
import React, { useCallback, useEffect, useRef, useState } from 'react';

const money = (n) => 'KES ' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-KE');
const when = (d) => (d ? new Date(d).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) : '');
const json = async (r) => r.json().catch(() => ({}));
const waLink = (phone, msg) => {
  let p = String(phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  return 'https://wa.me/' + p + '?text=' + encodeURIComponent(msg);
};

// ===== INVENTORY FORM: selling unit, deals, supplier, tax =====
export function ProductSellingFields({ form, setForm, suppliers = [] }) {
  const deals = Array.isArray(form.bulkDeals) ? form.bulkDeals : [];
  const setDeal = (i, k, v) => setForm(s => ({ ...s, bulkDeals: deals.map((d, j) => (j === i ? { ...d, [k]: v } : d)) }));
  return (
    <div className="ax-fields blitz-admin-full">
      <div className="ax-row">
        <label>Sold by
          <select value={form.unit || 'pcs'} onChange={e => { const unit = e.target.value; setForm(s => ({ ...s, unit, soldLoose: ['kg', 'g', 'l', 'ml'].includes(unit) })); }}>
            <option value="pcs">Piece / item</option><option value="pack">Pack</option><option value="bunch">Bunch</option>
            <option value="kg">Kilogram (loose)</option><option value="g">Gram (loose)</option>
            <option value="l">Litre (loose)</option><option value="ml">Millilitre (loose)</option>
          </select>
        </label>
        {form.soldLoose && (
          <label>Sell in steps of
            <input type="number" step="0.05" min="0.05" value={form.qtyStep ?? ''} placeholder="0.25" onChange={e => setForm(s => ({ ...s, qtyStep: e.target.value }))} />
          </label>
        )}
        <label>Supplier
          <select value={form.supplierId || ''} onChange={e => setForm(s => ({ ...s, supplierId: e.target.value }))}>
            <option value="">— none —</option>
            {suppliers.map(sp => <option key={sp._id} value={sp._id}>{sp.name}</option>)}
          </select>
        </label>
        <label>Tax category
          <select value={form.taxCategory || ''} onChange={e => setForm(s => ({ ...s, taxCategory: e.target.value }))}>
            <option value="">Shop default</option>
            <option value="B">B · VAT 16%</option><option value="E">E · VAT 8%</option>
            <option value="C">C · Zero-rated</option><option value="A">A · Exempt</option><option value="D">D · Non-VAT</option>
          </select>
        </label>
      </div>
      {!form.soldLoose && (
        <div className="ax-deals">
          <span className="blitz-admin-muted">Multi-buy deals (e.g. 6 for KES 300)</span>
          {deals.map((d, i) => (
            <div key={i} className="ax-deal">
              <input type="number" min="2" placeholder="Qty" value={d.qty} onChange={e => setDeal(i, 'qty', e.target.value)} />
              <span>for KES</span>
              <input type="number" min="1" placeholder="Price" value={d.price} onChange={e => setDeal(i, 'price', e.target.value)} />
              <button type="button" className="pos-void" onClick={() => setForm(s => ({ ...s, bulkDeals: deals.filter((_, j) => j !== i) }))}>✕</button>
            </div>
          ))}
          {deals.length < 5 && <button type="button" className="blitz-admin-btn small" onClick={() => setForm(s => ({ ...s, bulkDeals: [...deals, { qty: '', price: '' }] }))}>+ Add deal</button>}
        </div>
      )}
    </div>
  );
}

// ===== DELIVERIES: rider run sheet, live GPS, assignment, slot settings =====
export function DeliveriesTab({ api, user }) {
  const isRider = user && user.role === 'rider';
  const canManage = user && (user.role === 'owner' || user.role === 'manager' || (user.permissions || []).includes('orders'));
  const [orders, setOrders] = useState([]);
  const [riders, setRiders] = useState([]);
  const [sharing, setSharing] = useState(null); // orderId whose GPS is being shared
  const [gpsNote, setGpsNote] = useState('');
  const watchRef = useRef(null);
  const lastSentRef = useRef(0);

  const load = useCallback(async () => {
    try {
      setOrders(await json(await api.authGet(api.API_URL + '/admin/rider/orders')));
      if (canManage) setRiders(await json(await api.authGet(api.API_URL + '/admin/riders')));
    } catch (e) { /* offline */ }
  }, [api, canManage]);
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);
  useEffect(() => () => { if (watchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current); }, []);

  const stopSharing = () => {
    if (watchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null; setSharing(null); setGpsNote('');
  };
  const shareGps = (orderId) => {
    if (!navigator.geolocation) { alert('This device cannot share its location.'); return; }
    stopSharing();
    setSharing(orderId); setGpsNote('Finding your location…');
    watchRef.current = navigator.geolocation.watchPosition(async (pos) => {
      if (Date.now() - lastSentRef.current < 15000) return; // every ~15s is plenty
      lastSentRef.current = Date.now();
      const r = await api.authPost(api.API_URL + `/admin/rider/orders/${orderId}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
      const d = await json(r);
      setGpsNote(d.success ? `📡 Sharing live location (±${Math.round(pos.coords.accuracy)}m) — keep this screen open` : (d.error || 'Could not send location'));
    }, (err) => setGpsNote('Location error: ' + err.message), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  };
  const act = async (orderId, action) => {
    const r = await api.authPost(api.API_URL + `/admin/rider/orders/${orderId}/${action}`, {});
    const d = await json(r);
    if (!d.success) { alert(d.error || 'Failed'); return; }
    if (action === 'start') shareGps(orderId);
    if (action === 'delivered') stopSharing();
    if (action === 'arrived') alert('The customer was told you have arrived.');
    load();
  };
  const assign = async (orderId, riderUserId) => {
    const d = await json(await api.authPut(api.API_URL + `/admin/orders/${orderId}/assign`, { riderUserId: riderUserId || null }));
    if (!d.success) alert(d.error || 'Failed'); load();
  };

  return (
    <div className="blitz-admin-body">
      <h2>🛵 {isRider ? 'My deliveries' : 'Deliveries'}</h2>
      {gpsNote && <div className="ax-gps">{gpsNote} {sharing && <button className="pos-void" onClick={stopSharing}>stop</button>}</div>}
      {orders.length === 0 ? <p className="blitz-admin-empty">{isRider ? 'No deliveries assigned to you right now.' : 'No active deliveries.'}</p> : (
        <div className="blitz-admin-list">
          {orders.map(o => {
            const mine = isRider || (o.rider && user && o.rider.userId === user.userId);
            const map = o.gpsCoords && o.gpsCoords.lat ? `https://www.google.com/maps/dir/?api=1&destination=${o.gpsCoords.lat},${o.gpsCoords.lng}` : null;
            return (
              <div key={o._id} className={`ax-card ${o.status}`}>
                <div className="blitz-admin-row-between">
                  <b>#{String(o._id).slice(-6)} · {o.customerName || 'Customer'}</b>
                  <span className={`ax-badge ${o.status}`}>{o.status.replace('_', ' ')}</span>
                </div>
                {o.deliverySlot && <div className="ax-slot">🕒 {o.deliverySlot.label}</div>}
                <div className="blitz-admin-muted">📍 {o.deliveryLocation || 'No address'}</div>
                <div className="blitz-admin-muted">{o.items.map(i => `${i.name} ×${i.quantity}${i.unit && i.unit !== 'pcs' ? ' ' + i.unit : ''}`).join(', ')}</div>
                <div className="ax-pay">{o.balanceDue > 0 ? <>💵 Collect <b>{money(o.balanceDue)}</b></> : <>✅ Paid</>}</div>
                <div className="ax-actions">
                  {o.customerPhone && <a className="blitz-admin-btn small" href={`tel:${o.customerPhone}`}>📞 Call</a>}
                  {map && <a className="blitz-admin-btn small" href={map} target="_blank" rel="noreferrer">🧭 Directions</a>}
                  {mine && o.status !== 'on_the_way' && <button className="blitz-admin-btn small" onClick={() => act(o._id, 'start')}>▶ Start delivery</button>}
                  {mine && o.status === 'on_the_way' && sharing !== String(o._id) && <button className="blitz-admin-btn small" onClick={() => shareGps(String(o._id))}>📡 Share location</button>}
                  {mine && o.status === 'on_the_way' && <button className="blitz-admin-btn small" onClick={() => act(o._id, 'arrived')}>📍 I'm here</button>}
                  {mine && o.status === 'on_the_way' && <button className="blitz-admin-btn small ax-green" onClick={() => act(o._id, 'delivered')}>✅ Delivered</button>}
                </div>
                {canManage && !isRider && (
                  <div className="ax-assign">
                    Rider:
                    <select value={o.rider ? o.rider.userId : ''} onChange={e => assign(o._id, e.target.value)}>
                      <option value="">— unassigned —</option>
                      {riders.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
                    </select>
                    {riders.length === 0 && <span className="blitz-admin-muted">Add a login with role "rider" in Staff.</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {canManage && !isRider && <SlotSettings api={api} user={user} />}
    </div>
  );
}

function SlotSettings({ api, user }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { api.authGet(api.API_URL + '/admin/delivery/settings').then(json).then(setS).catch(() => {}); }, [api]);
  if (!s || s.error) return null;
  const canEdit = user && (user.role === 'owner' || user.role === 'manager');
  const setSlot = (i, k, v) => setS(x => ({ ...x, slots: x.slots.map((sl, j) => (j === i ? { ...sl, [k]: v } : sl)) }));
  const save = async () => {
    const d = await json(await api.authPut(api.API_URL + '/admin/delivery/settings', s));
    if (d.success) { setS(d.settings); setSaved('✅ Saved'); setTimeout(() => setSaved(''), 2500); } else alert(d.error || 'Failed');
  };
  return (
    <div className="ax-section">
      <h3>🕒 Delivery time slots</h3>
      <label className="ax-check"><input type="checkbox" checked={!!s.slotsEnabled} disabled={!canEdit} onChange={e => setS(x => ({ ...x, slotsEnabled: e.target.checked }))} /> Customers pick a delivery time at checkout</label>
      <div className="ax-row">
        <label>Days ahead<input type="number" min="0" max="7" value={s.daysAhead} disabled={!canEdit} onChange={e => setS(x => ({ ...x, daysAhead: e.target.value }))} /></label>
        <label>Close slot (minutes before)<input type="number" min="0" value={s.cutoffMinutes} disabled={!canEdit} onChange={e => setS(x => ({ ...x, cutoffMinutes: e.target.value }))} /></label>
      </div>
      {s.slots.map((sl, i) => (
        <div key={i} className="ax-slotrow">
          <input value={sl.label} disabled={!canEdit} onChange={e => setSlot(i, 'label', e.target.value)} placeholder="Label" />
          <input type="time" value={sl.start} disabled={!canEdit} onChange={e => setSlot(i, 'start', e.target.value)} />
          <input type="time" value={sl.end} disabled={!canEdit} onChange={e => setSlot(i, 'end', e.target.value)} />
          <input type="number" min="0" value={sl.capacity} disabled={!canEdit} onChange={e => setSlot(i, 'capacity', e.target.value)} title="Orders per slot (0 = no limit)" />
          {canEdit && <button className="pos-void" onClick={() => setS(x => ({ ...x, slots: x.slots.filter((_, j) => j !== i) }))}>✕</button>}
        </div>
      ))}
      {canEdit && (
        <div className="ax-actions">
          <button className="blitz-admin-btn small" onClick={() => setS(x => ({ ...x, slots: [...x.slots, { id: 'slot' + Date.now().toString(36), label: 'New slot', start: '10:00', end: '12:00', capacity: 10 }] }))}>+ Add slot</button>
          <button className="blitz-admin-btn small ax-green" onClick={save}>Save slots</button> {saved}
        </div>
      )}
      <p className="blitz-admin-muted">Capacity is the number of orders per slot (0 = no limit). Slot times are shop time.</p>
    </div>
  );
}

// ===== SUPPLIERS & PURCHASE ORDERS =====
export function SuppliersTab({ api, onStockChanged }) {
  const [suppliers, setSuppliers] = useState([]);
  const [pos, setPos] = useState([]);
  const [suggest, setSuggest] = useState(null);
  const [coverDays, setCoverDays] = useState(14);
  const [form, setForm] = useState({ name: '', phone: '', contactPerson: '', leadTimeDays: '' });
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([api.authGet(api.API_URL + '/admin/suppliers').then(json), api.authGet(api.API_URL + '/admin/purchase-orders').then(json)]);
    setSuppliers(Array.isArray(s) ? s : []); setPos(Array.isArray(p) ? p : []);
  }, [api]);
  const loadSuggest = useCallback(async () => {
    setSuggest(await json(await api.authGet(api.API_URL + '/admin/purchase-orders/suggest?coverDays=' + coverDays)));
  }, [api, coverDays]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSuggest(); }, [loadSuggest]);

  const saveSupplier = async (e) => {
    e.preventDefault();
    const d = await json(editing ? await api.authPut(api.API_URL + '/admin/suppliers/' + editing, form) : await api.authPost(api.API_URL + '/admin/suppliers', form));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    setForm({ name: '', phone: '', contactPerson: '', leadTimeDays: '' }); setEditing(null); load();
  };
  const delSupplier = async (id) => { if (!window.confirm('Delete this supplier? Products keep their stock.')) return; await api.authDelete(api.API_URL + '/admin/suppliers/' + id); load(); };

  const createPo = async (group) => {
    const items = group.items.map(i => ({ productId: i.productId, qty: i.suggestedQty, unitCost: i.unitCost }));
    const d = await json(await api.authPost(api.API_URL + '/admin/purchase-orders', { supplierId: group.supplierId, supplierName: group.supplierName, items }));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    load();
    alert(`Purchase order #${d.purchaseOrder.poNumber} created — ${money(d.purchaseOrder.total)}. Edit quantities below before sending if needed.`);
  };
  const poText = (po) => `Hello${po.supplierName ? ' ' + po.supplierName : ''}, BlitzMall order #${po.poNumber}:\n` + po.items.map(i => `• ${i.name} — ${i.qty}${i.unit && i.unit !== 'pcs' ? ' ' + i.unit : ''}`).join('\n') + `\nEstimated total ${money(po.total)}. Thank you!`;
  const markSent = async (po) => { await api.authPut(api.API_URL + '/admin/purchase-orders/' + po._id, { status: 'sent' }); load(); };
  const cancelPo = async (po) => { if (!window.confirm('Cancel this purchase order?')) return; await api.authPut(api.API_URL + '/admin/purchase-orders/' + po._id, { status: 'cancelled' }); load(); };
  const receive = async (po) => {
    const items = [];
    for (const i of po.items) {
      const got = window.prompt(`${i.name}: how many arrived? (ordered ${i.qty})`, String(i.qty));
      if (got === null) return;
      const cost = window.prompt(`${i.name}: cost per ${i.unit && i.unit !== 'pcs' ? i.unit : 'item'} (KES)`, String(i.unitCost));
      if (cost === null) return;
      items.push({ productId: i.productId, receivedQty: parseFloat(got) || 0, unitCost: parseFloat(cost) || 0 });
    }
    const recordExpense = window.confirm('Record this delivery as an expense (money paid to the supplier)?');
    const d = await json(await api.authPost(api.API_URL + `/admin/purchase-orders/${po._id}/receive`, { items, recordExpense }));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    alert(`✅ Stock updated — received ${money(d.receivedTotal)}.`);
    load(); loadSuggest(); if (onStockChanged) onStockChanged();
  };

  return (
    <div className="blitz-admin-body">
      <h2>🚚 Suppliers & re-orders</h2>
      <div className="ax-section">
        <div className="blitz-admin-row-between">
          <h3>📋 Suggested re-orders</h3>
          <label className="ax-inline">Cover <input type="number" min="3" max="60" value={coverDays} onChange={e => setCoverDays(e.target.value)} /> days</label>
        </div>
        {!suggest ? <p className="blitz-admin-muted">Loading…</p> : !suggest.suppliers || !suggest.suppliers.length ? <p className="blitz-admin-empty">Nothing needs re-ordering for the next {coverDays} days. 🎉</p> : suggest.suppliers.map(g => (
          <div key={g.supplierId || 'none'} className="ax-card">
            <div className="blitz-admin-row-between"><b>{g.supplierName}</b><span>{money(g.estimatedCost)}</span></div>
            {g.items.map(i => <div key={i.productId} className="blitz-admin-muted">{i.name}: {i.stock} left{i.dailyRate ? ` · sells ${i.dailyRate}/day` : ''} → order <b>{i.suggestedQty}</b></div>)}
            <div className="ax-actions"><button className="blitz-admin-btn small" onClick={() => createPo(g)}>Create purchase order</button></div>
          </div>
        ))}
      </div>

      <div className="ax-section">
        <h3>🧾 Purchase orders</h3>
        {pos.length === 0 ? <p className="blitz-admin-empty">No purchase orders yet.</p> : pos.map(po => (
          <div key={po._id} className={`ax-card po-${po.status}`}>
            <div className="blitz-admin-row-between"><b>PO #{po.poNumber} · {po.supplierName}</b><span className={`ax-badge ${po.status}`}>{po.status}</span></div>
            <div className="blitz-admin-muted">{po.items.map(i => `${i.name} ×${po.status === 'received' ? i.receivedQty : i.qty}`).join(', ')}</div>
            <div className="blitz-admin-muted">{when(po.createdAt)} · {money(po.status === 'received' ? po.receivedTotal : po.total)}</div>
            {['draft', 'sent'].includes(po.status) && (
              <div className="ax-actions">
                {po.supplierPhone && <a className="blitz-admin-btn small" href={waLink(po.supplierPhone, poText(po))} target="_blank" rel="noreferrer" onClick={() => markSent(po)}>💬 Send on WhatsApp</a>}
                {po.status === 'draft' && <button className="blitz-admin-btn small" onClick={() => markSent(po)}>Mark sent</button>}
                <button className="blitz-admin-btn small ax-green" onClick={() => receive(po)}>📦 Receive goods</button>
                <button className="pos-void" onClick={() => cancelPo(po)}>cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ax-section">
        <h3>🏭 Suppliers</h3>
        <form className="ax-row" onSubmit={saveSupplier}>
          <input placeholder="Supplier name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          <input placeholder="Phone (WhatsApp)" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
          <input placeholder="Contact person" value={form.contactPerson} onChange={e => setForm(f => ({ ...f, contactPerson: e.target.value }))} />
          <input type="number" placeholder="Lead time (days)" value={form.leadTimeDays} onChange={e => setForm(f => ({ ...f, leadTimeDays: e.target.value }))} />
          <button className="blitz-admin-btn small" type="submit">{editing ? 'Save' : '+ Add supplier'}</button>
          {editing && <button type="button" className="pos-void" onClick={() => { setEditing(null); setForm({ name: '', phone: '', contactPerson: '', leadTimeDays: '' }); }}>cancel</button>}
        </form>
        {suppliers.map(s => (
          <div key={s._id} className="ax-card blitz-admin-row-between">
            <div><b>{s.name}</b><div className="blitz-admin-muted">{[s.contactPerson, s.phone, s.productCount ? `${s.productCount} products` : ''].filter(Boolean).join(' · ')}</div></div>
            <div className="ax-actions">
              <button className="blitz-admin-btn small" onClick={() => { setEditing(s._id); setForm({ name: s.name, phone: s.phone, contactPerson: s.contactPerson, leadTimeDays: s.leadTimeDays }); }}>edit</button>
              <button className="pos-void" onClick={() => delSupplier(s._id)}>delete</button>
            </div>
          </div>
        ))}
        <p className="blitz-admin-muted">Link products to a supplier in Inventory → edit product → Supplier.</p>
      </div>
    </div>
  );
}

// ===== STOCK-TAKE =====
export function StockTakeTab({ api, products = [], onApplied }) {
  const [take, setTake] = useState(null);
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [count, setCount] = useState('');
  const [picked, setPicked] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    const list = await json(await api.authGet(api.API_URL + '/admin/stock-takes'));
    const arr = Array.isArray(list) ? list : [];
    setHistory(arr.filter(t => t.status !== 'open'));
    setTake(arr.find(t => t.status === 'open') || null);
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const start = async () => { const d = await json(await api.authPost(api.API_URL + '/admin/stock-takes', {})); if (d.success) { setTake(d.stockTake); setResult(null); } };
  const matches = search.trim() ? products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.barcode && p.barcode === search.trim())).slice(0, 6) : [];
  const pick = (p) => { setPicked(p); setSearch(''); setCount(''); setTimeout(() => inputRef.current && inputRef.current.focus(), 50); };
  const saveCount = async (e) => {
    e.preventDefault();
    if (!picked || count === '') return;
    const d = await json(await api.authPut(api.API_URL + `/admin/stock-takes/${take._id}/count`, { productId: picked._id, counted: count }));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    setTake(t => ({ ...t, counts: { ...(t.counts || {}), [picked._id]: { productId: picked._id, name: picked.name, counted: d.counted, expected: d.expected } } }));
    setPicked(null); setCount('');
  };
  const apply = async () => {
    if (!window.confirm('Apply the counts? Stock for every counted product will be corrected.')) return;
    const d = await json(await api.authPost(api.API_URL + `/admin/stock-takes/${take._id}/apply`, {}));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    setResult(d); setTake(null); load(); if (onApplied) onApplied();
  };
  const cancel = async () => { if (!window.confirm('Discard this stock-take?')) return; await api.authPost(api.API_URL + `/admin/stock-takes/${take._id}/cancel`, {}); setTake(null); load(); };
  const counts = take ? Object.values(take.counts || {}) : [];

  return (
    <div className="blitz-admin-body">
      <h2>📋 Stock-take</h2>
      {result && (
        <div className="ax-card ax-result">
          <b>✅ Stock-take applied</b>
          <div>{result.summary.counted} counted · {result.summary.matched} matched · short {result.summary.shortUnits} · over {result.summary.overUnits}</div>
          <div>Net value change: <b className={result.summary.netValue < 0 ? 'ax-red' : ''}>{money(result.summary.netValue)}</b></div>
        </div>
      )}
      {!take ? (
        <div className="ax-section">
          <p className="blitz-admin-muted">Count what is on the shelves; the app works out the difference and fixes the stock numbers. Sales made while you count are kept.</p>
          <button className="blitz-admin-btn" onClick={start}>▶ Start a stock-take</button>
        </div>
      ) : (
        <div className="ax-section">
          <div className="blitz-admin-row-between"><b>Stock-take #{take.number}</b><span className="blitz-admin-muted">started {when(take.startedAt)}</span></div>
          {!picked ? (
            <>
              <input className="blitz-admin-search" autoFocus placeholder="Scan barcode or type product name…" value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } }} />
              {matches.map(p => <button key={p._id} type="button" className="ax-pick" onClick={() => pick(p)}>{p.name} <span className="blitz-admin-muted">system: {p.stock ?? '—'}{p.unit && p.unit !== 'pcs' ? ' ' + p.unit : ''}</span></button>)}
            </>
          ) : (
            <form className="ax-row" onSubmit={saveCount}>
              <b>{picked.name}</b>
              <input ref={inputRef} type="number" step="0.01" min="0" placeholder="Counted on shelf" value={count} onChange={e => setCount(e.target.value)} />
              <button className="blitz-admin-btn small" type="submit">Save count</button>
              <button type="button" className="pos-void" onClick={() => setPicked(null)}>back</button>
            </form>
          )}
          <div className="ax-counts">
            {counts.length === 0 ? <p className="blitz-admin-empty">No products counted yet.</p> : counts.map(c => {
              const delta = Math.round((c.counted - c.expected) * 100) / 100;
              return <div key={c.productId} className="blitz-admin-row-between"><span>{c.name}</span><span>counted <b>{c.counted}</b> · system {c.expected} · <b className={delta < 0 ? 'ax-red' : delta > 0 ? 'ax-greentext' : ''}>{delta > 0 ? '+' : ''}{delta}</b></span></div>;
            })}
          </div>
          <div className="ax-actions">
            <button className="blitz-admin-btn ax-green" disabled={!counts.length} onClick={apply}>Apply {counts.length} count{counts.length === 1 ? '' : 's'}</button>
            <button className="pos-void" onClick={cancel}>discard</button>
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="ax-section">
          <h3>History</h3>
          {history.map(h => (
            <div key={h._id} className="blitz-admin-row-between ax-hist">
              <span>#{h.number} · {when(h.appliedAt || h.startedAt)} · {h.status}</span>
              {h.summary && <span>{h.summary.counted} items · {money(h.summary.netValue)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== TAX (eTIMS) =====
export function TaxTab({ api, user }) {
  const isOwner = user && user.role === 'owner';
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const load = useCallback(async () => {
    const [inv, s] = await Promise.all([api.authGet(api.API_URL + '/admin/tax/invoices').then(json), api.authGet(api.API_URL + '/admin/tax/settings').then(json)]);
    setData(inv); setSettings(s && s.settings ? s : null);
  }, [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.authGet(api.API_URL + '/admin/tax/summary?month=' + month).then(json).then(setSummary).catch(() => {}); }, [api, month]);

  const save = async () => {
    const d = await json(await api.authPut(api.API_URL + '/admin/tax/settings', settings.settings));
    if (!d.success) { alert(d.error || 'Failed'); return; }
    alert('✅ Tax settings saved'); load();
  };
  const retry = async () => { const d = await json(await api.authPost(api.API_URL + '/admin/tax/retry', {})); alert(d.success ? `Sent ${d.attempted} invoice(s) to eTIMS.` : d.error); load(); };
  const set = (k, v) => setSettings(s => ({ ...s, settings: { ...s.settings, [k]: v } }));
  const statusLabel = { pending: '⏳ waiting', failed: '⚠️ failed', submitted: '✅ sent to KRA', not_connected: '📦 queued' };

  return (
    <div className="blitz-admin-body">
      <h2>🧾 Tax invoices (KRA eTIMS)</h2>
      {settings && (
        <div className="ax-section">
          <label className="ax-check"><input type="checkbox" checked={!!settings.settings.enabled} disabled={!isOwner} onChange={e => set('enabled', e.target.checked)} /> Issue a tax invoice for every sale and delivered order</label>
          <div className="ax-row">
            <label>KRA PIN<input value={settings.settings.kraPin} disabled={!isOwner} placeholder="P051234567X" onChange={e => set('kraPin', e.target.value.toUpperCase())} /></label>
            <label>Business name<input value={settings.settings.businessName} disabled={!isOwner} onChange={e => set('businessName', e.target.value)} /></label>
            <label>Branch ID<input value={settings.settings.branchId} disabled={!isOwner} onChange={e => set('branchId', e.target.value)} /></label>
            <label>Default tax category
              <select value={settings.settings.defaultCategory} disabled={!isOwner} onChange={e => set('defaultCategory', e.target.value)}>
                {Object.entries(settings.categories).map(([k, c]) => <option key={k} value={k}>{k} · {c.label}</option>)}
              </select>
            </label>
          </div>
          <label className="ax-check"><input type="checkbox" checked={!!settings.settings.pricesIncludeVat} disabled={!isOwner} onChange={e => set('pricesIncludeVat', e.target.checked)} /> Shelf prices already include VAT</label>
          {isOwner && <button className="blitz-admin-btn small ax-green" onClick={save}>Save tax settings</button>}
          <div className={`ax-note ${settings.connected ? 'ok' : ''}`}>
            {settings.connected
              ? '✅ Connected to an eTIMS VSCU — invoices are sent to KRA automatically and retried if they fail.'
              : '📦 Not connected to KRA yet. Invoices are numbered and kept here; once KRA onboarding gives you a VSCU/OSCU connection, set ETIMS_VSCU_URL on the server and the queue is sent automatically.'}
          </div>
        </div>
      )}
      {summary && (
        <div className="ax-section">
          <div className="blitz-admin-row-between"><h3>VAT summary</h3><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></div>
          <div>{summary.invoices} documents · sales {money(summary.gross)} · tax <b>{money(summary.tax)}</b></div>
          {Object.entries(summary.byCategory || {}).map(([k, c]) => <div key={k} className="blitz-admin-muted">{k} · {c.label}: taxable {money(c.taxable)} · tax {money(c.tax)}</div>)}
        </div>
      )}
      {data && data.invoices && (
        <div className="ax-section">
          <div className="blitz-admin-row-between">
            <h3>Invoices</h3>
            <span className="blitz-admin-muted">{data.counts.submitted} sent · {data.counts.notConnected + data.counts.pending} queued · {data.counts.failed} failed</span>
          </div>
          {data.connected && (data.counts.failed + data.counts.pending + data.counts.notConnected) > 0 && <button className="blitz-admin-btn small" onClick={retry}>Send queued invoices now</button>}
          {data.invoices.length === 0 ? <p className="blitz-admin-empty">No invoices yet{settings && !settings.settings.enabled ? ' — switch tax invoices on above' : ''}.</p> : data.invoices.map(inv => (
            <div key={inv.invoiceNo} className="blitz-admin-row-between ax-hist">
              <span>{inv.type === 'credit_note' ? '↩️ Credit note' : '🧾 Invoice'} #{inv.invoiceNo}{inv.originalInvoiceNo ? ` (for #${inv.originalInvoiceNo})` : ''} · {inv.source} · {when(inv.createdAt)}</span>
              <span>{money(inv.gross)} · VAT {money(inv.totalTax)} · {statusLabel[inv.status] || inv.status}{inv.lastError ? ` — ${inv.lastError}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== NIGHTLY CLOSING REPORT (Records tab) =====
export function DailyReportCard({ api, user }) {
  const isOwner = user && user.role === 'owner';
  const canSend = user && (user.role === 'owner' || user.role === 'manager');
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }));
  const [rep, setRep] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [note, setNote] = useState('');
  useEffect(() => { api.authGet(api.API_URL + '/admin/reports/daily?date=' + date).then(json).then(setRep).catch(() => {}); }, [api, date]);
  useEffect(() => { api.authGet(api.API_URL + '/admin/reports/settings').then(json).then(setCfg).catch(() => {}); }, [api]);
  const send = async () => {
    const d = await json(await api.authPost(api.API_URL + '/admin/reports/daily/send', { date }));
    setNote(d.success ? `Sent — ${d.pushed} phone(s) notified${d.sms ? ' + SMS' : ''}.` : (d.error || 'Failed'));
  };
  const saveCfg = async () => {
    const d = await json(await api.authPut(api.API_URL + '/admin/reports/settings', cfg));
    setNote(d.success ? '✅ Report settings saved' : (d.error || 'Failed'));
  };
  const r = rep && rep.report;
  return (
    <div className="ax-section">
      <div className="blitz-admin-row-between"><h3>📊 Closing report</h3><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
      {!r ? <p className="blitz-admin-muted">Loading…</p> : (
        <>
          <div className="ax-kpis">
            <div><small>Sales</small><b>{money(r.revenue)}</b><span>{r.count} txns</span></div>
            <div><small>Cash / M-Pesa</small><b>{money(r.cash)}</b><span>{money(r.mpesa)}</span></div>
            <div><small>Profit</small><b>{money(r.profit)}</b><span>net {money(r.net)}</span></div>
            <div><small>Online orders</small><b>{r.orderCount}</b><span>{r.pendingOrders} pending</span></div>
          </div>
          <pre className="ax-report">{rep.text}</pre>
        </>
      )}
      {canSend && <button className="blitz-admin-btn small" onClick={send}>📲 Send this report now</button>}
      {cfg && !cfg.error && (
        <div className="ax-row">
          <label className="ax-check"><input type="checkbox" checked={!!cfg.enabled} disabled={!isOwner} onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))} /> Send automatically every night</label>
          <label>at<input type="time" value={cfg.sendAt} disabled={!isOwner} onChange={e => setCfg(c => ({ ...c, sendAt: e.target.value }))} /></label>
          <label>SMS copy to<input value={cfg.smsTo} disabled={!isOwner} placeholder="07…" onChange={e => setCfg(c => ({ ...c, smsTo: e.target.value }))} /></label>
          {isOwner && <button className="blitz-admin-btn small" onClick={saveCfg}>Save</button>}
        </div>
      )}
      {note && <div className="blitz-admin-muted">{note}</div>}
      <p className="blitz-admin-muted">The automatic report goes to the owner's phone (push) and, if set, by SMS.</p>
    </div>
  );
}

// ===== PRODUCT REVIEWS (Reviews tab) =====
export function ProductReviewsAdmin({ api, canModerate }) {
  const [list, setList] = useState([]);
  const load = useCallback(async () => { const d = await json(await api.authGet(api.API_URL + '/admin/product-reviews')); setList(Array.isArray(d) ? d : []); }, [api]);
  useEffect(() => { load(); }, [load]);
  const toggle = async (r) => { await api.authPut(api.API_URL + '/admin/product-reviews/' + r._id, { hidden: !r.hidden }); load(); };
  const del = async (r) => { if (!window.confirm('Delete this product review?')) return; await api.authDelete(api.API_URL + '/admin/product-reviews/' + r._id); load(); };
  return (
    <div className="ax-section">
      <h3>🛍️ Product reviews ({list.length})</h3>
      {list.length === 0 ? <p className="blitz-admin-empty">No product reviews yet.</p> : list.map(r => (
        <div key={r._id} className={`ax-card ${r.hidden ? 'ax-hidden' : ''}`}>
          <div className="blitz-admin-row-between"><b>{r.productName}</b><span>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span></div>
          {r.comment && <div>{r.comment}</div>}
          <div className="blitz-admin-muted">{r.name} {r.phoneTail} · {when(r.updatedAt || r.createdAt)}{r.hidden ? ' · hidden from shoppers' : ''}</div>
          {canModerate && <div className="ax-actions"><button className="blitz-admin-btn small" onClick={() => toggle(r)}>{r.hidden ? 'Show' : 'Hide'}</button><button className="pos-void" onClick={() => del(r)}>delete</button></div>}
        </div>
      ))}
    </div>
  );
}
