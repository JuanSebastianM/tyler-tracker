// Service worker registration, update flow and install detection.
//
// Disable the service worker with '?sw=off' (persists in localStorage; '?sw=on' re-enables).
// It is always disabled on localhost so the dev server and e2e tests see fresh files.
import { toast } from './toast.js';
import { t } from './i18n.js';
import { readJSON, writeJSON } from './storage.js';

const UPDATED_FLAG = 'tt.updated';

export function isServiceWorkerDisabled() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  const param = new URLSearchParams(location.search).get('sw');
  if (param === 'off' || param === 'on') writeJSON('sw', param);
  if (readJSON('sw', /** @type {string} */ ('on')) === 'off') return true;
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
  sessionStorage.setItem(UPDATED_FLAG, '1');
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
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
  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  const offerUpdate = (/** @type {ServiceWorker} */ worker) => {
    toast(t('pwa.updateReady'), {
      duration: 0,
      action: {
        label: t('pwa.reload'),
        onClick: () => {
          sessionStorage.setItem(UPDATED_FLAG, '1');
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
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
