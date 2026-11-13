// Safe localStorage access (private mode, quota errors and Node tests never throw).
import { STORAGE_PREFIX } from '../config.js';

/** @returns {Storage | null} */
function ls() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * @template T
 * @param {string} key key without prefix
 * @param {T} [fallback]
 * @returns {T}
 */
export function readJSON(key, fallback) {
  const s = ls();
  if (!s) return /** @type {T} */ (fallback);
  try {
    const raw = s.getItem(STORAGE_PREFIX + key);
    return raw == null ? /** @type {T} */ (fallback) : JSON.parse(raw);
  } catch {
    return /** @type {T} */ (fallback);
  }
}

/** @param {string} key @param {unknown} value */
export function writeJSON(key, value) {
  const s = ls();
  if (!s) return;
  try {
    s.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or private mode: caching is best effort */
  }
}

/** @param {string} key */
export function removeKey(key) {
  const s = ls();
  if (!s) return;
  try {
    s.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}
