// Push notifications on this device: support and permission state, subscribe from a tap, prefs,
// test notification, and re-validation at launch. Server side: supabase/functions/push.
//
// Rules from the platform docs (read 2026-11-18):
//  - iOS/iPadOS 16.4+: only web apps opened from the Home Screen get Web Push; the permission request
//    must come from a direct user interaction (a tap).
//    https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
//  - Apple: "When the user completes the gesture, call the push subscription method immediately from
//    the gesture's event handler code." Safari has no invisible pushes: the service worker shows a
//    notification for every push (src/lib/sw-push.js) or Safari revokes the permission.
//    https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
//  - userVisibleOnly must be true (Chrome/Edge reject anything else; WebKit requires it):
//    https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe, https://webkit.org/blog/12945/meet-web-push/
//  - Badging (navigator.setAppBadge / clearAppBadge) works for Home Screen web apps on iOS 16.4+.
import { createStore } from './store.js';
import { readJSON, writeJSON, removeKey } from './storage.js';
import { getAccessToken, refreshAccessToken, authStore, onEditorChange, onBeforeSignOut } from './auth.js';
import { isOffline } from './supabase.js';
import { getLocale, localeStore } from './i18n.js';
import { navigate } from './router.js';
import { isStandalone } from './pwa.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config.js';
import { base64UrlToBytes, detectSupport, isIosDevice, launchAction, pushErrorCode, sameServerKey, shouldSilenceDevice } from './push-logic.js';

export const PUSH_URL = `${SUPABASE_URL}/functions/v1/push`;

/**
 * @typedef {'idle' | 'checking' | 'off' | 'on' | 'denied' | 'lost' | 'error'} PushStatus
 * @typedef {{ meals: boolean, due: boolean }} PushPrefs
 * @typedef {object} PushState
 * @property {import('./push-logic.js').PushSupport | 'unknown'} support
 * @property {PushStatus} status
 * @property {PushPrefs} prefs
 * @property {null | 'enable' | 'disable' | 'test'} busy
 * @property {string | null} error  last error code of a check (status 'error')
 */

/** @type {import('./store.js').Store<PushState>} */
export const pushStore = createStore(/** @type {PushState} */ ({ support: 'unknown', status: 'idle', prefs: { meals: true, due: true }, busy: null, error: null }));

/** @typedef {{ ok: boolean, data?: any, code?: string }} PushResult  ok: data; else code */

const recordKey = () => `push.device.${authStore.get().user?.id || 'none'}`;
/** The endpoint this person enabled on this device, if any. @returns {{ endpoint: string } | null} */
const readRecord = () => readJSON(recordKey(), null);

function env() {
  const nav = typeof navigator === 'undefined' ? /** @type {any} */ ({ userAgent: '' }) : navigator;
  return {
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof window !== 'undefined' && 'Notification' in window,
    isIos: isIosDevice(nav),
    standalone: isStandalone(),
  };
}

const permission = () => /** @type {NotificationPermission} */ (typeof Notification === 'undefined' ? 'default' : Notification.permission);

/** POST to the push function with a fresh token; one retry after a refresh on 401. @returns {Promise<PushResult>} */
export async function callPush(/** @type {Record<string, unknown>} */ body) {
  if (isOffline()) return { ok: false, code: 'offline' };
  let auth = await getAccessToken();
  if (!auth.token) return { ok: false, code: auth.error === 'network' ? 'network' : 'unauthorized' };
  const send = (/** @type {string} */ token) =>
    fetch(PUSH_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let res = await send(auth.token);
    if (res.status === 401) {
      auth = await refreshAccessToken();
      if (!auth.token) return { ok: false, code: auth.error === 'network' ? 'network' : 'unauthorized' };
      res = await send(auth.token);
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, code: res.status === 401 ? 'unauthorized' : pushErrorCode(payload?.error) };
    return { ok: true, data: payload };
  } catch {
    return { ok: false, code: isOffline() ? 'offline' : 'network' };
  }
}

/** @type {ServiceWorkerRegistration | null} */
let registration = null;
/** @type {string | null} */
let publicKey = null;

/** The service worker registration, or null if there is none within a few seconds (dev server, ?sw=off). */
async function getRegistration() {
  if (registration) return registration;
  if (!('serviceWorker' in navigator)) return null;
  registration = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null);
  return registration;
}

/** @param {Partial<PushState>} patch @param {PushPrefs | null} [prefs] */
function setState(patch, prefs) {
  pushStore.set((s) => ({ ...s, ...patch, prefs: prefs ? { meals: !!prefs.meals, due: !!prefs.due } : s.prefs }));
}

/** @param {PushSubscription} sub */
const subJson = (sub) => /** @type {any} */ (sub.toJSON());

/** Save a browser subscription on the server. @param {PushSubscription} sub @param {string | null} oldEndpoint */
async function save(sub, oldEndpoint) {
  const r = await callPush({ action: 'subscribe', subscription: subJson(sub), locale: getLocale(), old_endpoint: oldEndpoint && oldEndpoint !== sub.endpoint ? oldEndpoint : null });
  if (r.ok) writeJSON(recordKey(), { endpoint: sub.endpoint });
  return r;
}

/** Subscribe with the server key, replacing a subscription made with another key. @param {ServiceWorkerRegistration} reg @param {string} key */
async function subscribeWith(reg, key) {
  const options = { userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) };
  try {
    return await reg.pushManager.subscribe(options);
  } catch (e) {
    // A subscription made with an older key must be removed first (InvalidStateError).
    const old = await reg.pushManager.getSubscription();
    if (!old) throw e;
    await old.unsubscribe().catch(() => {});
    return reg.pushManager.subscribe(options);
  }
}

let checking = /** @type {Promise<void> | null} */ (null);

/**
 * Re-validate this device at launch, when the app comes back and after sign-in: the browser
 * subscription, the server row and the server key must agree; renew or re-save when they do not.
 */
export function checkPush() {
  if (!checking) checking = runCheck().finally(() => (checking = null));
  return checking;
}

async function runCheck() {
  if (!authStore.get().editor) return;
  const support = detectSupport(env());
  if (support !== 'ok') return setState({ support, status: 'off', error: null });
  if (pushStore.get().status === 'idle') setState({ support, status: 'checking' });
  const reg = await getRegistration();
  if (!reg) return setState({ support: 'unsupported', status: 'off' });
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  const conf = await callPush({ action: 'config', endpoint: sub?.endpoint || null });
  if (!conf.ok) return setState({ support, status: pushStore.get().status === 'on' ? 'on' : 'error', error: conf.code });
  publicKey = conf.data.public_key;
  const server = conf.data.subscription;
  const record = readRecord();
  const action = launchAction({
    permission: permission(),
    browserEndpoint: sub?.endpoint || null,
    serverHasIt: !!server,
    recordEndpoint: record?.endpoint || null,
    keyMatches: sameServerKey(/** @type {any} */ (sub?.options)?.applicationServerKey, publicKey),
  });
  if (action === 'on') {
    if (record?.endpoint !== sub.endpoint) writeJSON(recordKey(), { endpoint: sub.endpoint });
    setState({ support, status: 'on', error: null }, server);
    if (server.locale !== getLocale()) callPush({ action: 'update_prefs', endpoint: sub.endpoint, locale: getLocale() });
    return;
  }
  if (action === 'off' || action === 'denied' || action === 'lost') {
    if (action === 'denied' && server && sub) callPush({ action: 'unsubscribe', endpoint: sub.endpoint }); // nothing could show anyway
    return setState({ support, status: action, error: null });
  }
  // Renew without a tap (the permission is still granted). If the browser refuses, ask for a tap.
  try {
    let next = sub;
    if (action === 'resubscribe') {
      if (sub) await sub.unsubscribe().catch(() => {});
      next = await subscribeWith(reg, publicKey);
    }
    const r = await save(next, record?.endpoint || null);
    if (!r.ok) return setState({ support, status: 'lost', error: r.code });
    setState({ support, status: 'on', error: null }, r.data.subscription);
  } catch {
    setState({ support, status: 'lost', error: null });
  }
}

/** Load the server key and the registration ahead of the tap, so the tap can subscribe at once. */
export async function preparePush() {
  if (detectSupport(env()) !== 'ok') return;
  await getRegistration();
  if (!publicKey) {
    const conf = await callPush({ action: 'config' });
    if (conf.ok) publicKey = conf.data.public_key;
  }
}

/**
 * "Activar en este teléfono". Call it straight from the tap handler: the subscription (which shows
 * the permission prompt) starts before the first await when the key and registration are ready.
 * @returns {Promise<PushResult>}
 */
export function enablePush() {
  /** @type {Promise<PushSubscription | null>} */
  let started;
  const reg = registration;
  const key = publicKey;
  if (reg && key) {
    started = subscribeWith(reg, key);
  } else if (typeof Notification !== 'undefined') {
    // Not prepared yet: ask for the permission from the tap, subscribe right after.
    started = Notification.requestPermission().then(async (p) => {
      if (p !== 'granted') return null;
      const r = await getRegistration();
      if (!r) throw new Error('unsupported');
      if (!publicKey) {
        const conf = await callPush({ action: 'config' });
        if (!conf.ok) throw Object.assign(new Error('config'), { code: conf.code });
        publicKey = conf.data.public_key;
      }
      return subscribeWith(r, publicKey);
    });
  } else {
    return Promise.resolve({ ok: false, code: 'unsupported' });
  }
  setState({ busy: 'enable' });
  return finishEnable(started).finally(() => setState({ busy: null }));
}

/** @param {Promise<PushSubscription | null>} started @returns {Promise<PushResult>} */
async function finishEnable(started) {
  /** @type {PushSubscription | null} */
  let sub = null;
  try {
    sub = await started;
  } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    if (code) return { ok: false, code };
    if (permission() === 'denied') {
      setState({ status: 'denied' });
      return { ok: false, code: 'denied' };
    }
    return { ok: false, code: /** @type {any} */ (e)?.message === 'unsupported' ? 'unsupported' : 'push_failed' };
  }
  if (!sub) {
    if (permission() === 'denied') setState({ status: 'denied' });
    return { ok: false, code: 'denied' };
  }
  const r = await save(sub, readRecord()?.endpoint || null);
  if (!r.ok) {
    // Roll back: a browser subscription the server does not know would never get anything.
    await sub.unsubscribe().catch(() => {});
    return r;
  }
  setState({ status: 'on', support: 'ok', error: null }, r.data.subscription);
  return r;
}

/** Current browser subscription endpoint, if any. */
async function currentEndpoint() {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  return sub?.endpoint || readRecord()?.endpoint || null;
}

/**
 * Switch meal or due alerts for this device. Optimistic: the switch moves at once and goes back if
 * the server refuses. @param {'meals' | 'due'} name @param {boolean} value @returns {Promise<PushResult>}
 */
export async function setPushPref(name, value) {
  const before = pushStore.get().prefs;
  setState({}, { ...before, [name]: value });
  const endpoint = await currentEndpoint();
  const r = endpoint ? await callPush({ action: 'update_prefs', endpoint, [name]: value }) : { ok: false, code: 'not_found' };
  if (!r.ok) {
    setState({}, before);
    if (r.code === 'not_found') setState({ status: 'lost' });
    return r;
  }
  setState({}, r.data.subscription);
  return r;
}

/** Ask the server to send a test notification to this device. @returns {Promise<PushResult>} */
export async function sendTestPush() {
  setState({ busy: 'test' });
  try {
    const endpoint = await currentEndpoint();
    if (!endpoint) return { ok: false, code: 'not_found' };
    const r = await callPush({ action: 'test', endpoint });
    if (!r.ok && (r.code === 'gone' || r.code === 'not_found')) setState({ status: 'lost' });
    return r;
  } finally {
    setState({ busy: null });
  }
}

/** "Desactivar en este teléfono". @returns {Promise<PushResult>} */
export async function disablePush() {
  setState({ busy: 'disable' });
  try {
    const reg = await getRegistration();
    const sub = await reg?.pushManager.getSubscription().catch(() => null);
    const endpoint = sub?.endpoint || readRecord()?.endpoint;
    if (endpoint) {
      const r = await callPush({ action: 'unsubscribe', endpoint });
      if (!r.ok) return r;
    }
    await sub?.unsubscribe().catch(() => {});
    removeKey(recordKey());
    setState({ status: 'off' });
    return { ok: true, data: null };
  } finally {
    setState({ busy: null });
  }
}

const IDLE_STATE = /** @type {PushState} */ ({ support: 'unknown', status: 'idle', prefs: { meals: true, due: true }, busy: null, error: null });

/** The registration if it is there within `ms` (sign-out must not wait the full 8 s). @param {number} ms */
const quickRegistration = (ms) => (registration ? Promise.resolve(registration) : Promise.race([getRegistration(), new Promise((r) => setTimeout(() => r(null), ms))]));

/**
 * Before an explicit sign-out (session still valid): this phone stops getting alerts. The browser
 * subscription is unsubscribed first, which works offline and silences the phone at once: the push
 * service then answers 404/410 for the old endpoint, and the function deletes the server row the
 * next time it sends to it. The server row is also removed right away when the network allows.
 * Signing in again shows "off": re-enabling needs a tap (iOS rule).
 */
export async function unlinkDevice() {
  const record = readRecord();
  removeKey(recordKey());
  pushStore.set(IDLE_STATE);
  if (!('serviceWorker' in navigator)) return;
  const reg = /** @type {ServiceWorkerRegistration | null} */ (await quickRegistration(1000));
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  const endpoint = sub?.endpoint || record?.endpoint || null;
  await Promise.all([
    sub ? sub.unsubscribe().catch(() => false) : null,
    endpoint && authStore.get().editor ? callPush({ action: 'unsubscribe', endpoint }) : null,
  ]);
}

/**
 * No editor signed in here, yet the browser holds a subscription (sign-out hook cut short, session
 * ended): unsubscribe locally. The server row then goes away on its next send (404/410).
 */
async function silenceIfSignedOut() {
  if (!shouldSilenceDevice(authStore.get()) || !('serviceWorker' in navigator)) return;
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub && shouldSilenceDevice(authStore.get())) await sub.unsubscribe().catch(() => {});
}

/** The badge counts notifications not yet seen; opening the app clears it. */
function clearBadge() {
  const nav = /** @type {any} */ (navigator);
  if (typeof nav.clearAppBadge === 'function') nav.clearAppBadge().catch(() => {});
}

let started = false;
/** Boot hook (src/main.js): follow sign-in, language and app resume; route notification taps. */
export function startPush() {
  if (started || typeof window === 'undefined') return;
  started = true;
  clearBadge();
  // A tap on a notification while the app is open: the service worker asks this window to navigate.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'tt-push-open' && typeof d.path === 'string' && d.path.startsWith('/')) navigate(d.path);
  });
  onEditorChange((editor) => {
    if (editor) checkPush();
    else pushStore.set(IDLE_STATE);
  });
  if (authStore.get().editor) checkPush();
  onBeforeSignOut(unlinkDevice);
  // Self-correction: whenever auth settles on "no editor here", a leftover subscription is dropped.
  let silenced = false;
  const sweep = () => {
    if (!shouldSilenceDevice(authStore.get())) return void (silenced = false);
    if (silenced) return;
    silenced = true;
    silenceIfSignedOut();
  };
  authStore.subscribe(sweep);
  sweep();
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    clearBadge();
    // Back from iOS Settings after unblocking: check at once; otherwise at most once a minute.
    if (authStore.get().editor && (pushStore.get().status === 'denied' || Date.now() - lastCheck > 60_000)) {
      lastCheck = Date.now();
      checkPush();
    }
  });
  // Notification text follows the app language.
  localeStore.subscribe(async (locale) => {
    if (pushStore.get().status !== 'on') return;
    const endpoint = await currentEndpoint();
    if (endpoint) callPush({ action: 'update_prefs', endpoint, locale });
  });
}
