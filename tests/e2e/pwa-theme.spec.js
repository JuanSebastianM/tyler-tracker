// The person's theme against the BUILT site (scripts/build-site.mjs) with the service worker on:
// the theme boot script and themes.css are precached, and the saved theme is applied before the
// body is parsed (no flash of the default theme), online and offline.
import { test, expect } from 'playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSupabase } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.E2E_PORT || 4173) + 2;
const BASE = `http://127.0.0.1:${PORT}/`;
const THEME_FILES = ['./src/lib/theme-boot.js', './src/styles/themes.css', './src/styles/tokens.css', './src/lib/theme.js'];

test.describe.configure({ mode: 'serial', timeout: 60_000 });
test.use({ serviceWorkers: 'allow', baseURL: BASE });

let dir = '';
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tt-theme-sw-'));
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

test('the built service worker precaches the theme boot script and stylesheets', () => {
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  for (const f of THEME_FILES) expect(sw, f).toContain(JSON.stringify(f));
  // The boot script is a classic script linked from index.html (CSP: no inline script).
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  expect(index).toMatch(/<script src="src\/lib\/theme-boot\.js"><\/script>/);
  expect(index.indexOf('theme-boot.js')).toBeLessThan(index.indexOf('<body>'));
});

test('the saved theme is painted from the first frame, online and offline', async ({ page, context }) => {
  // A visitor's choice on this device and the launch theme, as the app stores them, and a probe that records <html> when <body> appears:
  // anything set then was set before the first paint.
  await page.addInitScript(() => {
    const choice = JSON.stringify({ theme: 'rose', mode: 'dark' });
    localStorage.setItem('tt.theme.device', choice);
    localStorage.setItem('tt.theme.active', choice);
    const seen = /** @type {any} */ (window);
    new MutationObserver((_, obs) => {
      if (!document.body) return;
      obs.disconnect();
      const el = document.documentElement;
      seen.__firstBody = { theme: el.dataset.theme, scheme: el.dataset.scheme, bg: getComputedStyle(el).getPropertyValue('--c-bg').trim() };
    }).observe(document, { childList: true, subtree: true });
  });
  await mockSupabase(page, { mode: 'signedOut', now: null });
  await page.goto('./?sw=on#/today');
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  const cached = await page.evaluate(async (files) => {
    const out = {};
    for (const f of files) out[f] = !!(await caches.match(new URL(f, location.href).href));
    return out;
  }, THEME_FILES);
  expect(cached).toEqual(Object.fromEntries(THEME_FILES.map((f) => [f, true])));
  const rose = { theme: 'rose', scheme: 'dark', bg: '#181015' };
  expect(await page.evaluate(() => /** @type {any} */ (window).__firstBody)).toEqual(rose);

  // Offline launch: everything comes from the service worker, still rose dark from the first frame.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  expect(await page.evaluate(() => /** @type {any} */ (window).__firstBody)).toEqual(rose);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#181015');
  await context.setOffline(false);
});
