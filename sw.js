/* Service Worker — অ্যাপ ফাইল ফোনে রেখে দেয়, নেট ছাড়াই চালু হয় */
const CACHE = 'stms-v24';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './anchor-alarm.mp3'];

self.addEventListener('install', e => {
  // কোনো একটা ফাইল না থাকলেও (404) ইনস্টল থেমে যাবে না
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* নেট থাকলে সবসময় নতুন কপি; না থাকলে বা ৩ সেকেন্ডে সাড়া না পেলে ফোনের কপি */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(cache => new Promise(resolve => {
      let done = false;
      const fromCache = () => cache.match(req, { ignoreSearch: true })
        .then(h => h || cache.match('./index.html') || cache.match('./'));
      const timer = setTimeout(() => {
        fromCache().then(h => { if (h && !done) { done = true; resolve(h); } });
      }, 3000);
      // navigate-মোডের Request-এ init দিলে কিছু ব্রাউজারে TypeError হয়, তাই URL দিয়ে fetch
      Promise.resolve().then(() => fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' })).then(res => {
        clearTimeout(timer);
        if (res && res.ok) cache.put(req, res.clone());
        if (!done) { done = true; resolve(res); }
      }).catch(() => {
        clearTimeout(timer);
        fromCache().then(h => { if (!done) { done = true; resolve(h || Response.error()); } });
      });
    }))
  );
});
