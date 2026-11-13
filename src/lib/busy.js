// Work in flight that a page reload would lose: an assistant answer being streamed, a write being
// saved, a photo being uploaded. The service worker update flow (pwa.js) never reloads while
// anything is busy; it waits for `whenIdle()`.
//
//   const done = beginBusy('upload');
//   try { await upload(); } finally { done(); }
import { createStore } from './store.js';

/** @type {import('./store.js').Store<Record<string, number>>} count of open tasks per reason */
export const busyStore = createStore(/** @type {Record<string, number>} */ ({}));

/**
 * Mark work as in flight. Returns the function that ends it (safe to call more than once).
 * @param {string} [reason] for debugging and tests
 * @returns {() => void}
 */
export function beginBusy(reason = 'work') {
  busyStore.set((s) => ({ ...s, [reason]: (s[reason] || 0) + 1 }));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    busyStore.set((s) => {
      const next = { ...s, [reason]: (s[reason] || 1) - 1 };
      if (next[reason] <= 0) delete next[reason];
      return next;
    });
  };
}

/** True while any work is in flight. */
export function isBusy() {
  return Object.keys(busyStore.get()).length > 0;
}

/**
 * Run `fn` once nothing is busy (right away if nothing is). Returns a cancel function.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function whenIdle(fn) {
  if (!isBusy()) {
    fn();
    return () => {};
  }
  const unsubscribe = busyStore.subscribe(() => {
    if (isBusy()) return;
    unsubscribe();
    fn();
  });
  return unsubscribe;
}
