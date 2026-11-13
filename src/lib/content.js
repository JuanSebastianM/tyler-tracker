// Bilingual reading content from /content/*.json (schemas in docs/CONTENT.md).
//
//   const { data, status } = useContent('faq');      // data = parsed JSON or null
//   pick(item.title)                                  // current locale's text
//   currentStage(roadmap.items, age.weeks)
//   factOfTheDay(facts.items, today)
//
// Network-first: always tries the network so new FAQ entries appear without an app update,
// falls back to the last copy in localStorage (and the service worker cache) when offline.
import { createStore, useStore } from './store.js';
import { readJSON, writeJSON } from './storage.js';
import { useEffect } from '../../vendor/preact.js';
export { pick } from './i18n.js';

export const CONTENT_FILES = /** @type {const} */ ([
  'faq', 'facts', 'roadmap', 'must-know', 'training', 'health', 'parents', 'growth',
]);
/** @typedef {typeof CONTENT_FILES[number]} ContentName */

/**
 * @typedef {object} ContentState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {any} data
 * @property {boolean} fromCache
 */

/** @type {Map<string, import('./store.js').Store<ContentState>>} */
const stores = new Map();
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/** @param {string} name */
function storeFor(name) {
  let s = stores.get(name);
  if (!s) {
    const cached = readJSON(`content.${name}`, null);
    s = createStore(/** @type {ContentState} */ ({ status: 'idle', data: cached, fromCache: !!cached }));
    stores.set(name, s);
  }
  return s;
}

/**
 * Fetch a content file (network first). Shared across callers.
 * @param {ContentName} name
 * @param {{ base?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<any>} parsed JSON, or null when unavailable
 */
export function loadContent(name, opts = {}) {
  const existing = inflight.get(name);
  if (existing) return existing;
  const s = storeFor(name);
  const fetchImpl = opts.fetchImpl || fetch;
  s.set((st) => ({ ...st, status: st.data ? st.status : 'loading' }));
  const p = (async () => {
    try {
      const res = await fetchImpl(`${opts.base ?? './'}content/${name}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const data = withoutSamples(await res.json());
      writeJSON(`content.${name}`, data);
      s.set({ status: 'ready', data, fromCache: false });
      return data;
    } catch {
      const data = s.get().data;
      s.set({ status: data ? 'ready' : 'error', data, fromCache: !!data });
      return data;
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, p);
  return p;
}

/**
 * Entries marked "sample": true are placeholders written before the real content. They are shown
 * on localhost (dev, tests) or with '?samples=1', and hidden on the live site.
 */
export function samplesEnabled() {
  if (typeof location === 'undefined') return true;
  const param = new URLSearchParams(location.search).get('samples');
  if (param === '1' || param === '0') writeJSON('samples', param === '1');
  const stored = readJSON('samples', /** @type {boolean | null} */ (null));
  if (stored !== null) return stored;
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/** @param {any} data */
export function withoutSamples(data, enabled = samplesEnabled()) {
  if (enabled || !data || !Array.isArray(data.items)) return data;
  return { ...data, items: data.items.filter((/** @type {any} */ i) => !i.sample) };
}

/**
 * Hook: load a content file once per session and re-render when it arrives.
 * @param {ContentName} name
 * @returns {ContentState}
 */
export function useContent(name) {
  const s = storeFor(name);
  const state = useStore(s);
  useEffect(() => {
    if (s.get().status === 'idle' || (s.get().fromCache && !inflight.has(name))) loadContent(name);
  }, [name]);
  return state;
}

/**
 * Find an item by id.
 * @template {{ id: string }} T
 * @param {T[] | undefined} items
 * @param {string} id
 * @returns {T | null}
 */
export function findById(items, id) {
  return (items || []).find((i) => i.id === id) || null;
}

/**
 * Roadmap stage for an age in weeks: from_weeks <= age < to_weeks. Clamps to the first/last stage.
 * @template {{ from_weeks: number, to_weeks: number }} S
 * @param {S[]} stages
 * @param {number} ageWeeks
 * @returns {S | null}
 */
export function currentStage(stages, ageWeeks) {
  if (!stages?.length) return null;
  const sorted = [...stages].sort((a, b) => a.from_weeks - b.from_weeks);
  const hit = sorted.find((s) => ageWeeks >= s.from_weeks && ageWeeks < s.to_weeks);
  if (hit) return hit;
  return ageWeeks < sorted[0].from_weeks ? sorted[0] : sorted[sorted.length - 1];
}

/** FNV-1a 32-bit hash. @param {string} s */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic fact for a calendar date: same date -> same fact on every device. Consecutive
 * days never repeat the same fact when there are at least two.
 * @template T
 * @param {T[]} facts
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {T | null}
 */
export function factOfTheDay(facts, dateStr) {
  if (!facts?.length) return null;
  const n = facts.length;
  const day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86_400_000);
  // Walk a fixed pseudo-random permutation of the facts, one step per day.
  const offset = hash32('tyler') % n;
  const step = coprimeStep(n);
  return facts[(offset + day * step) % n];
}

/** A step size coprime with n, so stepping visits every index. @param {number} n */
function coprimeStep(n) {
  const gcd = (/** @type {number} */ a, /** @type {number} */ b) => (b ? gcd(b, a % b) : a);
  let step = Math.max(1, Math.floor(n * 0.618));
  while (gcd(step, n) !== 1) step++;
  return step;
}
