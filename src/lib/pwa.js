// Service worker registration, update flow and install detection.
//
// Disable the service worker with '?sw=off' (persists in localStorage). It is disabled on localhost
// so the dev server and e2e tests see fresh files; '?sw=on' forces it on (persists too).
import { toast } from './toast.js';
import { t } from './i18n.js';
import { readJSON, writeJSON } from './storage.js';
import { createStore } from './store.js';
import { isBusy, whenIdle } from './busy.js';

const UPDATED_FLAG = 'tt.updated';
/**
 * Update policy (never interrupt the person):
 *  - A new version that finishes installing within this time after launch (or after the app comes
 *    back to the foreground) is applied right away if the person has not touched the app yet and
 *    nothing is in flight, open or typed (canApplyNow), so a deploy shows up on the first open.
 *  - Otherwise a non-blocking toast offers "Update"; accepting waits for in-flight work
 *    (busy.js: answer streaming, write, upload) to finish.
 *  - It is also applied when the app goes to the background with nothing at stake, and always
 *    before render on the next launch (applyWaitingUpdate).
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
  if (await controllerChanged(4000)) return true; // the reload is under way
  // The new worker did not take over (it may still be finishing): start this version instead of
  // leaving a blank page. If it takes over later, the change is handled like any other update.
  requested = false;
  return false;
}

/** Resolves true when a new worker takes control within `ms`. @param {number} ms */
function controllerChanged(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

/** A new version is installed and waiting (or already took control in another tab). */
export const updateStore = createStore({ ready: false });

let reloading = false;
/** Set when this page asked the new worker to take over, so the controller change reloads it. */
let requested = false;
/** Another tab applied an update while this one was busy: reload at the next safe moment. */
let deferredReload = false;
/** @type {ServiceWorker | null} */
let pendingWorker = null;

/** Activate a waiting worker; the page reloads on controllerchange (see watchController). */
function activate(/** @type {ServiceWorker} */ worker) {
  sessionStorage.setItem(UPDATED_FLAG, '1');
  requested = true;
  watchController();
  worker.postMessage({ type: 'SKIP_WAITING' });
}

function reload() {
  if (reloading) return;
  reloading = true;
  sessionStorage.setItem(UPDATED_FLAG, '1');
  location.reload();
}

let watching = false;
/**
 * Reload whenever a NEW worker takes control of an already-controlled page, so a page never keeps
 * running old modules against the new version's cache. When this page asked for it, it already
 * waited for a safe moment. When another tab applied the update, the reload waits until nothing is
 * in flight and nothing is typed or open (the app has no lazy imports, so the old modules keep
 * working until then); the person sees the "new version" notice meanwhile.
 * The very first install (no controller before) does not reload.
 */
function watchController() {
  if (watching) return;
  watching = true;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first worker taking control (first visit) is the same version: nothing to reload.
    const hadController = controlled;
    controlled = true;
    if (!hadController || reloading) return;
    if (requested || canApplyNow()) return reload();
    deferredReload = true;
    updateStore.set({ ready: true });
    showUpdateNotice();
  });
}

/** An open sheet/dialog or typed text anywhere: never reload under the person's feet. */
export function hasUnsavedWork() {
  if (document.querySelector('[role="dialog"]')) return true;
  return [...document.querySelectorAll('textarea, input[type="text"], input[type="search"], input:not([type])')].some(
    (el) => !!(/** @type {HTMLInputElement} */ (el).value || '').trim(),
  );
}

/** Nothing in flight (answer streaming, write, upload), nothing open and nothing typed. */
export function canApplyNow() {
  return !isBusy() && !hasUnsavedWork();
}

/**
 * The person accepted the update: apply it as soon as no request is in flight (an answer being
 * streamed finishes first). Open sheets and typed text do not hold it back: it was their choice.
 */
export function applyUpdate() {
  whenIdle(() => {
    if (deferredReload) return reload();
    if (pendingWorker) activate(pendingWorker);
  });
}

let noticeShown = false;
function showUpdateNotice() {
  if (noticeShown) return;
  noticeShown = true;
  toast(t('pwa.updateReady'), {
    duration: 0,
    action: {
      label: t('pwa.reload'),
      onClick: () => {
        if (isBusy()) toast(t('pwa.updateAfterWork'));
        applyUpdate();
      },
    },
  });
}

/** The app went to the background with nothing at stake: a good moment to update. */
function applyIfIdleInBackground() {
  if (!canApplyNow()) return;
  if (deferredReload) reload();
  else if (pendingWorker) activate(pendingWorker);
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

  const offerUpdate = (/** @type {ServiceWorker} */ worker) => {
    pendingWorker = worker;
    updateStore.set({ ready: true });
    // Right after launch, before the person did anything: apply at once (shows up on first open).
    if (!touched && Date.now() - windowStart < AUTO_APPLY_MS && canApplyNow()) {
      activate(worker);
      return;
    }
    showUpdateNotice();
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
    if (document.visibilityState === 'hidden') {
      applyIfIdleInBackground();
      return;
    }
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
