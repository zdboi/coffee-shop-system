/* Front Office offline cache.
   Network first (so updates show up straight away), falling back to the saved
   copy when the internet is down. The database library from the CDN is cached
   too, so the counter can start offline after its first online start. */
const CACHE = 'cccc-frontoffice-v1';
const SHELL = ['./', './index.html', './pos-styles.css', './pos-app.js', './fo-extra.js', './manifest.json',
  '../config.js', '../shared/styles.css', '../shared/logic.js', '../shared/data.js', '../shared/supa.js', '../shared/calendar.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isLib = /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/.test(req.url) || /fonts\.(googleapis|gstatic)\.com/.test(req.url);
  if (!sameOrigin && !isLib) return; // database calls always go to the network
  e.respondWith(
    fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: sameOrigin }).then((hit) => hit || caches.match('./index.html')))
  );
});
