const CACHE_NAME = 'brew-ledger-v2'; // bumped so installed PWAs pick up the Production/Customization update's assets
const ASSETS = ['./index.html', './styles.css', './db.js', './logic.js', './app.js', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
  );
});

// Cache-first for app shell assets; network-first fallback for everything else (e.g. Google Fonts, Drive API)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if(url.origin === location.origin){
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res=>{
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c=>c.put(e.request, clone));
        return res;
      }).catch(()=>cached))
    );
  }
});
