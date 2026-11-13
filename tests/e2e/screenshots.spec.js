// Visual review screenshots (not part of `npm run check`).
//   SCREENSHOT_DIR=../review/foundation npm run screenshots
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
// Full-page shots hide the fixed tab bar, which would otherwise be painted mid-page.
const shot = (page, name, fullPage = false) =>
  page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage, style: fullPage ? '.tabbar { display: none !important; }' : undefined });
const settle = (page) => page.waitForTimeout(400);

for (const id of ['today', 'log', 'health', 'learn', 'profile']) {
  test(`tab ${id} (es, light)`, async ({ page }) => {
    await openApp(page, `/${id}`);
    await settle(page);
    await shot(page, `${id}-es-light`);
  });
}

test('today (en)', async ({ page }) => {
  await openApp(page, '/today', { locale: 'en' });
  await settle(page);
  await shot(page, 'today-en-light');
});

test('today (dark)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, '/today', { mode: 'asEditor' });
  await settle(page);
  await shot(page, 'today-es-dark-editor');
});

test('sign-in sheet', async ({ page }) => {
  await openApp(page, '/profile');
  await page.getByTestId('header-sign-in').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await settle(page);
  await shot(page, 'sign-in-sheet');
});

test('profile (editor)', async ({ page }) => {
  await openApp(page, '/profile', { mode: 'asEditor' });
  await settle(page);
  await shot(page, 'profile-editor');
});

test('kitchen sink', async ({ page }) => {
  await openApp(page, '/dev/ui');
  await settle(page);
  await shot(page, 'kitchen-sink', true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  await shot(page, 'kitchen-sink-dark', true);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Abrir hoja' }).click();
  await settle(page);
  await shot(page, 'kitchen-sheet');
});
