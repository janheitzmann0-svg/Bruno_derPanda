/* App-shell cache. Trip data is never cached here — it always goes to the
   network so a phone coming back online sees the group's latest entries. */
const CACHE = 'saustall-payme-v8';
const SHELL = ['./', './index.html', './app.js', './manifest.json',
               './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) return;   // entry files are fetched fresh by the app itself

  // Network-first so a redeploy reaches everyone, cache as offline fallback.
  // no-store bypasses the browser's own HTTP cache, which would otherwise keep
  // serving yesterday's app.js for as long as GitHub Pages' max-age says.
  const fresh = new Request(e.request.url, { cache: 'no-store', credentials: 'same-origin' });
  e.respondWith(
    fetch(fresh)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});
