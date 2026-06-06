import React, { useState, useEffect, useRef } from 'react';
import './Admin.css';
import { cacheProducts, getCachedProducts, queueSale, syncQueuedSales, getPendingCount, onOnline, onOffline } from './offline';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

const API_URL = 'https://blitzmall-backend.onrender.com/api';
const BLANK = { name: '', category: '', barcode: '', buyingPrice: '', price: '', stock: '', description: '', image: null, expiryDate: '' };

// JWT auth helper — adds Bearer token to every admin fetch
const authHeaders = () => {
  const token = localStorage.getItem('bm_token') || sessionStorage.getItem('bm_token');
  return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
};
const money = (n) => 'KES ' + (Math.round((n || 0) * 100) / 100).toLocaleString();
const stars = (n) => '★'.repeat(Math.max(0,n)) + '☆'.repeat(Math.max(0,5-n));
const fmt = (d) => d ? new Date(d).toLocaleDateString() : '';

function Admin() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [user, setUser] = useState(null); // { name, role, username }
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupUsername, setSetupUsername] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupName, setSetupName] = useState('');
  const [tab, setTab] = useState('sales');
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState('');
  const [saleCart, setSaleCart] = useState([]);
  const [payMethod, setPayMethod] = useState('cash');
  const [amountGiven, setAmountGiven] = useState('');
  const [cashPart, setCashPart] = useState('');
  const [mpesaPart, setMpesaPart] = useState('');
  const [recentSales, setRecentSales] = useState([]);
  const [lastChange, setLastChange] = useState(null);
  const [custPhone, setCustPhone] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [stkCheckoutId, setStkCheckoutId] = useState(null);
  const [stkStatus, setStkStatus] = useState('idle'); // idle | waiting | confirmed | failed
  const [stkError, setStkError] = useState('');
  const [cameraScan, setCameraScan] = useState(false);
  const scanRef = useRef(null);
  const cameraRef = useRef(null);
  const barcodeLoopRef = useRef(null);
  const [staffList, setStaffList] = useState([]);
  const [cashier, setCashier] = useState('Owner');
  const [newStaffName, setNewStaffName] = useState('');
  const [summary, setSummary] = useState(null);
  const [period, setPeriod] = useState('today');
  const [expenses, setExpenses] = useState([]);
  const [expDesc, setExpDesc] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [credit, setCredit] = useState([]);
  const [crName, setCrName] = useState('');
  const [crPhone, setCrPhone] = useState('');
  const [crAmount, setCrAmount] = useState('');
  const [crNote, setCrNote] = useState('');
  const [crShowPaid, setCrShowPaid] = useState(false);
  const [reviews, setReviews] = useState([]);
  const [alerts, setAlerts] = useState({ low: [], out: [], expiringSoon: [], expired: [] });
  const [muted, setMuted] = useState(false);
  const [showBanner, setShowBanner] = useState(true);
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserRole, setNewUserRole] = useState('cashier');
  const [newUserBranch, setNewUserBranch] = useState('');
  const [offline, setOffline] = useState(!navigator.onLine);
  const [pendingSync, setPendingSync] = useState(getPendingCount());
  const [loyaltyPhone, setLoyaltyPhone] = useState('');
  const [loyaltyData, setLoyaltyData] = useState(null);
  const [loyaltyMembers, setLoyaltyMembers] = useState([]);
  const [coupons, setCoupons] = useState([]);
  const [couponCode, setCouponCode] = useState('');
  const [couponType, setCouponType] = useState('percent');
  const [couponValue, setCouponValue] = useState('');
  const [couponMin, setCouponMin] = useState('');
  const [couponExpiry, setCouponExpiry] = useState('');
  const [couponMaxUses, setCouponMaxUses] = useState('');
  const [notifGranted, setNotifGranted] = useState(false);
  const [branches, setBranches] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [predictions, setPredictions] = useState(null);
  const [predLoading, setPredLoading] = useState(false);
  const [branchForm, setBranchForm] = useState({ name:'', location:'', phone:'', email:'' });
  const prevOut = useRef(new Set());
  const prevBranchId = useRef(null);
  const notifSent = useRef(new Set());
  const prevOrderCount = useRef(0);
  const audioCtx = useRef(null);
  const mutedRef = useRef(false);

  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // Online/offline listeners
  useEffect(() => {
    const unsubOnline = onOnline(() => { setOffline(false); syncQueuedSales(authHeaders).then(r => { if (r.synced > 0) setPendingSync(getPendingCount()); }); });
    const unsubOffline = onOffline(() => setOffline(true));
    return () => { unsubOnline(); unsubOffline(); };
  }, []);

  // Inject theme vars on <html> so admin UI stays visible even if WebView strips CSS classes
  useEffect(() => {
    if (!loggedIn) return;
    const vars = {
      '--bg': '#0a0a0c', '--card': '#16161b', '--bg-2': '#111114', '--line': '#26262e',
      '--text': '#f4f4f6', '--muted': '#8a8a96', '--gold': '#ffd24a', '--orange': '#ff7a1a',
      '--red': '#ff2d2d', '--green': '#36d399',
    };
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  }, [loggedIn]);

  const playAlarm = () => {
    if (mutedRef.current) return;
    try {
      if (!audioCtx.current) audioCtx.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx.current;
      if (ctx.state === 'suspended') ctx.resume();
      [0, 0.32, 0.64].forEach(t => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'square'; osc.frequency.value = 880;
        osc.connect(gain); gain.connect(ctx.destination);
        const s = ctx.currentTime + t;
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
        osc.start(s); osc.stop(s + 0.24);
      });
    } catch (e) { console.error('alarm', e); }
  };

  const authGet = (url) => fetch(url, { headers: authHeaders() });
  const authPost = (url, body) => fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const authPut = (url, body) => fetch(url, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
  const authDelete = (url) => fetch(url, { method: 'DELETE', headers: authHeaders() });

  const checkAlerts = async () => {
    try {
      const r = await authGet(API_URL + '/admin/summary');
      if (!r.ok) return;
      const d = await r.json();
      const out = d.out || [], low = d.low || [], expiringSoon = d.expiringSoon || [], expired = d.expired || [];
      setAlerts({ low, out, expiringSoon, expired });
      const newlyOut = out.map(p => p.name).filter(n => !prevOut.current.has(n));
      if (newlyOut.length > 0) { playAlarm(); setShowBanner(true); }
      prevOut.current = new Set(out.map(p => p.name));
    } catch (e) { console.error(e); }
  };

  const withBranch = (url) => activeBranchId ? url + (url.includes('?') ? '&' : '?') + 'branchId=' + activeBranchId : url;
  const asArray = (d) => (Array.isArray(d) ? d : []);
  const loadProducts = async () => {
    try {
      // Use authenticated endpoint with branch filter when logged in, fall back to public
      const url = user ? withBranch(API_URL + '/admin/products') : API_URL + '/products';
      const r = user ? await authGet(url) : await fetch(url);
      const data = asArray(await r.json());
      setProducts(data);
      cacheProducts(data); // cache for offline use
    } catch (e) {
      console.error(e);
      const cached = getCachedProducts();
      if (cached.length > 0) setProducts(cached);
      else setProducts([]);
    }
  };
  const loadOrders = async () => { try { const r = await authGet(withBranch(API_URL + '/admin/orders')); setOrders(asArray(await r.json())); } catch (e) { console.error(e); setOrders([]); } };
  const loadSales = async () => { try { const r = await authGet(withBranch(API_URL + '/admin/sales?limit=15')); setRecentSales(asArray(await r.json())); } catch (e) { console.error(e); setRecentSales([]); } };
  const loadSummary = async () => {
    try {
      const r = await authGet(withBranch(API_URL + '/admin/summary'));
      if (!r.ok) throw new Error('Server returned ' + r.status);
      const d = await r.json();
      if (d && d.summary) setSummary(d);
    } catch (e) { console.error(e); }
  };
  const loadExpenses = async () => { try { const r = await authGet(withBranch(API_URL + '/admin/expenses')); setExpenses(asArray(await r.json())); } catch (e) { console.error(e); setExpenses([]); } };
  const loadCredit = async () => { try { const r = await authGet(withBranch(API_URL + '/admin/credit')); setCredit(asArray(await r.json())); } catch (e) { console.error(e); setCredit([]); } };
  const loadReviews = async () => { try { const r = await authGet(API_URL + '/admin/reviews'); setReviews(asArray(await r.json())); } catch (e) { console.error(e); setReviews([]); } };
  const loadStaff = async () => { try { const r = await authGet(API_URL + '/admin/staff'); setStaffList(asArray(await r.json())); } catch (e) { console.error(e); setStaffList([]); } };
  const loadUsers = async () => { try { const r = await authGet(API_URL + '/admin/users'); setUsers(asArray(await r.json())); } catch (e) { console.error(e); setUsers([]); } };
  const createUser = async (e) => {
    e.preventDefault();
    if (!newUsername || !newPassword) { alert('Username and password required'); return; }
    try {
      const r = await authPost(API_URL + '/admin/users', { username: newUsername, password: newPassword, name: newUserName || newUsername, role: newUserRole, branchId: newUserBranch || null });
      const d = await r.json();
      if (d.success) { setNewUsername(''); setNewPassword(''); setNewUserName(''); setNewUserRole('cashier'); setNewUserBranch(''); loadUsers(); alert(d.message); }
      else alert(d.error || 'Failed to create user');
    } catch (e) { console.error(e); alert('Network error'); }
  };
  const delUser = async (id) => { if (!window.confirm('Delete this user?')) return; try { await authDelete(API_URL + '/admin/users/' + id); loadUsers(); } catch (e) { console.error(e); } };
  const loadBranches = async () => { try { const r = await authGet(API_URL + '/admin/branches'); setBranches(asArray(await r.json())); } catch (e) { console.error(e); } };
  const loadPredictions = async () => {
    setPredLoading(true);
    try { const r = await authGet(API_URL + '/admin/predictions'); if (r.ok) setPredictions(await r.json()); }
    catch (e) { console.error(e); } finally { setPredLoading(false); }
  };
  const loadLoyaltyMembers = async () => { try { const r = await authGet(API_URL + '/admin/loyalty'); setLoyaltyMembers(asArray(await r.json())); } catch (e) { console.error(e); } };
  const loadCoupons = async () => { try { const r = await authGet(API_URL + '/admin/coupons'); setCoupons(asArray(await r.json())); } catch (e) { console.error(e); } };
  const lookupLoyalty = async () => {
    if (!loyaltyPhone.trim()) return;
    try {
      const r = await authGet(API_URL + '/admin/loyalty/' + loyaltyPhone.trim());
      setLoyaltyData(await r.json());
    } catch (e) { console.error(e); }
  };
  const redeemPoints = async () => {
    if (!loyaltyData || !loyaltyData.exists || loyaltyData.points < 100) { alert('Customer needs at least 100 points to redeem'); return; }
    const pts = parseInt(prompt('How many points to redeem? (100 pts = KES 500 cashback, available: ' + loyaltyData.points + ')', Math.min(loyaltyData.points, 100)), 10);
    if (!pts || pts < 100) return;
    try {
      const r = await authPost(API_URL + '/admin/loyalty/redeem', { phone: loyaltyData.phone, points: pts });
      const d = await r.json();
      if (d.success) { alert(d.message); lookupLoyalty(); } else alert(d.error || 'Redeem failed');
    } catch (e) { console.error(e); }
  };
  const createCoupon = async (e) => {
    e.preventDefault();
    if (!couponCode || !couponValue) { alert('Code and value required'); return; }
    try {
      const r = await authPost(API_URL + '/admin/coupons', { code: couponCode, type: couponType, value: couponValue, minPurchase: couponMin, expiresAt: couponExpiry, maxUses: couponMaxUses });
      const d = await r.json();
      if (d.success) { setCouponCode(''); setCouponValue(''); setCouponMin(''); setCouponExpiry(''); setCouponMaxUses(''); loadCoupons(); }
      else alert(d.error || 'Failed');
    } catch (e) { console.error(e); }
  };
  const toggleCoupon = async (id, active) => { try { await authPut(API_URL + '/admin/coupons/' + id, { active: !active }); loadCoupons(); } catch (e) { console.error(e); } };
  const delCoupon = async (id) => { if (!window.confirm('Delete this coupon?')) return; try { await authDelete(API_URL + '/admin/coupons/' + id); loadCoupons(); } catch (e) { console.error(e); } };

  // Keep-alive ping to prevent Render backend from sleeping
  const keepAlive = async () => {
    try {
      const r = await fetch(API_URL + '/admin/summary');
      if (!r.ok) throw new Error('Keep-alive ping returned ' + r.status);
      await r.json();
    } catch (e) { /* silently ignore, backend might be cold-starting */ }
  };

  // Request browser notification permission on login
  useEffect(() => {
    if (!loggedIn) return;
    if ('Notification' in window && Notification.permission === 'default') { Notification.requestPermission().then(p => setNotifGranted(p === 'granted')); }
    if ('Notification' in window) setNotifGranted(Notification.permission === 'granted');
  }, [loggedIn]);

  // Show browser notifications for critical alerts (deduplicated)
  useEffect(() => {
    if (!loggedIn || !notifGranted || !('Notification' in window)) return;
    const now = Date.now();
    // Out of stock
    for (const p of (alerts.out||[])) {
      const key = 'out_' + p.name;
      if (!notifSent.current.has(key)) {
        notifSent.current.add(key);
        new Notification('🚨 Out of Stock!', { body: p.name + ' is out of stock!', icon: '/favicon.ico' });
      }
    }
    // Low stock
    for (const p of (alerts.low||[])) {
      const key = 'low_' + p.name;
      if (!notifSent.current.has(key)) {
        notifSent.current.add(key);
        new Notification('⚠️ Low Stock', { body: p.name + ' only has ' + p.stock + ' left!', icon: '/favicon.ico' });
      }
    }
    // Expired
    for (const p of (alerts.expired||[])) {
      const key = 'exp_' + p.name;
      if (!notifSent.current.has(key)) {
        notifSent.current.add(key);
        new Notification('❌ Expired Product', { body: p.name + ' has expired!', icon: '/favicon.ico' });
      }
    }
      // Clear old entries after 10 minutes to allow re-notification
    if (notifSent.current.size > 100) notifSent.current = new Set();
  }, [alerts.out.length, alerts.low.length, alerts.expired?.length, loggedIn, notifGranted]);

  // New order browser notifications
  useEffect(() => {
    if (!loggedIn) return;
    if (prevOrderCount.current === 0 && orders.length > 0) { prevOrderCount.current = orders.length; return; }
    if (orders.length > prevOrderCount.current) {
      const newCount = orders.length - prevOrderCount.current;
      const newOrders = orders.slice(0, newCount);
      playAlarm();
      if (notifGranted && ('Notification' in window)) {
        newOrders.forEach(o => {
          const key = 'newOrder_' + o._id;
          if (!notifSent.current.has(key)) {
            notifSent.current.add(key);
            const loc = o.deliveryLocation || 'In-Store / Standard';
            new Notification('🛒 New Order!', { 
              body: `${o.customerName || 'Customer'} (${o.customerId || ''})\n📍 Delivery: ${loc}`, 
              icon: '/favicon.ico' 
            });
          }
        });
      }
      prevOrderCount.current = orders.length;
    }
    if (notifSent.current.size > 100) notifSent.current = new Set();
  }, [orders.length, loggedIn, notifGranted]);

  useEffect(() => {
    if (!loggedIn) return;
    checkAlerts();
    loadOrders();
    keepAlive();
    const id = setInterval(() => {
      checkAlerts();
      loadOrders();
    }, 25000);
    const kaId = setInterval(keepAlive, 240000); // ping every 4 min to keep Render awake
    return () => { clearInterval(id); clearInterval(kaId); };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    if (tab === 'records') { loadSummary(); loadPredictions(); }
    else if (tab === 'expenses') { loadExpenses(); loadSummary(); }
    else if (tab === 'credit') loadCredit();
    else if (tab === 'reviews') loadReviews();
    else if (tab === 'staff') { loadStaff(); if (user?.role === 'owner') { loadUsers(); loadBranches(); } }
    else if (tab === 'loyalty') { loadLoyaltyMembers(); loadCoupons(); }
    else if (tab === 'branches' && (!user || user.role === 'owner')) loadBranches();
  }, [tab, loggedIn]);

  // Reload data when branch filter changes
  useEffect(() => {
    if (!loggedIn || !user) return;
    if (prevBranchId.current !== null && prevBranchId.current !== activeBranchId) {
      loadProducts(); loadOrders(); loadSales(); loadSummary(); loadExpenses(); loadCredit();
    }
    prevBranchId.current = activeBranchId;
  }, [activeBranchId, loggedIn]);

  // Poll M-Pesa STK status after sending push
  useEffect(() => {
    if (!stkCheckoutId || stkStatus !== 'waiting') return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(API_URL + '/mpesa/status/' + stkCheckoutId);
        const d = await r.json();
        if (d.status === 'confirmed') {
          clearInterval(interval);
          setStkStatus('confirmed');
          completeSaleRecord();
        } else if (d.status === 'failed') {
          clearInterval(interval);
          setStkStatus('failed');
          setStkError(d.resultDesc || 'Payment cancelled or failed.');
        }
      } catch (e) { console.error(e); }
    }, 3000);
    const timeout = setTimeout(() => { clearInterval(interval); if (stkStatus === 'waiting') { setStkStatus('failed'); setStkError('Timed out waiting for PIN. Try again.'); } }, 90000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [stkCheckoutId, stkStatus]);

  const completeSaleRecord = async () => {
    const saleData = { items: saleCart.length ? saleCart : window._pendingSaleCart, paymentMethod: payMethod, amountGiven, cashPart, mpesaPart, cashier, custPhone, branchId: activeBranchId || undefined };
    try {
      const r = await authPost(API_URL + '/admin/sales', saleData);
      const d = await r.json();
      if (d.success) {
        setLastChange({ change: d.change, total: d.total });
        setReceipt({ items: window._pendingSaleCart || [...saleCart], total: d.total, change: d.change, paymentMethod: payMethod, cashier, date: new Date(), phone: custPhone });
        setSaleCart([]); setAmountGiven(''); setCashPart(''); setMpesaPart(''); setCustPhone('');
        setStkCheckoutId(null); setStkStatus('idle'); window._pendingSaleCart = null;
        loadProducts(); loadSales(); checkAlerts();
        return;
      }
    } catch (e) { /* fall through to offline queue */ }
    // Offline: queue the sale locally
    if (queueSale(saleData)) {
      setPendingSync(getPendingCount());
      setLastChange({ change: 0, total: saleData.items.reduce((s, i) => s + i.price * i.qty, 0) });
      setSaleCart([]); setAmountGiven(''); setCashPart(''); setMpesaPart(''); setCustPhone('');
      window._pendingSaleCart = null;
    }
  };

  // On mount, check if we have a saved token
  useEffect(() => {
    const savedToken = localStorage.getItem('bm_token') || sessionStorage.getItem('bm_token');
    const savedUser = localStorage.getItem('bm_user') || sessionStorage.getItem('bm_user');
    if (savedToken && savedUser) {
      // Verify token is still valid
      fetch(API_URL + '/admin/me', { headers: { 'Authorization': 'Bearer ' + savedToken } })
        .then(r => { if (r.ok) return r.json(); throw new Error('Token expired'); })
        .then(d => {
          if (d.success) {
            setUser(d.user);
            setLoggedIn(true);
            if (d.user.role !== 'owner') {
              setActiveBranchId(d.user.branchId || null);
            } else {
              setActiveBranchId(null);
            }
            loadProducts(); loadOrders(); loadSales(); loadStaff();
          }
        })
        .catch(() => {
          localStorage.removeItem('bm_token');
          localStorage.removeItem('bm_user');
          sessionStorage.removeItem('bm_token');
          sessionStorage.removeItem('bm_user');
        });
    }
  }, []);

  // Inactivity timeout (15 minutes)
  useEffect(() => {
    if (!loggedIn) return;
    let timer;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        localStorage.removeItem('bm_token');
        localStorage.removeItem('bm_user');
        sessionStorage.removeItem('bm_token');
        sessionStorage.removeItem('bm_user');
        setLoggedIn(false);
        setUser(null);
        alert('You have been logged out due to inactivity.');
      }, 15 * 60 * 1000);
    };

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(event => window.addEventListener(event, resetTimer));
    resetTimer();

    return () => {
      clearTimeout(timer);
      events.forEach(event => window.removeEventListener(event, resetTimer));
    };
  }, [loggedIn]);

  const login = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const r = await fetch(API_URL + '/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginUsername, password: loginPassword }) });
      const d = await r.json();
      if (d.success) {
        if (rememberMe) {
          localStorage.setItem('bm_token', d.token);
          localStorage.setItem('bm_user', JSON.stringify(d.user));
        } else {
          sessionStorage.setItem('bm_token', d.token);
          sessionStorage.setItem('bm_user', JSON.stringify(d.user));
        }
        setUser(d.user);
        setLoggedIn(true);
        if (d.user.role !== 'owner') {
          setActiveBranchId(d.user.branchId || null);
        } else {
          setActiveBranchId(null);
        }
        setLoginUsername(''); setLoginPassword('');
        loadProducts(); loadOrders(); loadSales(); loadStaff();
      } else {
        // If 401 and no owner exists, prompt setup
        if (r.status === 401 && d.needsSetup) {
          setNeedsSetup(true);
        } else {
          setLoginError(d.error || 'Invalid username or password');
        }
      }
    } catch (e) { console.error(e); setLoginError('Network error. Check connection.'); }
  };

  const handleSetup = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch(API_URL + '/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: setupUsername, password: setupPassword, name: setupName }) });
      const d = await r.json();
      if (d.success) {
        setNeedsSetup(false);
        setLoginUsername(setupUsername);
        setLoginPassword(setupPassword);
        alert('Owner account created! Login with your credentials.');
      } else {
        alert(d.error || 'Setup failed');
      }
    } catch (e) { alert('Network error'); }
  };

  const onImage = (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onloadend = () => setForm(s => ({ ...s, image: rd.result })); rd.readAsDataURL(f); };
  const resetForm = () => { setForm(BLANK); setEditingId(null); setShowForm(false); };
  const submitProduct = async (e) => {
    e.preventDefault();
    if (!form.name || form.price === '') { alert('Name and selling price required'); return; }
    try {
      const payload = { ...form, branchId: activeBranchId || undefined };
      const url = editingId ? API_URL + '/admin/products/' + editingId : API_URL + '/admin/products';
      const opts = editingId ? authPut(url, payload) : authPost(url, payload);
      const r = await opts;
      if ((await r.json()).success) { resetForm(); loadProducts(); }
    } catch (e) { console.error(e); }
  };
  const submitProductAndNext = async (e) => {
    if (e) e.preventDefault();
    if (!form.name || form.price === '') { alert('Name and selling price required'); return; }
    try {
      const payload = { ...form, branchId: activeBranchId || undefined };
      const url = API_URL + '/admin/products';
      const r = await authPost(url, payload);
      if ((await r.json()).success) {
        const prevCat = form.category;
        setForm({ ...BLANK, category: prevCat });
        loadProducts();
      }
    } catch (e) { console.error(e); }
  };
  const editProduct = (p) => { setForm({ name: p.name||'', category: p.category||'', barcode: p.barcode||'', buyingPrice: p.buyingPrice??'', price: p.price??'', stock: p.stock??'', description: p.description||'', image: p.image||null, expiryDate: p.expiryDate ? new Date(p.expiryDate).toISOString().slice(0,10) : '' }); setEditingId(p._id); setShowForm(true); window.scrollTo(0,0); };
  const delProduct = async (id) => { if (!window.confirm('Delete this item?')) return; try { const r = await authDelete(API_URL + '/admin/products/' + id); if ((await r.json()).success) loadProducts(); } catch (e) { console.error(e); } };
  const updateOrder = async (id, payload) => { try { const r = await authPut(API_URL + '/admin/orders/' + id, payload); if ((await r.json()).success) loadOrders(); } catch (e) { console.error(e); } };

  // Camera barcode scanning
  const startCamera = async () => {
    try {
      setCameraScan(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 480 } });
      if (cameraRef.current) cameraRef.current.srcObject = stream;

      // Wait for video to play, then start detection
      const video = cameraRef.current;
      if (!video) return;
      video.onloadedmetadata = () => { video.play(); };

      const detect = async () => {
        if (!cameraScan || !document.body.contains(video)) return;
        try {
          if (window.BarcodeDetector) {
            const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_128', 'qr_code'] });
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0) {
              const code = barcodes[0].rawValue;
              stopCamera();
              setScan(code);
              // Try to find and add the product immediately
              const byCode = products.find(p => p.barcode && p.barcode === code);
              if (byCode) addToSale(byCode);
              else { scanRef.current?.focus(); }
              return;
            }
          }
        } catch (e) { /* detection error, keep trying */ }
        barcodeLoopRef.current = requestAnimationFrame(detect);
      };
      barcodeLoopRef.current = requestAnimationFrame(detect);
    } catch (e) {
      console.error('Camera error:', e);
      setCameraScan(false);
      alert('Could not access camera. Check permissions.');
    }
  };

  const stopCamera = () => {
    setCameraScan(false);
    if (barcodeLoopRef.current) { cancelAnimationFrame(barcodeLoopRef.current); barcodeLoopRef.current = null; }
    if (cameraRef.current) {
      const stream = cameraRef.current.srcObject;
      if (stream) { stream.getTracks().forEach(t => t.stop()); }
      cameraRef.current.srcObject = null;
    }
  };

  const stockTag = (s) => { if (s === undefined || s === null) return null; if (s <= 0) return React.createElement('span', {className:'tag out'}, 'Out'); if (s < 2) return React.createElement('span', {className:'tag low'}, 'Low: ' + s); return React.createElement('span', {className:'tag ok'}, s + ' left'); };
  const expiryTag = (d) => {
    if (!d) return null;
    const now = new Date(); const exp = new Date(d); const diff = exp - now;
    if (diff < 0) return React.createElement('span', {className:'tag out'}, 'Expired ' + fmt(d));
    if (diff < 7*86400000) return React.createElement('span', {className:'tag low'}, 'Exp soon ' + fmt(d));
    return React.createElement('span', {className:'tag ok'}, 'Exp ' + fmt(d));
  };

  const pid = (p) => p._id || p.id;
  const stockOf = (id) => { const p = products.find(x => pid(x) === id); return p ? (p.stock ?? null) : null; };
  const addToSale = (p) => { const id = pid(p); setSaleCart(c => { const ex = c.find(i => i.productId === id); if (ex) return c.map(i => i.productId === id ? { ...i, qty: i.qty+1 } : i); return [...c, { productId: id, name: p.name, price: p.price||0, buyingPrice: p.buyingPrice||0, qty: 1 }]; }); setScan(''); setLastChange(null); if (scanRef.current) scanRef.current.focus(); };
  const handleScanSubmit = (e) => { e.preventDefault(); const t = scan.trim(); if (!t) return; const byCode = products.find(p => p.barcode && p.barcode === t); if (byCode) { addToSale(byCode); return; } const byName = products.filter(p => p.name.toLowerCase().includes(t.toLowerCase())); if (byName.length === 1) addToSale(byName[0]); };
  const scanMatches = scan.trim() ? products.filter(p => p.name.toLowerCase().includes(scan.toLowerCase()) || (p.barcode||'').includes(scan)).slice(0,6) : [];
  const setSaleQty = (id, q) => { if (q <= 0) setSaleCart(c => c.filter(i => i.productId !== id)); else setSaleCart(c => c.map(i => i.productId === id ? { ...i, qty: q } : i)); };
  const saleTotal = saleCart.reduce((s, i) => s + i.price * i.qty, 0);
  const saleProfit = saleCart.reduce((s, i) => s + (i.price - i.buyingPrice) * i.qty, 0);
  const change = payMethod === 'cash' && parseFloat(amountGiven) > saleTotal ? (parseFloat(amountGiven) - saleTotal) : 0;
  const splitCovered = (parseFloat(cashPart)||0) + (parseFloat(mpesaPart)||0);

  const completeSale = async () => {
    if (!saleCart.length) return;
    if (payMethod === 'cash' && parseFloat(amountGiven||0) < saleTotal) { if (!window.confirm('Amount given is less than total. Record anyway?')) return; }
    if (payMethod === 'split' && splitCovered < saleTotal) { if (!window.confirm('Split amounts less than total. Record anyway?')) return; }

    if (payMethod === 'mpesa') {
      if (!custPhone) { alert('Enter customer phone number to send M-Pesa prompt.'); return; }
      try {
        window._pendingSaleCart = [...saleCart];
        setStkStatus('waiting'); setStkError('');
        const r = await fetch(API_URL + '/mpesa/stk-push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: custPhone, amount: saleTotal }) });
        const d = await r.json();
        if (d.success) { setStkCheckoutId(d.checkoutRequestId); }
        else { setStkStatus('failed'); setStkError(d.error || 'M-Pesa request failed'); }
      } catch (e) { setStkStatus('failed'); setStkError('Network error sending M-Pesa request'); }
      return;
    }

    // Cash / split: record immediately
    await completeSaleRecord();
  };
  const voidSale = async (id) => { if (!window.confirm('Void this sale and restore stock?')) return; try { const r = await authDelete(API_URL + '/admin/sales/' + id); if ((await r.json()).success) { loadProducts(); loadSales(); } } catch (e) { console.error(e); } };
  const addExpense = async (e) => { e.preventDefault(); if (!expDesc || expAmount === '') return; try { const r = await authPost(API_URL + '/admin/expenses', { description: expDesc, amount: expAmount, branchId: activeBranchId || undefined }); if ((await r.json()).success) { setExpDesc(''); setExpAmount(''); loadExpenses(); loadSummary(); } } catch (e) { console.error(e); } };
  const delExpense = async (id) => { try { const r = await authDelete(API_URL + '/admin/expenses/' + id); if ((await r.json()).success) { loadExpenses(); loadSummary(); } } catch (e) { console.error(e); } };
  const waLink = (phone, msg) => { let p = (phone||'').replace(/[^0-9]/g,''); if (p.startsWith('0')) p = '254' + p.slice(1); return 'https://wa.me/' + p + '?text=' + encodeURIComponent(msg); };
  const addCredit = async (e) => { e.preventDefault(); if (!crName || crAmount === '') return; try { const r = await authPost(API_URL + '/admin/credit', { customerName: crName, phone: crPhone, amount: crAmount, note: crNote }); if ((await r.json()).success) { setCrName(''); setCrPhone(''); setCrAmount(''); setCrNote(''); loadCredit(); } } catch (e) { console.error(e); } };
  const payCredit = async (id) => { try { const r = await authPut(API_URL + '/admin/credit/' + id + '/pay', {}); if ((await r.json()).success) loadCredit(); } catch (e) { console.error(e); } };
  const delCredit = async (id) => { if (!window.confirm('Delete this record?')) return; try { const r = await authDelete(API_URL + '/admin/credit/' + id); if ((await r.json()).success) loadCredit(); } catch (e) { console.error(e); } };
  const delReview = async (id) => { if (!window.confirm('Delete this review?')) return; try { const r = await authDelete(API_URL + '/admin/reviews/' + id); if ((await r.json()).success) loadReviews(); } catch (e) { console.error(e); } };
  const addStaff = async (e) => { e.preventDefault(); if (!newStaffName.trim()) return; try { const r = await authPost(API_URL + '/admin/staff', { name: newStaffName, branchId: activeBranchId || undefined }); if ((await r.json()).success) { setNewStaffName(''); loadStaff(); } } catch (e) { console.error(e); } };
  const delStaff = async (id) => { if (!window.confirm('Remove this cashier?')) return; try { const r = await authDelete(API_URL + '/admin/staff/' + id); if ((await r.json()).success) loadStaff(); } catch (e) { console.error(e); } };
  const exportBackup = async () => { try { const r = await authGet(API_URL + '/admin/export'); const data = await r.json(); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'blitz-admin-backup-' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url); } catch (e) { alert('Export failed'); } };

  // ===== PDF & Excel Export =====
  const exportSalesPDF = () => {
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      // Header
      doc.setFillColor(10, 10, 12);
      doc.rect(0, 0, pageW, 35, 'F');
      doc.setTextColor(255, 210, 74);
      doc.setFontSize(22);
      doc.text('Blitz Mall', 14, 18);
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(10);
      doc.text('Sales Report - ' + periodLabel[period] + ' - ' + new Date().toLocaleDateString(), 14, 27);
      // Summary cards
      const yy = 42;
      doc.setFillColor(22, 22, 27);
      doc.roundedRect(14, yy, (pageW-28-8)/2, 28, 3, 3, 'F');
      doc.roundedRect(14+(pageW-28-8)/2+8, yy, (pageW-28-8)/2, 28, 3, 3, 'F');
      doc.setTextColor(255, 210, 74);
      doc.setFontSize(11);
      doc.text('Revenue', 22, yy+10);
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(16);
      doc.text('KES ' + (Math.round(P.revenue*100)/100).toLocaleString(), 22, yy+23);
      doc.setTextColor(54, 211, 153);
      doc.setFontSize(11);
      doc.text('Profit', 22+(pageW-28-8)/2+8+8, yy+10);
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(16);
      doc.text('KES ' + (Math.round(P.profit*100)/100).toLocaleString(), 22+(pageW-28-8)/2+8+8, yy+23);
      // Second row
      const yy2 = yy + 34;
      doc.setFillColor(22, 22, 27);
      doc.roundedRect(14, yy2, (pageW-28-8)/2, 28, 3, 3, 'F');
      doc.roundedRect(14+(pageW-28-8)/2+8, yy2, (pageW-28-8)/2, 28, 3, 3, 'F');
      doc.setTextColor(255, 45, 45);
      doc.setFontSize(11);
      doc.text('Expenses', 22, yy2+10);
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(16);
      doc.text('KES ' + (Math.round(P.expenses*100)/100).toLocaleString(), 22, yy2+23);
      const netColor = P.net >= 0 ? '#36d399' : '#ff2d2d';
      doc.setTextColor(netColor === '#36d399' ? 54 : 255, netColor === '#36d399' ? 211 : 45, netColor === '#36d399' ? 153 : 45);
      doc.setFontSize(11);
      doc.text('Net Profit', 22+(pageW-28-8)/2+8+8, yy2+10);
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(16);
      doc.text('KES ' + (Math.round(P.net*100)/100).toLocaleString(), 22+(pageW-28-8)/2+8+8, yy2+23);
      // Best sellers table
      const bestTable = (summary.best||[]).slice(0, 10).map(b => [b.name, b.qty || 0, 'KES ' + Math.round((b.revenue||0)*100)/100]);
      autoTable(doc, {
        head: [['Product', 'Sold', 'Revenue']],
        body: bestTable,
        startY: yy2 + 38,
        theme: 'grid',
        headStyles: { fillColor: [255, 122, 26], fontSize: 9 },
        bodyStyles: { fillColor: [22, 22, 27], textColor: [244, 244, 246], fontSize: 9 },
        alternateRowStyles: { fillColor: [16, 16, 20] },
        tableLineColor: [38, 38, 46],
        tableLineWidth: 0.1,
      });
      // Payment split summary
      const finalY = doc.lastAutoTable.finalY + 10;
      doc.setFillColor(22, 22, 27);
      doc.roundedRect(14, finalY, pageW-28, 20, 3, 3, 'F');
      doc.setTextColor(244, 244, 246);
      doc.setFontSize(10);
      doc.text('Cash: KES ' + (Math.round(P.cash*100)/100).toLocaleString() + '    M-Pesa: KES ' + (Math.round(P.mpesa*100)/100).toLocaleString(), 22, finalY+13);
      // Footer
      doc.setFillColor(10, 10, 12);
      doc.rect(0, doc.internal.pageSize.getHeight()-15, pageW, 15, 'F');
      doc.setTextColor(138, 138, 150);
      doc.setFontSize(8);
      doc.text('Generated by Blitz Mall HQ on ' + new Date().toLocaleString(), pageW/2, doc.internal.pageSize.getHeight()-6, { align: 'center' });
      // Save
      doc.save('blitz-sales-report-' + new Date().toISOString().slice(0,10) + '.pdf');
    } catch (e) { console.error('PDF export error:', e); alert('Failed to generate PDF'); }
  };

  const exportInventoryExcel = () => {
    try {
      const rows = (products||[]).map(p => ({
        Name: p.name,
        Category: p.category || '',
        Barcode: p.barcode || '',
        'Buying Price': p.buyingPrice || 0,
        'Selling Price': p.price || 0,
        Stock: p.stock ?? 0,
        'Expiry Date': p.expiryDate ? new Date(p.expiryDate).toLocaleDateString() : '',
        'Margin KES': Math.round(((p.price||0)-(p.buyingPrice||0))*100)/100,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const colWidths = [{ wch: 30 }, { wch: 15 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 8 }, { wch: 15 }, { wch: 12 }];
      ws['!cols'] = colWidths;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
      XLSX.writeFile(wb, 'blitz-inventory-' + new Date().toISOString().slice(0,10) + '.xlsx');
    } catch (e) { console.error('Excel export error:', e); alert('Failed to export inventory'); }
  };

  const exportExpensesExcel = () => {
    try {
      const rows = (expenses||[]).map(e => ({
        Description: e.description,
        Amount: e.amount || 0,
        Date: e.createdAt ? new Date(e.createdAt).toLocaleDateString() : '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 40 }, { wch: 14 }, { wch: 15 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Expenses');
      XLSX.writeFile(wb, 'blitz-expenses-' + new Date().toISOString().slice(0,10) + '.xlsx');
    } catch (e) { console.error('Excel export error:', e); alert('Failed to export expenses'); }
  };

  if (!loggedIn) {
    if (needsSetup) {
      return (
        <div className="blitz-admin-login"><div className="blitz-admin-login-card"><div className="blitz-admin-logo">⚡</div>
          <h1>Blitz Mall <span>Setup</span></h1><p className="blitz-admin-muted">Create your owner account</p>
          <form onSubmit={handleSetup}>
            <input className="owner-field" type="text" placeholder="Your name" value={setupName} onChange={e => setSetupName(e.target.value)} required />
            <input className="owner-field" type="text" placeholder="Username" value={setupUsername} onChange={e => setSetupUsername(e.target.value)} required />
            <input className="owner-field" type="password" placeholder="Password (min 6 chars)" value={setupPassword} onChange={e => setSetupPassword(e.target.value)} minLength={6} required />
            <button className="blitz-admin-btn" type="submit">Create Owner Account</button>
          </form>
        </div></div>
      );
    }
    return (
      <div className="blitz-admin-login"><div className="blitz-admin-login-card"><div className="blitz-admin-logo">⚡</div>
        <h1>Blitz Mall <span>HQ</span></h1><p className="blitz-admin-muted">Sign in to manage your store</p>
        <form onSubmit={login}>
          <input className="owner-field" type="text" placeholder="Username" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} required />
          <input className="owner-field" type="password" placeholder="Password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required />
          <div style={{display:'flex',alignItems:'center',gap:8,margin:'10px 0 15px 0',userSelect:'none'}}>
            <input type="checkbox" id="rememberMe" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} style={{accentColor:'var(--accent)',width:16,height:16,cursor:'pointer'}} />
            <label htmlFor="rememberMe" style={{color:'var(--muted)',fontSize:'.85rem',cursor:'pointer'}}>Remember Me</label>
          </div>
          {loginError && <p style={{color:'var(--red)',fontSize:'.85rem'}}>{loginError}</p>}
          <button className="blitz-admin-btn" type="submit">Sign In</button>
        </form>
      </div></div>
    );
  }

  // Determine which tabs are visible based on role
  const role = user?.role || 'cashier';
  const isCashier = role === 'cashier';
  const allTabs = [
    { id: 'sales', label: '🧾 Sell' },
    { id: 'inventory', label: `📦 Inventory (${products.length})` },
    { id: 'orders', label: `🛒 Orders (${orders.length})` },
    { id: 'records', label: '📊 Records' },
    { id: 'expenses', label: '💸 Expenses' },
    { id: 'credit', label: '🧍 Credit' },
    { id: 'reviews', label: '⭐ Reviews' },
    { id: 'loyalty', label: '🎁 Loyalty' },
    { id: 'staff', label: '👷 Staff' },
    { id: 'branches', label: '🏪 Branches' },
  ];
  let visibleTabs = [];
  if (role === 'cashier') {
    visibleTabs = allTabs.filter(t => t.id === 'sales');
  } else if (role === 'staff') {
    visibleTabs = allTabs.filter(t => ['inventory', 'orders', 'expenses', 'reviews', 'loyalty'].includes(t.id));
  } else if (role === 'manager') {
    visibleTabs = allTabs.filter(t => !['staff', 'branches'].includes(t.id));
  } else {
    visibleTabs = allTabs;
  }
  const isTabVisible = visibleTabs.some(t => t.id === tab);
  const safeTab = isTabVisible ? tab : (visibleTabs[0]?.id || 'sales');

  const productList = Array.isArray(products) ? products : [];
  const filtered = productList.filter(p => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) || (p.barcode||'').includes(search) || (p.category||'').toLowerCase().includes(search.toLowerCase()));
  const P = summary?.summary?.[period] ?? { revenue:0, profit:0, expenses:0, net:0, cash:0, mpesa:0, count:0 };
  const periodLabel = { today: 'Today', week: 'This week', month: 'This month', year: 'This year', all: 'All time' };
  const totalAlerts = alerts.out.length + alerts.low.length + (alerts.expired||[]).length;
  const formatReceiptMsg = (r) => {
    const line = '━'.repeat(20);
    const items = r.items.map(i => `• ${i.name} x${i.qty}  KES ${(i.price*i.qty).toLocaleString()}`).join('\n');
    return `⚡️ *BLITZ MALL - OFFICIAL RECEIPT* ⚡️\n${line}\n📅 ${r.date.toLocaleString()}\n👤 Cashier: ${r.cashier}\n💳 ${r.paymentMethod}\n${line}\n${items}\n${line}\n*💰 TOTAL: KES ${r.total.toLocaleString()}*${r.change > 0 ? '\n💵 Change: KES ' + r.change.toLocaleString() : ''}\n${line}\n🏪 Brilliant Shop\n📞 07XX XXX XXX\n✅ Thank you for shopping with us!\n⭐ Rate us on the app!`;
  };
  const receiptWALink = receipt && receipt.phone ? waLink(receipt.phone, formatReceiptMsg(receipt)) : null;

  return (
    <div className="blitz-hq-shell" style={{ minHeight: '100vh', background: '#0a0a0c', color: '#f4f4f6' }}>
      <header className="blitz-admin-header">
        <div className="blitz-admin-brand"><span className="blitz-admin-logo sm">⚡</span> Blitz Mall <b>HQ</b></div>
        <div className="blitz-admin-head-right">
          {offline && <span className="blitz-admin-muted" style={{fontSize:'.75rem',color:'var(--orange)'}}>📡 Offline</span>}
          {pendingSync > 0 && <span className="blitz-admin-muted" style={{fontSize:'.75rem',color:'var(--gold)'}}>⏳ {pendingSync}</span>}
          {user?.role === 'owner' && branches.length > 0 && (
            <select value={activeBranchId||''} onChange={e => setActiveBranchId(e.target.value||null)}
              style={{background:'var(--bg-2)',color:'var(--text)',border:'1px solid var(--line)',borderRadius:8,padding:'4px 8px',fontSize:'.75rem',fontFamily:'inherit'}}>
              <option value="">🏪 All Branches</option>
              {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          )}
          <button className={"blitz-admin-bell" + (alerts.out.length ? " ring" : "")} onClick={() => setMuted(m => !m)}>
            {muted ? "🔕" : "🔔"}{totalAlerts > 0 && <i className="blitz-admin-bell-dot">{totalAlerts}</i>}
          </button>
          {!isCashier && <span className="blitz-admin-muted" style={{fontSize:'.78rem'}}>{user?.name} · {user?.role}{user?.branchId ? ' · ' + (branches.find(b => b._id === user.branchId)?.name || 'Branch') : ''}</span>}
          <button className="blitz-admin-exit" onClick={() => { 
            localStorage.removeItem('bm_token'); localStorage.removeItem('bm_user'); 
            sessionStorage.removeItem('bm_token'); sessionStorage.removeItem('bm_user'); 
            setLoggedIn(false); setUser(null); 
          }}>Exit</button>
        </div>
      </header>

      {showBanner && totalAlerts > 0 && (
        <div className={"blitz-hq-notice" + (alerts.out.length || (alerts.expired||[]).length ? " urgent" : "")}>
          <span className="blitz-hq-notice-text">
            {alerts.out.length > 0 && <b>🚨 Out of stock: {alerts.out.map(p => p.name).join(", ")}. </b>}
            {(alerts.expired||[]).length > 0 && <b>❌ Expired: {alerts.expired.map(p => p.name).join(", ")}. </b>}
            {(alerts.expiringSoon||[]).length > 0 && <span>⏰ Expiring soon: {alerts.expiringSoon.map(p => p.name).join(", ")}. </span>}
            {alerts.low.length > 0 && <span>⚠ Low: {alerts.low.map(p => p.name + "(" + p.stock + ")").join(", ")}.</span>}
          </span>
          <button onClick={() => setShowBanner(false)}>✕</button>
        </div>
      )}

      <div className="blitz-admin-tabs">
        {visibleTabs.map(t => (
          <button key={t.id} className={safeTab===t.id?"on":""} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {safeTab === "sales" && (
        <div className="blitz-admin-body pos-wrap">
          <div className="pos-left">
            <div className="pos-head-row">
              <h2>Sell</h2>
              <div className="pos-cashier-wrap">
                <span>Cashier:</span>
                <select className="pos-cashier-sel" value={cashier} onChange={e => setCashier(e.target.value)}>
                  <option value="Owner">Owner</option>
                  {staffList.map(s => <option key={s._id} value={s.name}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <form className="pos-scan" onSubmit={handleScanSubmit}>
              <span>📷</span>
              <input ref={scanRef} autoFocus value={scan} onChange={e => setScan(e.target.value)} placeholder="Scan barcode or type product name…" />
              <button className="blitz-admin-btn small" type="submit">Find</button>
              {window.BarcodeDetector && <button type="button" className="blitz-admin-btn small" onClick={cameraScan ? stopCamera : startCamera} style={{background:'var(--grad)',padding:'10px 12px',fontSize:'.85rem'}}>{cameraScan ? '✕' : '📸'}</button>}
            </form>
            {cameraScan && (
              <div style={{position:'relative',marginBottom:12,borderRadius:14,overflow:'hidden',background:'#000',maxHeight:280}}>
                <video ref={cameraRef} autoPlay playsInline muted style={{width:'100%',height:'auto',display:'block'}} />
                <button type="button" onClick={stopCamera} style={{position:'absolute',top:8,right:8,background:'rgba(0,0,0,.6)',color:'#fff',border:'none',borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:'.8rem'}}>✕ Close</button>
              </div>
            )}
            {scanMatches.length > 0 && (
              <div className="pos-suggest">
                {scanMatches.map(p => (
                  <button key={pid(p)} onClick={() => addToSale(p)} disabled={(p.stock??1) <= 0}>
                    <span>{p.name}</span>
                    <span className="pos-suggest-meta">{money(p.price)} · {stockTag(p.stock)}</span>
                  </button>
                ))}
              </div>
            )}
            {lastChange && <div className="pos-change-notice">✅ Sale done · Total {money(lastChange.total)}{lastChange.change > 0 && <b> · Give change: {money(lastChange.change)}</b>}</div>}
            <div className="pos-cart">
              {saleCart.length === 0 ? <p className="blitz-admin-empty">Scan or search to add items.</p> : saleCart.map(i => {
                const left = stockOf(i.productId); const warn = left !== null && i.qty >= left;
                return (
                  <div className="pos-cart-row" key={i.productId}>
                    <div className="pos-cart-info">
                      <b>{i.name}</b>
                      <span className="pos-line">{money(i.price)} × {i.qty} = <b>{money(i.price * i.qty)}</b></span>
                      {warn && <span className="pos-warn">⚠ only {left} in stock</span>}
                    </div>
                    <div className="blitz-admin-qty"><button onClick={() => setSaleQty(i.productId, i.qty-1)}>−</button><b>{i.qty}</b><button onClick={() => setSaleQty(i.productId, i.qty+1)}>+</button></div>
                    <button className="pos-x" onClick={() => setSaleQty(i.productId, 0)}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pos-right">
            {receipt ? (
              <div className="receipt-box">
                <div className="receipt-header">
                  <h3>⚡ BLITZ MALL</h3>
                  <p>Brilliant Shop</p>
                  <small>{receipt.date.toLocaleString()}</small>
                  <small>Cashier: {receipt.cashier}</small>
                </div>
                <div className="receipt-items">
                  {receipt.items.map((i,k) => <div key={k} className="receipt-line"><span>{i.name} ×{i.qty}</span><span>{money(i.price*i.qty)}</span></div>)}
                </div>
                <div className="receipt-total"><span>Total</span><b>{money(receipt.total)}</b></div>
                {receipt.change > 0 && <div className="receipt-change"><span>Change</span><b>{money(receipt.change)}</b></div>}
                <div className="receipt-pay">{receipt.paymentMethod}</div>
                <div className="receipt-actions">
                  <button className="blitz-admin-btn small" onClick={() => window.print()}>🖨 Print</button>
                  {receiptWALink && <a className="cr-remind" href={receiptWALink} target="_blank" rel="noreferrer">📱 WhatsApp</a>}
                  <button className="blitz-admin-btn small" onClick={() => setReceipt(null)}>New sale</button>
                </div>
              </div>
            ) : (
              <>
                <div className="pos-total-box"><span>Total</span><b>{money(saleTotal)}</b>{saleCart.length > 0 && <small>Profit: {money(saleProfit)}</small>}</div>
                <input className="pos-phone-input" type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)} placeholder="Customer phone for receipt (optional)" />
                <div className="pos-pay">
                  <button className={payMethod==="cash"?"on":""} onClick={() => setPayMethod("cash")}>💵 Cash</button>
                  <button className={payMethod==="mpesa"?"on":""} onClick={() => setPayMethod("mpesa")}>📱 M-Pesa</button>
                  <button className={payMethod==="split"?"on":""} onClick={() => setPayMethod("split")}>🔀 Split</button>
                <button className={payMethod==="airtel"?"on":""} onClick={() => setPayMethod("airtel")}>📲 Airtel</button>
                </div>
                {payMethod === "cash" && <div className="pos-cash"><label>Amount given<input type="number" value={amountGiven} onChange={e => setAmountGiven(e.target.value)} placeholder="e.g. 500" /></label><div className={"pos-change" + (change > 0 ? " show" : "")}>Change to give: <b>{money(change)}</b></div></div>}
                {payMethod === "mpesa" && (
                  <div className="pos-cash">
                    <label>Customer phone *<input type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)} placeholder="07xx xxx xxx" /></label>
                    {stkStatus === "waiting" && <div className="stk-waiting">📱 STK Push sent! Waiting for customer to enter PIN...</div>}
                    {stkStatus === "confirmed" && <div className="stk-ok">✅ Payment confirmed!</div>}
                    {stkStatus === "failed" && <div className="stk-fail">❌ {stkError || "Payment failed. Try again."}<button onClick={() => { setStkStatus("idle"); setStkError(""); }} style={{marginLeft:8,cursor:"pointer",background:"none",border:"none",color:"var(--orange)"}}>Retry</button></div>}
                  </div>
                )}
                {payMethod === "split" && <div className="pos-cash"><label>Cash part<input type="number" value={cashPart} onChange={e => setCashPart(e.target.value)} placeholder="KES" /></label><label>M-Pesa part<input type="number" value={mpesaPart} onChange={e => setMpesaPart(e.target.value)} placeholder="KES" /></label><div className="pos-change show">Covered: {money(splitCovered)} / {money(saleTotal)}</div></div>}
                {payMethod === "airtel" && <div className="pos-cash"><p style={{color:"var(--muted)",fontSize:".85rem"}}>Customer sends Airtel Money manually to your number. Confirm after you see it on your phone.</p></div>}
                <button className="blitz-admin-btn pos-complete" disabled={!saleCart.length} onClick={completeSale}>Complete sale</button>
              </>
            )}
            <div className="pos-recent">
              <h3>Recent sales</h3>
              {recentSales.length === 0 ? <p className="blitz-admin-empty sm">No sales yet.</p> : recentSales.map(s => (
                <div className="pos-recent-row" key={s._id}>
                  <div><b>{money(s.total)}</b><span className="blitz-admin-muted"> · {s.paymentMethod} · {s.staff||""} · {new Date(s.createdAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span></div>
                  <button className="pos-void" onClick={() => voidSale(s._id)}>void</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {safeTab === "inventory" && (
        <div className="blitz-admin-body">
          <div className="blitz-admin-row-between"><h2>Inventory</h2><div style={{display:"flex",gap:6,flexWrap:"wrap"}}><button className="blitz-admin-btn small" onClick={exportInventoryExcel}>📊 Excel</button><button className="blitz-admin-btn small" onClick={() => { showForm ? resetForm() : setShowForm(true); }}>{showForm ? "✕ Cancel" : "➕ Add stock"}</button></div></div>
          {showForm && (
            <form className="blitz-admin-form" onSubmit={submitProduct}>
              <h3>{editingId ? "Edit item" : "Add new stock"}</h3>
              <div className="blitz-admin-grid">
                <label>Product name *<input value={form.name} onChange={e => setForm(s=>({...s,name:e.target.value}))} placeholder="e.g. Cooking Oil 1L" required /></label>
                <label>Category<input value={form.category} onChange={e => setForm(s=>({...s,category:e.target.value}))} placeholder="e.g. Cooking, Drinks" list="cats" /><datalist id="cats">{[...new Set(products.map(p=>p.category).filter(Boolean))].map(c=><option key={c} value={c}/>)}</datalist></label>
                <label>Barcode<input value={form.barcode} onChange={e => setForm(s=>({...s,barcode:e.target.value}))} placeholder="Scan or type" /></label>
                <label>Qty in stock<input type="number" value={form.stock} onChange={e => setForm(s=>({...s,stock:e.target.value}))} placeholder="e.g. 50" /></label>
                <label>Buying price (KES)<input type="number" step="0.01" value={form.buyingPrice} onChange={e => setForm(s=>({...s,buyingPrice:e.target.value}))} placeholder="What you paid" /></label>
                <label>Selling price (KES) *<input type="number" step="0.01" value={form.price} onChange={e => setForm(s=>({...s,price:e.target.value}))} placeholder="What customer pays" required /></label>
                <label>Expiry date (if any)<input type="date" value={form.expiryDate} onChange={e => setForm(s=>({...s,expiryDate:e.target.value}))} /></label>
              </div>
              {form.buyingPrice !== "" && form.price !== "" && <div className="blitz-admin-margin">Profit per item: <b>{money(parseFloat(form.price)-parseFloat(form.buyingPrice))}</b></div>}
              <label className="blitz-admin-full">Description<textarea value={form.description} onChange={e => setForm(s=>({...s,description:e.target.value}))} placeholder="Optional notes for customers" /></label>
              <label className="blitz-admin-full">Image<input type="file" accept="image/*" onChange={onImage} /></label>
              {form.image && <div className="blitz-admin-preview"><img src={form.image} alt="preview" /></div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="blitz-admin-btn" type="submit" style={{ flex: 1 }}>{editingId ? "Save changes" : "Add to inventory"}</button>
                {!editingId && (
                  <button className="blitz-admin-btn" type="button" onClick={submitProductAndNext} style={{ flex: 1, background: 'var(--orange)' }}>Next (Add & Keep Open)</button>
                )}
              </div>
            </form>
          )}
          <div className="blitz-admin-search"><span>🔍</span><input placeholder="Search name, barcode or category…" value={search} onChange={e => setSearch(e.target.value)} /></div>
          {filtered.length === 0 ? <p className="blitz-admin-empty">No items yet.</p> : (
            <div className="blitz-admin-list">{filtered.map(p => {
              const margin = (p.price||0)-(p.buyingPrice||0);
              return (
                <div className="blitz-admin-item" key={p._id}>
                  <div className="blitz-admin-thumb">{p.image ? <img src={p.image} alt={p.name}/> : "🛍️"}</div>
                  <div className="blitz-admin-item-main">
                    <div className="blitz-admin-item-top"><b>{p.name}</b>{stockTag(p.stock)}{expiryTag(p.expiryDate)}</div>
                    <div className="blitz-admin-item-sub"><span className="blitz-admin-cat">{p.category||"Other"}</span>{p.barcode && <span className="blitz-admin-bc">#{p.barcode}</span>}</div>
                    <div className="blitz-admin-item-prices"><span>Buy {money(p.buyingPrice||0)}</span><span>Sell {money(p.price||0)}</span><span className={margin>=0?"profit":"loss"}>Margin {money(margin)}</span></div>
                  </div>
                  <div className="blitz-admin-item-actions"><button onClick={() => editProduct(p)}>✏️</button><button onClick={() => delProduct(p._id)}>🗑️</button></div>
                </div>
              );
            })}</div>
          )}
        </div>
      )}

      {safeTab === "orders" && (
        <div className="blitz-admin-body"><h2>Orders</h2>
          {orders.length === 0 ? <p className="blitz-admin-empty">No orders yet</p> : (
            <div className="blitz-admin-list">{orders.map(o => (
              <div className="blitz-admin-order" key={o._id}>
                <div className="blitz-admin-order-top"><b>{o.customerName}</b><span className="blitz-admin-phone">{o.customerId}</span></div>
                <div className="blitz-admin-order-items">{o.items.map((it,k) => <p key={k}>{it.name} ×{it.quantity} — {money(it.price*it.quantity)}</p>)}</div>
                
                {/* Delivery details, maps link, and fee adjustments */}
                <div style={{marginTop: 8, padding: 8, background: 'var(--bg-2)', borderRadius: 8, fontSize: '.8rem', display: 'flex', flexDirection: 'column', gap: 6}}>
                  <div>📍 <b>Location:</b> {o.deliveryLocation || 'None (In-Store / Standard)'}</div>
                  {o.deliveryFee !== undefined && (
                    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                      <span>🚚 <b>Delivery Fee:</b> {money(o.deliveryFee)}</span>
                      <button 
                        className="blitz-admin-btn small" 
                        onClick={() => updateOrder(o._id, { deliveryFee: o.deliveryFee > 0 ? 0 : 150 })}
                        style={{padding: '2px 6px', fontSize: '.7rem', borderRadius: 4, cursor: 'pointer', background: 'var(--line)', color: 'var(--text)', border: '1px solid var(--muted)'}}
                      >
                        {o.deliveryFee > 0 ? 'Make Free' : 'Add Fee (KES 150)'}
                      </button>
                    </div>
                  )}
                  {o.gpsCoords && o.gpsCoords.lat && (
                    <div>
                      🗺️ <b>GPS Route:</b> <a href={`https://www.google.com/maps/search/?api=1&query=${o.gpsCoords.lat},${o.gpsCoords.lng}`} target="_blank" rel="noreferrer" style={{color: 'var(--gold)', textDecoration: 'underline', fontWeight: 'bold'}}>Google Maps Routing</a>
                    </div>
                  )}
                </div>

                <div className="blitz-admin-order-foot">
                  <div>
                    {o.discount > 0 && <small style={{color:'var(--green)',display:'block'}}>Discount: -{money(o.discount)}</small>}
                    <b>Total: {money(o.totalPrice)}</b>
                  </div>
                  <span className="blitz-admin-muted">{new Date(o.createdAt).toLocaleString()}</span>
                </div>
                <div style={{display:'flex',gap:6,alignItems:'center',marginTop:6}}>
                  <select value={o.status} onChange={e => updateOrder(o._id, { status: e.target.value })} style={{flex:1}}>
                    <option value="pending">⏳ Pending</option><option value="packed">📦 Packed</option><option value="on_the_way">🚚 On the way</option><option value="delivered">✅ Delivered</option>
                  </select>
                  {o.status === 'delivered' && o.customerId && (
                    <a className="cr-remind" href={waLink(o.customerId,
                      '⚡️ *BLITZ MALL - DELIVERY CONFIRMED* ⚡️\n' +
                      '━'.repeat(20) + '\n' +
                      '✅ Your order has been *delivered*!\n' +
                      '📅 ' + new Date().toLocaleString() + '\n' +
                      '━'.repeat(20) + '\n' +
                      (o.items||[]).map(it => '• ' + it.name + ' x' + (it.quantity||it.qty||1) + ' — KES ' + ((it.price||0)*(it.quantity||it.qty||1)).toLocaleString()).join('\n') + '\n' +
                      '━'.repeat(20) + '\n' +
                      '*💰 TOTAL: KES ' + (o.totalPrice||0).toLocaleString() + '*\n' +
                      '━'.repeat(20) + '\n' +
                      '🏪 Brilliant Shop\n' +
                      '🙏 Thank you for ordering with Blitz Mall!\n' +
                      '⭐ Please leave a review on the app!'
                    )} target="_blank" rel="noreferrer" style={{fontSize:'.75rem',whiteSpace:'nowrap'}}>📱 WhatsApp</a>
                  )}
                </div>
              </div>
            ))}</div>
          )}
        </div>
      )}

      {safeTab === "records" && (
        <div className="blitz-admin-body">
          <div className="blitz-admin-row-between"><h2>Records</h2><div style={{display:"flex",gap:6,flexWrap:"wrap"}}><button className="blitz-admin-btn small" onClick={loadSummary}>↻ Refresh</button><button className="blitz-admin-btn small" onClick={exportSalesPDF}>📄 PDF</button><button className="blitz-admin-btn small" onClick={exportBackup}>⬇ JSON</button></div></div>
          <div className="rec-periods">{Object.keys(periodLabel).map(k => <button key={k} className={period===k?"on":""} onClick={() => setPeriod(k)}>{periodLabel[k]}</button>)}</div>
          {!summary ? <p className="blitz-admin-empty">Loading…</p> : (
            <>
              <div className="rec-cards">
                <div className="rec-card"><span>Revenue</span><b>{money(P.revenue)}</b><small>{P.count} sales</small></div>
                <div className="rec-card"><span>Profit</span><b className="green">{money(P.profit)}</b><small>before expenses</small></div>
                <div className="rec-card"><span>Expenses</span><b className="red">{money(P.expenses)}</b><small>{periodLabel[period].toLowerCase()}</small></div>
                <div className="rec-card big"><span>Net profit</span><b className={P.net>=0?"green":"red"}>{money(P.net)}</b><small>profit − expenses</small></div>
              </div>
              {/* === CHARTS === */}
              {(() => {
                // Build period comparison data
                const periodKeys = ['today','week','month','year'];
                const periodNames = { today:'Today', week:'This Week', month:'This Month', year:'This Year' };
                const periodData = periodKeys.map(k => ({
                  name: periodNames[k],
                  Revenue: Math.round((summary.summary?.[k]?.revenue || 0)),
                  Profit: Math.round((summary.summary?.[k]?.profit || 0)),
                }));

                // Payment split data
                const payData = [
                  { name: 'Cash', value: P.cash || 0 },
                  { name: 'M-Pesa', value: P.mpesa || 0 },
                ];
                const PAY_COLORS = ['#36d399', '#ff7a1a'];

                // Best sellers chart data
                const bestData = (summary.best||[]).slice(0, 8).map(b => ({
                  name: b.name.length > 18 ? b.name.slice(0, 16) + '..' : b.name,
                  Sold: b.qty,
                }));

                const chartStyle = { background:'var(--card)', border:'1px solid var(--line)', borderRadius:16, padding:'18px', marginBottom:16 };
                const tooltipStyle = { background:'#16161b', border:'1px solid #26262e', borderRadius:8, color:'#f4f4f6', fontSize:'.8rem' };

                return (
                  <>
                    {/* Period comparison bar chart */}
                    <div style={chartStyle}>
                      <h3 style={{fontSize:'.95rem',marginBottom:12}}>📈 Revenue vs Profit by Period</h3>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={periodData}>
                          <XAxis dataKey="name" tick={{fill:'#8a8a96',fontSize:11}} axisLine={{stroke:'#26262e'}} tickLine={false} />
                          <YAxis tick={{fill:'#8a8a96',fontSize:11}} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v) => 'KES ' + v.toLocaleString()} />
                          <Bar dataKey="Revenue" fill="#ffd24a" radius={[4,4,0,0]} maxBarSize={40} />
                          <Bar dataKey="Profit" fill="#36d399" radius={[4,4,0,0]} maxBarSize={40} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Payment split + Best sellers side by side */}
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
                      {/* Cash vs M-Pesa pie */}
                      <div style={{...chartStyle,marginBottom:0}}>
                        <h3 style={{fontSize:'.95rem',marginBottom:12}}>💳 Payment Split</h3>
                        {P.cash + P.mpesa > 0 ? (
                          <ResponsiveContainer width="100%" height={160}>
                            <PieChart>
                              <Pie data={payData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={4} dataKey="value">
                                {payData.map((e, i) => <Cell key={e.name} fill={PAY_COLORS[i]} />)}
                              </Pie>
                              <Tooltip contentStyle={tooltipStyle} formatter={(v) => 'KES ' + (Math.round(v*100)/100).toLocaleString()} />
                            </PieChart>
                          </ResponsiveContainer>
                        ) : <p className="blitz-admin-empty sm">No data</p>}
                        <div style={{display:'flex',justifyContent:'center',gap:16,marginTop:8,fontSize:'.78rem'}}>
                          <span><span style={{color:'#36d399'}}>●</span> Cash {money(P.cash)}</span>
                          <span><span style={{color:'#ff7a1a'}}>●</span> M-Pesa {money(P.mpesa)}</span>
                        </div>
                      </div>

                      {/* Best sellers bar chart */}
                      <div style={{...chartStyle,marginBottom:0}}>
                        <h3 style={{fontSize:'.95rem',marginBottom:12}}>🔥 Best Sellers</h3>
                        {bestData.length > 0 ? (
                          <ResponsiveContainer width="100%" height={160}>
                            <BarChart data={bestData} layout="vertical">
                              <XAxis type="number" tick={{fill:'#8a8a96',fontSize:10}} axisLine={false} tickLine={false} />
                              <YAxis type="category" dataKey="name" tick={{fill:'#f4f4f6',fontSize:10}} axisLine={false} tickLine={false} width={80} />
                              <Tooltip contentStyle={tooltipStyle} formatter={(v) => v + ' sold'} />
                              <Bar dataKey="Sold" fill="#ff7a1a" radius={[0,4,4,0]} maxBarSize={24} />
                            </BarChart>
                          </ResponsiveContainer>
                        ) : <p className="blitz-admin-empty sm">No sales yet.</p>}
                      </div>
                    </div>

                    {/* AI Predictions */}
                    {predictions && (
                      <div style={chartStyle}>
                        <h3 style={{fontSize:'.95rem',marginBottom:12}}>🧠 AI Predictions</h3>
                        {predictions.forecast && predictions.forecast.avgDaily > 0 && (
                          <div style={{background:'var(--bg-2)',borderRadius:12,padding:'14px',marginBottom:12}}>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                              <span style={{fontSize:'.85rem',color:'var(--muted)'}}>📈 7-Day Sales Forecast</span>
                              <b style={{color:'var(--gold)',fontSize:'1.1rem'}}>{money(predictions.forecast.next7Days)}</b>
                            </div>
                            <div style={{fontSize:'.8rem',color:'var(--muted)'}}>Avg daily: {money(predictions.forecast.avgDaily)} · Based on {predictions.forecast.dataPoints} days of data</div>
                          </div>
                        )}
                        {predictions.restock && predictions.restock.length > 0 && (
                          <>
                            <h4 style={{fontSize:'.85rem',color:'var(--orange)',marginBottom:8}}>⚠ Re-stock Alerts</h4>
                            <div style={{display:'flex',flexDirection:'column',gap:6}}>
                              {predictions.restock.slice(0, 10).map((r, i) => (
                                <div className="rec-line" key={i}>
                                  <span>{r.name}</span>
                                  <span>
                                    <b className={r.priority === 'critical' || r.priority === 'high' ? 'red' : 'gold'}>
                                      {r.priority === 'critical' ? 'OUT' : r.priority === 'high' ? Math.round(r.daysLeft)+'d' : Math.round(r.daysLeft)+'d left'}
                                    </b>
                                    <span className="blitz-admin-muted" style={{marginLeft:6,fontSize:'.75rem'}}>(stock: {r.currentStock}, rate: {r.dailyRate}/day)</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                        {predictions.slowMoving && predictions.slowMoving.length > 0 && (
                          <>
                            <h4 style={{fontSize:'.85rem',color:'var(--muted)',marginTop:12,marginBottom:8}}>🐢 Slow-Moving Products</h4>
                            <div style={{display:'flex',flexDirection:'column',gap:6}}>
                              {predictions.slowMoving.slice(0, 8).map((r, i) => (
                                <div className="rec-line" key={i}>
                                  <span>{r.name}</span>
                                  <span className="blitz-admin-muted">{r.currentStock} in stock · ~{r.monthlyRate}/month</span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                        {(!predictions.forecast || predictions.forecast.avgDaily <= 0) && (!predictions.restock || predictions.restock.length === 0) && (!predictions.slowMoving || predictions.slowMoving.length === 0) && (
                          <p className="blitz-admin-empty sm">Not enough sales data yet. Keep selling!</p>
                        )}
                      </div>
                    )}

                    {/* Alerts panel */}
                    <div style={chartStyle}>
                      <h3 style={{fontSize:'.95rem',marginBottom:12}}>⚠ Alerts</h3>
                      {[...(summary.expired||[]),...(summary.out||[]),...(summary.expiringSoon||[]),...(summary.low||[])].length === 0 ? <p className="blitz-admin-empty sm">All good.</p> : (
                        <div style={{display:'flex',flexDirection:'column',gap:6}}>
                          {(summary.expired||[]).map(p => <div className="rec-line" key={p.name}><span>{p.name}</span><b className="red">Expired {fmt(p.expiryDate)}</b></div>)}
                          {(summary.out||[]).map(p => <div className="rec-line" key={p.name}><span>{p.name}</span><b className="red">Out of stock</b></div>)}
                          {(summary.expiringSoon||[]).map(p => <div className="rec-line" key={p.name}><span>{p.name}</span><b className="gold">Exp {fmt(p.expiryDate)}</b></div>)}
                          {(summary.low||[]).map(p => <div className="rec-line" key={p.name}><span>{p.name}</span><b className="gold">Low: {p.stock}</b></div>)}
                        </div>
                      )}
                    </div>

                    {/* KRA Tax Estimator panel */}
                    <div style={chartStyle}>
                      <h3 style={{fontSize:'.95rem',marginBottom:12}}>🇰🇪 KRA Tax Estimator ({periodLabel[period]})</h3>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,flexWrap:'wrap'}}>
                        <div style={{background:'var(--bg-2)',padding:12,borderRadius:10,border:'1px solid var(--line)'}}>
                          <h4 style={{fontSize:'.85rem',color:'var(--gold)',marginBottom:8}}>Turnover Tax (TOT) <small style={{fontSize:'.7rem',color:'var(--muted)'}}>Gross &lt; 25M KES/yr</small></h4>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4,fontSize:'.8rem'}}>
                            <span>Gross Turnover:</span>
                            <b>{money(P.revenue)}</b>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',fontSize:'.8rem',color:'var(--accent)'}}>
                            <span>TOT Rate:</span>
                            <b>3%</b>
                          </div>
                          <hr style={{border:'0',borderTop:'1px solid var(--line)',margin:'8px 0'}} />
                          <div style={{display:'flex',justifyContent:'space-between',fontSize:'.85rem',fontWeight:'bold'}}>
                            <span>TOT Payable:</span>
                            <span style={{color:'var(--orange)'}}>{money(P.revenue * 0.03)}</span>
                          </div>
                        </div>

                        <div style={{background:'var(--bg-2)',padding:12,borderRadius:10,border:'1px solid var(--line)'}}>
                          <h4 style={{fontSize:'.85rem',color:'var(--gold)',marginBottom:8}}>Standard VAT (16%) <small style={{fontSize:'.7rem',color:'var(--muted)'}}>VAT Inclusive</small></h4>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4,fontSize:'.78rem'}}>
                            <span>Output VAT (16% of sales):</span>
                            <b>{money(P.revenue * 16 / 116)}</b>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4,fontSize:'.78rem'}}>
                            <span>Estimated COGS:</span>
                            <b>{money(P.revenue - P.profit)}</b>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4,fontSize:'.78rem'}}>
                            <span>Input VAT (16% of COGS):</span>
                            <b>{money((P.revenue - P.profit) * 16 / 116)}</b>
                          </div>
                          <hr style={{border:'0',borderTop:'1px solid var(--line)',margin:'8px 0'}} />
                          <div style={{display:'flex',justifyContent:'space-between',fontSize:'.85rem',fontWeight:'bold'}}>
                            <span>Net VAT Liability:</span>
                            <span style={{color: (P.revenue * 16 / 116) - ((P.revenue - P.profit) * 16 / 116) >= 0 ? 'var(--red)' : 'var(--green)'}}>
                              {money((P.revenue * 16 / 116) - ((P.revenue - P.profit) * 16 / 116))}
                            </span>
                          </div>
                        </div>
                      </div>
                      <p style={{fontSize:'.7rem',color:'var(--muted)',marginTop:10,fontStyle:'italic'}}>
                        *Disclaimer: This is an estimate based on recorded POS transactions for the selected period. Consult a certified KRA tax agent for official filing.
                      </p>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}

      {safeTab === "expenses" && (
        <div className="blitz-admin-body"><div className="blitz-admin-row-between"><h2>Expenses</h2><button className="blitz-admin-btn small" onClick={exportExpensesExcel}>📊 Excel</button></div>
          {summary?.summary?.today && <div className="exp-summary">Today: <b className="red">{money(summary.summary.today.expenses)}</b> · This month: <b className="red">{money(summary.summary.month?.expenses || 0)}</b></div>}
          <form className="exp-form" onSubmit={addExpense}><input value={expDesc} onChange={e => setExpDesc(e.target.value)} placeholder="What for? e.g. Transport, Rent" required /><input type="number" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="Amount KES" required /><button className="blitz-admin-btn small" type="submit">Add</button></form>
          {expenses.length === 0 ? <p className="blitz-admin-empty">No expenses yet.</p> : <div className="blitz-admin-list">{expenses.map(x => <div className="exp-row" key={x._id}><div><b>{x.description}</b><span className="blitz-admin-muted"> · {new Date(x.createdAt).toLocaleDateString()}</span></div><div className="exp-right"><b className="red">{money(x.amount)}</b><button className="pos-void" onClick={() => delExpense(x._id)}>delete</button></div></div>)}</div>}
        </div>
      )}

      {safeTab === "credit" && (() => {
        const unpaid = credit.filter(c => !c.paid); const paid = credit.filter(c => c.paid);
        const owed = unpaid.reduce((s,c) => s + (c.amount||0), 0);
        return (
          <div className="blitz-admin-body">
            <div className="blitz-admin-row-between"><h2>Credit (Madeni)</h2><div className="cr-owed">Outstanding: <b>{money(owed)}</b></div></div>
            <form className="cr-form" onSubmit={addCredit}>
              <input value={crName} onChange={e => setCrName(e.target.value)} placeholder="Customer name" required />
              <input value={crPhone} onChange={e => setCrPhone(e.target.value)} placeholder="Phone (07…)" />
              <input type="number" step="0.01" value={crAmount} onChange={e => setCrAmount(e.target.value)} placeholder="Amount KES" required />
              <input value={crNote} onChange={e => setCrNote(e.target.value)} placeholder="For what? (optional)" />
              <button className="blitz-admin-btn small" type="submit">Add debt</button>
            </form>
            {unpaid.length === 0 ? <p className="blitz-admin-empty">No one owes you. 🎉</p> : <div className="blitz-admin-list">{unpaid.map(c => <div className="cr-row" key={c._id}><div className="cr-info"><b>{c.customerName}</b>{c.note && <span className="blitz-admin-muted">{c.note}</span>}<span className="cr-date">since {new Date(c.createdAt).toLocaleDateString()}{c.phone ? " · " + c.phone : ""}</span></div><div className="cr-amt">{money(c.amount)}</div><div className="cr-actions">{c.phone && <a className="cr-remind" href={waLink(c.phone,"Hi " + c.customerName + ", friendly reminder you have a balance of " + money(c.amount) + " at Brilliant. Asante!")} target="_blank" rel="noreferrer">Remind</a>}<button className="cr-paid" onClick={() => payCredit(c._id)}>Mark paid</button><button className="pos-void" onClick={() => delCredit(c._id)}>delete</button></div></div>)}</div>}
            {paid.length > 0 && <div className="cr-paidwrap"><button className="cr-toggle" onClick={() => setCrShowPaid(s=>!s)}>{crShowPaid?"Hide":"Show"} cleared ({paid.length})</button>{crShowPaid && <div className="blitz-admin-list">{paid.map(c => <div className="cr-row cleared" key={c._id}><div className="cr-info"><b>{c.customerName}</b><span className="cr-date">paid {c.paidAt ? new Date(c.paidAt).toLocaleDateString() : ""}</span></div><div className="cr-amt">{money(c.amount)}</div><div className="cr-actions"><button className="pos-void" onClick={() => delCredit(c._id)}>delete</button></div></div>)}</div>}</div>}
          </div>
        );
      })()}

      {safeTab === "reviews" && (() => {
        const count = reviews.length; const avg = count ? reviews.reduce((s,r) => s+(r.rating||0),0)/count : 0; const complaints = reviews.filter(r => r.rating<=2).length;
        return (
          <div className="blitz-admin-body"><h2>Reviews</h2>
            <div className="rv-head"><div className="rv-avg"><b>{avg.toFixed(1)}</b><span className="rv-stars">{stars(Math.round(avg))}</span><small>{count} review{count!==1?"s":""}</small></div>{complaints > 0 && <div className="rv-complaints">⚠ {complaints} complaint{complaints!==1?"s":""} (1–2 stars)</div>}</div>
            {count === 0 ? <p className="blitz-admin-empty">No reviews yet.</p> : <div className="blitz-admin-list">{reviews.map(r => <div className={"rv-row" + (r.rating<=2?" bad":"")} key={r._id}><div className="rv-info"><div className="rv-top"><span className="rv-stars">{stars(r.rating)}</span><b>{r.customerName}</b></div>{r.message && <p className="rv-msg">{r.message}</p>}<span className="cr-date">{new Date(r.createdAt).toLocaleDateString()}</span></div><button className="pos-void" onClick={() => delReview(r._id)}>delete</button></div>)}</div>}
          </div>
        );
      })()}

      {safeTab === "loyalty" && (
        <div className="blitz-admin-body">
          <h2>🎁 Loyalty & Rewards</h2>
          <p className="blitz-admin-muted" style={{marginBottom:16}}>Customers earn 1 point per KES 100 spent. 100 points = KES 500 cashback. Tiers: Bronze (0), Silver (25K+), Gold (100K+), Platinum (500K+).</p>

          {/* Customer Lookup */}
          <div style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',marginBottom:16}}>
            <h3 style={{fontSize:'.95rem',marginBottom:10}}>🔍 Lookup Customer</h3>
            <div className="exp-form" style={{display:'flex',gap:8}}>
              <input type="tel" value={loyaltyPhone} onChange={e => setLoyaltyPhone(e.target.value)} placeholder="Enter phone number" style={{flex:1}} />
              <button className="blitz-admin-btn small" onClick={lookupLoyalty}>Search</button>
            </div>
            {loyaltyData && (
              loyaltyData.exists ? (
                <div style={{marginTop:12,padding:'12px',background:'var(--bg-2)',borderRadius:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <b style={{fontSize:'1.1rem'}}>{loyaltyData.customerName || 'Customer'}</b>
                      <span style={{display:'inline-block',marginLeft:8,padding:'2px 8px',borderRadius:6,fontSize:'.75rem',background:
                        loyaltyData.tier === 'Platinum' ? 'linear-gradient(135deg,#e2d7a8,#b8a76a)' :
                        loyaltyData.tier === 'Gold' ? 'linear-gradient(135deg,#ffd24a,#ff7a1a)' :
                        loyaltyData.tier === 'Silver' ? 'linear-gradient(135deg,#c0c0c0,#8a8a96)' :
                        'linear-gradient(135deg,#cd7f32,#a0522d)',
                        color: loyaltyData.tier === 'Platinum' ? '#000' : '#fff'
                      }}>{loyaltyData.tier}</span>
                    </div>
                    <b style={{fontSize:'1.3rem',color:'var(--gold)'}}>{loyaltyData.points} pts</b>
                  </div>
                  <div style={{marginTop:8,fontSize:'.85rem',color:'var(--muted)'}}>Total spent: {money(loyaltyData.totalSpent)}</div>
                  <div style={{marginTop:8,fontSize:'.85rem'}}>Cashback value: <b style={{color:'var(--green)'}}>{money(loyaltyData.points * 5)}</b></div>
                  <button className="blitz-admin-btn small" style={{marginTop:10}} onClick={redeemPoints}>🎯 Redeem Points</button>
                </div>
              ) : (
                <p className="blitz-admin-muted" style={{marginTop:8}}>{loyaltyData.message}</p>
              )
            )}
          </div>

          {/* Coupon Management */}
          <div style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',marginBottom:16}}>
            <h3 style={{fontSize:'.95rem',marginBottom:10}}>🏷️ Create Coupon</h3>
            <form onSubmit={createCoupon} style={{display:'flex',flexDirection:'column',gap:8}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <input value={couponCode} onChange={e => setCouponCode(e.target.value)} placeholder="Coupon code e.g. SAVE10" required />
                <select value={couponType} onChange={e => setCouponType(e.target.value)} style={{background:'var(--bg-2)',color:'var(--text)',border:'1px solid var(--line)',borderRadius:10,padding:'10px'}}>
                  <option value="percent">% Discount</option>
                  <option value="fixed">Fixed KES</option>
                </select>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                <input type="number" value={couponValue} onChange={e => setCouponValue(e.target.value)} placeholder={couponType==='percent'?'% off e.g. 10':'KES off e.g. 500'} required />
                <input type="number" value={couponMin} onChange={e => setCouponMin(e.target.value)} placeholder="Min purchase" />
                <input type="number" value={couponMaxUses} onChange={e => setCouponMaxUses(e.target.value)} placeholder="Max uses" />
              </div>
              <input type="date" value={couponExpiry} onChange={e => setCouponExpiry(e.target.value)} placeholder="Expiry date" />
              <button className="blitz-admin-btn small" type="submit">Create Coupon</button>
            </form>
            {coupons.length > 0 && (
              <div style={{marginTop:12}}>
                <h4 style={{fontSize:'.85rem',color:'var(--muted)',marginBottom:8}}>Existing coupons</h4>
                <div className="blitz-admin-list">
                  {coupons.map(c => {
                    const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
                    return (
                      <div className="exp-row" key={c._id} style={{opacity:c.active&&!expired?1:.4}}>
                        <div>
                          <b style={{color:'var(--gold)'}}>{c.code}</b>
                          <span className="blitz-admin-muted"> · {c.type==='percent'?c.value+'% off':'KES '+c.value+' off'}{c.minPurchase>0?' · min KES '+c.minPurchase:''}{c.maxUses>0?' · used '+c.usedCount+'/'+c.maxUses:''}{expired?' · EXPIRED':''}</span>
                        </div>
                        <div style={{display:'flex',gap:6}}>
                          <button className="blitz-admin-btn small" onClick={() => toggleCoupon(c._id, c.active)} style={{fontSize:'.75rem'}}>{c.active ? 'Disable' : 'Enable'}</button>
                          <button className="pos-void" onClick={() => delCoupon(c._id)}>delete</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Top Members */}
          {loyaltyMembers.length > 0 && (
            <div style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',marginBottom:16}}>
              <h3 style={{fontSize:'.95rem',marginBottom:10}}>🏆 Top Loyalty Members</h3>
              <div className="blitz-admin-list">
                {loyaltyMembers.slice(0, 20).map((m, i) => (
                  <div className="exp-row" key={m._id}>
                    <div>
                      <span style={{color:'var(--gold)',marginRight:8}}>#{i+1}</span>
                      <b>{m.customerName || m.phone}</b>
                      <span className="blitz-admin-muted"> · {m.phone}</span>
                    </div>
                    <div style={{display:'flex',gap:10,alignItems:'center'}}>
                      <span style={{
                        padding:'2px 8px',borderRadius:6,fontSize:'.7rem',
                        background: m.tier === 'Platinum' ? 'linear-gradient(135deg,#e2d7a8,#b8a76a)' :
                                   m.tier === 'Gold' ? 'linear-gradient(135deg,#ffd24a,#ff7a1a)' :
                                   m.tier === 'Silver' ? 'linear-gradient(135deg,#c0c0c0,#8a8a96)' :
                                   'linear-gradient(135deg,#cd7f32,#a0522d)',
                        color: m.tier === 'Platinum' ? '#000' : '#fff'
                      }}>{m.tier}</span>
                      <b style={{color:'var(--gold)',fontSize:'.85rem'}}>{m.points} pts</b>
                      <span className="blitz-admin-muted">{money(m.totalSpent)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {safeTab === "branches" && user?.role === 'owner' && (
        <div className="blitz-admin-body">
          <h2>🏪 Branches</h2>
          <p className="blitz-admin-muted" style={{marginBottom:16}}>Manage your shop branches. Staff assigned to a branch will only see that branch's data.</p>
          <form className="exp-form" onSubmit={async (e) => {
            e.preventDefault();
            if (!branchForm.name.trim()) return;
            try {
              const r = await authPost(API_URL + '/admin/branches', branchForm);
              if ((await r.json()).success) { setBranchForm({ name:'', location:'', phone:'', email:'' }); loadBranches(); }
            } catch (e) { console.error(e); }
          }}>
            <input value={branchForm.name} onChange={e => setBranchForm(f=>({...f,name:e.target.value}))} placeholder="Branch name e.g. Westlands" required />
            <input value={branchForm.location} onChange={e => setBranchForm(f=>({...f,location:e.target.value}))} placeholder="Location e.g. Nairobi" />
            <input value={branchForm.phone} onChange={e => setBranchForm(f=>({...f,phone:e.target.value}))} placeholder="Phone" />
            <button className="blitz-admin-btn small" type="submit">➕ Add Branch</button>
          </form>
          {branches.length === 0 ? <p className="blitz-admin-empty">No branches yet. Add your first branch.</p> : (
            <div className="blitz-admin-list">
              {branches.map(b => (
                <div className="exp-row" key={b._id}>
                  <div style={{flex:1}}>
                    <b>{b.name}</b>
                    <span className="blitz-admin-muted"> · {b.location||'No location'}{b.phone?' · '+b.phone:''}</span>
                  </div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}>
                    <span style={{padding:'2px 8px',borderRadius:6,fontSize:'.7rem',background:b.active?'rgba(54,211,153,.15)':'rgba(255,45,45,.15)',color:b.active?'var(--green)':'var(--red)'}}>{b.active?'Active':'Inactive'}</span>
                    <button className="pos-void" onClick={async () => {
                      if (!window.confirm('Delete branch ' + b.name + '?')) return;
                      try { await authDelete(API_URL + '/admin/branches/' + b._id); loadBranches(); }
                      catch (e) { console.error(e); }
                    }}>delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {safeTab === "staff" && (
        <div className="blitz-admin-body">
          <h2>Staff & Cashiers</h2>

          {/* Non-login cashier names for POS selector */}
          <div style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',marginBottom:16}}>
            <h3 style={{fontSize:'.95rem',marginBottom:10}}>👤 Cashier Names (POS Selector)</h3>
            <p className="blitz-admin-muted" style={{marginBottom:10,fontSize:'.8rem'}}>Add cashier names here for the Sell tab cashier dropdown. No login needed.</p>
            <form className="exp-form" onSubmit={addStaff} style={{marginBottom:12}}><input value={newStaffName} onChange={e => setNewStaffName(e.target.value)} placeholder="Staff name e.g. Jane" required /><button className="blitz-admin-btn small" type="submit">Add</button></form>
            {staffList.length === 0 ? <p className="blitz-admin-empty">No cashier names added.</p> : <div className="blitz-admin-list">{staffList.map(s => <div className="exp-row" key={s._id}><div><b>{s.name}</b><span className="blitz-admin-muted"> · {s.role||"Cashier"} · Added {new Date(s.createdAt).toLocaleDateString()}</span></div><button className="pos-void" onClick={() => delStaff(s._id)}>remove</button></div>)}</div>}
          </div>

          {/* Secure login accounts (owner only) */}
          {user?.role === 'owner' && (
            <div style={{background:'var(--card)',border:'1px solid var(--line)',borderRadius:16,padding:'16px',marginBottom:16}}>
              <h3 style={{fontSize:'.95rem',marginBottom:10}}>🔐 Secure Staff Logins</h3>
              <p className="blitz-admin-muted" style={{marginBottom:10,fontSize:'.8rem'}}>Create login accounts for staff. Each user gets role-based access and can sign in at the HQ login screen. <b>Managers</b> can manage inventory/orders. <b>Cashiers</b> can only use the Sell tab and see their assigned branch data.</p>
              <form onSubmit={createUser} style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="Username" required />
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Password (min 6 chars)" minLength={6} required />
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                  <input value={newUserName} onChange={e => setNewUserName(e.target.value)} placeholder="Full name (optional)" />
                  <select value={newUserRole} onChange={e => setNewUserRole(e.target.value)} style={{background:'var(--bg-2)',color:'var(--text)',border:'1px solid var(--line)',borderRadius:10,padding:'10px',fontFamily:'inherit'}}>
                    <option value="cashier">Cashier</option>
                    <option value="staff">Staff</option>
                    <option value="manager">Manager</option>
                  </select>
                  <select value={newUserBranch} onChange={e => setNewUserBranch(e.target.value)} style={{background:'var(--bg-2)',color:'var(--text)',border:'1px solid var(--line)',borderRadius:10,padding:'10px',fontFamily:'inherit'}}>
                    <option value="">All branches</option>
                    {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
                  </select>
                </div>
                <button className="blitz-admin-btn small" type="submit">👤 Create {newUserRole === 'cashier' ? 'Cashier' : newUserRole === 'staff' ? 'Staff' : 'Manager'} Login</button>
              </form>
              {users.length === 0 ? <p className="blitz-admin-empty">No staff logins yet.</p> : (
                <div className="blitz-admin-list">
                  {users.map(u => {
                    const branchName = branches.find(b => b._id === u.branchId)?.name;
                    return (
                      <div className="exp-row" key={u._id}>
                        <div>
                          <b>{u.name || u.username}</b>
                          <span className="blitz-admin-muted"> · @{u.username} · {u.role}{branchName ? ' · ' + branchName : ''} · Created {new Date(u.createdAt).toLocaleDateString()}</span>
                        </div>
                        <button className="pos-void" onClick={() => delUser(u._id)}>delete</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Admin;
