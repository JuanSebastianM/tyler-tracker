// Service worker registration, update flow and install detection.
//
// Disable the service worker with '?sw=off' (persists in localStorage). It is disabled on localhost
// so the dev server and e2e tests see fresh files; '?sw=on' forces it on (persists too).
import { toast } from './toast.js';
import { t } from './i18n.js';
import { readJSON, writeJSON } from './storage.js';

const UPDATED_FLAG = 'tt.updated';
/**
 * A new version that finishes installing within this time after launch (or after the app comes back
 * to the foreground) is applied right away if the person has not touched the app yet, so a deploy
 * shows up on the first open instead of the second. Otherwise a toast offers "Update".
 */
const AUTO_APPLY_MS = 15_000;

export function isServiceWorkerDisabled() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  const param = new URLSearchParams(location.search).get('sw');
  if (param === 'off' || param === 'on') writeJSON('sw', param);
  const stored = readJSON('sw', /** @type {string | null} */ (null));
  if (stored === 'off') return true;
  if (stored === 'on') return false; // '?sw=on' forces it, e.g. to test the built site locally
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/**
 * Activate a waiting worker before the app renders ("activates on next launch").
 * Resolves true if the page is about to reload.
 */
export async function applyWaitingUpdate() {
  if (isServiceWorkerDisabled()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.waiting || !navigator.serviceWorker.controller) return false;
  activate(reg.waiting);
  return true;
}

let reloading = false;
/** Activate a waiting worker; the page reloads on controllerchange (see watchController). */
function activate(/** @type {ServiceWorker} */ worker) {
  sessionStorage.setItem(UPDATED_FLAG, '1');
  watchController();
  worker.postMessage({ type: 'SKIP_WAITING' });
}

let watching = false;
/**
 * Reload whenever a NEW worker takes control of an already-controlled page (an update applied here
 * or in another tab), so a page never keeps running old modules against the new version's cache.
 * The very first install (no controller before) does not reload.
 */
function watchController() {
  if (watching) return;
  watching = true;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

/** An open sheet/dialog or typed text anywhere: never reload under the person's feet. */
function hasUnsavedWork() {
  if (document.querySelector('[role="dialog"]')) return true;
  return [...document.querySelectorAll('textarea, input[type="text"], input:not([type])')].some(
    (el) => !!(/** @type {HTMLInputElement} */ (el).value || '').trim(),
  );
}

export async function registerServiceWorker() {
  if (isServiceWorkerDisabled()) {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    return;
  }
  if (sessionStorage.getItem(UPDATED_FLAG)) {
    sessionStorage.removeItem(UPDATED_FLAG);
    toast(t('pwa.updated'), { tone: 'success' });
  }
  watchController();
  // updateViaCache 'none': update checks never use the HTTP cache for sw.js (Pages caches ~10 min).
  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });

  // Has the person interacted since launch / since the app came back to the foreground?
  let windowStart = Date.now();
  let touched = false;
  const markTouched = () => {
    touched = true;
  };
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, markTouched, { capture: true, passive: true });

  let offered = false;
  const offerUpdate = (/** @type {ServiceWorker} */ worker) => {
    if (!touched && Date.now() - windowStart < AUTO_APPLY_MS && !hasUnsavedWork()) {
      activate(worker);
      return;
    }
    if (offered) return;
    offered = true;
    toast(t('pwa.updateReady'), {
      duration: 0,
      action: { label: t('pwa.reload'), onClick: () => activate(worker) },
    });
  };
  const track = (/** @type {ServiceWorker | null} */ worker) => {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
  // The update check started by register() may already be installing when it resolves.
  else track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // iOS resumes a home-screen app instead of relaunching it: treat coming back as a launch.
    windowStart = Date.now();
    touched = false;
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    else reg.update().catch(() => {});
  });
}

/** Running as an installed app (home screen). */
export function isStandalone() {
  return (
    // @ts-ignore iOS Safari only
    navigator.standalone === true || (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches)
  );
}

/** iPhone/iPad Safari (not in-app browsers like Chrome iOS, which cannot install). */
export function isIosSafari() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua);
}
