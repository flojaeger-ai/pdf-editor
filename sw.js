const CACHE = 'pdf-editor-v7';
const PRECACHE = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './vendor/pdf-lib.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isNetworkFirst(req) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  let path = '';
  try { path = new URL(req.url).pathname; } catch (err) { return false; }
  const name = path.split('/').pop();
  return name === '' || name === 'index.html' || name === 'sw.js' ||
    name === 'app.js' || name === 'manifest.webmanifest' || name === 'manifest.json';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (isNetworkFirst(req)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html') || caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.ok && req.url.startsWith(self.location.origin)) {
          caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }
        return res;
      }).catch(() => cached || caches.match('./index.html'));
      return cached || fetched;
    })
  );
});
