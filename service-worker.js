/* DSR Remote — service worker, present only so Android Chrome offers
   "Install app" (a live relay connection is required for the app to do
   anything useful, so there's no real value in offline caching here).

   Network-first, not cache-first: this app is actively developed, and a
   cache-first strategy means a phone can get stuck serving an old,
   already-fixed bug indefinitely (exactly what happened testing the very
   first version of this file - a real fix was deployed but a phone kept
   rendering the old broken page because "reload" was answered entirely
   from the cache, never touching the network at all). Falling back to
   the cache only when the network request fails means a normal reload
   always gets what's actually live. */
const CACHE = 'dsr-remote-v2';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && new URL(req.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
