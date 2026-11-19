// The real service worker of the BUILT site (scripts/build-site.mjs) with src/lib/sw-push.js loaded:
// a push delivered by the browser (CDP ServiceWorker.deliverPushMessage, the same path DevTools uses)
// makes the worker show a notification, and a tap on it routes the open app to the notification's screen.
//
// What "shows a notification" is measured by: every showNotification() call the worker makes is
// recorded (a pass-through wrapper on the real registration) with whether the browser accepted it.
// Chrome's getNotifications() is not used: under load (CI, or 8 local workers) it sometimes leaves
// out a notification although showNotification() resolved and no notificationclose fired
// (diagnostics of CI runs 44466332635 and 44467357397; about 1 in 150 local runs).
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
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  // A browser that cannot show notifications at all (the headless shell rejects showNotification)
  // would prove nothing: fail on that cause first.
  const probe = await page.evaluate(async () => {
    try {
      await (await navigator.serviceWorker.ready).showNotification('probe', { tag: 'probe' });
      return 'shown';
    } catch (e) {
      return `showNotification failed: ${e}`;
    }
  });
  expect(probe, 'this browser must be able to show notifications').toBe('shown');
  // What the worker logs (sw-push.js reports a failed showNotification) goes into the test output.
  const worker = page.context().serviceWorkers().find((w) => w.url().startsWith(BASE));
  if (!worker) throw new Error('no service worker');
  worker.on('console', (m) => console.log(`[sw] ${m.text()}`));
  await worker.evaluate(() => {
    /** @type {any[]} */
    const calls = [];
    /** @type {any} */ (self).__shown = calls;
    const reg = /** @type {any} */ (self).registration;
    const real = reg.showNotification.bind(reg);
    reg.showNotification = (title, options) => {
      const call = { title, body: options?.body, tag: options?.tag, path: options?.data?.path, renotify: options?.renotify, result: 'pending' };
      calls.push(call);
      return real(title, options).then(
        (r) => ((call.result = 'shown'), r),
        (e) => ((call.result = `failed: ${e}`), Promise.reject(e)),
      );
    };
  });
  /** @param {any} payload */
  const deliver = (payload) => cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE.slice(0, -1), registrationId, data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  /** showNotification calls the worker made so far. */
  const shown = () => worker.evaluate(() => /** @type {any} */ (self).__shown.map((c) => ({ ...c })));
  return { deliver, shown };
}

test('every push shows a notification, even an unreadable one; a second meal alert reuses the tag', async ({ page }) => {
  const { deliver, shown } = await openWithWorker(page);
  const meal = { body: 'Aún no está registrada. Toca para registrarla.', tag: 'meal-2026-11-20-2', path: '/today', renotify: true, result: 'shown' };
  await deliver({ title: 'Comida 2 de Tyler · 11:30 a. m.', body: meal.body, path: '/today', tag: meal.tag });
  await expect.poll(shown).toEqual([{ title: 'Comida 2 de Tyler · 11:30 a. m.', ...meal }]);
  await deliver({ title: 'Tyler sigue esperando la comida 2', body: 'Era a las 11:30 a. m.', path: '/today', tag: meal.tag });
  await expect.poll(async () => (await shown())[1]).toEqual({ ...meal, title: 'Tyler sigue esperando la comida 2', body: 'Era a las 11:30 a. m.' });
  // Not JSON, then no payload at all: still a visible notification (iOS revokes the permission otherwise).
  await deliver('this is not json');
  await expect.poll(async () => (await shown())[2]).toEqual({ title: 'Tyler', body: 'Abre la app para ver el aviso. / Open the app to see the alert.', tag: 'tt', path: '/today', renotify: true, result: 'shown' });
  await deliver({ title: 'x', path: 'https://evil.example/' });
  await expect.poll(async () => (await shown())[3]).toMatchObject({ title: 'x', path: '/today', result: 'shown' });
  expect((await shown()).map((c) => c.result)).toEqual(['shown', 'shown', 'shown', 'shown']);
});

test('tapping a notification routes the open app to its screen', async ({ page, context }) => {
  const { deliver, shown } = await openWithWorker(page);
  await deliver({ title: 'Mañana: Puppy DP', body: 'Vacuna de Tyler.', path: '/health/vaccines', tag: 'due-vaccination-v1' });
  await expect.poll(async () => (await shown())[0]).toMatchObject({ path: '/health/vaccines', result: 'shown' });
  const worker = context.serviceWorkers().find((w) => w.url().startsWith(BASE));
  // The tap, dispatched in the worker as the OS would. The event carries the notification the
  // handler reads (data.path, close()); it is attached by hand so the test does not depend on
  // getNotifications() (see the note at the top).
  const closed = await worker.evaluate(async () => {
    let wasClosed = false;
    const event = new ExtendableEvent('notificationclick');
    Object.defineProperty(event, 'notification', { value: { data: { path: '/health/vaccines' }, close: () => (wasClosed = true) } });
    self.dispatchEvent(event);
    return wasClosed;
  });
  expect(closed).toBe(true);
  await expect(page).toHaveURL(/#\/health\/vaccines$/);
});
