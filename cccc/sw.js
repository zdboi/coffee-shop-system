/* Service worker: lets the counter (Front Office) open and run with no internet.
   Strategy: network first (so updates arrive right away), fall back to the saved copy.
   Supabase data calls are never cached here — the app keeps its own offline copy. */
const CACHE = 'cccc-app-v5.2.0';   // 1.2: new brand look (tokens, Brunson, logo + wordmark images)
const SHELL = [
  './', './index.html',
  './front/', './front/index.html', './front/front.js', './front/front.css', './front/manifest.json',
  './back/', './back/index.html',
  './shared/config.js', './shared/cloud.js', './shared/captcha.js', './shared/local.js', './shared/ui.js', './shared/logic.js',
  './shared/styles.css', './shared/vendor/qrcode.js',
  // Brand (release 1.2): colours + display font + logo images, so the counter looks right offline.
  './shared/brand/tokens.css', './shared/brand/brunson.woff',
  './shared/brand/tile-icon-192.webp', './shared/brand/tile-icon-192.png',
  './shared/brand/tile-icon-512.webp', './shared/brand/tile-icon-512.png',
  './shared/brand/logo-horizontal-cream.webp', './shared/brand/logo-horizontal-terracotta.webp',
  './shared/brand/logo-lockup-cream.webp',
  './shared/brand/wordmark-dark.webp', './shared/brand/wordmark-terracotta.webp', './shared/brand/wordmark-cream.webp',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(u => cache.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.hostname === 'challenges.cloudflare.com') return;       // CAPTCHA (Turnstile): never cached
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if(url.origin !== location.origin && !isFont) return;          // Supabase etc: straight to network
  if(isFont){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    }).catch(() => hit)));
    return;
  }
  e.respondWith(
    fetch(req).then(res => {
      if(res && res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: true}).then(hit => hit || (req.mode === 'navigate'
      ? caches.match(new URL('./front/index.html', self.registration.scope).href)
      : Response.error())))
  );
});
