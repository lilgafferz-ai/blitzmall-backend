/* eslint-disable react-hooks/rules-of-hooks */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './App.css';
import Admin from './Admin';

const API_URL = process.env.REACT_APP_API_URL || 'https://blitzmall-backend.onrender.com/api';
const PRODUCTS_CACHE_KEY = 'blitz_products_cache';
const ORDERS_CACHE_KEY = 'blitz_orders_cache';
const OFFLINE_ORDERS_KEY = 'blitz_offline_orders';

// Built-in avatars (served from public/avatars/). Upload-your-own also supported.
const AVATARS = [
  { id: 'cat', src: '/Avatars/cat.png' },
  { id: 'eightball', src: '/Avatars/eightball.png' },
  { id: 'glassicon', src: '/Avatars/glassicon.png' },
  { id: 'stickman', src: '/Avatars/stickman.png' },
];

function BlitzLogo({ size = 80 }) {
  return (
    <svg className="blitz-logo" width={size} height={size} viewBox="0 0 100 100" fill="none">
      <path d="M25 35 H75 L70 85 H30 Z" stroke="url(#bg1)" strokeWidth="3.5" fill="none" strokeLinejoin="round" />
      <path d="M37 35 V28 a13 13 0 0 1 26 0 V35" stroke="url(#bg1)" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <path d="M52 48 L44 62 H53 L46 76 L62 56 H52 L57 48 Z" fill="url(#bg1)" />
      <defs><linearGradient id="bg1" x1="0" y1="0" x2="100" y2="100">
        <stop offset="0%" stopColor="#ffd24a" /><stop offset="50%" stopColor="#ff7a1a" /><stop offset="100%" stopColor="#ff2d2d" />
      </linearGradient></defs>
    </svg>
  );
}

function Avatar({ profile, size = 40 }) {
  const st = { width: size, height: size };
  const src = profile?.photo || (AVATARS.find(x => x.id === profile?.avatarId) || AVATARS[0]).src;
  return <img className="avatar" style={st} src={src} alt="me" />;
}

function App() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [screen, setScreen] = useState('splash');
  const [customer, setCustomer] = useState(null);
  const [profile, setProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('blitz_profile')) || null; } catch { return null; }
  });
  const [products, setProducts] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY));
      return Array.isArray(c) && c.length ? c : []; } catch { return []; }
  });
  const [cart, setCart] = useState([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [activeProduct, setActiveProduct] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [detailQty, setDetailQty] = useState(1);
  const [payMethod, setPayMethod] = useState('delivery');
  const [myOrders, setMyOrders] = useState([]);
  const [reviewStars, setReviewStars] = useState(0);
  const [stkCheckoutId, setStkCheckoutId] = useState(null);
  const [stkStatus, setStkStatus] = useState('idle'); // idle | waiting | confirmed | failed
  const [stkError, setStkError] = useState('');
  const [reviewMsg, setReviewMsg] = useState('');
  const [reviewSent, setReviewSent] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showRefreshBtn, setShowRefreshBtn] = useState(false);
  const pullThreshold = 80;
  const loadProducts = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/products`);
      const d = await r.json();
      if (Array.isArray(d) && d.length) {
        setProducts(d);
        localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(d));
      }
    } catch (e) { console.warn('Offline: using cached products'); }
  }, []);

  const touchStartYRef = useRef(0);

  const handleTouchStart = (e) => {
    const el = e.currentTarget;
    if (el && el.scrollTop === 0) touchStartYRef.current = e.touches[0].clientY;
    else touchStartYRef.current = 0;
  };

  const handleTouchMove = (e) => {
    if (!touchStartYRef.current) return;
    const delta = e.touches[0].clientY - touchStartYRef.current;
    if (delta > 0 && delta < 200) setPullDistance(delta);
  };

  const handleTouchEnd = async () => {
    if (pullDistance >= pullThreshold && !isRefreshing) {
      setIsRefreshing(true);
      await loadProducts();
      setIsRefreshing(false);
    }
    setPullDistance(0);
    touchStartYRef.current = 0;
  };

  const refreshProducts = async () => {
    setIsRefreshing(true);
    await loadProducts();
    setIsRefreshing(false);
    setShowRefreshBtn(false);
  };

  

  useEffect(() => {
    loadProducts();
    window.addEventListener('online', loadProducts);
    return () => window.removeEventListener('online', loadProducts);
  }, [loadProducts]);

  useEffect(() => {
    if (screen === 'splash') { const t = setTimeout(() => setScreen('login'), 6000); return () => clearTimeout(t); }
  }, [screen]);

  useEffect(() => {
    if (isOnline) syncOfflineOrders();
  }, [isOnline]);

  useEffect(() => {
    const onOn = () => { setIsOnline(true); setShowRefreshBtn(true); };
    const onOff = () => { setIsOnline(false); setShowRefreshBtn(false); };
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); };
  }, []);

  const saveProfile = (p) => { setProfile(p); try { localStorage.setItem('blitz_profile', JSON.stringify(p)); } catch {} };

  // M-Pesa STK polling — must be before any conditional returns
  useEffect(() => {
    if (!stkCheckoutId || stkStatus !== 'waiting') return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`${API_URL}/mpesa/status/${stkCheckoutId}`);
        const d = await r.json();
        if (d.status === 'confirmed') {
          clearInterval(interval);
          setStkStatus('confirmed');
          setCart([]); setScreen('confirmation');
        } else if (d.status === 'failed') {
          clearInterval(interval);
          setStkStatus('failed');
          setStkError(d.resultDesc || 'Payment failed or cancelled.');
        }
      } catch (e) { console.error(e); }
    }, 3000);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (stkStatus === 'waiting') { setStkStatus('failed'); setStkError('Timed out. Try again.'); }
    }, 90000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [stkCheckoutId, stkStatus]);

  if (isAdmin) {
    return (
      <div className="app-container">
        <Admin />
        <button className="back-to-shop-btn" onClick={() => setIsAdmin(false)}>← Back to Blitz Mall</button>
      </div>
    );
  }

  const categoryOf = (p) => (p.category && p.category.trim()) ? p.category.trim() : 'Other';
  const categories = useMemo(() => ['All', ...[...new Set(products.map(categoryOf))].sort()], [products]);
  const productId = (p) => p._id || p.id;
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  const catIcon = (c) => {
    c = c.toLowerCase();
    if (c === 'all') return '✨'; if (c.includes('food') || c.includes('grocer')) return '🥫';
    if (c.includes('drink') || c.includes('bever') || c.includes('soda')) return '🥤';
    if (c.includes('oil') || c.includes('fat')) return '🫗'; if (c.includes('baby')) return '🍼';
    if (c.includes('clean') || c.includes('soap')) return '🧼'; if (c.includes('snack')) return '🍪';
    if (c.includes('body') || c.includes('beauty')) return '🧴'; if (c.includes('bread') || c.includes('bak')) return '🍞';
    if (c.includes('milk') || c.includes('dairy')) return '🥛'; return '🛍️';
  };

  const addToCart = (p, qty = 1) => {
    const id = productId(p); const ex = cart.find(i => productId(i) === id);
    if (ex) setCart(cart.map(i => productId(i) === id ? { ...i, quantity: i.quantity + qty } : i));
    else setCart([...cart, { ...p, quantity: qty }]);
  };
  const setQty = (id, q) => { if (q <= 0) setCart(cart.filter(i => productId(i) !== id)); else setCart(cart.map(i => productId(i) === id ? { ...i, quantity: q } : i)); };

  const validatePhone = (p) => {
    const digits = p.replace(/[^0-9]/g, '');
    return digits.length >= 10;
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!validatePhone(phone)) { alert('Please enter a valid phone number (at least 10 digits, e.g. 0712345678)'); return; }
    try {
      const r = await fetch(`${API_URL}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone }) });
      const d = await r.json();
      if (d.success) {
        setCustomer({ customerId: d.customerId, name });
        if (!profile) saveProfile({ name, phone, avatarId: 'cat', photo: null });
        setName(''); setPhone(''); setScreen('home');
      }
    } catch (e) { console.error(e); }
  };

  const handleCheckout = async () => {
    if (!cart.length) return;
    const orderData = { customerId: customer.customerId, customerName: customer.name, items: cart, paymentMethod: payMethod, createdAt: new Date().toISOString() };
    try {
      const r = await fetch(API_URL + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderData) });
      const d = await r.json();
      if (d.success) { setCart([]); setScreen('confirmation'); }
    } catch (e) {
      // Offline: queue order for later sync
      try {
        const queued = JSON.parse(localStorage.getItem(OFFLINE_ORDERS_KEY) || '[]');
        queued.push({ ...orderData, _queued: true, _id: 'offline_' + Date.now() });
        localStorage.setItem(OFFLINE_ORDERS_KEY, JSON.stringify(queued));
        setCart([]); setScreen('confirmation');
      } catch (err) { console.error('Failed to queue order:', err); }
    }
  };;

  const ORDERS_CACHE_KEY_ORDERS = ORDERS_CACHE_KEY + '_' + (customer?.customerId || 'anon');
  const syncOfflineOrders = useCallback(async () => {
    try {
      const queued = JSON.parse(localStorage.getItem(OFFLINE_ORDERS_KEY) || '[]');
      if (!queued.length) return;
      const synced = [];
      for (const order of queued) {
        try {
          const r = await fetch(API_URL + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerId: order.customerId, customerName: order.customerName, items: order.items, paymentMethod: order.paymentMethod }) });
          const d = await r.json();
          if (!d.success) synced.push(order);
        } catch { synced.push(order); }
      }
      localStorage.setItem(OFFLINE_ORDERS_KEY, JSON.stringify(synced));
    } catch (e) { console.warn('Failed to sync offline orders:', e); }
  }, [API_URL, customer]);;

  const loadMyOrders = async () => {
    try {
      const r = await fetch(API_URL + '/customer-orders/' + customer.customerId);
      const d = await r.json();
      if (Array.isArray(d) && d.length) {
        setMyOrders(d.reverse());
        localStorage.setItem(ORDERS_CACHE_KEY_ORDERS, JSON.stringify(d));
      }
    } catch (e) {
      console.warn('Offline: using cached orders');
      try {
        const cached = JSON.parse(localStorage.getItem(ORDERS_CACHE_KEY_ORDERS));
        if (Array.isArray(cached)) setMyOrders(cached);
      } catch {}
    }
  };

  useEffect(() => {
    if (!customer?.customerId) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ORDERS_CACHE_KEY + '_' + customer.customerId));
      if (Array.isArray(cached) && cached.length) setMyOrders(cached);
    } catch {}
  }, [customer]);

  const openProduct = (p) => { setActiveProduct(p); setDetailQty(1); setScreen('product'); };
  const onUpload = (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader();
    rd.onloadend = () => saveProfile({ ...(profile || {}), photo: rd.result }); rd.readAsDataURL(f); };

  const submitReview = async () => {
    if (!reviewStars) { alert('Please tap a star rating first'); return; }
    try {
      const r = await fetch(`${API_URL}/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer?.customerId || '', customerName: customer?.name || profile?.name || 'Customer', rating: reviewStars, message: reviewMsg })
      });
      if ((await r.json()).success) { setReviewSent(true); }
    } catch (e) { console.error(e); }
  };

  const steps = ['pending', 'packed', 'on_the_way', 'delivered'];
  const stepLabel = { pending: 'Pending', packed: 'Packed', on_the_way: 'On the way', delivered: 'Delivered' };

  // SPLASH
  if (screen === 'splash') return (
    <div className="splash" onClick={() => setScreen('login')}>
      <div className="splash-glow" />
      <div className="splash-inner"><BlitzLogo size={140} />
        <h1 className="splash-title">BLITZ<span>MALL</span></h1>
        <p className="splash-tag">Everything you need. Lightning fast.</p></div>
      <span className="splash-skip">tap to enter</span>
    </div>
  );

  // LOGIN
  if (screen === 'login') return (
    <div className="screen center-screen">
      <div className="ambient ambient-a" /><div className="ambient ambient-b" />
      <div className="login-card"><BlitzLogo size={70} />
        <h1 className="brand">BLITZ<span>MALL</span></h1>
        <p className="muted">Sign in to start shopping</p>
        <form onSubmit={handleLogin}>
          <input className="field" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
          <input className="field" type="tel" placeholder="Phone (07xx xxx xxx)" value={phone} onChange={e => setPhone(e.target.value)} required />
          <button className="btn-neon" type="submit">Enter Blitz Mall</button>
        </form>
        <button className="owner-link" onClick={() => setIsAdmin(true)}>Owner login</button>
      </div>
    </div>
  );

  const BottomNav = () => (
    <nav className="bottomnav">
      <button className={['home', 'category'].includes(screen) ? 'on' : ''} onClick={() => { setActiveCategory('All'); setScreen('home'); }}><span>🏠</span>Home</button>
      <button className={screen === 'cart' ? 'on' : ''} onClick={() => setScreen('cart')}><span>🛒{cartCount > 0 && <i className="dot" />}</span>Cart</button>
      <button className={['profile', 'orders'].includes(screen) ? 'on' : ''} onClick={() => setScreen('profile')}><span>👤</span>Profile</button>
    </nav>
  );

  // HOME — left category rail + search + trending
  if (screen === 'home' || screen === 'category') {
    const term = searchTerm.trim().toLowerCase();
    let shown = products;
    if (activeCategory !== 'All') shown = shown.filter(p => categoryOf(p) === activeCategory);
    if (term) shown = shown.filter(p => p.name.toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term) || categoryOf(p).toLowerCase().includes(term));
    const trending = useMemo(() => [...shown].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)), [shown]);

    return (
      <div className="screen with-nav shop-scroll" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
          {pullDistance > 0 && !isRefreshing && (
            <div className="pull-indicator" style={{height: Math.min(pullDistance, pullThreshold), opacity: pullDistance / pullThreshold}}>
              {pullDistance >= pullThreshold ? '↻ Release to refresh' : '↓ Pull to refresh'}
            </div>
          )}
          {isRefreshing && <div className="refreshing-indicator">⏳ Refreshing…</div>}
          {!isOnline && <div className="offline-banner">📡 You are offline — browsing cached products</div>}
          {isOnline && showRefreshBtn && (
            <button className="refresh-btn" onClick={refreshProducts}>🔄 Tap to refresh products</button>
          )}
        <header className="topbar">
          <div className="topbar-brand"><BlitzLogo size={30} /><span>BLITZ<b>MALL</b></span></div>
          <button className="icon-btn cart-icon" onClick={() => setScreen('cart')}>🛒{cartCount > 0 && <span className="cart-badge">{cartCount}</span>}</button>
          <button className="icon-btn" onClick={() => setScreen('profile')}><Avatar profile={profile} size={28} /></button>
        </header>

        <div className="searchbar wide">
          <span>🔍</span>
          <input placeholder="Search products…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
          {searchTerm && <button onClick={() => setSearchTerm('')}>✕</button>}
        </div>

        <div className="home-layout">
          <aside className="cat-rail">
            {categories.map(c => (
              <button key={c} className={`rail-item ${activeCategory === c ? 'on' : ''}`}
                onClick={() => { setActiveCategory(c); }}>
                <span className="rail-emoji">{catIcon(c)}</span>
                <span className="rail-name">{c}</span>
              </button>
            ))}
          </aside>

          <main className="home-main">
            <h3 className="section-h">{term ? `Results for “${searchTerm}”` : activeCategory === 'All' ? '🔥 Trending now' : activeCategory}</h3>
            {trending.length === 0 ? <p className="empty">Nothing to show yet.</p> : (
              <div className="prod-grid">
                {trending.map(p => <ProductCard key={productId(p)} p={p} onOpen={openProduct} onAdd={addToCart} />)}
              </div>
            )}
          </main>
        </div>
        <BottomNav />
      </div>
    );
  }

  // PRODUCT DETAIL
  if (screen === 'product' && activeProduct) {
    const p = activeProduct;
    return (
      <div className="screen with-nav">
        <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('home')}>‹</button>
          <button className="icon-btn cart-icon" onClick={() => setScreen('cart')}>🛒{cartCount > 0 && <span className="cart-badge">{cartCount}</span>}</button></header>
        <div className="scroll detail-wrap">
          <div className="detail-img">{p.image ? <img src={p.image} alt={p.name} /> : <div className="noimg">🛍️</div>}</div>
          <div className="detail-body">
            <span className="detail-cat">{categoryOf(p)}</span>
            <h1 className="detail-name">{p.name}</h1>
            <div className="detail-price">KES {p.price}</div>
            {p.description && <p className="detail-desc">{p.description}</p>}
            <div className="qty-row"><span>Quantity</span>
              <div className="qty-ctrl"><button onClick={() => setDetailQty(Math.max(1, detailQty - 1))}>−</button><b>{detailQty}</b><button onClick={() => setDetailQty(detailQty + 1)}>+</button></div></div>
          </div>
        </div>
        <div className="detail-bar"><div className="detail-bar-total">KES {p.price * detailQty}</div>
          <button className="btn-neon" onClick={() => { addToCart(p, detailQty); setScreen('cart'); }}>Add to cart</button></div>
      </div>
    );
  }

  // CART
  if (screen === 'cart') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('home')}>‹</button><h2 className="topbar-title">Your Cart</h2></header>
      <div className="scroll">
        {cart.length === 0 ? (
          <div className="empty-cart"><span>🛒</span><p>Your cart is empty</p><button className="btn-ghost" onClick={() => setScreen('home')}>Start shopping</button></div>
        ) : (<>
          <div className="cart-list">{cart.map(i => (
            <div className="cart-row" key={productId(i)}>
              <div className="cart-thumb">{i.image ? <img src={i.image} alt={i.name} /> : '🛍️'}</div>
              <div className="cart-info"><b>{i.name}</b><span className="cart-price">KES {i.price}</span></div>
              <div className="qty-ctrl small"><button onClick={() => setQty(productId(i), i.quantity - 1)}>−</button><b>{i.quantity}</b><button onClick={() => setQty(productId(i), i.quantity + 1)}>+</button></div>
              <button className="trash" onClick={() => setQty(productId(i), 0)}>🗑️</button>
            </div>))}
          </div>
          <div className="summary"><div className="summary-row"><span>Subtotal</span><b>KES {total}</b></div>
            <div className="summary-row muted"><span>Delivery</span><span>Calculated later</span></div></div>
        </>)}
      </div>
      {cart.length > 0 && <div className="detail-bar"><div className="detail-bar-total">KES {total}</div><button className="btn-neon" onClick={() => setScreen('checkout')}>Checkout</button></div>}
    </div>
  );

  // CHECKOUT
  if (screen === 'checkout') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('cart')}>‹</button><h2 className="topbar-title">Checkout</h2></header>
      <div className="scroll">
        <h3 className="section-h">Delivery to</h3>
        <div className="info-card"><b>{customer?.name}</b><span className="muted">{customer?.customerId}</span></div>
        <h3 className="section-h">Payment method</h3>
        <button className={`pay-opt ${payMethod === 'delivery' ? 'sel' : ''}`} onClick={() => setPayMethod('delivery')}><span>💵</span><div><b>Pay on delivery</b><small>Pay cash when it arrives</small></div><i className="radio" /></button>
        <button className={`pay-opt soon ${payMethod === 'mpesa' ? 'sel' : ''}`} onClick={() => setPayMethod('mpesa')}><span>📱</span><div><b>M-Pesa</b><small>Coming soon — enter PIN to pay</small></div><i className="radio" /></button>
        <div className="summary"><div className="summary-row"><span>Subtotal</span><b>KES {total}</b></div><div className="summary-row total"><span>Total</span><b>KES {total}</b></div></div>
      </div>
      <div className="detail-bar"><div className="detail-bar-total">KES {total}</div><button className="btn-neon" onClick={handleCheckout}>Place order</button></div>
    </div>
  );

  // CONFIRMATION
  if (screen === 'confirmation') return (
    <div className="screen center-screen"><div className="ambient ambient-a" />
      <div className="confirm-card"><div className="confirm-mark">⚡</div><h1>Order placed!</h1>
        <p className="muted">Brilliant is preparing your order. Watch your phone for updates.</p>
        <button className="btn-neon" onClick={() => { loadMyOrders(); setScreen('orders'); }}>Track my order</button>
        <button className="btn-ghost" onClick={() => { setReviewStars(0); setReviewMsg(''); setReviewSent(false); setScreen('review'); }}>Rate your experience</button>
        <button className="btn-ghost" onClick={() => setScreen('home')}>Keep shopping</button></div>
    </div>
  );

  // PROFILE (doubles as settings)
  if (screen === 'profile') return (
    <div className="screen with-nav">
      <header className="topbar"><div className="topbar-brand"><BlitzLogo size={30} /><span>BLITZ<b>MALL</b></span></div></header>
      <div className="scroll">
        <div className="profile-head">
          <Avatar profile={profile} size={88} />
          <h2>{profile?.name || customer?.name}</h2>
          <span className="muted">{profile?.phone || customer?.customerId}</span>
        </div>

        <h3 className="section-h">Choose an avatar</h3>
        <div className="avatar-row">
          {AVATARS.map(a => (
            <button key={a.id} className={`avatar-pick ${profile?.avatarId === a.id && !profile?.photo ? 'sel' : ''}`}
              onClick={() => saveProfile({ ...(profile || {}), avatarId: a.id, photo: null })}>
              <img src={a.src} alt={a.id} />
            </button>
          ))}
          <label className="avatar-upload">＋<input type="file" accept="image/*" onChange={onUpload} hidden /></label>
        </div>

        <h3 className="section-h">Account</h3>
        <button className="row-btn" onClick={() => { loadMyOrders(); setScreen('orders'); }}>📦 My orders<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('cart')}>🛒 My cart<span>›</span></button>
        <button className="row-btn" onClick={() => { setReviewStars(0); setReviewMsg(''); setReviewSent(false); setScreen('review'); }}>⭐ Rate us / Feedback<span>›</span></button>
        <button className="row-btn danger" onClick={() => { setCustomer(null); setScreen('login'); }}>↩️ Logout<span>›</span></button>
      </div>
      <BottomNav />
    </div>
  );

  // ORDERS / TRACKING
  if (screen === 'orders') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('profile')}>‹</button><h2 className="topbar-title">My Orders</h2></header>
      <div className="scroll">
        {myOrders.length === 0 ? (
          <div className="empty-cart"><span>📦</span><p>No orders yet</p><button className="btn-ghost" onClick={() => setScreen('home')}>Start shopping</button></div>
        ) : myOrders.map(o => {
          const idx = steps.indexOf(o.status);
          return (
            <div className="order-card" key={o._id}>
              <div className="order-top"><b>KES {o.totalPrice}</b><span className="muted">{new Date(o.createdAt).toLocaleDateString()}</span></div>
              <div className="order-items">{o.items.map((it, k) => <span key={k}>{it.name} ×{it.quantity}</span>)}</div>
              <div className="tracker">{steps.map((s, i) => (
                <div className={`t-step ${i <= idx ? 'done' : ''} ${i === idx ? 'now' : ''}`} key={s}><i /><small>{stepLabel[s]}</small></div>
              ))}</div>
            </div>
          );
        })}
      </div>
      <BottomNav />
    </div>
  );

  // REVIEW
  if (screen === 'review') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('profile')}>‹</button><h2 className="topbar-title">Rate us</h2></header>
      <div className="scroll">
        {reviewSent ? (
          <div className="empty-cart"><span>💛</span><p>Thank you for your feedback!</p>
            <button className="btn-ghost" onClick={() => setScreen('home')}>Back to shop</button></div>
        ) : (
          <div className="review-box">
            <h3 className="section-h">How was your experience with Brilliant?</h3>
            <div className="star-pick">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} className={n <= reviewStars ? 'on' : ''} onClick={() => setReviewStars(n)}>★</button>
              ))}
            </div>
            <textarea className="review-text" placeholder="Tell us what went well, or any complaint…" value={reviewMsg} onChange={e => setReviewMsg(e.target.value)} />
            <button className="btn-neon" onClick={submitReview}>Send feedback</button>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );

  return null;
}

const ProductCard = React.memo(function ProductCard({ p, onOpen, onAdd }) {
  const id = p._id || p.id;
  return (
    <div className="prod-card" onClick={() => onOpen(p)}>
      <div className="prod-img">{p.image ? <img src={p.image} alt={p.name} /> : <div className="noimg">🛍️</div>}</div>
      <div className="prod-meta"><span className="prod-name">{p.name}</span><span className="prod-price">KES {p.price}</span></div>
      <button className="prod-add" onClick={e => { e.stopPropagation(); onAdd(p, 1); }}>+</button>
    </div>
  );
});



export default App;
