// Is the app really online? `navigator.onLine` only says whether the phone has a network interface
// (it stays true on a dead signal or a captive portal), so the answer also follows real request
// outcomes: a Supabase request that fails at the network level marks the app offline, any HTTP
// response (even an error status) marks it online again.
//
//   const online = useOnline();
//   onReconnect(() => outbox.kick());
import { createStore, useStore } from './store.js';

/**
 * @typedef {object} ConnectivityState
 * @property {boolean} online      what the app shows and acts on
 * @property {boolean} browser     navigator.onLine
 * @property {boolean} requestFailed  the latest request failed at the network level
 * @property {number} changedAt    epoch ms of the last change of `online`
 */

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** @type {import('./store.js').Store<ConnectivityState>} */
export const connectivity = createStore(
  /** @type {ConnectivityState} */ ({ online: browserOnline(), browser: browserOnline(), requestFailed: false, changedAt: Date.now() }),
);

/** @type {Set<() => void>} */
const reconnectHooks = new Set();

/** @param {Partial<ConnectivityState>} patch */
function update(patch) {
  const prev = connectivity.get();
  const next = { ...prev, ...patch };
  next.online = next.browser && !next.requestFailed;
  if (next.online === prev.online && next.browser === prev.browser && next.requestFailed === prev.requestFailed) return;
  if (next.online !== prev.online) next.changedAt = Date.now();
  connectivity.set(next);
  if (next.online && !prev.online) for (const fn of [...reconnectHooks]) fn();
}

/** Monotonic clock (not affected by the device clock being changed). */
export const monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** When the connection was last known to work (an answer, or the browser's 'online' event). */
let lastGoodAt = -1;

/**
 * Record the outcome of a request to the backend.
 * @param {boolean} reachedServer true for any HTTP response, false for a network failure/timeout
 * @param {number} [startedAt] monotonicNow() when the request started: a failure of a request that began
 *   before the connection was seen working again (a stale retry from the offline period) is ignored
 */
export function reportRequest(reachedServer, startedAt = monotonicNow()) {
  if (reachedServer) {
    lastGoodAt = monotonicNow();
    update({ requestFailed: false, browser: true });
    return;
  }
  if (startedAt < lastGoodAt) return;
  update({ requestFailed: true, browser: browserOnline() });
}

/** Run `fn` every time the app goes from offline to online. Returns an unsubscribe function. */
export function onReconnect(/** @type {() => void} */ fn) {
  reconnectHooks.add(fn);
  return () => reconnectHooks.delete(fn);
}

/** Non-hook check. */
export function isOnline() {
  return connectivity.get().online;
}

/** Hook: true while the app believes it is online. */
export function useOnline() {
  return useStore(connectivity, (s) => s.online);
}

let started = false;
/** Follow the browser's online/offline events. Called once at boot. */
export function startConnectivity() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // 'online' only says a network is back; the next request decides whether the server is reachable.
  window.addEventListener('online', () => {
    lastGoodAt = monotonicNow();
    update({ browser: true, requestFailed: false });
  });
  window.addEventListener('offline', () => update({ browser: false }));
}
