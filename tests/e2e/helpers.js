// Shared e2e helpers. Feature tests should start with:
//
//   import { test, expect } from 'playwright/test';
//   import { openApp } from './helpers.js';
//
//   test('editor adds a weight', async ({ page }) => {
//     const sb = await openApp(page, '/health', { mode: 'asEditor' });
//     ...
//   });
import { expect } from 'playwright/test';
import { mockSupabase } from './supabase-mock.js';

export { mockSupabase };
export * from './fixtures.js';

/**
 * Mock Supabase, optionally set the locale, open a route and wait for the shell.
 * @param {import('playwright/test').Page} page
 * @param {string} [path] app path such as '/today' or '/learn/faq'
 * @param {Parameters<typeof mockSupabase>[1] & { locale?: 'es' | 'en' }} [opts]
 */
export async function openApp(page, path = '/today', opts = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  const sb = await mockSupabase(page, opts);
  if (opts.locale) {
    await page.addInitScript((l) => localStorage.setItem('tt.locale', JSON.stringify(l)), opts.locale);
  }
  await page.goto(`./#${path}`);
  await expect(page.locator('.tabbar')).toBeVisible();
  if (opts.mode === 'asEditor') await expect(page.getByTestId('header-editor')).toBeVisible();
  return Object.assign(sb, { pageErrors: errors });
}

/** The visible toast with this text. @param {import('playwright/test').Page} page @param {string | RegExp} text */
export const toastWith = (page, text) => page.locator('.toast').filter({ hasText: text });

/** Tab bar link for a tab id. @param {import('playwright/test').Page} page @param {string} id */
export const tab = (page, id) => page.locator(`.tabbar a[data-tab="${id}"]`);
