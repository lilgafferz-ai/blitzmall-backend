// Online product-photo finder.

// ---- Online image search via DuckDuckGo (real product photos, no API key needed) ----
async function searchDuckDuckGoImages(query, maxResults = 10) {
  const results = [];
  try {
    // Step 1: Get vqd token from DuckDuckGo's image search page
    const htmlRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await htmlRes.text();
    const vqdMatch = html.match(/vqd=([\w-]+)/);
    if (!vqdMatch) return results;
    const vqd = vqdMatch[1];

    // Step 2: Fetch image results using the vqd token
    const imgRes = await fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${vqd}&o=json&f=,,,&p=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const data = await imgRes.json();

    if (data.results && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (r.image) results.push(r.image);
        if (results.length >= maxResults) break;
      }
    }
  } catch (e) {
    console.error('DuckDuckGo image search failed:', e.message);
  }
  return results;
}

// ---- 4K / full-resolution product image upgrade (PC & desktop web only) ----
// Image sources hand out thumbnails as small as 600px. Rewriting known
// thumbnail URL patterns to their full-resolution original makes product
// photos crisp for customers on the shop PC and desktop browsers. The phone
// app deliberately keeps URLs exactly as stored — this feature is PC-only.
const upgradeImageUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  // Wikimedia Commons: .../thumb/a/ab/Foo.jpg/600px-Foo.jpg -> .../a/ab/Foo.jpg
  // (the original, full-resolution file — often 4K+). Only keep the rewrite
  // when the result is a real image file — a PDF-derived thumb would upgrade
  // to a .pdf URL that can't render in an <img>.
  const upgraded = url.replace(/\/thumb\/([^/]+\/[^/]+\/[^/]+)\/\d+px-[^/]+$/i, '/$1');
  return /\.(jpe?g|png|webp|gif|avif)$/i.test(upgraded) ? upgraded : url;
};
const isMobileUA = (ua) => /Mobile|Android|iP(hone|od|ad)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/i.test(ua || '');
// Hosts whose full-size image files are safe to hotlink from the customer app.
const SAFE_IMAGE_HOSTS = /^https?:\/\/(upload\.wikimedia\.org|images\.(openfoodfacts|openbeautyfacts|openproductsfacts|openpetfoodfacts)\.org)/i;
const upgradeImagesForClient = (list, isMobile) => {
  if (isMobile) return list; // mobile keeps stored URLs — feature is PC-only
  return (Array.isArray(list) ? list : []).map(p => {
    if (!p || !p.image) return p;
    const arr = Array.isArray(p.image) ? p.image : [p.image];
    const upgraded = arr.map(upgradeImageUrl);
    return { ...p, image: Array.isArray(p.image) ? upgraded : upgraded[0] };
  });
};

// ---- Shared image search pipeline: OpenFoodFacts → DuckDuckGo → AI fallback ----
// Returns up to 3 image URLs. Used by both the API endpoint and autoFetchProductImage.
// Finds REAL photos BY NAME, only returning a photo when the product's own details
// (brand, product, size) match the words typed — so the picture and the typed
// description line up. Barcode is a fallback only. No AI / no random web images.
async function searchProductImages(name, barcode) {
  const images = [];
  const addImg = (url) => {
    const clean = upgradeImageUrl(url);
    if (clean && typeof clean === 'string' && !clean.startsWith('data:') && !images.includes(clean)) images.push(clean);
  };
  // fetch with a timeout so a slow source can't hang the finder
  const fetchT = (url, ms = 7000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { headers: { 'User-Agent': 'BlitzMall/1.0' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };
  // Normalise text and glue sizes together ("500 ml" -> "500ml") for matching.
  const STOP = new Set(['the','and','for','with','of','a','an','x','pack','pcs','pc','ml','l','g','kg']);
  const norm = (s) => (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/(\d)\s+(ml|l|g|kg|cl|mg|kgs|pcs)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim();

  // Open Facts family (food, drinks, beauty, household, pet) — real product
  // photos with a searchable catalogue, no API key.
  const FACTS = [
    'https://world.openfoodfacts.org',
    'https://world.openbeautyfacts.org',
    'https://world.openproductsfacts.org',
    'https://world.openpetfoodfacts.org',
  ];

  const qWords = norm(name).split(' ').filter(w => w.length >= 2 && !STOP.has(w));
  const sizeWords = qWords.filter(w => /\d/.test(w));   // 500ml, 1l, 250g …
  const textWords = qWords.filter(w => !/\d/.test(w));  // brand / product words

  // NAME — the primary, strict path. Query EVERY free, no-key image source in
  // parallel, then keep only results whose own text contains the words you typed,
  // so the chosen photo matches your description. Best match first.
  if (qWords.length) {
    // Search by brand/product words (size terms make searches miss); size is
    // still scored below for ranking.
    const searchTerms = textWords.length ? textWords.join(' ') : (name || '').trim();
    const need = Math.max(1, Math.ceil(textWords.length * 0.6)); // a majority of brand/product words must match
    const q = encodeURIComponent(searchTerms);

    // Each source yields { url, text, bonus }. `text` is what we match against;
    // `bonus` prioritises real product packshots (Open Facts) over generic images.
    const sources = [
      // Google Custom Search images — broadest coverage, finds almost anything.
      // Only active when GOOGLE_API_KEY + GOOGLE_CSE_ID env vars are set.
      ...((process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) ? [(async () => {
        try {
          const r = await fetchT(`https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&searchType=image&imgType=photo&num=8&q=${encodeURIComponent((name || '').trim())}`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.items || []).map(it => ({ url: it.link, text: `${it.title || ''} ${it.snippet || ''}`, bonus: 5 })).filter(c => c.url);
        } catch (e) { return []; }
      })()] : []),
      // Open Facts family — real product packshots
      ...FACTS.map((base) => (async () => {
        try {
          const r = await fetchT(`${base}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&fields=product_name,brands,quantity,image_front_url`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.products || []).filter(p => p.image_front_url).map(p => ({
            url: p.image_front_url,
            text: `${p.product_name || ''} ${p.brands || ''} ${p.quantity || ''}`,
            bonus: 6,
          }));
        } catch (e) { return []; }
      })()),
      // Wikimedia Commons — free, no key
      (async () => {
        try {
          const r = await fetchT(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=15&prop=imageinfo&iiprop=url&iiurlwidth=2560&format=json&origin=*`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          const pages = d.query && d.query.pages ? Object.values(d.query.pages) : [];
          return pages.map(p => ({
            url: p.imageinfo && p.imageinfo[0] && (p.imageinfo[0].thumburl || p.imageinfo[0].url),
            text: (p.title || '').replace(/^File:/i, '').replace(/\.\w+$/, ''),
            bonus: 1,
          })).filter(c => c.url && /\.(jpe?g|png|webp)$/i.test(c.url));
        } catch (e) { return []; }
      })(),    // Openverse — aggregates Flickr, Wikimedia, museums and more (free, no key).
    // Prefer the full-size original only from hotlink-safe hosts (Wikimedia /
    // Open Facts CDNs); elsewhere the proxied /thumb/ URL is far more reliable
    // than a third-party origin that may 403 when the customer's app loads it.
    (async () => {
        try {
          const r = await fetchT(`https://api.openverse.org/v1/images/?q=${q}&page_size=15&mature=false`, 9000);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.results || []).map(x => ({
            url: (x.url && SAFE_IMAGE_HOSTS.test(x.url)) ? x.url : (x.thumbnail || x.url),
            text: `${x.title || ''} ${(x.tags || []).map(t => t.name).join(' ')}`,
            bonus: 0,
          })).filter(c => c.url);
        } catch (e) { return []; }
      })(),
    ];

    const all = (await Promise.all(sources)).flat();
    const scored = [];
    for (const c of all) {
      const text = norm(c.text);
      if (!text) continue;
      const tm = textWords.filter(w => text.includes(w)).length;
      const sm = sizeWords.filter(w => text.includes(w)).length;
      let score;
      if (textWords.length) {
        if (tm < need) continue;          // not enough of your words match — reject
        score = tm * 2 + sm + (c.bonus || 0);
      } else {
        if (sm === 0) continue;
        score = sm + (c.bonus || 0);
      }
      scored.push({ url: c.url, score });
    }
    scored.sort((a, b) => b.score - a.score).forEach(c => { if (images.length < 3) addImg(c.url); });
  }

  // BARCODE — fallback only: if a code happens to be present and the name found
  // nothing, look it up (an exact, guaranteed-correct match).
  if (images.length === 0 && barcode && barcode.trim()) {
    const bc = barcode.trim();
    for (const base of FACTS) {
      if (images.length >= 3) break;
      try {
        const r = await fetchT(`${base}/api/v0/product/${bc}.json`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d.status === 1 && d.product) { addImg(d.product.image_front_url); addImg(d.product.image_url); }
      } catch (e) {}
    }
  }

  // Only photos whose details match what you typed — accuracy over quantity
  // (returns nothing rather than a wrong picture; then you upload manually).
  return images.slice(0, 3);
}

// ---- Auto-fetch images when adding a product (used internally) ----
async function autoFetchProductImage(name, barcode) {
  try {
    return await searchProductImages(name, barcode);
  } catch (e) {
    console.error('autoFetchProductImage failed:', e.message);
    return []; // no fake/AI images — real photos only
  }
}

module.exports = { searchDuckDuckGoImages, upgradeImageUrl, isMobileUA, SAFE_IMAGE_HOSTS, upgradeImagesForClient, searchProductImages, autoFetchProductImage };
