// Per-person colour theme and light/dark mode.
//
//   const { theme, mode, scheme } = useThemeChoice();
//   await setThemeChoice({ theme: 'rose' });   // or { mode: 'dark' }
//
// A choice belongs to one person. Signed-in editors keep theirs in `user_settings` (their own row,
// RLS) and a copy on the device so the app paints it before the network answers. Visitors keep
// theirs on the device. On sign-out the device's own choice applies again.
//
// What is applied is written to localStorage `tt.theme.active`; src/lib/theme-boot.js (a classic
// script in index.html) applies that before first paint. The DOM contract (attributes on <html>)
// is described in src/styles/tokens.css.
import { createStore, useStore } from './store.js';
import { readJSON, writeJSON } from './storage.js';

/** Theme ids. Keep in sync with themes.css and theme-boot.js (checked by tests/unit/theme.test.mjs). */
export const THEMES = /** @type {const} */ (['default', 'rose', 'lavender', 'mint', 'sky']);
export const MODES = /** @type {const} */ (['auto', 'light', 'dark']);

/** @typedef {typeof THEMES[number]} ThemeId */
/** @typedef {typeof MODES[number]} ColorMode */
/** @typedef {{ theme: ThemeId, mode: ColorMode }} ThemeChoice */
/** @typedef {ThemeChoice & { scheme: 'light' | 'dark' }} AppliedTheme */

/** @type {ThemeChoice} */
export const DEFAULT_CHOICE = Object.freeze({ theme: 'default', mode: 'auto' });

/** localStorage keys (without the app prefix). */
export const ACTIVE_KEY = 'theme.active';
export const DEVICE_KEY = 'theme.device';
/** @param {string} userId */
export const userKey = (userId) => `theme.user.${userId}`;

/**
 * A valid choice from anything (stored JSON, a user_settings row). Unknown values fall back to
 * the default theme / automatic mode.
 * @param {any} value  { theme, mode } or a row { theme, color_mode }
 * @returns {ThemeChoice}
 */
export function normalizeChoice(value) {
  const theme = value && THEMES.includes(value.theme) ? value.theme : DEFAULT_CHOICE.theme;
  const rawMode = value ? (value.mode ?? value.color_mode) : null;
  const mode = MODES.includes(rawMode) ? rawMode : DEFAULT_CHOICE.mode;
  return { theme, mode };
}

/**
 * @param {ColorMode} mode
 * @param {boolean} prefersDark  the device setting
 * @returns {'light' | 'dark'}
 */
export function resolveScheme(mode, prefersDark) {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDark ? 'dark' : 'light';
}

/** @param {ThemeChoice | null | undefined} a @param {ThemeChoice | null | undefined} b */
export const sameChoice = (a, b) => !!a && !!b && a.theme === b.theme && a.mode === b.mode;

/**
 * Which choice applies right now.
 * @param {{ authStatus: 'loading' | 'signedOut' | 'signedIn', userId?: string | null, row?: any,
 *   rowsReady?: boolean, userCached?: any, device?: any, active?: any }} s
 *   row: the signed-in user's user_settings row (if loaded); rowsReady: the table was fetched from
 *   the server (so "no row" means "never chose"); userCached: that user's choice cached on this
 *   device; device: the device's own (signed-out) choice; active: what was painted at launch.
 * @returns {ThemeChoice}
 */
export function resolveChoice(s) {
  if (s.authStatus === 'loading') return normalizeChoice(s.active);
  if (s.userId) {
    if (s.row) return normalizeChoice(s.row);
    if (s.rowsReady) return { ...DEFAULT_CHOICE };
    return normalizeChoice(s.userCached);
  }
  return normalizeChoice(s.device);
}

const prefersDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** @type {import('./store.js').Store<AppliedTheme>} */
export const themeStore = createStore(
  /** @type {AppliedTheme} */ ({ ...normalizeChoice(readJSON(ACTIVE_KEY, null)), scheme: 'light' }),
);

/** Hook: the applied { theme, mode, scheme }. */
export function useThemeChoice() {
  return useStore(themeStore);
}

/**
 * Apply a choice to <html> and the theme-color meta, and remember it for the next launch.
 * @param {ThemeChoice} choice
 */
export function applyChoice(choice) {
  const c = normalizeChoice(choice);
  const scheme = resolveScheme(c.mode, prefersDark());
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-theme', c.theme);
    root.setAttribute('data-mode', c.mode);
    root.setAttribute('data-scheme', scheme);
    const bg = getComputedStyle(root).getPropertyValue('--c-bg').trim();
    if (bg) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
  }
  const prev = themeStore.get();
  if (!sameChoice(prev, c) || prev.scheme !== scheme) themeStore.set({ ...c, scheme });
  writeJSON(ACTIVE_KEY, c);
}

/**
 * @typedef {object} ThemeDeps
 * @property {import('./store.js').Store<import('./auth.js').AuthState>} authStore
 * @property {any} userSettings  the user_settings table store (src/data/stores.js)
 */

/** @type {ThemeDeps | null} */
let deps = null;

/** The choice for the current session, from auth + user_settings + the device. */
function currentChoice() {
  if (!deps) return normalizeChoice(readJSON(ACTIVE_KEY, null));
  const auth = deps.authStore.get();
  const userId = auth.user?.id || null;
  const st = deps.userSettings.state.get();
  const row = userId ? st.rows.find((/** @type {any} */ r) => r.user_id === userId) || null : null;
  const rowsReady = st.status === 'ready' && !st.fromCache;
  const choice = resolveChoice({
    authStatus: auth.status,
    userId,
    row,
    rowsReady,
    userCached: userId ? readJSON(userKey(userId), null) : null,
    device: readJSON(DEVICE_KEY, null),
    active: readJSON(ACTIVE_KEY, null),
  });
  // Cache the user's confirmed choice (never an optimistic one that may still roll back).
  if (userId && auth.status === 'signedIn' && ((row && !row._pending) || (!row && rowsReady))) {
    writeJSON(userKey(userId), choice);
  }
  return choice;
}

let started = false;

/**
 * Follow sign-in/out, the user's row and the device's dark mode. Call once at boot.
 * @param {ThemeDeps} d
 */
export function initTheme(d) {
  deps = d;
  if (started) return;
  started = true;
  const recompute = () => applyChoice(currentChoice());
  d.authStore.subscribe(recompute);
  d.userSettings.state.subscribe(recompute);
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyChoice(themeStore.get()));
  }
  recompute();
}

/**
 * Change the current person's theme and/or mode. Applies at once; editors' choice is upserted to
 * user_settings (rolled back with a toast by the store if the write fails).
 * @param {Partial<ThemeChoice>} patch
 * @returns {Promise<{ error: any }>}
 */
export async function setThemeChoice(patch) {
  const next = normalizeChoice({ ...themeStore.get(), ...patch });
  const auth = deps?.authStore.get();
  const userId = auth?.status === 'signedIn' ? auth.user?.id : null;
  if (deps && userId && auth?.editor) {
    // The optimistic row makes the subscription apply the new choice immediately.
    const { error } = await deps.userSettings.upsert({ user_id: userId, theme: next.theme, color_mode: next.mode });
    return { error };
  }
  writeJSON(userId ? userKey(userId) : DEVICE_KEY, next);
  applyChoice(next);
  return { error: null };
}
