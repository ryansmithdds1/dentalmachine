// Dental Machine service worker: keeps the app itself (HTML, scripts, styles) available offline so the
// office can keep working from the encrypted copy of today when the internet drops (docs/offline.md).
// Patient data from the API is never cached here: /api is always passed straight to the network, and the
// offline copy lives, encrypted, in IndexedDB (client/src/offline).
const CACHE = 'dm-shell-v2';

// The page and the files it loads first. Screens loaded later (the schedule, the chart) are cached as they're
// fetched — the app loads the ones needed offline right after sign-in.
async function precache() {
  const c = await caches.open(CACHE);
  await c.addAll(['/manifest.webmanifest', '/icon.svg']);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await c.put('/', res);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await c.addAll([...new Set(assets)]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  // Pages: the network first (always the latest app), the cached shell when offline. Only a good answer
  // replaces the cached shell (an error page from a struggling server must not become the offline app).
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok && (res.headers.get('Content-Type') || '').includes('text/html')) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put('/', copy)));
      }
      return res;
    }).catch(() => caches.match('/').then((hit) => hit || new Response('<h1>You’re offline</h1><p>Dental Machine will open here once the connection is back.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  // Built files have content hashes in their names, so a cached copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    })));
  }
});
