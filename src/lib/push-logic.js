// Pure helpers for push notifications on this device (src/lib/push.js). No DOM, unit-tested.

/**
 * @typedef {'ok' | 'needs-install' | 'unsupported'} PushSupport
 * @typedef {{ hasServiceWorker: boolean, hasPushManager: boolean, hasNotification: boolean, isIos: boolean, standalone: boolean }} PushEnv
 */

/**
 * Can this browser receive push? On iPhone and iPad, Web Push exists only in web apps opened from the
 * Home Screen (iOS/iPadOS 16.4+); in a Safari tab PushManager is missing, so "install it" is the
 * useful answer there, not "unsupported".
 * https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
 * @param {PushEnv} env
 * @returns {PushSupport}
 */
export function detectSupport(env) {
  if (env.isIos && !env.standalone) return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  return 'ok';
}

/** iPhone, iPad (also iPadOS reporting itself as a Mac) or iPod, any browser. @param {{ userAgent: string, platform?: string, maxTouchPoints?: number }} nav */
export function isIosDevice(nav) {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
}

/** base64url → bytes (the VAPID public key for `applicationServerKey`). @param {string} s */
export function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Was this browser subscription made with the server's current VAPID key? Unknown (no key exposed by
 * the browser) counts as a match.
 * @param {ArrayBuffer | null | undefined} subscriptionKey PushSubscription.options.applicationServerKey
 * @param {string} publicKey base64url
 */
export function sameServerKey(subscriptionKey, publicKey) {
  if (!subscriptionKey || !publicKey) return true;
  const a = new Uint8Array(subscriptionKey);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * @typedef {'on' | 'off' | 'denied' | 'lost' | 'resubscribe' | 'resave'} LaunchAction
 *  on: all good; off: never enabled here; denied: permission blocked; lost: it was enabled here but the
 *  subscription is gone and cannot be renewed without a tap; resubscribe: renew the browser
 *  subscription (permission still granted) and save it; resave: same subscription, new endpoint to save.
 */

/**
 * What to do at launch with this device's push state.
 * @param {{ permission: NotificationPermission, browserEndpoint: string | null, serverHasIt: boolean,
 *   recordEndpoint: string | null, keyMatches: boolean }} s
 *   recordEndpoint: the endpoint this person enabled on this device (localStorage), if any.
 * @returns {LaunchAction}
 */
export function launchAction(s) {
  if (s.permission === 'denied') return 'denied';
  if (s.browserEndpoint) {
    if (!s.keyMatches) return s.recordEndpoint || s.serverHasIt ? 'resubscribe' : 'off';
    if (s.serverHasIt) return 'on';
    if (!s.recordEndpoint) return 'off';
    // Enabled here, but the server dropped it (the push service said it was gone) or the browser
    // replaced it: a fresh subscription is the safe fix.
    return s.recordEndpoint === s.browserEndpoint ? 'resubscribe' : 'resave';
  }
  if (!s.recordEndpoint) return 'off';
  return s.permission === 'granted' ? 'resubscribe' : 'lost';
}

/** Map a push function error code / token error to what the settings screen shows. @param {string | undefined} code */
export function pushErrorCode(code) {
  const known = ['offline', 'network', 'unauthorized', 'not_editor', 'not_found', 'gone', 'too_many', 'push_failed', 'denied', 'unsupported'];
  return code && known.includes(code) ? code : 'server_error';
}

/**
 * Nobody who may receive alerts is signed in on this device: a phone left subscribed (sign-out
 * without network, a session that ended, an account that is not an editor) unsubscribes locally.
 * Only definite states count: never while auth is still loading or the editor check is pending.
 * @param {{ status: 'loading' | 'signedOut' | 'signedIn', editorCheck: 'unknown' | 'yes' | 'no' }} auth
 */
export function shouldSilenceDevice(auth) {
  return auth.status === 'signedOut' || (auth.status === 'signedIn' && auth.editorCheck === 'no');
}
