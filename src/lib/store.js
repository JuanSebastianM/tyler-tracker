// Tiny observable store plus a Preact hook. Every shared piece of state (auth, locale, tables,
// toasts) is one of these.
import { useEffect, useState, useRef } from '../../vendor/preact.js';

/**
 * @template T
 * @typedef {object} Store
 * @property {() => T} get
 * @property {(next: T | ((prev: T) => T)) => void} set
 * @property {(fn: (state: T) => void) => () => void} subscribe
 */

/**
 * @template T
 * @param {T} initial
 * @returns {Store<T>}
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<(state: T) => void>} */
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? /** @type {(p: T) => T} */ (next)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const fn of [...subs]) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * Subscribe a component to a store. With a selector, the component re-renders only when the
 * selected value changes (Object.is).
 * @template T, S
 * @param {Store<T>} store
 * @param {(state: T) => S} [selector]
 * @returns {S}
 */
export function useStore(store, selector) {
  const sel = selector || ((/** @type {any} */ s) => s);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [value, setValue] = useState(() => sel(store.get()));
  useEffect(() => {
    const check = () => {
      const next = selRef.current(store.get());
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    };
    check();
    return store.subscribe(check);
  }, [store]);
  return value;
}
