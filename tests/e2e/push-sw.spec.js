// The real service worker of the BUILT site (scripts/build-site.mjs) with src/lib/sw-push.js loaded:
// a push delivered by the browser (CDP ServiceWorker.deliverPushMessage, the same path DevTools uses)
// shows a notification, and a tap on it routes the open app to the notification's screen.
import { test, expect } from 'playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { mockSupabase } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');

/** A free local port (each worker builds and serves its own copy of the site). */
const freePort = () =>
  new Promise((res) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (srv.address());
      srv.close(() => res(port));
    });
  });
let BASE = '';

test.describe.configure({ mode: 'serial', timeout: 45_000 });
// channel 'chromium': the full Chromium build in new headless mode. Playwright's default headless
// browser (chromium-headless-shell, what CI runs) has no notification support: Notification.permission
// stays 'denied' whatever the context grants, so showNotification() rejects even though the push
// event is delivered. Locally the config's /usr/bin/google-chrome (also new headless) is used instead.
test.use({ serviceWorkers: 'allow', permissions: ['notifications'], channel: 'chromium' });

let dir = '';
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

test.beforeAll(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}/`;
  dir = mkdtempSync(join(tmpdir(), 'tt-push-'));
  execFileSync(process.execPath, ['scripts/build-site.mjs', dir], { cwd: ROOT, env: { ...process.env, GITHUB_SHA: 'bbbbbbb0000000000000000000000000000000000' }, stdio: 'ignore' });
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(PORT), '--root', dir], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}index.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Open the built app with its service worker controlling the page; returns a CDP push sender. */
async function openWithWorker(page) {
  await mockSupabase(page, { mode: 'asEditor', now: null });
  const cdp = await page.context().newCDPSession(page);
  /** @type {string | null} */
  let registrationId = null;
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    const reg = e.registrations.find((r) => r.scopeURL === BASE && !r.isDeleted);
    if (reg) registrationId = reg.registrationId;
  });
  await cdp.send('ServiceWorker.enable');
  await page.goto(`${BASE}?sw=on#/today`);
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  await expect.poll(() => registrationId).not.toBeNull();
  // Fail on the cause, not on a timeout: a browser that cannot show notifications proves nothing here.
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  const probe = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    try {
      await reg.showNotification('probe', { tag: 'probe' });
    } catch (e) {
      return `showNotification failed: ${e}`;
    }
    const shown = await reg.getNotifications({ tag: 'probe' });
    shown.forEach((n) => n.close());
    return `shown ${shown.length}`;
  });
  expect(probe, 'this browser must be able to show and list notifications').toBe('shown 1');
  // What the worker logs (sw-push.js reports a failed showNotification) goes into the test output.
  const worker = page.context().serviceWorkers().find((w) => w.url().startsWith(BASE));
  worker?.on('console', (m) => console.log(`[sw] ${m.text()}`));
  // Test-only listener: says in the output whether the browser delivered the push at all.
  await worker?.evaluate(() => {
    self.addEventListener('push', () => console.log('push event received'));
    self.addEventListener('notificationclose', (e) => console.log('CLOSED ' + e.notification.tag));
    const orig = self.registration.showNotification.bind(self.registration);
    self.registration.showNotification = (t, o) => orig(t, o).then((r) => (console.log('SHOWN ' + o.tag), r), (e) => (console.log('SHOWFAIL ' + e), Promise.reject(e)));
  });
  /** @param {any} payload */
  const deliver = (payload) => cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE.slice(0, -1), registrationId, data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const notifications = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })));
  return { deliver, notifications };
}

test('a push shows a notification, even an unreadable one; the same tag replaces it', async ({ page }) => {
  const { deliver, notifications } = await openWithWorker(page);
  await deliver({ title: 'Comida 2 de Tyler · 11:30 a. m.', body: 'Aún no está registrada. Toca para registrarla.', path: '/today', tag: 'meal-2026-11-20-2' });
  await expect.poll(notifications).toEqual([{ title: 'Comida 2 de Tyler · 11:30 a. m.', body: 'Aún no está registrada. Toca para registrarla.', tag: 'meal-2026-11-20-2', data: { path: '/today' } }]).catch(async (e) => { console.log('LIST1', JSON.stringify(await notifications())); throw e; });
  await deliver({ title: 'Tyler sigue esperando la comida 2', body: 'Era a las 11:30 a. m.', path: '/today', tag: 'meal-2026-11-20-2' });
  await expect.poll(async () => (await notifications()).map((n) => n.title)).toEqual(['Tyler sigue esperando la comida 2']);
  await deliver('this is not json');
  await expect.poll(async () => (await notifications()).length).toBe(2).catch(async (e) => { console.log('LIST', JSON.stringify(await notifications())); throw e; });
  expect((await notifications()).find((n) => n.tag === 'tt').title).toBe('Tyler');
});

test('tapping a notification routes the open app to its screen', async ({ page, context }) => {
  const { deliver, notifications } = await openWithWorker(page);
  await deliver({ title: 'Mañana: Puppy DP', body: 'Vacuna de Tyler.', path: '/health/vaccines', tag: 'due-vaccination-v1' });
  await expect.poll(async () => (await notifications()).length).toBe(1);
  const [worker] = context.serviceWorkers();
  // Dispatch the click in the worker the way the OS would (a synthetic NotificationEvent).
  await worker.evaluate(async () => {
    const [n] = await self.registration.getNotifications();
    self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
  });
  await expect(page).toHaveURL(/#\/health\/vaccines$/);
  await expect.poll(async () => (await notifications()).length).toBe(0); // closed by the tap
});
