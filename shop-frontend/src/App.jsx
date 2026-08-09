
import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import ErrorBoundary from './ErrorBoundary';
import { SplashScreen } from '@capacitor/splash-screen';
import { Capacitor } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
const Admin = React.lazy(() => import('./Admin'));

const getDefaultApiUrl = () => {
  try {
    const saved = localStorage.getItem('blitz_api_url');
    if (saved) return saved;
  } catch (e) {}
  
  return 'https://blitzmall-backend.onrender.com/api';
};

const API_URL = getDefaultApiUrl();
const PRODUCTS_CACHE_KEY = 'blitz_products_cache';
const ORDERS_CACHE_KEY = 'blitz_orders_cache';
const OFFLINE_ORDERS_KEY = 'blitz_offline_orders';
const CUSTOMER_KEY = 'blitz_customer';
const FAVORITES_KEY = 'blitz_favorites';
const SHOP_COORDS = { lat: 0.8273, lng: 35.1207 }; // Blitz Mall, Matunda

let fcmWebApp = null; // reuse the Firebase web app across toggle on/off cycles

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

// Product images may be a single URL or an array of up to 3. These helpers keep
// the default display to one photo and expose the full set for the tap gallery.
const firstImage = (img) => (Array.isArray(img) ? img[0] : img);
const allImages = (img) => (Array.isArray(img) ? img.filter(Boolean) : (img ? [img] : []));
// Upscale Open Food/Beauty Facts thumbnails (…front_en.3.400.jpg) to full-res
// so the tapped gallery is crisp and clear. Other URLs pass through unchanged.
const hiRes = (url) => (typeof url === 'string' ? url.replace(/\.\d+\.jpg(\?.*)?$/i, '.full.jpg') : url);

function Avatar({ profile, size = 40 }) {
  const st = { width: size, height: size };
  const rawSrc = profile?.photo || (AVATARS.find(x => x.id === profile?.avatarId) || AVATARS[0]).src;
  const src = getAvatarSrc(rawSrc);
  return <img className="avatar" style={st} src={src} alt="me" />;
}

const DEFAULT_BANNERS = [
  { id: 1, title: "🚀 MEGA LAUNCH", text: "Free Delivery on Mall Area orders! Limited time.", code: "", gradient: "linear-gradient(135deg, #ff007f, #7f00ff)" },
  { id: 2, title: "🎁 WEEKEND SPECIAL", text: "Get 10% discount on orders over KES 1000!", code: "BLITZ10", gradient: "linear-gradient(135deg, #00f2fe, #4facfe)" },
  { id: 3, title: "💳 INSTANT PAY", text: "Scan & Pay with secure M-Pesa STK push!", code: "", gradient: "linear-gradient(135deg, #38ef7d, #11998e)" },
];

// The 8 sectors of the prize wheel (colors must match the server's sector order).
// Wheel slices must match the server's WHEEL_SECTORS outcome list (labels &
// colors only — the SERVER decides the prize, the wheel is pure theatre).
const WHEEL_SECTORS = [
  { label: 'TRY AGAIN', color: '#3a3a46' },
  { label: 'TRY AGAIN', color: '#3a3a46' },
  { label: '1 PT', color: '#30d158' },
  { label: '2 PTS', color: '#30d158' },
  { label: '3 PTS', color: '#30d158' },
  { label: '5 PTS', color: '#30d158' },
  { label: 'KES 50', color: '#bf5af2' },
  { label: '10 PTS', color: '#ffd60a' },
  { label: 'FREE DEL', color: '#64d2ff' },
  { label: 'KES 100', color: '#ff9f0a' },
  { label: '25 PTS', color: '#30d158' },
  { label: 'JACKPOT', color: '#ff2d55' },
];

const TIER_LABELS = { Bronze: '🥉 Bronze Shopper', Silver: '🥈 Silver Shopper', Gold: '🥇 Gold Shopper', Platinum: '💎 Platinum Shopper' };

// Screens that auto-redirect themselves (never recorded in the back stack).
const TRANSIENT_SCREENS = ['splash', 'welcome'];

// Exit the native app. Works in the Capacitor Android app, plain WebViews and
// the browser (where it just closes the window).
const exitApp = () => {
  try {
    const app = Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
    if (app && app.exitApp) { app.exitApp(); return; }
  } catch (e) {}
  try {
    if (window.navigator && window.navigator.app && window.navigator.app.exitApp) { window.navigator.app.exitApp(); return; }
  } catch (e) {}
  window.close();
};

// True scratch-to-reveal card. A canvas foil sits on top of the hidden prize;
// rubbing it (touch or mouse) erases the foil and reveals the server-issued
// voucher underneath once enough of it is scratched.
function ScratchCard({ revealed, result, claiming, signedIn, onComplete, onNeedLogin, onCopy }) {
  const canvasRef = useRef(null);
  const pressedRef = useRef(false);
  const doneRef = useRef(false);
  const lastCheckRef = useRef(0);
  const stageRef = useRef(null);

  // Prevent the page from scrolling while the user's finger is on the scratch
  // card. CSS `touch-action: none` is unreliable on some mobile browsers, so we
  // attach a non-passive touchmove listener that calls preventDefault().
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const prevent = (e) => { if (pressedRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', prevent, { passive: false });
    return () => el.removeEventListener('touchmove', prevent);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || revealed || !signedIn) return;
    doneRef.current = false;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    grad.addColorStop(0, '#c89b3c');
    grad.addColorStop(0.35, '#f7c945');
    grad.addColorStop(0.7, '#d4a94e');
    grad.addColorStop(1, '#a67c1e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillStyle = 'rgba(110, 74, 0, 0.35)';
    for (let x = 14; x < rect.width; x += 30) {
      for (let y = 14; y < rect.height; y += 30) ctx.fillText('₵', x, y);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✦ SCRATCH HERE ✦', rect.width / 2, rect.height / 2 - 8);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('rub with your finger to reveal', rect.width / 2, rect.height / 2 + 12);
  }, [revealed, signedIn]);

  const scratchAt = (clientX, clientY) => {
    if (doneRef.current || !signedIn || revealed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(clientX - rect.left, clientY - rect.top, 20, 0, Math.PI * 2);
    ctx.fill();
    // Check how much foil is left only every ~150ms — getImageData is costly on
    // low-end devices and pointermove fires dozens of times per second.
    const now = performance.now();
    if (now - lastCheckRef.current < 150) return;
    lastCheckRef.current = now;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let clear = 0, total = 0;
      for (let i = 3; i < data.length; i += 80) { total++; if (data[i] === 0) clear++; }
      if (total && clear / total > 0.45) {
        doneRef.current = true;
        ctx.globalCompositeOperation = 'source-over';
        onComplete();
      }
    } catch (e) {}
  };

  if (!signedIn) {
    return (
      <div className="scratch-stage" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, height: 'auto', minHeight: 150, padding: 20 }}>
        <span style={{ fontSize: '2rem' }}>🎁</span>
        <p className="muted" style={{ margin: 0, fontSize: '.8rem', textAlign: 'center' }}>Sign in with your phone number to scratch & win daily deals!</p>
        <button className="btn-neon" onClick={onNeedLogin} style={{ padding: '8px 18px', fontSize: '.8rem' }}>Sign In</button>
      </div>
    );
  }

  if (revealed) {
    const win = !!(result && result.code);
    const title = (result && result.title) || (result && result.message) || 'Better Luck Tomorrow!';
    const msg = (result && result.message) || (claiming ? 'Revealing your prize…' : '');
    return (
      <div className="scratch-result">
        <div className="scratch-emoji">{claiming ? '🔄' : win ? '🎉' : '😢'}</div>
        <h4>{claiming ? 'Revealing…' : title}</h4>
        <p>{claiming ? 'Hang tight — unlocking your prize…' : msg}</p>
        {claiming && (
          <div className="spinner" style={{ width: 28, height: 28, margin: '0 auto', borderRadius: '50%', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--gold)', animation: 'spin 1s linear infinite' }} />
        )}
        {win && !claiming && (
          <div className="scratch-code" onClick={() => onCopy(result.code)} style={{ cursor: 'pointer' }}>
            {result.code}
            <small style={{ fontSize: '0.6rem', display: 'block', color: 'var(--muted)' }}>(tap to copy · use at checkout)</small>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={stageRef} className="scratch-stage" onPointerDown={e => { pressedRef.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {} scratchAt(e.clientX, e.clientY); }} onPointerMove={e => { if (pressedRef.current) scratchAt(e.clientX, e.clientY); }} onPointerUp={() => { pressedRef.current = false; }} onPointerLeave={() => { pressedRef.current = false; }}>
      <div className="scratch-under">
        <div className="scratch-emoji">🎁</div>
        <h4>Scratch & Win Daily!</h4>
        <p>Scratch the foil to reveal today's lucky deal</p>
      </div>
      <canvas ref={canvasRef} className="scratch-canvas" />
      <div className="scratch-hint">✦ rub to reveal ✦</div>
    </div>
  );
}

function FlashSaleCountdown({ expires }) {
  const [timeLeft, setTimeLeft] = useState('...');
  useEffect(() => {
    if (!expires) {
      setTimeLeft('Limited time');
      return;
    }
    const updateTimer = () => {
      const diff = new Date(expires) - new Date();
      if (diff <= 0) {
        setTimeLeft('Ended');
        return;
      }
      const secs = Math.floor(diff / 1000);
      const mins = Math.floor(secs / 60);
      const hours = Math.floor(mins / 60);
      const days = Math.floor(hours / 24);
      if (days > 0) {
        setTimeLeft(`${days}d ${hours % 24}h`);
      } else {
        const h = String(hours % 24).padStart(2, '0');
        const m = String(mins % 60).padStart(2, '0');
        const s = String(secs % 60).padStart(2, '0');
        setTimeLeft(`${h}:${m}:${s}`);
      }
    };
    updateTimer();
    const id = setInterval(updateTimer, 1000);
    return () => clearInterval(id);
  }, [expires]);
  return <span>{timeLeft}</span>;
}

// Live delivery map — real OpenStreetMap view of the shop and the customer's
// pinned drop-off point, connected by a dashed route line. Uses Leaflet with
// emoji div-markers (no image assets to bundle, works offline-first).
function LiveMap({ from, to, height = 180 }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      try { map.remove(); } catch (e) {}
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Only re-draw when the coordinates actually change (the orders screen
  // re-renders on its 15s auto-refresh, and we don't want to reset the user's
  // zoom/pan every time).
  const lastCoordsRef = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    const key = `${from && from.lat}|${from && from.lng}|${to && to.lat}|${to && to.lng}`;
    if (key === lastCoordsRef.current) return;
    lastCoordsRef.current = key;
    layer.clearLayers();
    const pts = [];
    if (from && from.lat && from.lng) {
      pts.push(L.latLng(from.lat, from.lng));
      L.marker([from.lat, from.lng], {
        icon: L.divIcon({ className: '', html: '<div style="font-size:24px;line-height:1">🏪</div>', iconSize: [28, 28], iconAnchor: [14, 14] })
      }).addTo(layer).bindPopup('Blitz Mall Shop');
    }
    if (to && to.lat && to.lng) {
      pts.push(L.latLng(to.lat, to.lng));
      L.marker([to.lat, to.lng], {
        icon: L.divIcon({ className: '', html: '<div style="font-size:24px;line-height:1">📍</div>', iconSize: [28, 28], iconAnchor: [14, 28] })
      }).addTo(layer).bindPopup('Your delivery location');
    }
    if (from && from.lat && from.lng && to && to.lat && to.lng) {
      L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color: '#ff7a1a', weight: 3, dashArray: '6 6', opacity: 0.9
      }).addTo(layer);
    }
    try {
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25));
      else map.setView([SHOP_COORDS.lat, SHOP_COORDS.lng], 13);
    } catch (e) {}
  }, [from, to]);

  return <div ref={ref} style={{ height, width: '100%', borderRadius: 12, zIndex: 0, position: 'relative' }} />;
}

function App() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [screen, setScreen] = useState('splash');
  const [perfMode, setPerfMode] = useState(() => {
    try {
      const saved = localStorage.getItem('blitz_perf_mode');
      if (saved !== null) return saved === 'true'; // user's explicit choice wins
      // No saved choice yet: auto-enable on low-end devices (few CPU cores or
      // little RAM) so the app stays fast; high-end devices keep the rich UI.
      const cores = navigator.hardwareConcurrency || 8;
      const mem = navigator.deviceMemory || 8;
      return cores <= 4 || mem <= 3;
    } catch (e) {
      return false;
    }
  });

  useEffect(() => {
    // The Admin screen owns its own perf-mode class (Fast/Rich toggle). Skip
    // it here so the Admin is never silently forced into perf mode on a PC
    // the customer view auto-flags as low-end — which is what killed the
    // glowing Sign In button.
    if (isAdmin) return;
    try {
      if (perfMode) {
        document.body.classList.add('perf-mode');
      } else {
        document.body.classList.remove('perf-mode');
      }
    } catch (e) {}
  }, [perfMode, isAdmin]);

  // Futuristic addictive features — prizes are decided SERVER-SIDE so the
  // odds can't be cheated, every voucher is bound to the winning phone number
  // and actually works at checkout, and daily limits survive app restarts.
  const [showSpinWheel, setShowSpinWheel] = useState(false);
  const [wheelSpinning, setWheelSpinning] = useState(false);
  const [wheelPrize, setWheelPrize] = useState(null);
  const [wheelRotation, setWheelRotation] = useState(0);
  const [promoStatus, setPromoStatus] = useState(null);

  const [showAiBot, setShowAiBot] = useState(false);
  const [aiMessages, setAiMessages] = useState([
    { sender: 'bot', text: 'Jambo! I am your BlitzMall AI Assistant. Ask me to add products to cart, track or cancel orders, or file complaints!' }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const aiMessagesEndRef = useRef(null);
  
  const aiQuickActions = [
    { label: '🛒 Add milk', text: 'add milk to cart' },
    { label: '🛍️ Order milk + bread', text: 'order milk and bread' },
    { label: '📦 Track order', text: 'track my order' },
    { label: '🍳 Recipe ideas', text: 'recipe ideas' },
    { label: '🏷️ Show deals', text: 'show me deals' },
  ];

  const handleAiQuickAction = (actionText) => {
    setAiInput(actionText);
    // Send the message directly after a brief delay for state update
    setTimeout(async () => {
      const userMsg = { sender: 'user', text: actionText };
      setAiMessages(prev => [...prev, userMsg]);
      setAiInput('');
      setAiLoading(true);
      try {
        const aiRes = await fetch(`${API_URL}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: actionText, customerId: customer?.customerId })
        });
        const aiData = await aiRes.json();
        if (aiData.action?.type === 'add_to_cart' && aiData.action.product) {
          addToCart(aiData.action.product, aiData.action.quantity || 1);
        } else if (aiData.action?.type === 'order_placed') {
          showToast('✅ Order placed! Track it in My Orders.');
          loadMyOrders();
        }
        const botResponse = aiData.response || 'Sorry, I could not process that.';
        setAiMessages(prev => [...prev, { sender: 'bot', text: botResponse }]);
      } catch (e) {
        setAiMessages(prev => [...prev, { sender: 'bot', text: '🤖 Sorry, I encountered an error. Please try again later.' }]);
      } finally {
        setAiLoading(false);
      }
    }, 100);
  };

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (aiMessagesEndRef.current) {
      aiMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [aiMessages, aiLoading]);

  const [banners, setBanners] = useState(DEFAULT_BANNERS);
  const [scratchResult, setScratchResult] = useState(null);
  const [scratchRevealed, setScratchRevealed] = useState(false);

  const [customer, setCustomer] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem(CUSTOMER_KEY)); return c && c.customerId ? c : null; } catch { return null; }
  });
  const [notifEnabled, setNotifEnabled] = useState(() => {
    try { return localStorage.getItem('blitz_push_enabled') === 'true'; } catch { return false; }
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
  const [favorites, setFavorites] = useState(() => {
    try { const f = JSON.parse(localStorage.getItem(FAVORITES_KEY)); return Array.isArray(f) ? f : []; } catch { return []; }
  });
  const [referralCode, setReferralCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // Phone-verified sign-in: a first-time number must confirm a 6-digit OTP
  // before its account is created (returning numbers sign straight in).
  const [otpPending, setOtpPending] = useState(null); // { phone, name, referralCode } awaiting the code
  const [otpInput, setOtpInput] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpResendIn, setOtpResendIn] = useState(0);
  const [otpVerifying, setOtpVerifying] = useState(false);
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
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [pointsToConvert, setPointsToConvert] = useState('');
  const [useWalletPayment, setUseWalletPayment] = useState(false);
  const [lastOrderWasDelivery, setLastOrderWasDelivery] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // Desktop (Electron) update status surfaced by main.js through the preload
  // bridge — lets the in-app "Check for Updates" button show real status
  // (checking / downloading / restart / up-to-date) instead of reloading.
  const [pcUpdateStatus, setPcUpdateStatus] = useState('');
  const [pcAppVersion, setPcAppVersion] = useState('');
  // Guaranteed-fallback update info from the raw latest.yml (never depends on
  // the GitHub API or electron-updater): { version, downloadUrl } when a
  // newer desktop build exists, null otherwise.
  const [pcLatest, setPcLatest] = useState(null);
  const [deliveryArea, setDeliveryArea] = useState('mall'); // 'mall' | 'standard'
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [gpsCoords, setGpsCoords] = useState(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsAddress, setGpsAddress] = useState('');
  const [orderTrackingProgress, setOrderTrackingProgress] = useState({});
  const [bannerIndex, setBannerIndex] = useState(0);
  const [savedBaskets, setSavedBaskets] = useState([]);
  const [basketNameInput, setBasketNameInput] = useState('');
  const [showBasketSaveForm, setShowBasketSaveForm] = useState(false);
  const [loyaltyRewards, setLoyaltyRewards] = useState([]);
  const [scratchRevealing, setScratchRevealing] = useState(false);
  const [custAccount, setCustAccount] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [custLoyalty, setCustLoyalty] = useState(null);
  const [stkCheckoutId, setStkCheckoutId] = useState(null);
  const [stkStatus, setStkStatus] = useState('idle'); // idle | waiting | confirmed | failed
  const [stkError, setStkError] = useState('');
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [reviewMsg, setReviewMsg] = useState('');
  const [reviewSent, setReviewSent] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showRefreshBtn, setShowRefreshBtn] = useState(false);
  const [appInfo, setAppInfo] = useState(null);
  const [gallery, setGallery] = useState(null); // image URLs when the photo gallery is open
  const pullThreshold = 80;
  const loadProducts = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/products`);
      const d = await r.json();
      if (Array.isArray(d)) {
        setProducts(d);
        localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(d));
      }
    } catch (e) { console.warn('Offline: using cached products'); }
  }, []);

  const loadBanners = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/banners`);
      const d = await r.json();
      if (Array.isArray(d)) {
        setBanners(d);
      }
    } catch (e) { console.warn('Failed to load banners'); }
  }, []);

  const touchStartYRef = useRef(0);
  const pullDistanceRef = useRef(0);
  const rafIdRef = useRef(null);

  const handleTouchStart = (e) => {
    const el = e.currentTarget;
    if (el && el.scrollTop === 0) touchStartYRef.current = e.touches[0].clientY;
    else touchStartYRef.current = 0;
  };

  const handleTouchMove = (e) => {
    if (!touchStartYRef.current) return;
    const delta = e.touches[0].clientY - touchStartYRef.current;
    if (delta > 0 && delta < 200) {
      pullDistanceRef.current = delta;
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          setPullDistance(pullDistanceRef.current);
          rafIdRef.current = null;
        });
      }
    }
  };

  const handleTouchEnd = async () => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const finalDist = pullDistanceRef.current || pullDistance;
    if (finalDist >= pullThreshold && !isRefreshing) {
      setIsRefreshing(true);
      await loadProducts();
      await loadBanners();
      setIsRefreshing(false);
    }
    setPullDistance(0);
    pullDistanceRef.current = 0;
    touchStartYRef.current = 0;
  };

  const refreshProducts = async () => {
    setIsRefreshing(true);
    await loadProducts();
    await loadBanners();
    setIsRefreshing(false);
    setShowRefreshBtn(false);
  };

  useEffect(() => {
    loadProducts();
    loadBanners();
    window.addEventListener('online', loadProducts);
    window.addEventListener('online', loadBanners);
    try { SplashScreen.hide(); } catch {}
    return () => {
      window.removeEventListener('online', loadProducts);
      window.removeEventListener('online', loadBanners);
    };
  }, [loadProducts, loadBanners]);

  useEffect(() => {
    if (!banners || banners.length <= 1) return;
    const interval = setInterval(() => {
      setBannerIndex((prevIndex) => (prevIndex + 1) % banners.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [banners]);

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

  // Load the signed-in phone's promo status (daily spins/scratch) + account.
  useEffect(() => {
    if (!customer?.customerId) return;
    loadPromoStatus();
    loadCustLoyalty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.customerId]);

  // ---- Android back-swipe protection ----
  // Every real screen change pushes a history entry; a back-swipe (or back
  // button) pops it like an in-app "back" instead of exiting the app. At the
  // root a single back just shows a hint — the app only exits on a deliberate
  // second back press, or via the explicit Exit App button in the profile.
  const navStackRef = useRef([]);
  const pushListenerRef = useRef(null); // native push-received listener (registered once)
  const backHandlingRef = useRef(false);
  const lastBackPressRef = useRef(0);

  useEffect(() => {
    try { window.history.replaceState({ screen: 'splash' }, ''); } catch (e) {}
    const onPop = () => {
      if (showSpinWheel) {
        // Never let a back-swipe kill the wheel mid-animation (the voucher was
        // already issued server-side and would be lost).
        if (wheelSpinning) { try { window.history.pushState({ spinning: 1 }, ''); } catch (e) {} return; }
        setShowSpinWheel(false);
        try { window.history.pushState({ modal: 1 }, ''); } catch (e) {}
        return;
      }
      if (showAiBot) {
        setShowAiBot(false);
        try { window.history.pushState({ modal: 1 }, ''); } catch (e) {}
        return;
      }
      const stack = navStackRef.current;
      if (stack.length > 1) {
        stack.pop();
        // Skip transient screens (splash/welcome auto-redirect themselves).
        while (stack.length > 1 && TRANSIENT_SCREENS.includes(stack[stack.length - 1])) stack.pop();
        backHandlingRef.current = true;
        setScreen(stack[stack.length - 1]);
      } else {
        const now = Date.now();
        if (now - lastBackPressRef.current < 3000) { exitApp(); return; }
        lastBackPressRef.current = now;
        showToast('Press back again to exit the app');
        try { window.history.pushState({ root: 1 }, ''); } catch (e) {}
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSpinWheel, showAiBot, wheelSpinning]);

  useEffect(() => {
    if (backHandlingRef.current) { backHandlingRef.current = false; return; }
    if (TRANSIENT_SCREENS.includes(screen)) return; // never record splash/welcome
    const stack = navStackRef.current;
    if (stack[stack.length - 1] !== screen) {
      stack.push(screen);
      try { window.history.pushState({ screen }, ''); } catch (e) {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (isOnline) syncOfflineOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  useEffect(() => {
    const onOn = () => { setIsOnline(true); setShowRefreshBtn(true); };
    const onOff = () => { setIsOnline(false); setShowRefreshBtn(false); };
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); };
  }, []);

  const saveProfile = (p) => { setProfile(p); try { localStorage.setItem('blitz_profile', JSON.stringify(p)); } catch {} };

  // OTP resend countdown — one tick per second while waiting to resend.
  useEffect(() => {
    if (otpResendIn <= 0) return;
    const id = setInterval(() => setOtpResendIn(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otpResendIn > 0]);

  // M-Pesa STK polling — must be before any conditional returns
  useEffect(() => {
    if (!stkCheckoutId || stkStatus !== 'waiting') return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await fetch(`${API_URL}/mpesa/status/${stkCheckoutId}`);
        const d = await r.json();
        if (d.status === 'confirmed') {
          stopped = true;
          setStkStatus('confirmed');
          setCart([]); setScreen('confirmation');
          triggerSimulatedNotifications();
        } else if (d.status === 'failed') {
          stopped = true;
          setStkStatus('failed');
          setStkError(d.resultDesc || '❌ Payment Declined — Wrong PIN or Cancelled');
        }
      } catch (e) { console.error(e); }
    };
    const interval = setInterval(poll, 2000);
    poll();
    const timeout = setTimeout(() => { if (!stopped) { stopped = true; clearInterval(interval); setStkStatus('failed'); setStkError('⏱️ Timed out waiting for payment. Try again.'); } }, 120000);
    return () => { stopped = true; clearInterval(interval); clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Today's spin + scratch status (and tier) for the signed-in phone.
  const loadPromoStatus = async () => {
    if (!customer?.customerId) return;
    try {
      const r = await fetch(`${API_URL}/promos/status/${customer.customerId}`);
      const d = await r.json();
      if (!d || d.error) return;
      setPromoStatus(d);
      if (d.scratch && d.scratch.used) {
        setScratchResult({ title: d.scratch.title, message: d.scratch.message, code: d.scratch.code, alreadyUsed: true });
        setScratchRevealed(true);
      }
    } catch (e) { console.warn('Failed to load promo status'); }
  };

  // Customer account is keyed by the phone they signed in with.
  const loadCustLoyalty = async () => {
    if (!customer?.customerId) return;
    try {
      const r = await fetch(`${API_URL}/customers/${customer.customerId}`);
      const d = await r.json();
      if (d && !d.error) {
        setCustAccount(d);
        setCustLoyalty({ tier: d.loyaltyTier || d.tier, points: d.loyaltyPoints || 0, totalSpent: d.totalSpent || 0 });
      }
    } catch (e) { console.error('Failed to load customer account:', e); }
  };

  // Scratch completed → ask the SERVER for the prize (fair, once per day, and
  // the voucher it issues is bound to this phone so it works at checkout).
  const claimScratch = async () => {
    if (scratchRevealing || !customer?.customerId) return;
    setScratchRevealing(true);
    try {
      const r = await fetch(`${API_URL}/promos/scratch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: customer.customerId, name: customer.name })
      });
      const d = await r.json();
      setScratchRevealing(false);
      if (!d.success) {
        // Gate (need 2 purchases) or cooldown — put the foil back + explain.
        setScratchResult(null);
        setScratchRevealed(false);
        showToast(d.error || (d.alreadyUsed ? (d.message || 'Scratch again later!') : 'Could not scratch — try again'));
        return;
      }
      setScratchResult(d);
      setScratchRevealed(true);
      setPromoStatus(s => ({ ...(s || {}), tier: d.tier || s?.tier, scratch: { used: true, code: d.code, title: d.title, message: d.message } }));
      if (d.code) {
        setCouponInput(d.code);
        showToast(`🎁 ${d.title}`);
      } else {
        showToast(d.alreadyUsed ? `🔒 ${d.title || 'Already claimed today'}` : `😢 ${d.title}`);
      }
    } catch (e) {
      setScratchRevealing(false);
      setScratchResult(null);
      setScratchRevealed(false); // put the foil back so they can retry
      showToast('Network error — please try again');
    }
  };

  const onScratchComplete = () => {
    if (scratchRevealed || scratchRevealing) return;
    setScratchRevealed(true); // lift the foil, reveal while the server decides
    claimScratch();
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

  const deferredSearchTerm = React.useDeferredValue(searchTerm);

  const categoryOf = (p) => (p.category && p.category.trim()) ? p.category.trim() : 'Other';
  const categories = React.useMemo(() => {
    return ['All', ...[...new Set(products.map(categoryOf))].sort()];
  }, [products]);
  const productId = (p) => p._id || p.id;
  const total = React.useMemo(() => cart.reduce((s, i) => s + i.price * i.quantity, 0), [cart]);
  const cartCount = React.useMemo(() => cart.reduce((s, i) => s + i.quantity, 0), [cart]);

  const trending = React.useMemo(() => {
    const term = deferredSearchTerm.trim().toLowerCase();
    let shown = products;
    if (activeCategory !== 'All') shown = shown.filter(p => categoryOf(p) === activeCategory);
    if (term) shown = shown.filter(p => p.name.toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term) || categoryOf(p).toLowerCase().includes(term));
    return [...shown].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [products, activeCategory, deferredSearchTerm]);

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
          if (!d.success) {
            // A definitive rejection (4xx: product no longer in the catalogue,
            // invalid basket…) will NEVER succeed — drop it and tell the
            // customer instead of retrying forever. Network/server errors
            // (5xx) stay queued for the next sync.
            if (r.status >= 400 && r.status < 500) {
              showToast('⚠️ One offline order could not be placed: ' + ((d && d.error) || 'an item is no longer available'));
            } else {
              synced.push(order);
            }
          }
        } catch (e) { console.error('Failed to sync offline order:', e); synced.push(order); }
      }
      localStorage.setItem(OFFLINE_ORDERS_KEY, JSON.stringify(synced));
    } catch (e) { console.warn('Failed to sync offline orders:', e); }
  }, []);

  useEffect(() => {
    if (!customer?.customerId) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ORDERS_CACHE_KEY + '_' + customer.customerId));
      if (Array.isArray(cached) && cached.length) setMyOrders(cached);
    } catch {}
    loadSavedBaskets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer]);

  useEffect(() => {
    if (screen === 'profile' || screen === 'referral') {
      loadCustLoyalty();
      loadLoyaltyRewards();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // When the Share screen opens, ask the server for the newest APK so the QR
  // code and download link always point at the latest released build.
  useEffect(() => {
    if (screen !== 'share') return;
    fetch(`${API_URL}/app-info`)
      .then(r => r.json())
      .then(d => { if (d && d.apkUrl) setAppInfo(d); })
      .catch(() => {});
  }, [screen]);

  const lastPollTimeRef = useRef(new Date().toISOString());

  useEffect(() => {
    if (!notifEnabled || !customer?.customerId) return;
    
    let active = true;
    const pollInterval = setInterval(async () => {
      if (!active) return;
      try {
        const r = await fetch(`${API_URL}/notifications/feed?phone=${customer.customerId}&since=${lastPollTimeRef.current}`);
        const data = await r.json();
        if (active && Array.isArray(data) && data.length > 0) {
          data.forEach(item => {
            showToast(`🔔 ${item.title} — ${item.body}`);
            if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) && 'Notification' in window && Notification.permission === 'granted') {
              try { new Notification(item.title, { body: item.body }); } catch (e) {}
            }
          });
          const latest = data[data.length - 1];
          if (latest && latest.createdAt) {
            lastPollTimeRef.current = latest.createdAt;
          }
        }
      } catch (e) {
        console.warn('Failed to poll notifications feed:', e);
      }
    }, 8000);
    
    return () => {
      active = false;
      clearInterval(pollInterval);
    };
  }, [notifEnabled, customer?.customerId]);

  useEffect(() => {
    if (couponInput && !appliedCoupon && total > 0) {
      const delayDebounce = setTimeout(() => {
        validateCoupon();
      }, 800);
      return () => clearTimeout(delayDebounce);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponInput, total, appliedCoupon]);

  const loadMyOrders = async () => {
    try {
      const r = await fetch(API_URL + '/customer-orders/' + customer.customerId);
      const d = await r.json();
      if (Array.isArray(d)) {
        setMyOrders(d.reverse());
        localStorage.setItem(ORDERS_CACHE_KEY_ORDERS, JSON.stringify(d));
        // Update tracking progress for active deliveries
        const progressMap = {};
        for (const o of d) {
          if (o.status === 'on_the_way' && o.dispatchedAt) {
            const elapsed = (Date.now() - new Date(o.dispatchedAt).getTime()) / 1000;
            const estTime = 20 * 60; // 20 min
            progressMap[o._id] = Math.min(95, Math.round((elapsed / estTime) * 100));
          } else if (o.status === 'delivered') {
            progressMap[o._id] = 100;
          } else {
            progressMap[o._id] = 0;
          }
        }
        setOrderTrackingProgress(progressMap);
      }
    } catch (e) {
      console.warn('Offline: using cached orders');
      try {
        const cached = JSON.parse(localStorage.getItem(ORDERS_CACHE_KEY_ORDERS));
        if (Array.isArray(cached)) setMyOrders(cached);
      } catch {}
    }
  };

  // Auto-refresh orders and tracking progress
  useEffect(() => {
    if (screen !== 'orders' || !customer?.customerId) return;
    const interval = setInterval(() => {
      loadMyOrders();
    }, 15000); // refresh every 15 seconds
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, customer?.customerId]);

  const addToCart = useCallback((p, qty = 1) => {
    const id = productId(p);
    setCart(prev => {
      const ex = prev.find(i => productId(i) === id);
      if (ex) return prev.map(i => productId(i) === id ? { ...i, quantity: i.quantity + qty } : i);
      return [...prev, { ...p, quantity: qty }];
    });
  }, []);

  const openProduct = useCallback((p) => { setActiveProduct(p); setDetailQty(1); setScreen('product'); }, []);

  const isFavorite = useCallback((id) => favorites.some(f => productId(f) === id), [favorites]);
  const toggleFavorite = useCallback((p) => {
    setFavorites(prev => {
      const id = productId(p);
      const next = prev.some(f => productId(f) === id) ? prev.filter(f => productId(f) !== id) : [...prev, p];
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch (e) {}
      return next;
    });
  }, []);

  // Desktop app: main.js streams live updater events here so the in-app
  // "Check for Updates" button can show exactly what the native auto-updater
  // is doing. (Must live before the `if (isAdmin)` early return — hooks can't
  // be conditional.)
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.blitzUpdater : null;
    if (!bridge || typeof bridge.onStatus !== 'function') return;
    const off = bridge.onStatus((s) => {
      if (!s) return;
      if (s.version) setPcAppVersion(s.version);
      setCheckingUpdate(false);
      if (s.status === 'checking') {
        setPcUpdateStatus('Checking for updates…');
      } else if (s.status === 'available') {
        // Native auto-update is progressing — drop the manual-download fallback
        // so the two paths don't fight for attention.
        setPcLatest(null);
        setPcUpdateStatus(`Update v${s.newVersion} found — downloading…`);
        showToast('⬇️ Update found — downloading in the background');
      } else if (s.status === 'downloaded') {
        setPcLatest(null);
        setPcUpdateStatus('Update downloaded — restart to apply');
        showToast('✅ Update downloaded! Restart the app when prompted.');
      } else if (s.status === 'up-to-date') {
        setPcUpdateStatus('You are up to date');
        showToast('✅ PC app is up to date!');
      } else if (s.status === 'error') {
        setPcUpdateStatus('Update check failed — try again later');
        showToast('⚠️ Update check failed — please try again later');
      }
    });
    return () => { if (off && typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          // Switching views never logs the staff user out — the admin session
          // persists (localStorage) until they tap Exit in the admin section.
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

  const setQty = (id, q) => { if (q <= 0) setCart(cart.filter(i => productId(i) !== id)); else setCart(cart.map(i => productId(i) === id ? { ...i, quantity: q } : i)); };

  const validatePhone = (p) => {
    const digits = p.replace(/[^0-9]/g, '');
    return digits.length >= 10;
  };

  // Completes a successful sign-in — used by the direct (returning customer)
  // path AND the OTP-verified (first-time) path. The server decides returning.
  const finishSignIn = (d, nameUsed) => {
    const cust = { customerId: d.customerId, name: nameUsed, phone: d.customerId };
    setCustomer(cust);
    if (d.referralBonus) showToast(`🎁 Welcome bonus: +${d.referralBonus} loyalty points — thanks for using a friend's code!`);
    try { localStorage.setItem(CUSTOMER_KEY, JSON.stringify(cust)); } catch {}
    if (!profile) saveProfile({ name: nameUsed, phone: d.customerId, avatarId: 'cat', photo: null });
    setName(''); setPhone(''); setReferralCode('');
    setOtpPending(null); setOtpInput(''); setOtpError('');
    setWelcomeMsg({ name: nameUsed, returning: !!d.returning });
    setScreen('welcome');
  };

  const startOtpStep = (d, nameUsed) => {
    setOtpPending({ phone: d.phone || phone, name: nameUsed, referralCode });
    setOtpInput(''); setOtpError('');
    setOtpResendIn(Math.max(0, Math.min(60, Math.floor(d.resendAfter || 60))));
    showToast('📲 We sent a 6-digit code to your phone');
    if (d.devOtp) showToast(`🔑 Dev code (SMS not configured yet): ${d.devOtp}`);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!validatePhone(phone)) { alert('Please enter a valid phone number (at least 10 digits, e.g. 0712345678)'); return; }
    try {
      const r = await fetch(`${API_URL}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone, referralCode }) });
      const d = await r.json().catch(() => ({}));
      // A rate-limit 429 (from the global/auth limiters) has a plain-text body
      // that can't be parsed as JSON — handle it before touching d.otpRequired.
      if (r.status === 429 && !d.otpRequired) {
        alert(d.error || 'Too many attempts. Please try again later.');
        return;
      }
      if (d.success) {
        finishSignIn(d, name);
      } else if (d.otpRequired) {
        // First-time number: the server sent an OTP — swap to the code step.
        if (r.status === 429 && d.resendAfter) {
          setOtpResendIn(d.resendAfter);
          alert(d.error || 'Please wait before requesting another code.');
          return;
        }
        startOtpStep(d, name);
      } else {
        alert(d.error || 'Login failed.');
      }
    } catch (e) { 
      console.error(e);
      alert('Network error. Please check your connection and try again.');
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (!otpPending) return;
    const code = otpInput.trim();
    if (!/^\d{6}$/.test(code)) { setOtpError('Enter the 6-digit code'); return; }
    setOtpVerifying(true);
    setOtpError('');
    try {
      const r = await fetch(`${API_URL}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: otpPending.phone, otp: code, name: otpPending.name, referralCode: otpPending.referralCode })
      });
      const d = await r.json().catch(() => ({}));
      if (d.success) {
        finishSignIn(d, otpPending.name);
      } else {
        setOtpError(d.error || 'Verification failed. Please try again.');
        if (/expired|too many wrong/i.test(d.error || '')) setOtpPending(null);
      }
    } catch (err) {
      console.error(err);
      setOtpError('Network error. Please check your connection and try again.');
    } finally {
      setOtpVerifying(false);
    }
  };

  const handleResendOtp = async () => {
    if (!otpPending || otpResendIn > 0) return;
    try {
      const r = await fetch(`${API_URL}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: otpPending.name, phone: otpPending.phone, referralCode: otpPending.referralCode })
      });
      const d = await r.json().catch(() => ({}));
      if (d.otpRequired) {
        setOtpResendIn(Math.max(0, Math.min(60, Math.floor(d.resendAfter || 60))));
        showToast('📲 A new code was sent to your phone');
        if (d.devOtp) showToast(`🔑 Dev code (SMS not configured yet): ${d.devOtp}`);
      } else if (d.success) {
        finishSignIn(d, otpPending.name);
      } else {
        setOtpError(d.error || 'Could not resend the code.');
      }
    } catch (err) {
      console.error(err);
      setOtpError('Network error — could not resend the code.');
    }
  };

  const handleLogout = () => {
    setCustomer(null);
    setCart([]);
    setMyOrders([]);
    try { localStorage.removeItem(CUSTOMER_KEY); } catch {}
    setScreen('login');
  };

  // Compare dotted versions like "0.1.41" — returns true when a > b.
  const isNewerVersion = (a, b) => {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  };

  const handleManualUpdateCheck = async () => {
    if (checkingUpdate) return;
    const bridge = typeof window !== 'undefined' ? window.blitzUpdater : null;
    if (bridge && typeof bridge.checkForUpdates === 'function') {
      setCheckingUpdate(true);
      setPcUpdateStatus('Checking for updates…');
      showToast('Checking for updates...');
      try {
        await bridge.checkForUpdates();
      } catch (e) {
        console.error(e);
        setPcUpdateStatus('Update check failed — try again later');
        setCheckingUpdate(false);
        showToast('⚠️ Update check failed');
      }
      // Safety net: if no status event arrives (e.g. a check was already in
      // flight), never leave the button stuck on "Checking…" — reset it.
      setTimeout(() => setCheckingUpdate(false), 45000);

      // Guaranteed fallback: read the raw latest.yml so the "Download new
      // version" button appears whenever GitHub has a newer build — even if
      // electron-updater's API check is throttled or silently failing.
      try {
        if (typeof bridge.latest === 'function') {
          const info = await bridge.latest();
          if (info && info.version && info.downloadUrl) {
            const cur = info.currentVersion || pcAppVersion;
            if (isNewerVersion(info.version, cur)) {
              setPcLatest({ version: info.version, downloadUrl: info.downloadUrl });
              setPcUpdateStatus(`New version v${info.version} available — tap Download`);
              showToast(`⬇️ New version v${info.version} is available!`);
            } else if (info.error) {
              console.warn('updater:latest error:', info.error);
            }
          }
        }
      } catch (e) { console.warn('Failed to fetch latest release info:', e); }
      return;
    }
    setCheckingUpdate(true);
    showToast('Checking for updates...');
    try {
      const res = await fetch(`${API_URL}/native-update`);
      const latest = await res.json();
      if (!latest || !latest.version || !latest.url) {
        showToast('Already up to date! (no updates on server)');
        setCheckingUpdate(false);
        return;
      }
      
      const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
      if (isNative) {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        const cur = await CapacitorUpdater.current();
        if (cur && cur.bundle && cur.bundle.version === latest.version) {
          showToast(`App is up to date! (v${latest.version.slice(0,7)})`);
          setCheckingUpdate(false);
          return;
        }
        showToast('Downloading new update...');
        const bundle = await CapacitorUpdater.download({ url: latest.url, version: latest.version });
        await CapacitorUpdater.next({ id: bundle.id });
        showToast('⚡ Update applied! Reloading...');
        setTimeout(() => {
          CapacitorUpdater.reload();
        }, 1500);
      } else {
        // Web / PC
        showToast('Updating components and reloading...');
        setTimeout(() => {
          window.location.reload(true);
        }, 1500);
      }
    } catch (e) {
      console.error(e);
      showToast('Update check failed');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const validateCoupon = async () => {
    setCouponError('');
    if (!couponInput.trim()) return;
    try {
      const r = await fetch(`${API_URL}/coupons/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: couponInput.trim().toUpperCase(), total, phone: customer?.customerId || customer?.phone || '' })
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

  const handleConvertToWallet = async () => {
    const pts = parseInt(pointsToConvert, 10);
    if (isNaN(pts) || pts <= 0) return;
    if (pts > (custLoyalty?.points || 0)) {
      alert('You do not have enough points!');
      return;
    }
    if (pts % 5 !== 0) {
      alert('Points must be converted in multiples of 5.');
      return;
    }

    try {
      const r = await fetch(`${API_URL}/loyalty/convert-to-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: customer?.customerId, points: pts })
      });
      const d = await r.json();
      if (d.success) {
        showToast(`💰 Converted ${pts} points to KES ${pts / 5} wallet cash!`);
        setShowWalletModal(false);
        setPointsToConvert('');
        loadCustLoyalty();
      } else {
        alert(d.error || 'Failed to convert points');
      }
    } catch (e) {
      console.error(e);
      alert('Network error converting points');
    }
  };

  const pinGpsLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      return;
    }
    setGpsLoading(true);
    setGpsAddress('');
    let bestPos = null;
    let bestAccuracy = Infinity;
    // Use watchPosition to get the most accurate fix within 6 seconds
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (pos.coords.accuracy < bestAccuracy) {
          bestAccuracy = pos.coords.accuracy;
          bestPos = pos;
          setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
        }
      },
      (err) => {
        console.warn('Geolocation error:', err);
        if (!bestPos) {
          alert('Could not pin location. Please enable GPS/location permissions on your device.');
          setGpsLoading(false);
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    // After 6 seconds, stop watching and use best result
    setTimeout(() => {
      navigator.geolocation.clearWatch(watchId);
      setGpsLoading(false);
      if (bestPos) {
        const lat = bestPos.coords.latitude;
        const lng = bestPos.coords.longitude;
        // Reverse geocode for address
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`)
          .then(r => r.json())
          .then(data => {
            if (data.display_name) {
              setGpsAddress(data.display_name.split(',').slice(0, 3).join(','));
              if (!deliveryLocation) setDeliveryLocation(data.display_name.split(',').slice(0, 2).join(', ').trim());
            }
          })
          .catch(() => {});
      }
    }, 6000);
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

  const spinTheWheel = async () => {
    if (wheelSpinning) return;
    if (!customer?.customerId) {
      alert('Please sign in with your phone number to spin!');
      setShowSpinWheel(false);
      setScreen('login');
      return;
    }
    setWheelSpinning(true);
    setWheelPrize(null);
    try {
      const r = await fetch(`${API_URL}/promos/spin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: customer.customerId, name: customer.name })
      });
      const d = await r.json();
      if (d.alreadyUsed) {
        setWheelSpinning(false);
        setWheelPrize({ alreadyUsed: true, title: d.title || 'Already Spun Today!', message: d.message || 'Come back tomorrow for another spin!', code: d.code || '' });
        setPromoStatus(s => ({ ...(s || {}), spin: { used: true, code: d.code, title: d.title, message: d.message } }));
        return;
      }
      if (!d.success) {
        setWheelSpinning(false);
        showToast(d.error || 'Something went wrong — please try again');
        return;
      }
      // Spin to land the winning sector under the pointer (12 sectors of 30°).
      const sectorIdx = typeof d.sectorIndex === 'number' ? d.sectorIndex : 1;
      const target = ((360 - (sectorIdx + 0.5) * (360 / WHEEL_SECTORS.length)) + 360) % 360;
      const current = ((wheelRotation % 360) + 360) % 360;
      const delta = (target - current + 360) % 360;
      setWheelRotation(wheelRotation + 360 * 5 + delta);

      setTimeout(() => {
        setWheelSpinning(false);
        setWheelPrize(d);
        setPromoStatus(s => ({ ...(s || {}), tier: d.tier || s?.tier, spin: { used: true, code: d.code, title: d.title, message: d.message } }));
        if (d.pointsAdded) loadCustLoyalty();
        if (d.code) {
          setCouponInput(d.code);
          showToast(`🎁 ${d.title}`);
        } else {
          showToast(`😢 ${d.title}`);
        }
      }, 4200);
    } catch (e) {
      setWheelSpinning(false);
      showToast('Network error — please try again');
    }
  };

  const sendAiMessage = async (e) => {
    e.preventDefault();
    const messageText = aiInput.trim();
    if (!messageText) return;
    const userMsg = { sender: 'user', text: messageText };
    setAiMessages(prev => [...prev, userMsg]);
    setAiInput('');
    setAiLoading(true);

    try {
      const aiRes = await fetch(`${API_URL}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText, customerId: customer?.customerId, conversationHistory: aiMessages.slice(-10) })
      });
      const aiData = await aiRes.json();
      if (aiData.action?.type === 'add_to_cart' && aiData.action.product) {
        addToCart(aiData.action.product, aiData.action.quantity || 1);
      } else if (aiData.action?.type === 'order_placed') {
        showToast('✅ Order placed! Track it in My Orders.');
        loadMyOrders();
      }
      const botResponse = aiData.response || 'Sorry, I could not process that.';
      setAiMessages(prev => [...prev, { sender: 'bot', text: botResponse }]);
    } catch (e) {
      console.error(e);
      setAiMessages(prev => [...prev, { sender: 'bot', text: '🤖 Sorry, I encountered an error. Please try again later.' }]);
    } finally {
      setAiLoading(false);
    }
  };

  const handleCheckout = async () => {
    if (!cart.length) return;
    if (isSubmittingOrder) return;
    setIsSubmittingOrder(true);
    const finalFee = total >= 1500 || appliedCoupon?.type === 'free_delivery' || deliveryArea === 'mall' ? 0 : 150;
    const discountAmt = appliedCoupon ? appliedCoupon.discount : 0;
    const walletBalance = custAccount?.walletBalance || 0;
    const maxWalletApplicable = Math.min(walletBalance, Math.max(0, total + finalFee - discountAmt));
    const appliedWalletAmt = useWalletPayment ? maxWalletApplicable : 0;
    const finalTotal = Math.max(0, total + finalFee - discountAmt - appliedWalletAmt);

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
      discount: discountAmt,
      useWallet: useWalletPayment
    };
    try {
      const r = await fetch(API_URL + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderData) });
      const d = await r.json();
      if (d.success) {
        if (payMethod === 'mpesa' && finalTotal > 0) {
          // Trigger STK push
          setStkStatus('waiting');
          setStkError('');
          try {
            const stkRes = await fetch(API_URL + '/mpesa/stk-push', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phone: customer.phone || customer.customerId,
                amount: finalTotal,
                orderId: d.orderId
              })
            });
            const stkData = await stkRes.json();
            if (stkData.success) {
              setStkCheckoutId(stkData.checkoutRequestId);
            } else {
              setStkStatus('failed');
              setStkError(stkData.error || 'Failed to initiate M-Pesa STK push');
            }
          } catch (e) {
            setStkStatus('failed');
            setStkError('Failed to connect to M-Pesa service.');
          }
        } else {
          setCart([]);
          setAppliedCoupon(null);
          setCouponInput('');
          setLastOrderWasDelivery(!!deliveryLocation);
          setDeliveryLocation('');
          setGpsCoords(null);
          setGpsAddress('');
          setUseWalletPayment(false);
          loadCustLoyalty();
          setScreen('confirmation');
          triggerSimulatedNotifications();
        }
      } else {
        alert(d.error || 'Failed to place order');
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
        setLastOrderWasDelivery(!!deliveryLocation);
        setDeliveryLocation('');
        setGpsCoords(null);
        setGpsAddress('');
        setUseWalletPayment(false);
        loadCustLoyalty();
        setScreen('confirmation');
        triggerSimulatedNotifications();
      } catch (err) {
        alert('Offline and failed to save order.');
      }
    } finally {
      setIsSubmittingOrder(false);
    }
  };


  const onUpload = (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader();
    rd.onloadend = () => saveProfile({ ...(profile || {}), photo: rd.result }); rd.readAsDataURL(f); };

  // ===== Push notifications =====
  const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // Ask the OS/browser for permission, obtain the FCM token and register it with
  // our server. Native (Android) uses the Capacitor push plugin; web/PC uses the
  // Firebase JS SDK + service worker. Everything degrades gracefully when the
  // Firebase config isn't set up yet.
  const registerPushToken = async () => {
    if (!customer?.customerId) { showToast('Sign in first to enable notifications'); return; }
    const platform = isNativeApp ? 'android' : (/electron/i.test(navigator.userAgent || '') ? 'pc' : 'web');
    let token = null;
    let error = '';
    try {
      if (isNativeApp) {
        try {
          const { PushNotifications } = await import('@capacitor/push-notifications');
          let perm = await PushNotifications.checkPermissions();
          if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
          if (perm.receive !== 'granted') error = 'denied';
          else {
            await PushNotifications.register();
            token = await new Promise(resolve => {
              const unsubs = [];
              const finish = (t) => { try { unsubs.forEach(u => u.remove()); } catch (e) {} resolve(t); };
              unsubs.push(PushNotifications.addListener('registration', (r) => finish(r && r.value)));
              unsubs.push(PushNotifications.addListener('registrationError', () => finish(null)));
              setTimeout(() => finish(null), 15000);
            });
            if (token && !pushListenerRef.current) {
              pushListenerRef.current = await PushNotifications.addListener('pushNotificationReceived', (n) => {
                if (n && n.notification) showToast(`${n.notification.title || 'BlitzMall'} — ${n.notification.body || ''}`);
              });
            }
          }
        } catch (nativeErr) {
          console.warn('Native push plugin failed, using mock fallback:', nativeErr);
          // Fallback: generate a mock token so the polling loop can take over
          token = `MOCK_NATIVE_TOKEN_${customer.customerId}_${Date.now()}`;
          error = 'mock_fallback';
        }
      } else {
        // Request standard browser notifications permission
        if ('Notification' in window && Notification.permission !== 'granted') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            error = 'denied';
          }
        }
        
        if (error !== 'denied') {
          const cfg = window.BLITZ_FIREBASE_CONFIG;
          if (!cfg || !cfg.apiKey || !cfg.vapidKey) {
            // Fallback mock token for web if Firebase is not configured
            token = `MOCK_WEB_TOKEN_${customer.customerId}_${Date.now()}`;
            error = 'mock_fallback';
          } else {
            try {
              const { initializeApp, getApps } = await import('firebase/app');
              const { getMessaging, getToken, onMessage } = await import('firebase/messaging');
              if (!fcmWebApp) fcmWebApp = getApps().length ? getApps()[0] : initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId }, 'blitzmallWeb');
              const messaging = getMessaging(fcmWebApp);
              const perm = await Notification.requestPermission();
              if (perm !== 'granted') error = 'denied';
              else {
                const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
                token = await getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
                onMessage(messaging, (payload) => {
                  if (payload && payload.notification) showToast(`${payload.notification.title || 'BlitzMall'} — ${payload.notification.body || ''}`);
                });
              }
            } catch (webFcmErr) {
              console.warn('Web FCM failed, using mock fallback:', webFcmErr);
              token = `MOCK_WEB_TOKEN_${customer.customerId}_${Date.now()}`;
              error = 'mock_fallback';
            }
          }
        }
      }
    } catch (e) {
      console.error('Push enable error:', e);
      // Last resort: still try a mock token so polling can work
      token = `MOCK_FALLBACK_${customer.customerId}_${Date.now()}`;
      error = 'mock_fallback';
    }

    if (token) {
      try {
        const r = await fetch(`${API_URL}/notifications/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: customer.customerId, token, platform })
        });
        const d = await r.json();
        if (d.success) {
          setNotifEnabled(true);
          try { localStorage.setItem('blitz_push_enabled', 'true'); } catch (err) {}
          // Honest status: the token is registered now and will work the moment
          // the store's server push secret is configured, but until then the
          // in-app feed (polled toasts) is what actually delivers updates.
          let serverReady = true;
          try {
            const s = await (await fetch(`${API_URL}/notifications/status`)).json();
            serverReady = !!(s && s.serverFcmConfigured);
          } catch (e) {}
          if (error === 'mock_fallback') {
            showToast('🔔 Notifications enabled — in-app updates active (simulated mode)');
          } else if (serverReady) {
            showToast('🔔 Notifications enabled!');
          } else {
            showToast('🔔 Notifications enabled — you get in-app updates now; real push turns on once the store finishes setup');
          }
          return;
        }
      } catch (e) { console.error(e); }
      error = 'error';
    }

    if (error === 'denied') showToast('Notifications blocked — allow them in your phone/browser settings');
    else if (error === 'not_configured') showToast('Push is almost ready — BlitzMall needs to finish setup');
    else if (error && error !== 'mock_fallback') showToast('Could not enable notifications — try again');
  };

  const disablePush = async () => {
    setNotifEnabled(false);
    try { localStorage.setItem('blitz_push_enabled', 'false'); } catch (e) {}
    // Tell the server to forget this phone's tokens so pushes actually stop.
    try {
      await fetch(`${API_URL}/notifications/unregister`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: customer?.customerId || '' })
      });
    } catch (e) {}
    if (pushListenerRef.current) {
      try { pushListenerRef.current.remove(); } catch (e) {}
      pushListenerRef.current = null;
    }
    showToast('🔕 Notifications turned off');
  };

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

  // LOGIN — direct sign-in for returning numbers; a 6-digit OTP step for
  // first-time numbers (the server verifies the number before creating the
  // account, so referral codes only apply to verified sign-ins).
  if (screen === 'login') return (
    <div className="screen center-screen">
      <div className="ambient ambient-a" /><div className="ambient ambient-b" />
      <div className="login-card"><BlitzLogo size={70} />
        <h1 className="brand">BLITZ<span>MALL</span></h1>
        {otpPending ? (
          <>
            <p className="muted">Enter the 6-digit code sent to</p>
            <p className="otp-phone">{(() => { const p = String(otpPending.phone); const m = p.match(/^0?(\d{3})(\d{3})(\d{4})$/); return m ? `0${m[1]} ${m[2]} ${m[3]}` : p; })()}</p>
            <form onSubmit={handleVerifyOtp}>
              <input className="field otp-input" type="tel" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={otpInput} onChange={e => setOtpInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} autoFocus />
              {otpError && <p className="form-error">{otpError}</p>}
              <button className="btn-neon login-cta" type="submit" disabled={otpVerifying}>{otpVerifying ? 'Verifying…' : 'Verify & Sign In'}</button>
            </form>
            <button className="owner-link" type="button" disabled={otpResendIn > 0} onClick={handleResendOtp}>
              {otpResendIn > 0 ? `Resend code in ${otpResendIn}s` : 'Resend code'}
            </button>
            <button className="owner-link" type="button" onClick={() => { setOtpPending(null); setOtpInput(''); setOtpError(''); }}>← Change phone number</button>
          </>
        ) : (
          <>
            <p className="muted">Sign in to start shopping</p>
            <form onSubmit={handleLogin}>
              <input className="field" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
              <input className="field" type="tel" placeholder="Phone (07xx xxx xxx)" value={phone} onChange={e => setPhone(e.target.value)} required />
              <input className="field" placeholder="Referral code (optional) — got invited? 🎁" value={referralCode} onChange={e => setReferralCode(e.target.value)} />
              <button className="btn-neon login-cta" type="submit">Enter Blitz Mall</button>
            </form>
            <button className="owner-link" onClick={() => setIsAdmin(true)}>Owner login</button>
          </>
        )}
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
            {banners.map(b => (
              <div className="promo-banner-slide" key={b._id || b.id} style={{ background: b.gradient, cursor: 'pointer' }} onClick={() => { setActiveCategory('All'); setScreen('offers'); }}>
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
                    showToast(`Code ${b.code} copied! Use it at checkout.`);
                  }}>Copy Code: {b.code}</button>
                )}
                <button className="promo-view-deals" onClick={(e) => { e.stopPropagation(); setScreen('offers'); }}>View today's deals →</button>
              </div>
            ))}
          </div>
          <div className="promo-banner-dots">
            {banners.map((_, i) => (
              <span key={i} className={`promo-dot ${i === bannerIndex ? 'active' : ''}`} onClick={() => setBannerIndex(i)} />
            ))}
          </div>
        </div>

        {/* FLASH SALE CARD */}
        {(() => {
          const flashSaleProducts = products.filter(p => p.isFlashSale);
          if (flashSaleProducts.length === 0) return null;
          
          const closestExpiry = flashSaleProducts.reduce((min, p) => {
            if (!p.flashSaleExpires) return min;
            const exp = new Date(p.flashSaleExpires);
            return !min || exp < min ? exp : min;
          }, null);

          return (
            <div className="flash-sale-card">
              <div className="flash-sale-header">
                <span className="flash-sale-title">⚡ FLASH SALE</span>
                <div className="flash-sale-timer">
                  Ends in: <FlashSaleCountdown expires={closestExpiry} />
                </div>
              </div>
              <div className="flash-sale-items">
                {flashSaleProducts.map(p => {
                  const origPrice = p.originalPrice || p.price;
                  const discPrice = p.price;
                  const pct = p.flashSaleDiscount || Math.round((1 - discPrice / origPrice) * 100);
                  return (
                    <div className="flash-item" key={`flash-${p._id || p.id}`} onClick={() => openProduct(p)}>
                      <span className="flash-badge">-{pct}%</span>
                      <div className="flash-item-img">
                        {p.image ? <img src={firstImage(p.image)} alt={p.name} className="product-img-element" loading="lazy"/> : '🛍️'}
                      </div>
                      <div className="flash-item-info">
                        <span className="flash-item-name">{p.name}</span>
                        <div className="flash-price-row">
                          <span className="flash-price-disc">KES {discPrice}</span>
                          <span className="flash-price-orig">KES {origPrice}</span>
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: '2px' }}>
                          {p.flashSaleReason || 'Limited deal'}
                        </div>
                      </div>
                      <button className="flash-add-btn" onClick={(e) => {
                        e.stopPropagation();
                        addToCart(p, 1);
                      }}>+</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* SCRATCH & WIN CARD — rub the foil to reveal today's deal */}
        <div className="scratch-card-wrap">
          {(promoStatus?.tier) && (
            <div className="wheel-tier-badge" style={{ margin: '12px 12px 0 12px' }}>
              {TIER_LABELS[promoStatus.tier] || promoStatus.tier} · better deals as you shop more
            </div>
          )}
          <ScratchCard
            revealed={scratchRevealed}
            result={scratchResult}
            claiming={scratchRevealing}
            signedIn={!!customer?.customerId}
            onComplete={onScratchComplete}
            onNeedLogin={() => setScreen('login')}
            onCopy={(code) => { navigator.clipboard.writeText(code); showToast('Voucher code copied! Use it at checkout.'); }}
          />
        </div>

        {/* One-tap entry to Today's Deals when items are on offer */}
        {products.some(p => p.isFlashSale || (p.discountApplied && p.originalPrice && p.originalPrice > p.price)) && (
          <button className="deal-banner-chip" onClick={() => setScreen('offers')} style={{ cursor: 'pointer', width: 'calc(100% - 32px)', display: 'flex', justifyContent: 'center', margin: '0 16px 6px 16px' }}>
            🔥 Today's Deals — tap to see what's on offer right now →
          </button>
        )}

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
                {trending.map(p => <ProductCard key={productId(p)} p={p} onOpen={openProduct} onAdd={addToCart} fav={isFavorite(productId(p))} onFav={toggleFavorite} />)}
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
              <p className="modal-subtitle">Spin once a day — loyal shoppers win bigger prizes!</p>

              {(promoStatus?.tier || wheelPrize?.tier) && (
                <div className="wheel-tier-badge">
                  {TIER_LABELS[promoStatus?.tier || wheelPrize?.tier] || promoStatus?.tier || wheelPrize?.tier}
                </div>
              )}

              {promoStatus?.cashPrizeUnlockSpend > 0 && !promoStatus?.promosLocked && !promoStatus?.spin?.used && (
                <p className="modal-subtitle" style={{ fontSize: '.72rem', color: 'var(--gold)', marginTop: 6 }}>
                  💰 Money prizes unlock after {promoStatus.cashPrizeUnlockOrders || 5}+ orders and more than KES {promoStatus.cashPrizeUnlockSpend} in total shopping
                </p>
              )}

              <div className="wheel-container">
                <div className={`wheel-pointer ${wheelSpinning ? 'ticking' : ''}`} />
                <div className={`wheel-led-ring ${wheelSpinning ? 'spinning' : ''}`}>
                  {[...Array(12)].map((_, idx) => (
                    <span key={idx} className="wheel-led-dot" style={{ transform: `translate(-50%, -50%) rotate(${idx * 30}deg) translateY(-112px)` }} />
                  ))}
                </div>
                <div className="wheel-face" style={{
                  background: `conic-gradient(${WHEEL_SECTORS.map((s, idx) => {
                    const startAngle = idx * (360 / WHEEL_SECTORS.length);
                    const endAngle = (idx + 1) * (360 / WHEEL_SECTORS.length);
                    return `${s.color} ${startAngle}deg ${endAngle}deg`;
                  }).join(', ')})`,
                  transform: `rotate(${wheelRotation}deg)`
                }}>
                  {WHEEL_SECTORS.map((s, i) => (
                    <span key={i} className="wheel-label" style={{
                      transform: `translate(-50%, -50%) rotate(${(i + 0.5) * (360 / WHEEL_SECTORS.length)}deg) translateY(-84px) rotate(90deg)`
                    }}>{s.label}</span>
                  ))}
                </div>
                <div className="wheel-center-hub">SPIN</div>
              </div>

              {wheelPrize && (
                <div className={`wheel-prize-announcement animate-prize ${wheelPrize.code ? 'win' : ''}`}>
                  <h4>{wheelPrize.alreadyUsed ? '🔒 ' : wheelPrize.code ? '🎉 ' : '😢 '}{wheelPrize.title}</h4>
                  <p>{wheelPrize.message}</p>
                  {wheelPrize.code && (
                    <div className="wheel-coupon-box" onClick={() => {
                      navigator.clipboard.writeText(wheelPrize.code);
                      showToast('Voucher code copied! Use it at checkout.');
                    }}>
                      {wheelPrize.code} <small>(tap to copy · use at checkout)</small>
                    </div>
                  )}
                </div>
              )}

              <button
                className="btn-neon spin-action-btn"
                onClick={spinTheWheel}
                disabled={wheelSpinning || promoStatus?.spin?.used || promoStatus?.promosLocked}
              >
                {wheelSpinning ? '🌀 Spinning...' : promoStatus?.spin?.used ? '🔒 Come Back Soon' : promoStatus?.promosLocked ? '🔒 Complete 2 purchases to unlock' : '🔥 Spin Now!'}
              </button>
            </div>
          </div>
        )}

        {/* Wallet Points Conversion Modal */}
        {showWalletModal && (
          <div className="futuristic-modal-overlay" onClick={() => setShowWalletModal(false)}>
            <div className="futuristic-modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: '340px' }}>
              <button className="modal-close-btn" onClick={() => setShowWalletModal(false)}>✕</button>
              <h2 className="modal-title" style={{ color: 'var(--gold)' }}>🪙 Convert Points to Cash</h2>
              <p className="modal-subtitle" style={{ marginBottom: 16 }}>Redeem your loyalty points directly into your virtual wallet at a rate of 5 points = KES 1.</p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: '.75rem' }}>Available Points</span>
                  <b style={{ fontSize: '1.05rem', color: 'var(--orange)' }}>{custLoyalty?.points || 0} PTS</b>
                </div>
                
                <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: '.75rem' }}>Est. Wallet Value</span>
                  <b style={{ fontSize: '1.05rem', color: 'var(--green)' }}>KES {Math.floor((custLoyalty?.points || 0) / 5).toLocaleString('en-KE')}</b>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: '.75rem', color: '#fff', fontWeight: 'bold' }}>Points to convert:</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input 
                      type="number"
                      className="field" 
                      placeholder="e.g. 50" 
                      value={pointsToConvert} 
                      onChange={e => setPointsToConvert(e.target.value)} 
                      style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '.9rem' }} 
                    />
                    <button 
                      type="button" 
                      className="btn-ghost" 
                      onClick={() => setPointsToConvert(String(Math.floor((custLoyalty?.points || 0) / 5) * 5))}
                      style={{ padding: '0 10px', fontSize: '.72rem', borderRadius: 8 }}
                    >
                      Max
                    </button>
                  </div>
                  <small className="muted" style={{ fontSize: '.68rem' }}>* Must be a multiple of 5 points (5 PTS = KES 1)</small>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  type="button" 
                  className="btn-ghost" 
                  onClick={() => setShowWalletModal(false)}
                  style={{ flex: 1, padding: '10px' }}
                >
                  Cancel
                </button>
                <button 
                  type="button" 
                  className="btn-neon" 
                  onClick={handleConvertToWallet}
                  style={{ flex: 1, padding: '10px', background: 'var(--grad)', color: '#000' }}
                  disabled={!pointsToConvert || parseInt(pointsToConvert) <= 0 || parseInt(pointsToConvert) > (custLoyalty?.points || 0) || parseInt(pointsToConvert) % 5 !== 0}
                >
                  Convert
                </button>
              </div>
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
              {aiMessages.length === 1 && aiMessages[0].sender === 'bot' && aiQuickActions.length > 0 && (
                <div className="ai-quick-actions">
                  <p className="ai-quick-label">Try asking:</p>
                  <div className="ai-quick-buttons">
                    {aiQuickActions.map((action, i) => (
                      <button key={i} className="ai-quick-btn" onClick={() => handleAiQuickAction(action.text)}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {aiMessages.map((msg, i) => (
                <div className={`ai-message ${msg.sender}`} key={i}>
                  <div className="ai-message-bubble">
                    {msg.text.split('\n').map((line, idx) => {
                      // Safely render **bold** segments and leading bullets as React
                      // nodes instead of injecting raw HTML (prevents XSS).
                      const isBullet = line.startsWith('• ');
                      const content = isBullet ? line.slice(2) : line;
                      const parts = content.split(/(\*\*.+?\*\*)/g).filter(Boolean);
                      return (
                        <p key={idx} style={{ margin: '4px 0' }}>
                          {isBullet && <span className="ai-bullet">• </span>}
                          {parts.map((part, j) =>
                            part.startsWith('**') && part.endsWith('**')
                              ? <strong key={j}>{part.slice(2, -2)}</strong>
                              : <React.Fragment key={j}>{part}</React.Fragment>
                          )}
                        </p>
                      );
                    })}
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
              <div ref={aiMessagesEndRef} />
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
          <div className="detail-img" onClick={() => { const imgs = allImages(p.image); if (imgs.length) setGallery(imgs); }}>
            {p.image ? <img src={firstImage(p.image)} alt={p.name} className="product-img-element" loading="lazy"/> : <div className="noimg">🛍️</div>}
            {allImages(p.image).length > 1 && <span className="detail-img-hint">📷 {allImages(p.image).length} photos · tap</span>}
          </div>
          <div className="detail-body">
            <span className="detail-cat">{categoryOf(p)}</span>
            <div className="detail-name-row">
              <h1 className="detail-name">{p.name}</h1>
              <button className={`detail-fav ${isFavorite(productId(p)) ? 'on' : ''}`} onClick={() => toggleFavorite(p)} aria-label="Toggle favorite">
                {isFavorite(productId(p)) ? '❤️' : '🤍'}
              </button>
            </div>
            <div className="detail-price">KES {p.price}</div>
            {p.description && <p className="detail-desc">{p.description}</p>}
            <div className="qty-row"><span>Quantity</span>
              <div className="qty-ctrl"><button onClick={() => setDetailQty(Math.max(1, detailQty - 1))}>−</button><b>{detailQty}</b><button onClick={() => setDetailQty(detailQty + 1)}>+</button></div></div>
          </div>
        </div>
        <div className="detail-bar"><div className="detail-bar-total">KES {p.price * detailQty}</div>
          <button className="btn-neon" onClick={() => { addToCart(p, detailQty); setScreen('cart'); }}>Add to cart</button></div>
        {gallery && (
          <div className="img-gallery-overlay" onClick={() => setGallery(null)}>
            <button className="gallery-close" onClick={() => setGallery(null)}>✕</button>
            <div className="gallery-slider" onClick={e => e.stopPropagation()}>
              {gallery.map((url, i) => (
                <div className="gallery-slide" key={i}><img src={hiRes(url)} alt={`Slide ${i + 1}`} /></div>
              ))}
            </div>
            {gallery.length > 1 && <div className="gallery-hint">← swipe to see all {gallery.length} photos →</div>}
          </div>
        )}
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
              <div className="cart-thumb">{i.image ? (Array.isArray(i.image) ? <img src={i.image[0]} alt={i.name} loading="lazy" /> : <img src={i.image} alt={i.name} loading="lazy" />) : '🛍️'}</div>
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
    const walletBalance = custAccount?.walletBalance || 0;
    const maxWalletApplicable = Math.min(walletBalance, Math.max(0, total + finalFee - discountAmt));
    const appliedWalletAmt = useWalletPayment ? maxWalletApplicable : 0;
    const finalTotal = Math.max(0, total + finalFee - discountAmt - appliedWalletAmt);

    return (
      <div className="screen with-nav">
        <header className="topbar">
          <button className="icon-btn back" onClick={() => {
            setAppliedCoupon(null);
            setCouponInput('');
            setDeliveryLocation('');
            setGpsCoords(null);
            setGpsAddress('');
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

            <button type="button" className="btn-ghost" onClick={pinGpsLocation} style={{ width: '100%', padding: '10px', fontSize: '0.85rem', borderRadius: '10px', border: '1px dashed var(--orange)', background: 'rgba(255,122,26,0.06)' }} disabled={gpsLoading}>
              {gpsLoading ? '⏳ Getting precise location...' : gpsCoords ? '✅ GPS Location Pinned' : '📍 Pin My Location (GPS)'}
            </button>
            {gpsCoords && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div className="gps-accuracy">
                  <span className={`dot ${gpsCoords.accuracy <= 10 ? 'good' : gpsCoords.accuracy <= 30 ? 'ok' : 'poor'}`} />
                  <span style={{ color: gpsCoords.accuracy <= 10 ? 'var(--green)' : gpsCoords.accuracy <= 30 ? 'var(--gold)' : 'var(--red)' }}>
                    Accuracy: ±{gpsCoords.accuracy || '?'}m {gpsCoords.accuracy <= 10 ? '(Excellent)' : gpsCoords.accuracy <= 30 ? '(Good)' : '(Fair)'}
                  </span>
                </div>
                <small style={{ color: 'var(--muted)', fontSize: '0.72rem', textAlign: 'center' }}>
                  📌 {gpsCoords.lat.toFixed(6)}, {gpsCoords.lng.toFixed(6)}
                </small>
                {gpsAddress && <div className="gps-address">📫 {gpsAddress}</div>}
                <div className="gps-minimap">
                  <a href={`https://www.google.com/maps/search/?api=1&query=${gpsCoords.lat},${gpsCoords.lng}`} target="_blank" rel="noreferrer">
                    <img src={`https://staticmap.openstreetmap.de/staticmap.php?center=${gpsCoords.lat},${gpsCoords.lng}&zoom=16&size=320x140&markers=${gpsCoords.lat},${gpsCoords.lng},red-pushpin`} alt="Your location" />
                  </a>
                </div>
              </div>
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

          {custAccount && (custAccount.walletBalance > 0 || useWalletPayment) && (
            <>
              <h3 className="section-h">Virtual Wallet</h3>
              <div className="info-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <b style={{ fontSize: '.85rem', color: '#fff' }}>Use Virtual Wallet Cash</b>
                    <div style={{ fontSize: '.7rem', color: 'var(--muted)', marginTop: 2 }}>Available: KES {custAccount.walletBalance.toLocaleString('en-KE')}</div>
                  </div>
                  <input 
                    type="checkbox" 
                    checked={useWalletPayment} 
                    onChange={e => setUseWalletPayment(e.target.checked)} 
                    style={{ width: 22, height: 22, cursor: 'pointer', accentColor: 'var(--orange)' }}
                  />
                </div>
                {useWalletPayment && (
                  <div style={{ background: 'rgba(54, 211, 153, 0.1)', color: 'var(--green)', padding: '6px 10px', borderRadius: '6px', fontSize: '0.8rem' }}>
                    Applied <b>KES {appliedWalletAmt.toLocaleString('en-KE')}</b> from wallet cash!
                  </div>
                )}
              </div>
            </>
          )}

          <h3 className="section-h">Payment method</h3>
          <button className={`pay-opt ${payMethod === 'delivery' ? 'sel' : ''}`} onClick={() => setPayMethod('delivery')}>
            <span>💵</span>
            <div>
              <b>Pay on delivery</b>
              <small>Pay cash when it arrives</small>
            </div>
            <i className="radio" />
          </button>
          <button className={`pay-opt ${payMethod === 'mpesa' ? 'sel' : ''}`} onClick={() => setPayMethod('mpesa')}>
            <span>📱</span>
            <div>
              <b>M-Pesa</b>
              <small>Pay instantly via secure M-Pesa STK Push</small>
            </div>
            <i className="radio" />
          </button>

          <div className="summary">
            <div className="summary-row"><span>Subtotal</span><b>KES {total}</b></div>
            <div className="summary-row"><span>Delivery fee</span><b>KES {finalFee}</b></div>
            {discountAmt > 0 && (
              <div className="summary-row" style={{ color: 'var(--green)' }}><span>Discount</span><b>- KES {discountAmt}</b></div>
            )}
            {appliedWalletAmt > 0 && (
              <div className="summary-row" style={{ color: 'var(--green)' }}><span>Wallet Applied</span><b>- KES {appliedWalletAmt}</b></div>
            )}
            <div className="summary-row total"><span>Total</span><b>KES {finalTotal}</b></div>
          </div>
        </div>
        <div className="detail-bar">
          <div className="detail-bar-total">KES {finalTotal}</div>
          <button className="btn-neon" onClick={handleCheckout} disabled={isSubmittingOrder}>
            {isSubmittingOrder ? 'Processing...' : 'Place order'}
          </button>
        </div>
        {renderToasts()}
        {stkStatus === 'waiting' && (
          <div className="futuristic-modal-overlay" style={{ zIndex: 9999 }}>
            <div className="futuristic-modal-card" style={{ textAlign: 'center', padding: '30px' }}>
              <div className="spinner" style={{ margin: '0 auto 20px auto', width: '50px', height: '50px', borderRadius: '50%', border: '4px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--gold)', animation: 'spin 1s linear infinite' }}></div>
              <h3 style={{ fontFamily: 'Unbounded, sans-serif', color: 'var(--gold)' }}>Waiting for Payment</h3>
              <p className="muted" style={{ fontSize: '0.9rem', margin: '12px 0' }}>
                We have sent an M-Pesa STK push prompt to your phone number <b>{customer?.phone || customer?.customerId}</b>.<br />
                Please enter your M-Pesa PIN to authorize the payment of <b>KES {finalTotal}</b>.
              </p>
              <small style={{ color: 'var(--muted)', display: 'block', marginBottom: '20px' }}>
                Checking status automatically...
              </small>
              <button className="btn-ghost" onClick={() => setStkStatus('idle')}>
                Cancel & Pay Later / Cash
              </button>
            </div>
          </div>
        )}
        {stkStatus === 'failed' && (
          <div className="futuristic-modal-overlay" style={{ zIndex: 9999 }}>
            <div className="futuristic-modal-card" style={{ textAlign: 'center', padding: '30px' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>❌</div>
              <h3 style={{ fontFamily: 'Unbounded, sans-serif', color: 'var(--orange, #ff7a1a)' }}>Payment Failed</h3>
              <p className="muted" style={{ fontSize: '0.9rem', margin: '12px 0' }}>
                {stkError || 'The M-Pesa payment could not be completed. Please try again.'}
              </p>
              <button className="btn-ghost" onClick={() => { setStkStatus('idle'); setStkError(''); }}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // CONFIRMATION
  if (screen === 'confirmation') return (
    <div className="screen center-screen"><div className="ambient ambient-a" />
      <div className="confirm-card"><div className="confirm-mark">⚡</div><h1>Order placed!</h1>
        <p className="muted">Brilliant is preparing your order. Watch your phone for updates.</p>
        {lastOrderWasDelivery && (
          <p className="muted" style={{ fontSize: '.75rem', marginTop: 6, background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.25)', borderRadius: 10, padding: '8px 12px' }}>
            🛵 Delivery order — our rider will confirm your transport fee and notify you with the final amount to pay.
          </p>
        )}
        <button className="btn-neon" onClick={() => { loadMyOrders(); setScreen('orders'); }}>Track my order</button>
        <button className="btn-ghost" onClick={() => { setReviewStars(0); setReviewMsg(''); setReviewSent(false); setScreen('review'); }}>Rate your experience</button>
        <button className="btn-ghost" onClick={() => setScreen('home')}>Keep shopping</button></div>
    </div>
  );

  // PROFILE (doubles as settings)
  if (screen === 'profile') return (
    <div className="screen with-nav">
      <header className="topbar"><div className="topbar-brand"><BlitzLogo size={30} /><span>BLITZ<b>MALL</b></span></div></header>
      <div className="scroll profile-scroll">
        <div className="profile-head">
          <Avatar profile={profile} size={88} />
          <h2>{profile?.name || customer?.name}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '7px 16px', fontSize: '.88rem', fontWeight: 700, color: 'var(--gold)', letterSpacing: '.5px' }}>
            📱 {customer?.customerId || profile?.phone}
          </div>
          <span className="muted" style={{ fontSize: '.66rem', maxWidth: 280, textAlign: 'center', lineHeight: 1.4 }}>
            Points, wallet &amp; orders are tied to this number — sign in with the same number on every device to keep them together.
          </span>
          {custAccount?.isOwner && (
            <span style={{ marginTop: 8, background: 'linear-gradient(135deg, #ffd24a, #ff7a1a)', color: '#000', fontWeight: 'bold', fontSize: '.7rem', padding: '4px 14px', borderRadius: 20, letterSpacing: '.5px', boxShadow: '0 4px 12px rgba(255, 178, 26, 0.45)' }}>👑 OWNER</span>
          )}
        </div>

        {/* Choose an avatar — kept up top so it's the first thing you see */}
        <h3 className="section-h">Choose an avatar</h3>
        <div className="avatar-row" style={{ marginBottom: 4 }}>
          {AVATARS.map(a => (
            <button key={a.id} className={`avatar-pick ${profile?.avatarId === a.id && !profile?.photo ? 'sel' : ''}`}
              onClick={() => saveProfile({ ...(profile || {}), avatarId: a.id, photo: null })}>
              <img src={getAvatarSrc(a.src)} alt={a.id} />
            </button>
          ))}
          <label className="avatar-upload">＋<input type="file" accept="image/*" onChange={onUpload} hidden /></label>
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
              {(() => {
                // Cashback value follows the owner's redemption currency
                // (Admin → Loyalty Controls → Points Redemption Store).
                const tiers = (custAccount?.redeemTiers || []).filter(t => t && parseFloat(t.points) > 0);
                const rate = tiers.length ? Math.max(...tiers.map(t => (parseFloat(t.value) || 0) / parseFloat(t.points))) : 0;
                return (
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>Est. Cashback</span>
                    <div style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '2px 0 0 0' }}>KES {Math.floor((custLoyalty.points || 0) * rate).toLocaleString('en-KE')}</div>
                    {rate > 0 && <div style={{ fontSize: '0.62rem', opacity: 0.8, marginTop: 2 }}>1 pt = KES {Math.round(rate * 100) / 100}</div>}
                  </div>
                );
              })()}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px', borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: '10px' }}>
              <div>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>Virtual Wallet Cash</span>
                <div style={{ fontFamily: 'Unbounded, sans-serif', fontSize: '1.25rem', fontWeight: 'bold', margin: '2px 0 0 0', color: '#11998e' }}>KES {(custAccount?.walletBalance || 0).toLocaleString('en-KE')}</div>
              </div>
              <button
                type="button"
                className="btn-neon"
                onClick={() => setShowWalletModal(true)}
                style={{
                  padding: '6px 12px',
                  fontSize: '.72rem',
                  background: '#000',
                  color: '#fff',
                  border: '1px solid #000',
                  boxShadow: 'none'
                }}
              >
                🪙 Convert Points
              </button>
            </div>
            <small style={{ display: 'block', marginTop: '10px', fontSize: '0.65rem', opacity: 0.7, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: '6px' }}>
              {(() => { const ts = [...(custAccount?.redeemTiers || [])].sort((a, b) => (parseFloat(a.points) || 0) - (parseFloat(b.points) || 0)); const base = ts[0]; return base ? `* ${base.points} PTS = KES ${base.value} cashback. Trade points in the Redemption Store or ask cashier to redeem at counter!` : '* Trade points in the Redemption Store or ask cashier to redeem at counter!'; })()}
            </small>
          </div>
        )}

        {/* Account summary — everything keyed by the phone number they signed in with */}
        {custAccount && (
          <div style={{ margin: '16px 14px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '.95rem', fontFamily: 'Unbounded, sans-serif', color: 'var(--gold)' }}>👤 My Account</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="muted" style={{ fontSize: '.68rem' }}>Orders placed</div>
                <b style={{ fontSize: '1.05rem' }}>{custAccount.orderCount || 0}</b>
              </div>
              <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="muted" style={{ fontSize: '.68rem' }}>Total spent</div>
                <b style={{ fontSize: '1.05rem' }}>KES {(custAccount.totalSpent || 0).toLocaleString('en-KE')}</b>
              </div>
              <div style={{ background: custAccount.outstandingDebt > 0 ? 'rgba(255,45,85,0.12)' : 'var(--bg-2)', borderRadius: 10, padding: '10px 12px', border: custAccount.outstandingDebt > 0 ? '1px solid rgba(255,45,85,0.5)' : 'none' }}>
                <div className="muted" style={{ fontSize: '.68rem' }}>Outstanding balance</div>
                <b style={{ fontSize: '1.05rem', color: custAccount.outstandingDebt > 0 ? '#ff6b81' : 'var(--text)' }}>KES {(custAccount.outstandingDebt || 0).toLocaleString('en-KE')}</b>
              </div>
              <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="muted" style={{ fontSize: '.68rem' }}>Shopper tier</div>
                <b style={{ fontSize: '.95rem', color: 'var(--gold)' }}>{TIER_LABELS[custAccount.tier] || custAccount.tier || 'New'}</b>
              </div>
            </div>
            {custAccount.memberSince && (
              <div className="muted" style={{ fontSize: '.7rem', marginTop: 10 }}>
                📅 Member since {new Date(custAccount.memberSince).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}
              </div>
            )}
            {custAccount.outstandingDebt > 0 && (
              <div style={{ fontSize: '.72rem', color: '#ff6b81', marginTop: 8, background: 'rgba(255,45,85,0.08)', padding: '8px 10px', borderRadius: 8 }}>
                ⚠️ You have an outstanding balance of KES {custAccount.outstandingDebt.toLocaleString('en-KE')} — please clear it at the counter to keep your account active.
              </div>
            )}
            {custAccount.vouchers && custAccount.vouchers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: '.78rem', color: 'var(--green)', marginBottom: 6 }}>🎟️ My vouchers:</div>
                {custAccount.vouchers.filter(v => !v.used).map((v, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-2)', border: '1px dashed var(--gold)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: '.78rem' }}>
                    <b style={{ fontFamily: 'monospace', color: 'var(--gold)' }}>{v.code}</b>
                    <span className="muted">{v.type === 'percent' ? `${v.value}% off` : v.type === 'free_delivery' ? 'Free delivery' : `KES ${v.value} off`}{v.minPurchase ? ` · min KES ${v.minPurchase}` : ''}</span>
                  </div>
                ))}
                {custAccount.vouchers.filter(v => !v.used).length === 0 && (
                  <div className="muted" style={{ fontSize: '.72rem' }}>All your vouchers have been used 🎉</div>
                )}
              </div>
            )}
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

        <h3 className="section-h">Preferences</h3>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '12px 16px', margin: '0 14px 16px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <b style={{ fontSize: '.88rem', color: '#fff' }}>🔔 Push Notifications</b>
            <div style={{ fontSize: '.72rem', color: 'var(--muted)', marginTop: 2 }}>Order updates & promo alerts</div>
          </div>
          <button
            className="btn-neon"
            onClick={() => (notifEnabled ? disablePush() : registerPushToken())}
            style={{
              padding: '6px 12px',
              fontSize: '.75rem',
              background: notifEnabled ? 'var(--green)' : 'var(--line)',
              color: notifEnabled ? '#000' : 'var(--text)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {notifEnabled ? 'ON' : 'OFF'}
          </button>
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '12px 16px', margin: '0 14px 16px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <b style={{ fontSize: '.88rem', color: '#fff' }}>Performance Mode</b>
            <div style={{ fontSize: '.72rem', color: 'var(--muted)', marginTop: 2 }}>Disable blurs & animations on low-end devices</div>
          </div>
          <button 
            className="btn-neon" 
            onClick={() => {
              const newVal = !perfMode;
              setPerfMode(newVal);
              try { localStorage.setItem('blitz_perf_mode', String(newVal)); } catch (e) {}
            }}
            style={{
              padding: '6px 12px', 
              fontSize: '.75rem',
              background: perfMode ? 'var(--green)' : 'var(--line)',
              color: perfMode ? '#000' : 'var(--text)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {perfMode ? 'ON (Fast)' : 'OFF (Rich)'}
          </button>
        </div>

        <div style={{ background: 'var(--card)', border: pcLatest ? '1px solid rgba(255,122,26,.55)' : '1px solid var(--line)', borderRadius: 14, padding: '12px 16px', margin: '0 14px 16px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              <b style={{ fontSize: '.88rem', color: '#fff' }}>🔄 Check for Updates</b>
              <div style={{ fontSize: '.72rem', color: 'var(--muted)', marginTop: 2 }}>
                {pcAppVersion ? `Desktop v${pcAppVersion}` : 'Sync changes & download new features'}{pcUpdateStatus ? ` · ${pcUpdateStatus}` : ''}
              </div>
            </div>
            <button 
              className="btn-neon" 
              onClick={handleManualUpdateCheck}
              disabled={checkingUpdate}
              style={{
                padding: '6px 12px', 
                fontSize: '.75rem',
                background: checkingUpdate ? 'var(--line)' : 'var(--grad)',
                color: checkingUpdate ? 'var(--text)' : '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                flexShrink: 0
              }}
            >
              {checkingUpdate ? 'Checking...' : 'Check'}
            </button>
          </div>
          {pcLatest && (
            <button
              onClick={async () => {
                try {
                  const bridge = typeof window !== 'undefined' ? window.blitzUpdater : null;
                  if (bridge && typeof bridge.openDownload === 'function') {
                    await bridge.openDownload(pcLatest.downloadUrl);
                  } else {
                    window.open(pcLatest.downloadUrl, '_blank');
                  }
                  showToast(`⬇️ Downloading v${pcLatest.version} — run the installer to update`);
                } catch (e) {
                  console.error(e);
                  showToast('Could not open the download — check your browser');
                }
              }}
              style={{
                marginTop: 10, width: '100%', padding: '10px 12px',
                background: 'var(--grad)', color: '#000', border: 'none', borderRadius: 10,
                fontWeight: 700, fontSize: '.82rem', cursor: 'pointer', boxShadow: '0 4px 14px rgba(255,122,26,.35)'
              }}
            >
              ⬇️ Download New Version v{pcLatest.version}
            </button>
          )}
        </div>

        <h3 className="section-h">Account</h3>
        <button className="row-btn" onClick={() => setScreen('favorites')}>❤️ My favorites<span>›</span></button>
        <button className="row-btn" onClick={() => { loadMyOrders(); setScreen('orders'); }}>📦 My orders<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('referral')}>🎁 Invite friends & earn points<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('cart')}>🛒 My cart<span>›</span></button>
        <button className="row-btn" onClick={() => setScreen('share')}>📲 Share / Download App<span>›</span></button>
        <button className="row-btn" onClick={() => { setReviewStars(0); setReviewMsg(''); setReviewSent(false); setScreen('review'); }}>⭐ Rate us / Feedback<span>›</span></button>
        <button className="row-btn danger" onClick={() => { if (window.confirm('Exit BlitzMall app?')) exitApp(); }}>🚪 Exit App<span>›</span></button>
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
          const progress = orderTrackingProgress[o._id] || 0;
          const bikeLeft = `calc(70px + ${(progress / 100)} * (100% - 140px))`;
          const progressWidth = `calc(${(progress / 100)} * (100% - 140px))`;
          const etaMinutes = o.status === 'on_the_way' && o.dispatchedAt
            ? Math.max(0, 20 - Math.round((Date.now() - new Date(o.dispatchedAt).getTime()) / 60000))
            : null;
          return (
            <div className="order-card" key={o._id}>
              <div className="order-top"><b>KES {o.totalPrice}</b><span className="muted">{new Date(o.createdAt).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}</span></div>
              <div className="order-items">{o.items.map((it, k) => <span key={k}>{it.name} ×{it.quantity}</span>)}</div>
              
              {o.status === 'on_the_way' && (
                <>
                  <div className="bike-anim-container">
                    <span className="bike-node start">🏪 Shop</span>
                    <div className="bike-track" />
                    <div className="bike-track-progress" style={{ width: progressWidth }} />
                    <span className="bike-emoji" style={{ left: bikeLeft }}>🛵</span>
                    <span className="bike-node end">📍 You</span>
                  </div>
                  {etaMinutes !== null && (
                    <div className="delivery-eta">🕐 Estimated arrival: <b>{etaMinutes > 0 ? `~${etaMinutes} min` : 'Any moment now!'}</b></div>
                  )}
                </>
              )}

              {o.status === 'delivered' && (
                <div className="bike-delivered-badge">✅ Delivered successfully!</div>
              )}

              {o.gpsCoords && o.gpsCoords.lat && o.gpsCoords.lng && (
                <div className="order-map-wrap">
                  <LiveMap
                    from={{ lat: o.shopCoords?.lat || SHOP_COORDS.lat, lng: o.shopCoords?.lng || SHOP_COORDS.lng }}
                    to={{ lat: o.gpsCoords.lat, lng: o.gpsCoords.lng }}
                  />
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

  // FAVORITES — products the shopper hearted on the grid or detail page.
  if (screen === 'favorites') return (
    <div className="screen with-nav">
      <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('profile')}>‹</button><h2 className="topbar-title">❤️ My Favorites</h2></header>
      <div className="scroll">
        <div className="offers-hero">
          <h2>❤️ Your favorites</h2>
          <p>{favorites.length} item{favorites.length === 1 ? '' : 's'} saved — tap 🤍 to remove one.</p>
        </div>
        {favorites.length === 0 ? (
          <div className="empty-cart"><span>🤍</span><p>No favorites yet</p><button className="btn-ghost" onClick={() => setScreen('home')}>Browse products</button></div>
        ) : (
          <div className="prod-grid" style={{ padding: '0 16px' }}>
            {favorites.map(p => <ProductCard key={productId(p)} p={p} onOpen={openProduct} onAdd={addToCart} fav onFav={toggleFavorite} />)}
          </div>
        )}
      </div>
      <BottomNav />
      {renderToasts()}
    </div>
  );

  // TODAY'S DEALS — opens when a customer taps any top ad banner.
  if (screen === 'offers') {
    const flashSaleProducts = products.filter(p => p.isFlashSale);
    const discounted = products.filter(p => p.discountApplied && p.originalPrice && p.originalPrice > p.price && !p.isFlashSale);
    const activeBanner = (banners && banners.length ? banners[bannerIndex % banners.length] : null) || banners[0] || null;
    return (
      <div className="screen with-nav">
        <header className="topbar">
          <button className="icon-btn back" onClick={() => setScreen('home')}>‹</button>
          <h2 className="topbar-title">Today's Deals</h2>
          <button className="icon-btn cart-icon" onClick={() => setScreen('cart')}>🛒{cartCount > 0 && <span className="cart-badge">{cartCount}</span>}</button>
        </header>
        <div className="scroll">
          <div className="offers-hero">
            <h2>🔥 Today's Deals</h2>
            <p>{flashSaleProducts.length + discounted.length} items on offer right now — grab them before they're gone!</p>
          </div>

          {activeBanner && activeBanner.code && (
            <div className="deal-banner-chip">
              🎟️ {activeBanner.title}: use code <b>{activeBanner.code}</b> at checkout
              <button onClick={() => { navigator.clipboard.writeText(activeBanner.code); showToast('Code copied! Use it at checkout.'); }} style={{ marginLeft: 4, background: 'none', border: 'none', color: 'var(--gold)', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.72rem' }}>Copy</button>
            </div>
          )}

          {flashSaleProducts.length === 0 && discounted.length === 0 && (
            <div className="empty-cart"><span>🎈</span><p>No offers right now — check back soon!</p>
              <button className="btn-ghost" onClick={() => setScreen('home')}>Back to shop</button></div>
          )}

          {flashSaleProducts.length > 0 && (
            <>
              <div className="offer-section-title">⚡ Flash Sale <span className="deal-countdown-chip">ends soon</span></div>
              <div className="flash-sale-card" style={{ margin: '0 16px' }}>
                <div className="flash-sale-items">
                  {flashSaleProducts.map(p => {
                    const origPrice = p.originalPrice || p.price;
                    const discPrice = p.price;
                    const pct = p.flashSaleDiscount || Math.round((1 - discPrice / origPrice) * 100);
                    return (
                      <div className="flash-item" key={`deal-flash-${p._id || p.id}`} onClick={() => openProduct(p)}>
                        <span className="flash-badge">-{pct}%</span>
                        <div className="flash-item-img">
                          {p.image ? <img src={firstImage(p.image)} alt={p.name} className="product-img-element" loading="lazy"/> : '🛍️'}
                        </div>
                        <div className="flash-item-info">
                          <span className="flash-item-name">{p.name}</span>
                          <div className="flash-price-row">
                            <span className="flash-price-disc">KES {discPrice}</span>
                            <span className="flash-price-orig">KES {origPrice}</span>
                          </div>
                        </div>
                        <button className="flash-add-btn" onClick={(e) => { e.stopPropagation(); addToCart(p, 1); }}>+</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {discounted.length > 0 && (
            <>
              <div className="offer-section-title">🏷️ Discounted Goods</div>
              <div className="prod-grid" style={{ padding: '0 16px' }}>
                {discounted.map(p => <ProductCard key={productId(p)} p={p} onOpen={openProduct} onAdd={addToCart} fav={isFavorite(productId(p))} onFav={toggleFavorite} />)}
              </div>
            </>
          )}
        </div>
        <BottomNav />
        {renderToasts()}
      </div>
    );
  }

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
    // Prefer the live "latest APK" reported by the server; fall back to the
    // known URL if the server can't be reached.
    const apkUrl = appInfo?.apkUrl || 'https://blitzmall-backend.onrender.com/apk/blitzmall-v3.apk';
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
            {appInfo?.version && (
              <div style={{ fontSize: '0.72rem', color: 'var(--green)', marginBottom: 8 }}>
                ✅ Latest version: {appInfo.version}
              </div>
            )}

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

  // REFERRAL — share your phone code so friends get a welcome bonus and you
  // earn loyalty points every time someone new signs up with your code.
  if (screen === 'referral') {
    const myCode = customer?.customerId || '';
    const refCount = custAccount?.referralCount || 0;
    const waMsg = encodeURIComponent(`Hey! 👋 Shop at Blitz Mall and we BOTH earn bonus loyalty points. Use my referral code when signing in: ${myCode} — download the app: https://blitzmall-backend.onrender.com/apk/blitzmall-v3.apk`);
    return (
      <div className="screen with-nav">
        <header className="topbar"><button className="icon-btn back" onClick={() => setScreen('profile')}>‹</button><h2 className="topbar-title">Invite Friends</h2></header>
        <div className="scroll">
          <div className="referral-hero">
            <span style={{ fontSize: '3rem', display: 'block' }}>🎁</span>
            <h3 style={{ fontFamily: 'Unbounded, sans-serif', margin: '10px 0 6px 0', color: 'var(--gold)' }}>Invite & Earn Points</h3>
            <p className="muted" style={{ fontSize: '.82rem', lineHeight: 1.6 }}>
              When a friend signs in with <b>your code</b>, you earn <b style={{ color: 'var(--orange)' }}>+100 points</b> and they get a <b style={{ color: 'var(--green)' }}>+50 welcome bonus</b>. Points unlock vouchers in your Points Redemption Store!
            </p>
            <div className="referral-code-box" onClick={() => { navigator.clipboard.writeText(myCode); showToast('Referral code copied! Send it to a friend 🎉'); }}>
              <small>YOUR REFERRAL CODE</small>
              <b>{myCode}</b>
              <span>tap to copy</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16, width: '100%' }}>
              <a className="btn-neon" style={{ textAlign: 'center', textDecoration: 'none', color: '#000' }} href={`https://wa.me/?text=${waMsg}`} target="_blank" rel="noreferrer">💬 Share on WhatsApp</a>
              <button className="btn-ghost" onClick={() => { navigator.clipboard.writeText(myCode); showToast('Code copied!'); }}>📋 Copy my code</button>
            </div>
            <div className="referral-stats">
              <div><b>{refCount}</b><small>friends invited</small></div>
              <div><b>{custLoyalty?.points || 0}</b><small>my points</small></div>
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

const ProductCard = React.memo(function ProductCard({ p, onOpen, onAdd, fav, onFav }) {
  return (
    <div className="prod-card" onClick={() => onOpen(p)}>
      {onFav && (
        <button
          className={`prod-fav ${fav ? 'on' : ''}`}
          onClick={e => { e.stopPropagation(); onFav(p); }}
          aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
        >
          {fav ? '❤️' : '🤍'}
        </button>
      )}
      <div className="prod-img">{p.image ? <img src={firstImage(p.image)} alt={p.name} className="product-img-element" loading="lazy"/> : <div className="noimg">🛍️</div>}</div>
      <div className="prod-meta"><span className="prod-name">{p.name}</span><span className="prod-price">KES {p.price}</span></div>
      <button className="prod-add" onClick={e => { e.stopPropagation(); onAdd(p, 1); }}>+</button>
    </div>
  );
});



export default App;
