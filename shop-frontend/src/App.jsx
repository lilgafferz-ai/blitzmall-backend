
import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import ErrorBoundary from './ErrorBoundary';
import { SplashScreen } from '@capacitor/splash-screen';
const Admin = React.lazy(() => import('./Admin'));

const API_URL = process.env.REACT_APP_API_URL || 'https://blitzmall-backend.onrender.com/api';
const PRODUCTS_CACHE_KEY = 'blitz_products_cache';
const ORDERS_CACHE_KEY = 'blitz_orders_cache';
const OFFLINE_ORDERS_KEY = 'blitz_offline_orders';
const CUSTOMER_KEY = 'blitz_customer';

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
      <defs>
        <linearGradient id="bg1" x1="0" y1="0" x2="100" y2="100">
          <stop offset="0%" stopColor="#ffd24a" />
          <stop offset="50%" stopColor="#ff7a1a" />
          <stop offset="100%" stopColor="#ff2d2d" />
        </linearGradient>
        <filter id="glow-react" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.2" result="blur" />
          <feComponentTransfer in="blur" result="glow1">
            <feFuncA type="linear" slope="0.75"/>
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="glow1" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#glow-react)">
        <path d="M25 35 H75 L70 85 H30 Z" stroke="url(#bg1)" strokeWidth="4.5" fill="none" strokeLinejoin="round" />
        <path d="M37 35 V28 a13 13 0 0 1 26 0 V35" stroke="url(#bg1)" strokeWidth="4.5" fill="none" strokeLinecap="round" />
        <path d="M52 48 L44 62 H53 L46 76 L62 56 H52 L57 48 Z" fill="url(#bg1)" />
      </g>
    </svg>
  );
}

const getAvatarSrc = (src) => {
  if (!src) return '';
  if (src.startsWith('data:')) return src;
  return src.startsWith('/') ? src.substring(1) : src;
};

function Avatar({ profile, size = 40 }) {
  const st = { width: size, height: size };
  const rawSrc = profile?.photo || (AVATARS.find(x => x.id === profile?.avatarId) || AVATARS[0]).src;
  const src = getAvatarSrc(rawSrc);
  return <img className="avatar" style={st} src={src} alt="me" />;
}

const BANNERS = [
  { id: 1, title: "🚀 MEGA LAUNCH", text: "Free Delivery on Mall Area orders! Limited time.", code: "", gradient: "linear-gradient(135deg, #ff007f, #7f00ff)" },
  { id: 2, title: "🎁 WEEKEND SPECIAL", text: "Get 10% discount on orders over KES 1000!", code: "BLITZ10", gradient: "linear-gradient(135deg, #00f2fe, #4facfe)" },
  { id: 3, title: "💳 INSTANT PAY", text: "Scan & Pay with secure M-Pesa STK push!", code: "", gradient: "linear-gradient(135deg, #38ef7d, #11998e)" },
];

function App() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [screen, setScreen] = useState('splash');

  // Futuristic addictive features
  const [showSpinWheel, setShowSpinWheel] = useState(false);
  const [wheelSpinning, setWheelSpinning] = useState(false);
  const [wheelPrize, setWheelPrize] = useState(null);
  const [lastSpinDate, setLastSpinDate] = useState(() => {
    try { return localStorage.getItem('last_spin_date') || ''; } catch { return ''; }
  });

  const [showAiBot, setShowAiBot] = useState(false);
  const [aiMessages, setAiMessages] = useState([
    { sender: 'bot', text: 'Jambo! I am your BlitzMall AI Assistant. Ask me to suggest a recipe, find cheap groceries, or explain checkout rewards!' }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const [flashTime, setFlashTime] = useState('04:12:08');

  const [customer, setCustomer] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem(CUSTOMER_KEY)); return c && c.customerId ? c : null; } catch { return null; }
  });
  const [welcomeMsg, setWelcomeMsg] = useState(null);
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
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponError, setCouponError] = useState('');
  const [deliveryArea, setDeliveryArea] = useState('mall'); // 'mall' | 'standard'
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [gpsCoords, setGpsCoords] = useState(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [bannerIndex, setBannerIndex] = useState(0);
  const [savedBaskets, setSavedBaskets] = useState([]);
  const [basketNameInput, setBasketNameInput] = useState('');
  const [showBasketSaveForm, setShowBasketSaveForm] = useState(false);
  const [loyaltyRewards, setLoyaltyRewards] = useState([]);
  const [scratchRevealed, setScratchRevealed] = useState(() => {
    try { return localStorage.getItem('scratch_revealed') === 'true'; } catch { return false; }
  });
  const [scratchRevealing, setScratchRevealing] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [custLoyalty, setCustLoyalty] = useState(null);
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
    try { SplashScreen.hide(); } catch {}
    return () => window.removeEventListener('online', loadProducts);
  }, [loadProducts]);

  useEffect(() => {
    if (screen === 'splash') {
      const t = setTimeout(() => {
        // Auto-login returning customers
        if (customer && customer.customerId) {
          setWelcomeMsg({ name: customer.name, returning: true });
          setScreen('welcome');
        } else {
          setScreen('login');
        }
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [screen, customer]);

  useEffect(() => {
    if (screen === 'welcome') {
      const t = setTimeout(() => setScreen('home'), 1500);
      return () => clearTimeout(t);
    }
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
          triggerSimulatedNotifications();
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

  const loadSavedBaskets = async () => {
    if (!customer?.customerId) return;
    try {
      const r = await fetch(`${API_URL}/customer/baskets/${customer.customerId}`);
      const d = await r.json();
      setSavedBaskets(Array.isArray(d) ? d : []);
    } catch (e) { console.error('Failed to load saved baskets:', e); }
  };

  const saveCurrentBasket = async () => {
    if (!basketNameInput.trim()) return;
    try {
      const r = await fetch(`${API_URL}/customer/baskets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customer?.customerId,
          basketName: basketNameInput.trim(),
          items: cart.map(i => ({
            _id: i._id,
            id: i.id,
            name: i.name,
            price: i.price,
            quantity: i.quantity,
            image: i.image,
            category: i.category
          }))
        })
      });
      const d = await r.json();
      if (d.success) {
        alert('🛒 Basket template saved successfully!');
        setBasketNameInput('');
        setShowBasketSaveForm(false);
        loadSavedBaskets();
      } else {
        alert('Failed to save basket');
      }
    } catch (e) {
      console.error(e);
      alert('Error saving basket');
    }
  };

  const loadSavedBasketToCart = (basket) => {
    setCart(basket.items);
    alert(`🛒 Loaded basket "${basket.basketName}" into your cart!`);
  };

  const deleteSavedBasket = async (id) => {
    try {
      const r = await fetch(`${API_URL}/customer/baskets/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) {
        loadSavedBaskets();
      }
    } catch (e) { console.error(e); }
  };

  const loadLoyaltyRewards = async () => {
    try {
      const r = await fetch(`${API_URL}/loyalty/rewards`);
      const d = await r.json();
      setLoyaltyRewards(d || []);
    } catch (e) { console.error('Failed to load loyalty rewards:', e); }
  };

  const redeemReward = async (rewardId) => {
    try {
      const r = await fetch(`${API_URL}/loyalty/redeem-reward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer?.customerId, rewardId })
      });
      const d = await r.json();
      if (d.success) {
        alert(`🎉 Successfully redeemed!\nCopy coupon code: ${d.couponCode} to use at checkout.`);
        loadCustLoyalty();
        if (d.couponCode) {
          setCouponInput(d.couponCode);
        }
      } else {
        alert(d.error || 'Failed to redeem reward');
      }
    } catch (e) {
      console.error(e);
      alert('Error redeeming reward');
    }
  };

  const scratchCoupon = () => {
    if (scratchRevealed || scratchRevealing) return;
    setScratchRevealing(true);
    setTimeout(() => {
      setScratchRevealing(false);
      setScratchRevealed(true);
      try { localStorage.setItem('scratch_revealed', 'true'); } catch {}
      setCouponInput('SHAKE15');
      showToast("🎁 15% OFF Shake Coupon applied at checkout!");
    }, 1200);
  };

  const showToast = (message) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  const triggerSimulatedNotifications = () => {
    setTimeout(() => {
      showToast("🛒 Your order has been received by Blitz Mall Cashier!");
    }, 4000);
    setTimeout(() => {
      showToast("📦 Order Packing: Items are being packed and sealed.");
    }, 12000);
    setTimeout(() => {
      showToast("🚴 Out for Delivery: A rider has picked up your parcel!");
    }, 24000);
  };

  const renderToasts = () => (
    <div style={{position:'fixed',top:20,left:'50%',transform:'translateX(-50%)',zIndex:99999,display:'flex',flexDirection:'column',gap:10,width:'90%',maxWidth:360,pointerEvents:'none'}}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background:'rgba(22, 22, 27, 0.95)',
          border:'1px solid var(--orange)',
          borderRadius:12,
          padding:'12px 16px',
          color:'var(--text)',
          fontSize:'.82rem',
          boxShadow:'0 10px 25px rgba(255, 122, 26, 0.2)',
          display:'flex',
          alignItems:'center',
          gap:10,
          pointerEvents:'auto'
        }}>
          <span style={{fontSize:'1.1rem'}}>🔔</span>
          <span style={{flex:1}}>{t.message}</span>
          <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',fontSize:'1rem'}}>✕</button>
        </div>
      ))}
    </div>
  );

  const renderShakeStyle = () => (
    <style>{`
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-6px); }
        20%, 40%, 60%, 80% { transform: translateX(6px); }
      }
      .shake-animation {
        animation: shake 0.6s ease-in-out infinite;
      }
    `}</style>
  );

  const categoryOf = (p) => (p.category && p.category.trim()) ? p.category.trim() : 'Other';
  const categories = ['All', ...[...new Set(products.map(categoryOf))].sort()];
  const productId = (p) => p._id || p.id;
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

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
  }, [customer]);

  useEffect(() => {
    if (!customer?.customerId) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ORDERS_CACHE_KEY + '_' + customer.customerId));
      if (Array.isArray(cached) && cached.length) setMyOrders(cached);
    } catch {}
    loadSavedBaskets();
  }, [customer]);

  useEffect(() => {
    if (screen === 'profile') {
      loadCustLoyalty();
      loadLoyaltyRewards();
    }
  }, [screen]);

  // Flash sale countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const diff = endOfDay - now;
      if (diff <= 0) {
        setFlashTime('00:00:00');
        return;
      }
      const hrs = String(Math.floor(diff / (1000 * 60 * 60))).padStart(2, '0');
      const mins = String(Math.floor((diff / (1000 * 60)) % 60)).padStart(2, '0');
      const secs = String(Math.floor((diff / 1000) % 60)).padStart(2, '0');
      setFlashTime(`${hrs}:${mins}:${secs}`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  if (isAdmin) {
    return (
      <div className="app-container">
        <ErrorBoundary>
          <React.Suspense fallback={
            <div className="splash welcome-splash">
              <div className="splash-glow welcome-glow" />
              <div className="splash-inner welcome-inner">
                <p className="welcome-sub">Loading Admin Dashboard...</p>
                <BlitzLogo size={60} />
              </div>
            </div>
          }>
            <Admin />
          </React.Suspense>
        </ErrorBoundary>
        <button className="back-to-shop-btn" onClick={() => {
          sessionStorage.removeItem('bm_token');
          sessionStorage.removeItem('bm_user');
          localStorage.removeItem('bm_token');
          localStorage.removeItem('bm_user');
          setIsAdmin(false);
        }}>← Back to Blitz Mall</button>
      </div>
    );
  }

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
        const isReturning = !!d.returning;
        const cust = { customerId: d.customerId, name, phone };
        setCustomer(cust);
        try { localStorage.setItem(CUSTOMER_KEY, JSON.stringify(cust)); } catch {}
        if (!profile) saveProfile({ name, phone, avatarId: 'cat', photo: null });
        setName(''); setPhone('');
        setWelcomeMsg({ name, returning: isReturning });
        setScreen('welcome');
      }
    } catch (e) { console.error(e); }
  };

  const handleLogout = () => {
    setCustomer(null);
    setCart([]);
    setMyOrders([]);
    try { localStorage.removeItem(CUSTOMER_KEY); } catch {}
    setScreen('login');
  };

  const validateCoupon = async () => {
    setCouponError('');
    if (!couponInput.trim()) return;
    try {
      const r = await fetch(`${API_URL}/coupons/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: couponInput.trim().toUpperCase(), total })
      });
      const d = await r.json();
      if (d.valid) {
        setAppliedCoupon(d);
        setCouponError('');
      } else {
        setAppliedCoupon(null);
        setCouponError(d.error || 'Invalid coupon code');
      }
    } catch {
      setCouponError('Network error validating coupon');
    }
  };

  const pinGpsLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLoading(false);
      },
      (err) => {
        console.warn('Geolocation error:', err);
        alert('Could not pin location. Please enable GPS/location permissions on your device.');
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const reOrderPastOrder = (order) => {
    const newCart = order.items.map(it => {
      const p = products.find(prod => (prod._id || prod.id) === (it._id || it.id || it.productId));
      return {
        ...(p || it),
        quantity: it.quantity || 1
      };
    });
    setCart(newCart);
    setScreen('cart');
  };

  const loadCustLoyalty = async () => {
    if (!customer?.customerId) return;
    try {
      const r = await fetch(`${API_URL}/admin/loyalty/${customer.customerId}`);
      const d = await r.json();
      if (d.exists) {
        setCustLoyalty(d);
      }
    } catch (e) { console.error('Failed to load customer loyalty:', e); }
  };

  const spinTheWheel = () => {
    if (wheelSpinning) return;
    setWheelSpinning(true);
    setWheelPrize(null);
    
    const prizes = [
      { name: 'discount', message: 'You won KES 50 Off on your next order! Code: SPIN50', code: 'SPIN50', rotation: 1800 + 45 },
      { name: 'delivery', message: 'You won Free Delivery on your next order! Code: SPINFREE', code: 'SPINFREE', rotation: 1800 + 135 },
      { name: 'points', message: 'You won 100 loyalty points! Added to your profile.', code: '', rotation: 1800 + 225 },
      { name: 'again', message: 'Ah, so close! Try again tomorrow.', code: '', rotation: 1800 + 315 },
    ];
    
    const selected = prizes[Math.floor(Math.random() * prizes.length)];
    
    setTimeout(async () => {
      setWheelSpinning(false);
      setWheelPrize(selected);
      const today = new Date().toLocaleDateString();
      setLastSpinDate(today);
      try { localStorage.setItem('last_spin_date', today); } catch {}
      
      if (selected.name === 'points' && customer?.phone) {
        try {
          await fetch(`${API_URL}/admin/loyalty/add-points`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: customer.phone, points: 100 })
          });
          loadCustLoyalty();
        } catch (e) { console.error(e); }
      }
    }, 3000);
  };

  const sendAiMessage = async (e) => {
    e.preventDefault();
    if (!aiInput.trim()) return;
    const userMsg = { sender: 'user', text: aiInput.trim() };
    setAiMessages(prev => [...prev, userMsg]);
    const text = aiInput.trim().toLowerCase();
    setAiInput('');
    setAiLoading(true);

    setTimeout(() => {
      let botResponse = '';
      if (text.includes('recipe') || text.includes('cook') || text.includes('make')) {
        botResponse = '🥞 *Recommended Recipe: Blitz Pancakes!*\nIngredients available in shop:\n• Wheat Flour\n• Milk\n• Sugar\n• Cooking Oil\n\nDirections:\n1. Mix flour, milk, and sugar to make a smooth batter.\n2. Heat a pan with a drop of oil.\n3. Pour batter and cook until golden brown on both sides. Serve hot!';
      } else if (text.includes('loyalty') || text.includes('point') || text.includes('reward') || text.includes('cashback')) {
        botResponse = '🎁 *BlitzMall Rewards Plan:*\n• Get 1 point for every KES 10 spent.\n• Redeem points for cashback (1 point = KES 0.5 cashback applied at checkout).\n• Unlock Silver tier at KES 5,000 spent, and Gold at KES 20,000 spent for extra perks!';
      } else if (text.includes('delivery') || text.includes('shipping') || text.includes('fare')) {
        botResponse = '🚚 *Delivery Options:*\n• Mall Delivery: FREE (KES 0) for standard orders.\n• Other Destinations: KES 150 standard delivery fee. We use coordinates pinned at checkout to navigate direct to your door!';
      } else if (text.includes('discount') || text.includes('coupon') || text.includes('promo')) {
        botResponse = '🏷️ *Active Store Coupons:*\n• Use code `BLITZ10` at checkout for 10% off orders above KES 1,000!\n• Or play the Daily Spin the Wheel on the home screen to win exclusive coupons.';
      } else {
        botResponse = '🤖 Jambo! I can help you find products, calculate rewards, or suggest recipe ingredients. Type "recipe", "rewards", "delivery", or "discount" to explore!';
      }
      setAiMessages(prev => [...prev, { sender: 'bot', text: botResponse }]);
      setAiLoading(false);
    }, 800);
  };

  const handleCheckout = async () => {
    if (!cart.length) return;
    const finalFee = total >= 1500 || appliedCoupon?.type === 'free_delivery' || deliveryArea === 'mall' ? 0 : 150;
    const discountAmt = appliedCoupon ? appliedCoupon.discount : 0;
    const orderData = {
      customerId: customer.customerId,
      customerName: customer.name,
      items: cart,
      paymentMethod: payMethod,
      createdAt: new Date().toISOString(),
      deliveryLocation: `${deliveryArea === 'mall' ? 'Mall Area' : 'Standard Delivery'} - ${deliveryLocation}`,
      deliveryFee: finalFee,
      gpsCoords,
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      discount: discountAmt
    };
    try {
      const r = await fetch(API_URL + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderData) });
      const d = await r.json();
      if (d.success) {
        setCart([]);
        setAppliedCoupon(null);
        setCouponInput('');
        setDeliveryLocation('');
        setGpsCoords(null);
        setScreen('confirmation');
        triggerSimulatedNotifications();
      }
    } catch (e) {
      // Offline: queue order for later sync
      try {
        const queued = JSON.parse(localStorage.getItem(OFFLINE_ORDERS_KEY) || '[]');
        queued.push({ ...orderData, _queued: true, _id: 'offline_' + Date.now() });
        localStorage.setItem(OFFLINE_ORDERS_KEY, JSON.stringify(queued));
        setCart([]);
        setAppliedCoupon(null);
        setCouponInput('');
        setDeliveryLocation('');
        setGpsCoords(null);
        setScreen('confirmation');
        triggerSimulatedNotifications();
      } catch (err) { console.error('Failed to queue order:', err); }
    }
  };

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
    <div className="splash" onClick={() => {
      if (customer && customer.customerId) {
        setWelcomeMsg({ name: customer.name, returning: true });
        setScreen('welcome');
      } else {
        setScreen('login');
      }
    }}>
      <div className="splash-glow" />
      <div className="splash-inner"><BlitzLogo size={140} />
        <h1 className="splash-title">BLITZ<span>MALL</span></h1>
        <p className="splash-tag">Everything you need. Lightning fast.</p></div>
      <span className="splash-skip">tap to enter</span>
    </div>
  );

  // WELCOME SPLASH (after login)
  if (screen === 'welcome' && welcomeMsg) return (
    <div className="splash welcome-splash" onClick={() => setScreen('home')}>
      <div className="splash-glow welcome-glow" />
      <div className="splash-inner welcome-inner">
        <div className="welcome-emoji">{welcomeMsg.returning ? '👋' : '🎉'}</div>
        <h1 className="welcome-title">
          {welcomeMsg.returning ? 'Welcome back,' : 'Welcome,'}
        </h1>
        <h2 className="welcome-name">{welcomeMsg.name}!</h2>
        <p className="welcome-sub">
          {welcomeMsg.returning
            ? 'Great to see you again ⚡'
            : 'Your account is ready. Let\'s shop! 🛍️'}
        </p>
        <BlitzLogo size={60} />
      </div>
      <span className="splash-skip">tap to shop</span>
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
    const trending = [...shown].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

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

        <div className="promo-banner-slider">
          <div className="promo-banner-track" style={{ transform: `translateX(-${bannerIndex * 100}%)` }}>
            {BANNERS.map(b => (
              <div className="promo-banner-slide" key={b.id} style={{ background: b.gradient }}>
                <div className="promo-slide-decorations">
                  <div className="promo-slide-circle" />
                  <div className="promo-slide-triangle" />
                </div>
                <div className="promo-slide-content">
                  <h4 className="promo-slide-title">{b.title}</h4>
                  <p className="promo-slide-text">{b.text}</p>
                </div>
                {b.code && (
                  <button className="promo-copy-btn" onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(b.code);
                    alert(`Code ${b.code} copied! Use it at checkout.`);
                  }}>Copy Code: {b.code}</button>
                )}
              </div>
            ))}
          </div>
          <div className="promo-banner-dots">
            {BANNERS.map((_, i) => (
              <span key={i} className={`promo-dot ${i === bannerIndex ? 'active' : ''}`} onClick={() => setBannerIndex(i)} />
            ))}
          </div>
        </div>

        {/* FLASH SALE CARD */}
        <div className="flash-sale-card">
          <div className="flash-sale-header">
            <span className="flash-sale-title">⚡ FLASH SALE</span>
            <div className="flash-sale-timer">Ends in: <span>{flashTime}</span></div>
          </div>
          <div className="flash-sale-items">
            {products.slice(0, 2).map(p => {
              const origPrice = p.price;
              const discPrice = Math.round(origPrice * 0.8);
              return (
                <div className="flash-item" key={`flash-${p._id || p.id}`} onClick={() => openProduct(p)}>
                  <span className="flash-badge">-20%</span>
                  <div className="flash-item-img">
                    {p.image ? <img src={p.image} alt={p.name} /> : '🛍️'}
                  </div>
                  <div className="flash-item-info">
                    <span className="flash-item-name">{p.name}</span>
                    <div className="flash-price-row">
                      <span className="flash-price-disc">KES {discPrice}</span>
                      <span className="flash-price-orig">KES {origPrice}</span>
                    </div>
                  </div>
                  <button className="flash-add-btn" onClick={(e) => {
                    e.stopPropagation();
                    addToCart({ ...p, price: discPrice }, 1);
                  }}>+</button>
                </div>
              );
            })}
          </div>
        </div>

        {/* SHAKE-TO-REVEAL SCRATCH CARD */}
        <div style={{
          margin: '16px',
          background: 'var(--card)',
          borderRadius: 20,
          border: '2px dashed var(--orange)',
          padding: '20px',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
          textAlign: 'center'
        }}>
          {!scratchRevealed ? (
            <div 
              onClick={scratchCoupon}
              className={scratchRevealing ? 'shake-animation' : ''}
              style={{
                cursor: 'pointer',
                background: 'linear-gradient(135deg, #ffd24a, #ff7a1a)',
                borderRadius: 12,
                padding: '30px 20px',
                color: '#000',
                fontWeight: 'bold',
                fontFamily: 'Unbounded, sans-serif',
                position: 'relative',
                boxShadow: '0 8px 20px rgba(255, 122, 26, 0.3)',
                userSelect: 'none'
              }}
            >
              <div style={{fontSize: '2rem', marginBottom: 8}}>🎁</div>
              <div style={{fontSize: '1rem'}}>SHAKE OR CLICK TO SCRATCH</div>
              <div style={{fontSize: '0.75rem', opacity: 0.8, marginTop: 4}}>Reveal a special 15% OFF coupon!</div>
            </div>
          ) : (
            <div style={{
              background: 'rgba(54, 211, 153, 0.1)',
              border: '1px solid var(--green)',
              borderRadius: 12,
              padding: '24px 20px',
              animation: 'fadeIn 0.5s ease'
            }}>
              <span style={{fontSize: '2rem'}}>🎉</span>
              <h4 style={{margin: '8px 0 4px 0', color: 'var(--green)', fontFamily: 'Unbounded, sans-serif'}}>15% Discount Unlocked!</h4>
              <p className="muted" style={{fontSize: '0.8rem', marginBottom: 12}}>Use code at checkout to claim your deal.</p>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '8px 16px',
                fontFamily: 'monospace',
                fontSize: '1.1rem',
                fontWeight: 'bold',
                color: 'var(--gold)',
                cursor: 'pointer'
              }} onClick={() => {
                navigator.clipboard.writeText('SHAKE15');
                alert('Copied to clipboard!');
              }}>
                SHAKE15 <small style={{fontSize: '0.65rem', color: 'var(--muted)', fontWeight: 'normal'}}>(Tap to copy)</small>
              </div>
            </div>
          )}
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

        {/* Futuristic Floating Actions & Triggers */}
        <div className="futuristic-floating-actions">
          <button className="float-action-btn wheel-btn" onClick={() => setShowSpinWheel(true)}>
            <span className="float-icon">🎡</span>
            <span className="float-label">Spin & Win</span>
          </button>
          <button className="float-action-btn ai-btn" onClick={() => setShowAiBot(true)}>
            <span className="float-icon">🤖</span>
            <span className="float-label">AI Assistant</span>
          </button>
        </div>

        {/* Daily Spin & Win Modal */}
        {showSpinWheel && (
          <div className="futuristic-modal-overlay" onClick={() => { if (!wheelSpinning) setShowSpinWheel(false); }}>
            <div className="futuristic-modal-card wheel-card" onClick={e => e.stopPropagation()}>
              <button className="modal-close-btn" onClick={() => setShowSpinWheel(false)} disabled={wheelSpinning}>✕</button>
              <h2 className="modal-title">🎡 Daily Spin & Win</h2>
              <p className="modal-subtitle">Spin once a day to win points or discount codes!</p>
              
              <div className="wheel-container">
                <div className="wheel-pointer">⚡</div>
                <div className={`neon-wheel ${wheelSpinning ? 'spinning' : ''}`} style={{
                  transform: wheelPrize ? `rotate(${wheelPrize.rotation}deg)` : 'rotate(0deg)',
                  transition: wheelSpinning ? 'transform 3s cubic-bezier(0.1, 0.8, 0.1, 1)' : 'none'
                }}>
                  <div className="wheel-sector sec-1"><span>🎁 KES 50</span></div>
                  <div className="wheel-sector sec-2"><span>🚚 FREE DEL</span></div>
                  <div className="wheel-sector sec-3"><span>⭐ 100 PTS</span></div>
                  <div className="wheel-sector sec-4"><span>😢 TRY LATER</span></div>
                </div>
                <div className="wheel-center-hub">BLITZ</div>
              </div>

              {wheelPrize && (
                <div className="wheel-prize-announcement animate-prize">
                  <h4>🎉 Congratulations!</h4>
                  <p>{wheelPrize.message}</p>
                  {wheelPrize.code && (
                    <div className="wheel-coupon-box" onClick={() => {
                      navigator.clipboard.writeText(wheelPrize.code);
                      alert('Coupon code copied!');
                    }}>
                      {wheelPrize.code} <small>(Tap to copy)</small>
                    </div>
                  )}
                </div>
              )}

              <button 
                className="btn-neon spin-action-btn" 
                onClick={spinTheWheel} 
                disabled={wheelSpinning || lastSpinDate === new Date().toLocaleDateString()}
              >
                {wheelSpinning ? '🌀 Spinning...' : lastSpinDate === new Date().toLocaleDateString() ? '🔒 Come Back Tomorrow' : '🔥 Spin Now!'}
              </button>
            </div>
          </div>
        )}

        {/* AI Assistant Chat Drawer */}
        {showAiBot && (
          <div className="ai-chat-drawer">
            <div className="ai-chat-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="ai-chat-avatar">🤖</span>
                <div>
                  <h4 style={{ margin: 0 }}>Blitz AI Assistant</h4>
                  <small style={{ color: 'var(--green)' }}>● Online</small>
                </div>
              </div>
              <button className="ai-chat-close" onClick={() => setShowAiBot(false)}>✕</button>
            </div>
            
            <div className="ai-chat-messages">
              {aiMessages.map((msg, i) => (
                <div className={`ai-message ${msg.sender}`} key={i}>
                  <div className="ai-message-bubble">
                    {msg.text.split('\n').map((line, idx) => (
                      <p key={idx} style={{ margin: '4px 0' }}>{line}</p>
                    ))}
                  </div>
                </div>
              ))}
              {aiLoading && (
                <div className="ai-message bot">
                  <div className="ai-message-bubble loading">
                    <span>.</span><span>.</span><span>.</span>
                  </div>
                </div>
              )}
            </div>

            <form className="ai-chat-input-row" onSubmit={sendAiMessage}>
              <input 
                type="text" 
                placeholder="Ask me for a recipe, rewards info..." 
                value={aiInput} 
                onChange={e => setAiInput(e.target.value)} 
                disabled={aiLoading} 
              />
              <button type="submit" className="btn-neon" disabled={aiLoading || !aiInput.trim()}>Send</button>
            </form>
          </div>
        )}

        <BottomNav />
        {renderToasts()}
        {renderShakeStyle()}
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
        {renderToasts()}
      </div>
    );
  }

  // CART
  if (screen === 'cart') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('home')}>‹</button><h2 className="topbar-title">Your Cart</h2></header>
      <div className="scroll">
        {cart.length === 0 ? (
          <div className="empty-cart">
            <span>🛒</span>
            <p>Your cart is empty</p>
            <button className="btn-ghost" onClick={() => setScreen('home')} style={{marginBottom: 20}}>Start shopping</button>
            {savedBaskets.length > 0 && (
              <div style={{marginTop: 30, width: '100%', textAlign: 'left', padding: '0 16px'}}>
                <h3 className="section-h" style={{margin: '0 0 10px 0', padding: 0}}>📋 Saved Carts / Templates</h3>
                <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                  {savedBaskets.map(b => (
                    <div key={b._id} style={{background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                      <div style={{flex: 1, marginRight: 10}}>
                        <b style={{fontSize: '.85rem', color: 'var(--gold)'}}>{b.basketName}</b>
                        <div style={{fontSize: '.72rem', color: 'var(--muted)', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>
                          {b.items.map(it => `${it.name} (${it.quantity})`).join(', ')}
                        </div>
                      </div>
                      <div style={{display: 'flex', gap: 6}}>
                        <button className="btn-neon" onClick={() => loadSavedBasketToCart(b)} style={{padding: '6px 12px', fontSize: '.75rem'}}>Load</button>
                        <button className="btn-ghost" onClick={() => deleteSavedBasket(b._id)} style={{padding: '6px 8px', fontSize: '.75rem', borderColor: 'var(--red)', color: 'var(--red)'}}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (<>
          <div className="cart-list">{cart.map(i => (
            <div className="cart-row" key={productId(i)}>
              <div className="cart-thumb">{i.image ? <img src={i.image} alt={i.name} /> : '🛍️'}</div>
              <div className="cart-info"><b>{i.name}</b><span className="cart-price">KES {i.price}</span></div>
              <div className="qty-ctrl small"><button onClick={() => setQty(productId(i), i.quantity - 1)}>−</button><b>{i.quantity}</b><button onClick={() => setQty(productId(i), i.quantity + 1)}>+</button></div>
              <button className="trash" onClick={() => setQty(productId(i), 0)}>🗑️</button>
            </div>))}
          </div>

          {/* Cart progress bar */}
          <div className="gamified-delivery-bar" style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',margin:'12px 16px'}}>
            {total >= 1500 ? (
              <div style={{textAlign:'center'}}>
                <span style={{fontSize:'1.3rem'}}>🎉</span> <b style={{color:'var(--green)',fontSize:'.88rem'}}>Free Delivery Unlocked!</b>
                <p className="muted" style={{fontSize:'.75rem',marginTop:4,marginBottom:0}}>Your order qualifies for free shipping (save KES 150).</p>
              </div>
            ) : (
              <div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:'.82rem',marginBottom:6}}>
                  <span>Free Delivery progress:</span>
                  <b>KES {total} / KES 1,500</b>
                </div>
                <div style={{background:'var(--bg-2)',height:8,borderRadius:4,overflow:'hidden',border:'1px solid var(--line)'}}>
                  <div style={{background:'linear-gradient(90deg, var(--orange), var(--gold))',width:`${Math.min(100, (total/1500)*100)}%`,height:'100%',borderRadius:4,transition:'width 0.3s ease'}} />
                </div>
                <p className="muted" style={{fontSize:'.75rem',marginTop:6,marginBottom:0,textAlign:'center'}}>
                  Add <b>KES {1500 - total}</b> more to unlock free delivery!
                </p>
              </div>
            )}
          </div>

          {/* Save active cart template */}
          <div style={{margin: '12px 16px'}}>
            {!showBasketSaveForm ? (
              <button className="btn-ghost" onClick={() => setShowBasketSaveForm(true)} style={{width: '100%', padding: '8px 12px', fontSize: '.82rem'}}>
                💾 Save Current Cart as Template
              </button>
            ) : (
              <div style={{background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px'}}>
                <h4 style={{margin: '0 0 8px 0', fontSize: '.85rem'}}>Save Cart Template</h4>
                <div style={{display: 'flex', gap: 8}}>
                  <input className="field" placeholder="Template name e.g. Weekly Groceries" value={basketNameInput} onChange={e => setBasketNameInput(e.target.value)} style={{flex: 1, padding: 8, borderRadius: 8, fontSize: '.82rem'}} />
                  <button className="btn-neon" onClick={saveCurrentBasket} style={{padding: '8px 12px', fontSize: '.82rem'}}>Save</button>
                  <button className="btn-ghost" onClick={() => { setShowBasketSaveForm(false); setBasketNameInput(''); }} style={{padding: '8px 10px', fontSize: '.82rem'}}>✕</button>
                </div>
              </div>
            )}
          </div>

          <div className="summary"><div className="summary-row"><span>Subtotal</span><b>KES {total}</b></div>
            <div className="summary-row muted"><span>Delivery</span><span>Calculated later</span></div></div>
        </>)}
      </div>
      {cart.length > 0 && <div className="detail-bar"><div className="detail-bar-total">KES {total}</div><button className="btn-neon" onClick={() => setScreen('checkout')}>Checkout</button></div>}
      {renderToasts()}
    </div>
  );

  // CHECKOUT
  if (screen === 'checkout') {
    const finalFee = total >= 1500 || appliedCoupon?.type === 'free_delivery' || deliveryArea === 'mall' ? 0 : 150;
    const discountAmt = appliedCoupon ? appliedCoupon.discount : 0;
    const finalTotal = Math.max(0, total + finalFee - discountAmt);

    return (
      <div className="screen with-nav">
        <header className="topbar">
          <button className="icon-btn back" onClick={() => {
            setAppliedCoupon(null);
            setCouponInput('');
            setDeliveryLocation('');
            setGpsCoords(null);
            setScreen('cart');
          }}>‹</button>
          <h2 className="topbar-title">Checkout</h2>
        </header>
        <div className="scroll">
          <h3 className="section-h">Delivery to</h3>
          <div className="info-card">
            <b>{customer?.name}</b>
            <span className="muted">{customer?.customerId}</span>
          </div>

          <h3 className="section-h">Delivery destination</h3>
          <div className="info-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              Select Delivery Area:
              <select className="field" value={deliveryArea} onChange={e => setDeliveryArea(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '8px', background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                <option value="mall">Mall Area (KES 0 - Free)</option>
                <option value="standard">Standard Delivery (KES 150)</option>
              </select>
            </label>

            <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              Detailed Address / Landmark:
              <input className="field" placeholder="e.g. Apartment, House No, Landmark" value={deliveryLocation} onChange={e => setDeliveryLocation(e.target.value)} style={{ padding: '8px', borderRadius: '8px' }} required />
            </label>

            <button type="button" className="btn-ghost" onClick={pinGpsLocation} style={{ width: '100%', padding: '8px', fontSize: '0.85rem' }} disabled={gpsLoading}>
              {gpsLoading ? '⏳ Fetching Location...' : gpsCoords ? '✅ GPS Location Pinned' : '📍 Pin Location (Get GPS)'}
            </button>
            {gpsCoords && (
              <small style={{ color: 'var(--green)', fontSize: '0.75rem', textAlign: 'center' }}>
                Coordinates: {gpsCoords.lat.toFixed(5)}, {gpsCoords.lng.toFixed(5)}
              </small>
            )}
          </div>

          <h3 className="section-h">Promo code</h3>
          <div className="info-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input className="field" placeholder="Enter coupon code (e.g. BLITZ10)" value={couponInput} onChange={e => setCouponInput(e.target.value)} style={{ flex: 1, padding: '8px', borderRadius: '8px' }} />
              <button type="button" className="btn-neon" onClick={validateCoupon} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>Apply</button>
            </div>
            {appliedCoupon && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(54, 211, 153, 0.1)', color: 'var(--green)', padding: '6px 10px', borderRadius: '6px', fontSize: '0.85rem' }}>
                <span>Applied: <b>{appliedCoupon.code}</b> (- KES {appliedCoupon.discount})</span>
                <button type="button" onClick={() => { setAppliedCoupon(null); setCouponInput(''); }} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
              </div>
            )}
            {couponError && (
              <small style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{couponError}</small>
            )}
          </div>

          <h3 className="section-h">Payment method</h3>
          <button className={`pay-opt ${payMethod === 'delivery' ? 'sel' : ''}`} onClick={() => setPayMethod('delivery')}>
            <span>💵</span>
            <div>
              <b>Pay on delivery</b>
              <small>Pay cash when it arrives</small>
            </div>
            <i className="radio" />
          </button>
          <button className={`pay-opt soon ${payMethod === 'mpesa' ? 'sel' : ''}`} onClick={() => setPayMethod('mpesa')}>
            <span>📱</span>
            <div>
              <b>M-Pesa</b>
              <small>Coming soon — enter PIN to pay</small>
            </div>
            <i className="radio" />
          </button>

          <div className="summary">
            <div className="summary-row"><span>Subtotal</span><b>KES {total}</b></div>
            <div className="summary-row"><span>Delivery fee</span><b>KES {finalFee}</b></div>
            {discountAmt > 0 && (
              <div className="summary-row" style={{ color: 'var(--green)' }}><span>Discount</span><b>- KES {discountAmt}</b></div>
            )}
            <div className="summary-row total"><span>Total</span><b>KES {finalTotal}</b></div>
          </div>
        </div>
        <div className="detail-bar">
          <div className="detail-bar-total">KES {finalTotal}</div>
          <button className="btn-neon" onClick={handleCheckout}>Place order</button>
        </div>
        {renderToasts()}
      </div>
    );
  }

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

        {custLoyalty && (
          <div className="loyalty-card-wrapper" style={{ margin: '16px 14px', background: 'var(--grad)', borderRadius: '14px', padding: '16px', color: '#000', position: 'relative', overflow: 'hidden', boxShadow: '0 8px 20px rgba(255, 122, 26, 0.25)' }}>
            <div style={{ position: 'absolute', right: '-20px', bottom: '-20px', fontSize: '6rem', opacity: 0.12, transform: 'rotate(-15deg)' }}>⚡</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold', opacity: 0.7 }}>Blitz Loyalty Card</span>
                <h3 style={{ margin: '4px 0 0 0', fontFamily: 'Unbounded, sans-serif', fontSize: '1.2rem' }}>{custLoyalty.tier} Tier</h3>
              </div>
              <span style={{ fontSize: '1.5rem' }}>🎁</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>Accumulated Points</span>
                <div style={{ fontFamily: 'Unbounded, sans-serif', fontSize: '1.5rem', fontWeight: 'bold', margin: '2px 0 0 0' }}>{custLoyalty.points} PTS</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>Est. Cashback</span>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '2px 0 0 0' }}>KES {Math.round(custLoyalty.points * 5).toLocaleString()}</div>
              </div>
            </div>
            <small style={{ display: 'block', marginTop: '10px', fontSize: '0.65rem', opacity: 0.7, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: '6px' }}>
              * 100 PTS = KES 500 cashback. Ask cashier to redeem at counter!
            </small>
          </div>
        )}

        {custLoyalty && loyaltyRewards.length > 0 && (
          <div style={{margin: '16px 14px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px'}}>
            <h3 style={{margin: '0 0 10px 0', fontSize: '.95rem', fontFamily: 'Unbounded, sans-serif', color: 'var(--gold)'}}>🎁 Points Redemption Store</h3>
            <p className="muted" style={{fontSize: '.75rem', marginBottom: 12}}>Trade your accumulated loyalty points for checkout coupon codes!</p>
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {loyaltyRewards.map(r => {
                const canRedeem = custLoyalty.points >= r.pointsCost;
                return (
                  <div key={r._id} style={{display:'flex', justifyContent:'space-between', alignItems:'center', background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:10, padding:'10px 12px'}}>
                    <div>
                      <b style={{fontSize:'.82rem', color:'#fff'}}>{r.name}</b>
                      <div className="muted" style={{fontSize:'.7rem', marginTop:2}}>Costs: <b style={{color:'var(--orange)'}}>{r.pointsCost} PTS</b> · Value: KES {r.rewardValue}</div>
                    </div>
                    <button 
                      className="btn-neon" 
                      disabled={!canRedeem} 
                      onClick={() => redeemReward(r._id)} 
                      style={{
                        padding: '6px 12px', 
                        fontSize: '.72rem', 
                        background: canRedeem ? 'var(--grad)' : 'var(--line)',
                        borderColor: canRedeem ? 'transparent' : 'var(--line)',
                        color: canRedeem ? '#000' : 'var(--muted)'
                      }}
                    >
                      Trade
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <h3 className="section-h">Choose an avatar</h3>
        <div className="avatar-row">
          {AVATARS.map(a => (
            <button key={a.id} className={`avatar-pick ${profile?.avatarId === a.id && !profile?.photo ? 'sel' : ''}`}
              onClick={() => saveProfile({ ...(profile || {}), avatarId: a.id, photo: null })}>
              <img src={getAvatarSrc(a.src)} alt={a.id} />
            </button>
          ))}
          <label className="avatar-upload">＋<input type="file" accept="image/*" onChange={onUpload} hidden /></label>
        </div>

        <h3 className="section-h">Account</h3>
        <button className="row-btn" onClick={() => { loadMyOrders(); setScreen('orders'); }}>📦 My orders<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('cart')}>🛒 My cart<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('share')}>📲 Share / Download App<span>›</span></button>
        <button className="row-btn" onClick={() => { setReviewStars(0); setReviewMsg(''); setReviewSent(false); setScreen('review'); }}>⭐ Rate us / Feedback<span>›</span></button>
        <button className="row-btn danger" onClick={handleLogout}>↩️ Logout<span>›</span></button>
      </div>
      <BottomNav />
      {renderToasts()}
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
              
              {o.status === 'on_the_way' && (
                <div className="bike-anim-container">
                  <span className="bike-node">🏪 Mall</span>
                  <div className="bike-track" />
                  <span className="bike-emoji">🛵</span>
                  <span className="bike-node">📍 Dest</span>
                </div>
              )}

              <div className="tracker">{steps.map((s, i) => (
                <div className={`t-step ${i <= idx ? 'done' : ''} ${i === idx ? 'now' : ''}`} key={s}><i /><small>{stepLabel[s]}</small></div>
              ))}</div>

              <button type="button" className="btn-ghost small" onClick={() => reOrderPastOrder(o)} style={{ marginTop: '12px', fontSize: '0.8rem', width: '100%', padding: '6px' }}>
                🔄 Order Again
              </button>
            </div>
          );
        })}
      </div>
      <BottomNav />
      {renderToasts()}
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
      {renderToasts()}
    </div>
  );

  // SHARE / DOWNLOAD APP
  if (screen === 'share') {
    const apkUrl = 'https://blitzmall-frontend.vercel.app/blitzmall.apk';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(apkUrl)}`;
    
    return (
      <div className="screen with-nav">
        <header className="topbar">
          <button className="icon-btn back" onClick={() => setScreen('profile')}>‹</button>
          <h2 className="topbar-title">Share App</h2>
        </header>
        <div className="scroll">
          <div className="share-box">
            <BlitzLogo size={50} />
            <h3 style={{ marginTop: '12px', marginBottom: '4px', fontFamily: 'Unbounded, sans-serif', fontSize: '1.2rem' }}>Get BlitzMall App</h3>
            <p className="muted" style={{ fontSize: '0.9rem' }}>Scan this QR code to download the Android APK directly onto your phone.</p>
            
            <div className="share-qr-container">
              <img src={qrUrl} alt="App Download QR Code" />
            </div>

            <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '8px' }}>Or download directly using this link:</p>
            <div className="share-link-box" onClick={() => {
              navigator.clipboard.writeText(apkUrl);
              alert('Download link copied to clipboard!');
            }}>
              {apkUrl}
            </div>
            <small style={{ color: 'var(--muted)', fontSize: '0.75rem', display: 'block', marginTop: '-8px', marginBottom: '16px' }}>
              (Tap link to copy to clipboard)
            </small>

            <div className="share-steps">
              <h4>📋 Installation Instructions:</h4>
              <ol>
                <li>Scan the QR code or tap the link to download the <strong>blitzmall.apk</strong> file.</li>
                <li>Open the downloaded file on your Android device.</li>
                <li>If prompted, allow installation from "Unknown Sources" in your browser/settings.</li>
                <li>Tap <strong>Install</strong> and follow the prompts to complete setup.</li>
              </ol>
            </div>
          </div>
        </div>
        <BottomNav />
        {renderToasts()}
      </div>
    );
  }

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
