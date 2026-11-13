// Review screenshots for the Today and Log features (skipped unless SCREENSHOT_DIR is set).
//   SCREENSHOT_DIR=../review/today-log E2E_PORT=4181 node scripts/bin.mjs playwright test tests/e2e/today-log-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
const shot = (page, name, fullPage = true) =>
  page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage, style: fullPage ? '.tabbar { display: none !important; } .fab { display: none !important; }' : undefined });
const settle = (page) => page.waitForTimeout(400);

for (const scheme of ['light', 'dark']) {
  for (const locale of ['es', 'en']) {
    for (const mode of ['asEditor', 'signedOut']) {
      test(`today ${scheme} ${locale} ${mode}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openApp(page, '/today', { mode, locale, fixtures: richFixtures() });
        await settle(page);
        await shot(page, `today-${locale}-${scheme}-${mode === 'asEditor' ? 'editor' : 'visitor'}`);
      });
    }
  }
}

test('today: pee choice open and viewport', async ({ page }) => {
  await openApp(page, '/today', { mode: 'asEditor', fixtures: richFixtures() });
  await page.getByTestId('quick-pee').click();
  await settle(page);
  await shot(page, 'today-quick-choice', false);
});

for (const scheme of ['light', 'dark']) {
  test(`log day view ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/log', { mode: 'asEditor', fixtures: richFixtures() });
    await settle(page);
    await shot(page, `log-day-es-${scheme}`);
  });
  test(`log stats ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/log/stats', { fixtures: richFixtures() });
    await settle(page);
    await shot(page, `log-stats-7-es-${scheme}`);
    await page.getByRole('radio', { name: 'Últimos 14 días' }).click();
    await settle(page);
    await shot(page, `log-stats-14-es-${scheme}`);
  });
}

test('log day view en, visitor, and empty day', async ({ page }) => {
  await openApp(page, '/log', { locale: 'en', fixtures: richFixtures() });
  await settle(page);
  await shot(page, 'log-day-en-visitor');
  await page.goto('./#/log?day=2026-10-01');
  await settle(page);
  await shot(page, 'log-day-empty-en');
});

test('edit sheet', async ({ page }) => {
  await openApp(page, '/log', { mode: 'asEditor', fixtures: richFixtures() });
  await page.getByTestId('timeline').getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await settle(page);
  await shot(page, 'log-edit-sheet', false);
  await page.keyboard.press('Escape');
  await page.getByTestId('fab-add').click();
  await page.getByRole('dialog').getByLabel('Tipo').selectOption('meal');
  await settle(page);
  await shot(page, 'log-add-meal-sheet', false);
});

test('stats en', async ({ page }) => {
  await openApp(page, '/log/stats', { locale: 'en', fixtures: richFixtures() });
  await settle(page);
  await shot(page, 'log-stats-en');
});
