// Tyler Tracker service worker.
// VERSION and PRECACHE are stamped by scripts/build-site.mjs at deploy time. The unstamped file in
// the repo is never registered (the app skips registration on localhost).
const VERSION = '__SW_VERSION__';
/** @type {string[]} */
const PRECACHE = [/* __PRECACHE__ */];
const SHELL_CACHE = `tt-shell-${VERSION}`;
const CONTENT_CACHE = 'tt-content';

self.addEventListener('install', (event) => {
  // Do not skipWaiting here: the page activates the new worker on next launch (or when the
  // user taps "Update"), so a running session never mixes old and new files.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tt-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never touch Supabase or any other origin.
  if (url.origin !== self.location.origin) return;

  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);

  // Content JSON: network first, cache fallback.
  if (path.startsWith('content/') && path.endsWith('.json')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CONTENT_CACHE);
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res.ok) cache.put(url.pathname, res.clone());
          return res;
        } catch {
          return (await cache.match(url.pathname)) || (await caches.match(url.pathname)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Navigations: the app shell (hash routing means every page is index.html).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => (await caches.match(new URL('./index.html', scope).href)) || fetch(req))(),
    );
    return;
  }

  // App files: cache first.
  event.respondWith(
    (async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || fetch(req);
    })(),
  );
});
