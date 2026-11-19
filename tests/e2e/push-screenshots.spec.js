// Review screenshots of Ajustes → Notificaciones in every state (not part of `npm run check`).
//   SCREENSHOT_DIR=/home/claude/review/push E2E_PORT=4199 npm run test:e2e -- tests/e2e/push-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openSettings, IPHONE_UA } from './push-fixtures.js';
import { EDITOR_USER } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');

const KNOWN = 'https://web.push.apple.com/known';
const on = { browser: { permission: 'granted', existing: KNOWN, record: KNOWN }, fn: { known: [KNOWN] } };

/** @param {import('playwright/test').Page} page @param {string} name @param {string} testid */
async function shot(page, name, testid) {
  const el = page.getByTestId(testid);
  await expect(el).toBeVisible();
  await page.getByTestId('push-settings').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  // No horizontal overflow in the section.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(dir || '.', `${name}.png`) });
}

const cases = [
  ['off-es', {}, 'push-enable'],
  ['on-es', on, 'push-test'],
  ['on-en', { ...on, locale: 'en' }, 'push-test'],
  ['denied-es', { browser: { permission: 'denied' } }, 'push-denied'],
  ['lost-es', { browser: { permission: 'default', record: 'https://web.push.apple.com/gone' } }, 'push-lost'],
  ['unsupported-es', { browser: { noPush: true } }, 'push-unsupported'],
];
for (const [name, opts, testid] of cases) {
  test(name, async ({ page }) => {
    await openSettings(page, opts);
    await shot(page, name, testid);
  });
}

for (const [name, theme] of [['on-dark', { theme: 'default', mode: 'dark' }], ['denied-rose-dark', { theme: 'rose', mode: 'dark' }], ['denied-rose-light', { theme: 'rose', mode: 'light' }]]) {
  test(name, async ({ page }) => {
    await page.addInitScript((c) => localStorage.setItem('tt.theme.active', JSON.stringify(c)), theme);
    const fixtures = { user_settings: [{ user_id: EDITOR_USER.id, theme: theme.theme, color_mode: theme.mode, created_at: '2026-11-13T15:00:00.000Z', updated_at: '2026-11-13T15:00:00.000Z', created_by: EDITOR_USER.id, created_by_name: 'Alex' }] };
    await openSettings(page, { ...(name.startsWith('on') ? on : { browser: { permission: 'denied' } }), fixtures });
    await shot(page, name, name.startsWith('on') ? 'push-test' : 'push-denied');
  });
}

for (const locale of ['es', 'en']) {
  test(`install-${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CO', serviceWorkers: 'block' });
    const page = await context.newPage();
    await openSettings(page, { browser: { noPush: true }, locale });
    await shot(page, `install-${locale}`, 'push-install');
    await context.close();
  });
}
