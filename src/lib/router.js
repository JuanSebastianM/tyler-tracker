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

// In-app history depth. Every history entry the app creates is stamped with `ttIdx` (0 for the
// entry the app was opened on), so "back" can tell whether the previous entry is still the app.
let currentIdx = 0;

/** Stamp the current entry with its depth (new entries get previous depth + 1). */
function stampEntry(isNewEntry = true) {
  const idx = history.state?.ttIdx;
  if (typeof idx === 'number') {
    currentIdx = idx;
    return;
  }
  currentIdx = isNewEntry ? currentIdx + 1 : 0;
  try {
    history.replaceState({ ...(history.state || {}), ttIdx: currentIdx }, '');
  } catch {
    /* ignore */
  }
}

if (typeof window !== 'undefined') {
  stampEntry(false);
  window.addEventListener('hashchange', () => {
    stampEntry(true);
    locationStore.set(parseHash(location.hash));
  });
}

/** Depth of the current entry inside the app (0 = the page the app was opened on). */
export const historyDepth = () => (typeof history !== 'undefined' && typeof history.state?.ttIdx === 'number' ? history.state.ttIdx : 0);

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

/**
 * Go back when the previous history entry belongs to the app; otherwise (a deep link opened
 * directly, e.g. from a shared link or the home screen) replace the current entry with `fallback`.
 * Never navigates out of the app.
 * @param {string} fallback app path, usually the route's parent
 */
export function goBack(fallback) {
  if (historyDepth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

/**
 * Closest ancestor of `path` that is a route ('/learn/faq/x' -> '/learn/faq'), else '/<first segment>'.
 * @param {Array<{ path: string }>} routes @param {string} path
 */
export function parentPath(routes, path) {
  const parts = path.split('/').filter(Boolean);
  for (let n = parts.length - 1; n >= 1; n--) {
    const candidate = '/' + parts.slice(0, n).join('/');
    if (resolveRoute(routes, candidate)) return candidate;
  }
  return '/' + (parts[0] || '');
}

/** @returns {Location} */
export function useLocation() {
  return useStore(locationStore);
}

/** Build an href for a path ('#/learn/faq'). @param {string} path */
export const href = (path) => '#' + (path.startsWith('/') ? path : '/' + path);
