// Hash router: '#/health/vaccines?tab=due' -> { path: '/health/vaccines', query: { tab: 'due' } }.
// Route patterns support params: '/learn/guide/:id'.
import { createStore, useStore } from './store.js';

/**
 * @typedef {object} Location
 * @property {string} path   always starts with '/'
 * @property {Record<string, string>} query
 */

/** @param {string} hash @returns {Location} */
export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  let path = '/' + pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path === '') path = '/';
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return { path, query };
}

/**
 * Match a pattern against a path. Returns params or null.
 * @param {string} pattern e.g. '/learn/guide/:id'
 * @param {string} path
 * @returns {Record<string, string> | null}
 */
export function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/**
 * Find the first route whose pattern matches.
 * @template {{ path: string }} R
 * @param {R[]} routes
 * @param {string} path
 * @returns {{ route: R, params: Record<string, string> } | null}
 */
export function resolveRoute(routes, path) {
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params) return { route, params };
  }
  return null;
}

const initial = typeof location !== 'undefined' ? parseHash(location.hash) : { path: '/', query: {} };
/** @type {import('./store.js').Store<Location>} */
export const locationStore = createStore(initial);

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => locationStore.set(parseHash(location.hash)));
}

/**
 * Navigate to an app path ('/health/vaccines'). With replace, no history entry is added.
 * @param {string} path
 * @param {{ replace?: boolean }} [opts]
 */
export function navigate(path, opts = {}) {
  const hash = '#' + (path.startsWith('/') ? path : '/' + path);
  if (opts.replace) {
    history.replaceState(history.state, '', hash);
    locationStore.set(parseHash(hash));
  } else {
    location.hash = hash;
  }
}

/** Go back if the previous entry is inside the app, else to `fallback`. @param {string} fallback */
export function goBack(fallback) {
  if (history.state?.ttDepth > 0 || history.length > 1) {
    const before = location.hash;
    history.back();
    // If back() left the app or did nothing, fall back.
    setTimeout(() => {
      if (location.hash === before) navigate(fallback, { replace: true });
    }, 150);
  } else {
    navigate(fallback, { replace: true });
  }
}

/** @returns {Location} */
export function useLocation() {
  return useStore(locationStore);
}

/** Build an href for a path ('#/learn/faq'). @param {string} path */
export const href = (path) => '#' + (path.startsWith('/') ? path : '/' + path);
