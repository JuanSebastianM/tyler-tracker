// Review screenshots of offline logging (not part of `npm run check`): pending marks, the header
// indicator, the sync sheet with the "could not be saved" list, and the offline messages, in light
// and dark, Spanish and English, plus the rose theme.
//   SCREENSHOT_DIR=/home/claude/review/offline E2E_PORT=4198 npm run test:e2e -- tests/e2e/offline-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp, EDITOR_USER } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
test.describe.configure({ timeout: 60_000 });

/** Toasts are hidden so the screen under them can be reviewed (their placement is reviewed elsewhere). */
const shot = async (page, name, { toasts = false } = {}) => {
  if (!toasts) await page.addStyleTag({ content: '.toaster { display: none !important; }' });
  await page.screenshot({ path: resolve(dir || '.', `${name}.png`) });
  if (!toasts) await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent?.includes('.toaster { display: none') && s.remove()));
};
/** The pending mark fades in after 1.2 s. */
const settle = (page) => page.waitForTimeout(1600);

const VARIANTS = [
  { theme: 'default', mode: 'light', locale: 'es' },
  { theme: 'default', mode: 'dark', locale: 'es' },
  { theme: 'default', mode: 'light', locale: 'en' },
  { theme: 'rose', mode: 'dark', locale: 'es' },
];

for (const v of VARIANTS) {
  const name = (s) => `${s}-${v.theme}-${v.mode}-${v.locale}`;
  const es = v.locale === 'es';
  test(`offline ${v.theme} ${v.mode} ${v.locale}`, async ({ page, context }) => {
    await page.addInitScript((c) => localStorage.setItem('tt.theme.active', JSON.stringify(c)), { theme: v.theme, mode: v.mode });
    const userSettings = [{ user_id: EDITOR_USER.id, theme: v.theme, color_mode: v.mode, created_at: '2026-11-13T15:00:00.000Z', updated_at: '2026-11-13T15:00:00.000Z' }];
    const sb = await openApp(page, '/today', { mode: 'asEditor', locale: v.locale, fixtures: { user_settings: userSettings } });
    await expect(page.locator('html')).toHaveAttribute('data-scheme', v.mode);
    sb.setOffline(true);
    await context.setOffline(true);
    await page.getByRole('button', { name: es ? 'Registrar comida 2' : 'Log meal 2', exact: true }).click();
    await page.getByTestId('quick-pee').click();
    await page.getByRole('button', { name: es ? 'Afuera' : 'Outside', exact: true }).click();
    await settle(page);
    await shot(page, name('today-pending'));

    await page.goto('./#/log');
    await page.locator('.tl-item.is-pending').last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page);
    await shot(page, name('log-pending'));

    await page.goto('./#/health/weight');
    await page.getByTestId('fab-add').click();
    await page.getByTestId('weight-form').getByLabel(es ? 'Peso' : 'Weight').fill('5,25');
    await page.getByTestId('form-save').click();
    await page.getByTestId('weight-row').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page);
    await shot(page, name('weight-pending'));

    await page.getByTestId('sync-indicator').click();
    await expect(page.getByTestId('sync-sheet')).toBeVisible();
    await settle(page);
    await shot(page, name('sync-sheet-offline'));
    await page.keyboard.press('Escape');

    await page.goto('./#/health/vaccines');
    await page.getByTestId('fab-add').click();
    await page.getByTestId('photo-input').setInputFiles({ name: 'carne.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
    await page.getByTestId('photo-offline-note').scrollIntoViewIfNeeded();
    await settle(page);
    await shot(page, name('vaccine-photo-offline'));
    await page.keyboard.press('Escape');

    await page.goto('./#/log?day=2026-10-01');
    await expect(page.getByTestId('day-needs-connection')).toBeVisible();
    await shot(page, name('log-day-offline'));

    // The server refuses the weight: it lands in the "could not be saved" list.
    sb.setReject((table) => table === 'weights');
    sb.setOffline(false);
    await context.setOffline(false);
    await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-rejected', '1');
    await settle(page);
    await shot(page, name('rejected-indicator'), { toasts: true });
    await page.getByTestId('sync-indicator').click();
    await expect(page.getByTestId('rejected-item')).toHaveCount(1);
    await settle(page);
    await shot(page, name('sync-sheet-rejected'));
  });
}

test('visitor offline and sign-in note', async ({ page, context }) => {
  const sb = await openApp(page, '/today');
  sb.setOffline(true);
  await context.setOffline(true);
  await expect(page.getByTestId('sync-indicator')).toBeVisible();
  await shot(page, 'visitor-offline');
  await page.getByTestId('header-sign-in').click();
  await settle(page);
  await shot(page, 'sign-in-offline');
});

test('session ended with changes waiting', async ({ page, context }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  sb.setOffline(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await page.evaluate(() => localStorage.removeItem('tt-auth'));
  sb.setRefresh('invalid');
  sb.setOffline(false);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('sync-indicator')).toBeVisible();
  await page.getByTestId('sync-indicator').click();
  await settle(page);
  await shot(page, 'sync-sheet-sign-in');
  await shot(page, 'sync-sheet-sign-in-toasts', { toasts: true });
});
