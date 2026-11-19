// Device side of push notifications: support detection, launch re-validation decisions, and the
// service worker's push / notificationclick handlers (src/lib/sw-push.js run in a fake worker scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectSupport, isIosDevice, launchAction, sameServerKey, base64UrlToBytes, pushErrorCode } from '../../src/lib/push-logic.js';

const env = (o = {}) => ({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, standalone: false, ...o });

test('support: iPhone Safari tab needs the Home Screen app; others by feature', () => {
  assert.equal(detectSupport(env({ isIos: true, standalone: false, hasPushManager: false })), 'needs-install');
  assert.equal(detectSupport(env({ isIos: true, standalone: true })), 'ok');
  assert.equal(detectSupport(env({ isIos: true, standalone: true, hasPushManager: false })), 'unsupported'); // iOS < 16.4
  assert.equal(detectSupport(env()), 'ok'); // desktop Chrome in a tab
  assert.equal(detectSupport(env({ hasServiceWorker: false })), 'unsupported');
  assert.ok(isIosDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)' }));
  assert.ok(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }));
  assert.ok(!isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }));
});

test('launch: what to do with the browser subscription, the server row and the local record', () => {
  const base = { permission: 'granted', browserEndpoint: 'https://p/1', serverHasIt: true, recordEndpoint: 'https://p/1', keyMatches: true };
  assert.equal(launchAction(base), 'on');
  assert.equal(launchAction({ ...base, permission: 'denied' }), 'denied');
  // The server dropped it (push service said gone): renew.
  assert.equal(launchAction({ ...base, serverHasIt: false }), 'resubscribe');
  // The browser replaced the subscription: save the new endpoint.
  assert.equal(launchAction({ ...base, serverHasIt: false, recordEndpoint: 'https://p/0' }), 'resave');
  // Server keys changed: renew with the new key.
  assert.equal(launchAction({ ...base, keyMatches: false }), 'resubscribe');
  // Never enabled by this person here.
  assert.equal(launchAction({ ...base, serverHasIt: false, recordEndpoint: null }), 'off');
  assert.equal(launchAction({ ...base, browserEndpoint: null, serverHasIt: false, recordEndpoint: null }), 'off');
  // Enabled here but the browser lost it: renew when allowed, else ask for a tap.
  assert.equal(launchAction({ ...base, browserEndpoint: null, serverHasIt: false }), 'resubscribe');
  assert.equal(launchAction({ ...base, browserEndpoint: null, serverHasIt: false, permission: 'default' }), 'lost');
});

test('server key comparison and error codes', () => {
  const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const bytes = base64UrlToBytes(key);
  assert.equal(bytes.length, 65);
  assert.ok(sameServerKey(bytes.buffer, key));
  const other = bytes.slice();
  other[10] ^= 1;
  assert.ok(!sameServerKey(other.buffer, key));
  assert.ok(sameServerKey(null, key));
  assert.equal(pushErrorCode('gone'), 'gone');
  assert.equal(pushErrorCode('weird'), 'server_error');
});

// ---------------------------------------------------------------------------
// src/lib/sw-push.js in a fake service worker global scope
// ---------------------------------------------------------------------------
const SCOPE = 'https://juansebastianm.github.io/tyler-tracker/';

function loadWorker({ clients = [], badge = true } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const badges = [];
  const self = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    registration: {
      scope: SCOPE,
      showNotification: async (title, options) => shown.push({ title, options }),
      getNotifications: async () => shown,
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => opened.push(url),
    },
    navigator: badge ? { setAppBadge: async (n) => badges.push(n) } : {},
  };
  vm.runInNewContext(readFileSync(new URL('../../src/lib/sw-push.js', import.meta.url), 'utf8'), { self, URL });
  /** Dispatch an event and wait for what it passed to waitUntil. */
  const fire = async (type, event) => {
    let pending = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p) => (pending = p) });
    await pending;
  };
  return { fire, shown, opened, badges };
}

const pushEvent = (payload) => ({ data: payload === undefined ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });

test('sw: a push always shows a notification, with the payload or a fallback, and sets the badge', async () => {
  const w = loadWorker();
  await w.fire('push', pushEvent({ title: 'Comida 2 de Tyler · 11:30 a. m.', body: 'Aún no está registrada.', path: '/today', tag: 'meal-2026-11-20-2' }));
  assert.equal(w.shown[0].title, 'Comida 2 de Tyler · 11:30 a. m.');
  assert.equal(w.shown[0].options.tag, 'meal-2026-11-20-2');
  assert.equal(w.shown[0].options.data.path, '/today');
  assert.equal(w.shown[0].options.icon, `${SCOPE}assets/icons/icon-192.png`);
  assert.deepEqual(w.badges, [1]);
  // No payload, unreadable payload, or a path that is not an app route: still a notification.
  await w.fire('push', pushEvent());
  await w.fire('push', pushEvent('not json'));
  await w.fire('push', pushEvent({ title: 'x', path: 'https://evil.example/' }));
  assert.equal(w.shown.length, 4);
  assert.equal(w.shown[1].title, 'Tyler');
  assert.equal(w.shown[3].options.data.path, '/today');
  assert.deepEqual(w.badges, [1, 2, 3, 4]);
});

test('sw: a tap focuses an open window and routes it in place', async () => {
  const messages = [];
  let focused = 0;
  const client = { url: `${SCOPE}#/today`, focused: false, postMessage: (m) => messages.push(m), focus: async () => focused++ };
  const other = { url: 'https://juansebastianm.github.io/other/', focused: true, postMessage: () => assert.fail('other app'), focus: async () => {} };
  const w = loadWorker({ clients: [other, client] });
  let closed = false;
  await w.fire('notificationclick', { notification: { data: { path: '/health/vaccines' }, close: () => (closed = true) } });
  assert.ok(closed);
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: 'tt-push-open', path: '/health/vaccines' }]));
  assert.equal(focused, 1);
  assert.deepEqual(w.opened, []);
});

test('sw: a tap with no window open opens the app on the screen', async () => {
  const w = loadWorker({ clients: [] });
  await w.fire('notificationclick', { notification: { data: { path: '/health/reminders' }, close() {} } });
  assert.deepEqual(w.opened, [`${SCOPE}#/health/reminders`]);
  await w.fire('notificationclick', { notification: { data: {}, close() {} } });
  assert.equal(w.opened[1], `${SCOPE}#/today`);
});
