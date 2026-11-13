// Tyler Tracker service worker.
// VERSION and PRECACHE are stamped by scripts/build-site.mjs at deploy time. The unstamped file in
// the repo is never registered (the app skips registration on localhost).
const VERSION = '__SW_VERSION__';
/** @type {string[]} */
const PRECACHE = [/* __PRECACHE__ */];
const SHELL_CACHE = `tt-shell-${VERSION}`;
const CONTENT_CACHE = 'tt-content';

/**
 * Fetch every file of this version into a fresh cache, bypassing every HTTP cache on the way.
 * GitHub Pages and its CDN cache files for about 10 minutes, so a plain `cache.addAll()` right after a
 * deploy could pin the PREVIOUS files under the new version forever. Each request therefore carries
 * `?v=<version>` (a new CDN cache key) and `cache: 'reload'` (skips the browser's HTTP cache); the
 * response is stored under the clean URL. `src/version.js` must contain this exact version, otherwise
 * the CDN is still serving the old deploy: the install fails and the browser retries on its next
 * update check, instead of activating a stale mix.
 */
async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  try {
    await Promise.all(
      PRECACHE.map(async (path) => {
        const clean = new URL(path, self.registration.scope);
        const busted = new URL(clean.href);
        busted.searchParams.set('v', VERSION);
        const res = await fetch(busted.href, { cache: 'reload', credentials: 'same-origin', redirect: 'follow' });
        if (!res.ok) throw new Error(`precache ${path}: HTTP ${res.status}`);
        if (path === './src/version.js') {
          const text = await res.clone().text();
          if (!text.includes(JSON.stringify(VERSION))) throw new Error(`precache ${path}: stale file, expected ${VERSION}`);
        }
        await cache.put(clean.href, res);
      }),
    );
  } catch (e) {
    await caches.delete(SHELL_CACHE); // never leave a half-filled cache behind
    throw e;
  }
}

self.addEventListener('install', (event) => {
  // Do not skipWaiting here: the page activates the new worker on next launch (or when the
  // user taps "Update"), so a running session never mixes old and new files.
  event.waitUntil(precache());
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
          const shell = await caches.open(SHELL_CACHE);
          return (await cache.match(url.pathname)) || (await shell.match(url.href, { ignoreSearch: true })) || Response.error();
        }
      })(),
    );
    return;
  }

  // Only this version's cache answers (caches.match() would search every cache, including an older
  // or newer version's shell during an update, and mix files from two deploys).
  // Navigations: the app shell (hash routing means every page is index.html).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(new URL('./index.html', scope).href)) || fetch(req);
      })(),
    );
    return;
  }

  // App files: cache first.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || fetch(req);
    })(),
  );
});
