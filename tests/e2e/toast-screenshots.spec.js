// Review screenshots for toast placement (skipped unless SCREENSHOT_DIR is set).
//   SCREENSHOT_DIR=../review/fix-toast E2E_PORT=4197 node scripts/bin.mjs playwright test tests/e2e/toast-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');

/** Wait until every toast finished entering, then take the viewport. */
async function shot(page, name) {
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('.toast')].every((el) => el.getAnimations().every((a) => a.playState === 'finished'))))
    .toBe(true);
  await page.screenshot({ path: resolve(dir || '.', `${name}.png`) });
}

const updateNotice = (page) =>
  page.evaluate(async () => {
    const { toast } = await import(new URL('src/lib/toast.js', document.baseURI).href);
    const { t } = await import(new URL('src/lib/i18n.js', document.baseURI).href);
    toast(t('pwa.updateReady'), { duration: 0, action: { label: t('pwa.reload'), onClick: () => {} } });
  });

for (const scheme of ['light', 'dark']) {
  for (const locale of /** @type {const} */ (['es', 'en'])) {
    test(`meal logged, add button free (${scheme}, ${locale})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page, '/today', { mode: 'asEditor', locale, fixtures: richFixtures() });
      const meal = page.getByTestId('meal-4');
      await meal.getByRole('button').last().click();
      await expect(page.locator('.toast')).toHaveCount(1);
      await shot(page, `today-meal-toast-${locale}-${scheme}`);
    });
  }
  test(`two toasts and the update notice at 320 px (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/today', { mode: 'asEditor', fixtures: richFixtures() });
    await page.getByTestId('quick-pee').click();
    await page.getByRole('button', { name: 'Afuera', exact: true }).click();
    await updateNotice(page);
    await expect(page.locator('.toast')).toHaveCount(2);
    await shot(page, `today-two-toasts-320-${scheme}`);
  });
  test(`assistant toast above the composer (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await updateNotice(page);
    await shot(page, `assistant-toast-${scheme}`);
  });
  test(`visitor toast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/today', { fixtures: richFixtures() });
    await updateNotice(page);
    await shot(page, `today-visitor-toast-${scheme}`);
  });
}
