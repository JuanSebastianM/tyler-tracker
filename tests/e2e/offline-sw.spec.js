// Offline against the BUILT site (scripts/build-site.mjs) with the service worker on: after the
// first online launch the app shell and every /content file are precached, so the app opens with
// no connection at all, reading content and the changes queued on the device (IndexedDB).
// The built folder gets the fake content (content-fixtures.js), never the real files.
import { test, expect } from 'playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSupabase, CONTENT_FIXTURES, contentItems } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.E2E_PORT || 4173) + 5;
const BASE = `http://127.0.0.1:${PORT}/`;

test.describe.configure({ mode: 'serial', timeout: 60_000 });
test.use({ serviceWorkers: 'allow', baseURL: BASE });

let dir = '';
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tt-offline-sw-'));
  execFileSync(process.execPath, ['scripts/build-site.mjs', dir], { cwd: ROOT, env: { ...process.env, GITHUB_SHA: 'ddddddd0000000000000000000000000000000000' }, stdio: 'ignore' });
  for (const [name, data] of Object.entries(CONTENT_FIXTURES)) writeFileSync(join(dir, 'content', `${name}.json`), JSON.stringify(data));
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

test('every content file is in the precache list', () => {
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  for (const name of Object.keys(CONTENT_FIXTURES)) expect(sw, name).toContain(JSON.stringify(`./content/${name}.json`));
});

test('no connection at all: the app opens, content reads, queued changes survive and sync once', async ({ page, context }) => {
  const sb = await mockSupabase(page, { mode: 'asEditor', now: null });
  await page.goto('./?sw=on#/learn');
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  const critical = contentItems('must-know').find((i) => i.priority === 'critical');
  await expect(page.getByText(critical.title.es, { exact: true })).toBeVisible();

  // Offline: log a pee.
  sb.setOffline(true);
  await context.setOffline(true);
  await page.goto('./?sw=on#/today');
  await page.getByTestId('quick-pee').click();
  await page.getByRole('button', { name: 'Afuera', exact: true }).click();
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-pending', '1');

  // Close and reopen with no connection: everything comes from the device.
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-pending', '1');
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-online', 'false');
  await page.goto('./?sw=on#/learn');
  await expect(page.getByText(critical.title.es, { exact: true })).toBeVisible();
  await page.goto('./?sw=on#/learn/faq');
  await expect(page.getByText(contentItems('faq')[0].question.es, { exact: true }).first()).toBeVisible();
  await page.goto('./?sw=on#/log');
  await expect(page.getByTestId('timeline').getByTestId('pending-mark')).toHaveCount(1);
  expect(sb.restCalls('routine_events', 'POST')).toHaveLength(0);

  // Back online: sent once.
  sb.setOffline(false);
  await context.setOffline(false);
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);
  expect(sb.restCalls('routine_events', 'POST')).toHaveLength(1);
  expect(sb.db.routine_events.filter((e) => e.type === 'pee')).toHaveLength(2);
});
