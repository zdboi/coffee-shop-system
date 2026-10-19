const CACHE_NAME = 'coffee-pos-v1';
const ASSETS = ['./pos.html', './pos-styles.css', './pos-app.js', './pos-manifest.json', '../Inventory/styles.css', '../Inventory/db.js', '../Inventory/logic.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
  );
});
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
