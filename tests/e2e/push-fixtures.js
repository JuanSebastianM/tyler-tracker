// Fakes for the push settings tests: the browser's push machinery (service worker registration,
// PushManager, Notification permission) in the page, and the `push` Edge Function.
import { expect } from 'playwright/test';
import { mockSupabase, EDITOR_USER } from './helpers.js';
import { SUPABASE_URL } from './supabase-mock.js';

const PUBLIC_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

/**
 * Fake push environment in the page.
 * @param {import('playwright/test').Page} page
 * @param {{ permission?: NotificationPermission, answer?: NotificationPermission, standalone?: boolean,
 *   existing?: string | null, record?: string | null, noPush?: boolean }} o
 */
export async function fakeBrowserPush(page, o = {}) {
  await page.addInitScript(
    ({ o, userId }) => {
      // The fake browser keeps its permission and subscription across reloads, like a real one.
      const saved = JSON.parse(sessionStorage.getItem('fake-push') || 'null');
      const state = { permission: saved?.permission || o.permission || 'default', subscribeCalls: [], current: null, unsubscribed: 0, prompts: 0 };
      window.__push = state;
      const persist = () =>
        sessionStorage.setItem('fake-push', JSON.stringify({ permission: state.permission, endpoint: state.current?.endpoint || null, key: state.current?.options.applicationServerKey ? [...new Uint8Array(state.current.options.applicationServerKey)] : null }));
      const makeSub = (endpoint, key) => ({
        endpoint,
        options: { applicationServerKey: key },
        toJSON: () => ({ endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }),
        unsubscribe: async () => {
          state.unsubscribed++;
          state.current = null;
          persist();
          return true;
        },
      });
      if (saved) {
        if (saved.endpoint) state.current = makeSub(saved.endpoint, saved.key ? new Uint8Array(saved.key).buffer : null);
      } else if (o.existing) state.current = makeSub(o.existing, null);
      if (o.record && !saved) localStorage.setItem(`tt.push.device.${userId}`, JSON.stringify({ endpoint: o.record }));
      if (o.standalone) Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
      if (o.noPush) {
        delete window.PushManager;
        return;
      }
      const ask = async () => {
        state.prompts++;
        if (state.permission === 'default') state.permission = o.answer || 'granted';
        persist();
        return state.permission;
      };
      const reg = {
        scope: location.href,
        pushManager: {
          getSubscription: async () => state.current,
          subscribe: async (opts) => {
            state.subscribeCalls.push({ userVisibleOnly: opts.userVisibleOnly, keyLength: new Uint8Array(opts.applicationServerKey).length });
            if ((await ask()) !== 'granted') throw new DOMException('Permission denied', 'NotAllowedError');
            state.current = makeSub(`https://web.push.apple.com/fake-${state.subscribeCalls.length}`, opts.applicationServerKey);
            persist();
            return state.current;
          },
        },
      };
      Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg), configurable: true });
      Object.defineProperty(Notification, 'permission', { get: () => state.permission, configurable: true });
      Notification.requestPermission = ask;
    },
    { o, userId: EDITOR_USER.id },
  );
}

/**
 * Mock of the `push` Edge Function. Registered after mockSupabase, so it wins over its catch-all.
 * @param {import('playwright/test').Page} page
 */
export async function mockPushFunction(page, { known = [], failWrites = false } = {}) {
  const fn = { calls: [], subs: new Map(known.map((e) => [e, { endpoint: e, locale: 'es', meals: true, due: true }])), failWrites, testStatus: 200 };
  await page.route(`${SUPABASE_URL}/functions/v1/push`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(req.postData() || '{}');
    fn.calls.push(body);
    const json = (status, b) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (!(req.headers()['authorization'] || '').startsWith('Bearer ')) return json(401, { error: 'unauthorized' });
    if (fn.failWrites && body.action !== 'config') return json(500, { error: 'server_error' });
    switch (body.action) {
      case 'config':
        return json(200, { public_key: PUBLIC_KEY, subscription: (body.endpoint && fn.subs.get(body.endpoint)) || null });
      case 'subscribe': {
        if (body.old_endpoint) fn.subs.delete(body.old_endpoint);
        const row = { endpoint: body.subscription.endpoint, locale: body.locale, meals: true, due: true, ...(fn.subs.get(body.subscription.endpoint) || {}) };
        row.locale = body.locale;
        fn.subs.set(row.endpoint, row);
        return json(200, { subscription: row });
      }
      case 'update_prefs': {
        const row = fn.subs.get(body.endpoint);
        if (!row) return json(404, { error: 'not_found' });
        if (body.meals != null) row.meals = body.meals;
        if (body.due != null) row.due = body.due;
        if (body.locale) row.locale = body.locale;
        return json(200, { subscription: row });
      }
      case 'unsubscribe':
        fn.subs.delete(body.endpoint);
        return json(200, { ok: true });
      case 'test':
        if (!fn.subs.has(body.endpoint)) return json(404, { error: 'not_found' });
        return fn.testStatus === 200 ? json(200, { sent: true }) : json(fn.testStatus, { error: fn.testStatus === 410 ? 'gone' : 'push_failed' });
      default:
        return json(400, { error: 'bad_request' });
    }
  });
  return fn;
}

/** @param {import('playwright/test').Page} page */
export async function openSettings(page, { browser = {}, fn = {}, locale, mode = 'asEditor', fixtures } = {}) {
  await fakeBrowserPush(page, browser);
  const sb = await mockSupabase(page, { mode, fixtures });
  const push = await mockPushFunction(page, fn);
  if (locale) await page.addInitScript((l) => localStorage.setItem('tt.locale', JSON.stringify(l)), locale);
  await page.goto('./#/profile');
  await expect(page.locator('.tabbar')).toBeVisible();
  return { sb, push };
}

