// Per-person colour theme (Ajustes → Tema): visitors keep it on the device, editors in
// user_settings (own row only); the saved theme is painted before the app boots.
import { test, expect } from 'playwright/test';
import { openApp, toastWith, mockSupabase, EDITOR_USER, EDITOR_USER_2, EDITOR_NAME_2, defaultFixtures } from './helpers.js';

const ROSE_LIGHT_BG = '#f8f0f3';
const ROSE_DARK_BG = '#181015';
const DEFAULT_LIGHT_BG = '#f2f5ef';
const DEFAULT_DARK_BG = '#111713';

/** Theme attributes on <html>, a few computed tokens and the theme-color metas. @param {import('playwright/test').Page} page */
const themeState = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    return {
      theme: root.getAttribute('data-theme'),
      mode: root.getAttribute('data-mode'),
      scheme: root.getAttribute('data-scheme'),
      bg: cs.getPropertyValue('--c-bg').trim(),
      gold: cs.getPropertyValue('--c-gold').trim(),
      metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')),
    };
  });

/** @param {import('playwright/test').Page} page */
const themeCard = (page) => page.getByTestId('theme-settings');

/** @param {import('playwright/test').Page} page @param {string} name */
async function pickTheme(page, name) {
  await themeCard(page).getByRole('radio', { name }).click();
  await expect(themeCard(page).getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
}

/** @param {import('playwright/test').Page} page */
async function signInViaSheet(page, email) {
  await page.getByTestId('header-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Iniciar sesión' });
  await dialog.getByLabel('Correo').fill(email);
  await dialog.getByLabel('Contraseña').fill('correct-password');
  await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('header-editor')).toBeVisible();
}

/** A new browser context with the project's settings (a separate device). @param {import('playwright/test').Browser} browser */
async function newDevice(browser) {
  const u = test.info().project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL, viewport: u.viewport, deviceScaleFactor: u.deviceScaleFactor, isMobile: u.isMobile,
    hasTouch: u.hasTouch, locale: u.locale, timezoneId: u.timezoneId, colorScheme: u.colorScheme, serviceWorkers: 'block',
  });
  return { ctx, page: await ctx.newPage() };
}

const twoEditors = () => [
  ...defaultFixtures().editors,
  { user_id: EDITOR_USER_2.id, display_name: EDITOR_NAME_2, created_at: '2026-11-10T15:00:00.000Z' },
];
const roseRow = (userId = EDITOR_USER.id, mode = 'auto') => ({
  user_id: userId, theme: 'rose', color_mode: mode,
  created_at: '2026-11-12T15:00:00.000Z', updated_at: '2026-11-12T15:00:00.000Z', created_by: userId, created_by_name: 'Alex',
});

test('default theme is unchanged for someone who never chose (light and dark tokens)', async ({ page }) => {
  await openApp(page, '/profile');
  const expected = {
    light: { '--c-bg': '#f2f5ef', '--c-surface': '#ffffff', '--c-surface-2': '#e8ede4', '--c-ink': '#1d2a22', '--c-ink-2': '#536058',
      '--c-line': '#d6ddd1', '--c-gold': '#e8a83a', '--c-gold-strong': '#d18e1c', '--c-on-gold': '#2b1d02', '--c-gold-soft': '#fbedcf',
      '--c-on-gold-soft': '#5a3b00', '--c-gold-ink': '#8a5700', '--c-green': '#2e6b4c', '--c-red': '#b0321d', '--c-blue': '#2c5d86',
      '--c-focus': '#1f6fd1' },
    dark: { '--c-bg': '#111713', '--c-surface': '#1a221d', '--c-surface-2': '#242e28', '--c-ink': '#e9efe9', '--c-ink-2': '#a5b2aa',
      '--c-line': '#2f3b34', '--c-gold': '#f0b54c', '--c-gold-strong': '#f6c56a', '--c-on-gold': '#2b1d02', '--c-gold-soft': '#3b2e13',
      '--c-on-gold-soft': '#f7d9a0', '--c-gold-ink': '#f3c46c', '--c-green': '#7fc79f', '--c-red': '#f29482', '--c-blue': '#8fbbe3',
      '--c-focus': '#7db4ff' },
  };
  const read = (names) =>
    page.evaluate((n) => Object.fromEntries(n.map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])), names);
  expect(await read(Object.keys(expected.light))).toEqual(expected.light);
  // Rendered colours of the shell match the original palette too.
  const tabBg = () => page.locator('.tab-active .tab-icon').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await tabBg()).toBe('rgb(232, 168, 58)');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(242, 245, 239)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await themeState(page)).scheme).toBe('dark');
  expect(await read(Object.keys(expected.dark))).toEqual(expected.dark);
  await expect.poll(tabBg).toBe('rgb(240, 181, 76)'); // after the 220 ms transition
  expect((await themeState(page)).metas).toEqual([DEFAULT_DARK_BG, DEFAULT_DARK_BG]);
  await expect(themeCard(page).getByRole('radio', { name: 'Predeterminado' })).toHaveAttribute('aria-checked', 'true');
  await expect(themeCard(page).getByRole('radio', { name: 'Automático' })).toHaveAttribute('aria-checked', 'true');
});

test('visitor picks a theme: applies at once, stays on the device and survives a reload', async ({ page }) => {
  const sb = await openApp(page, '/profile');
  await expect(themeCard(page)).toContainText('en este dispositivo');
  await pickTheme(page, 'Rosa');
  expect(await themeState(page)).toMatchObject({ theme: 'rose', mode: 'auto', scheme: 'light', bg: ROSE_LIGHT_BG, metas: [ROSE_LIGHT_BG, ROSE_LIGHT_BG] });
  // The rest of the app follows the tokens: the active tab uses the rose accent.
  const accent = () => page.locator('.tab-active .tab-icon').evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(accent).toBe('rgb(238, 141, 176)');
  expect(sb.restCalls('user_settings')).toHaveLength(0);

  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  expect(await themeState(page)).toMatchObject({ theme: 'rose', bg: ROSE_LIGHT_BG });
  await expect(themeCard(page).getByRole('radio', { name: 'Rosa' })).toHaveAttribute('aria-checked', 'true');
  expect(sb.pageErrors).toEqual([]);
});

test('the saved theme is painted before the app boots (no flash of the default theme)', async ({ page }) => {
  await openApp(page, '/today');
  await page.evaluate(() => localStorage.setItem('tt.theme.active', JSON.stringify({ theme: 'rose', mode: 'dark' })));
  // Keep the app from booting at all: only index.html, the CSS and theme-boot.js run.
  await page.route('**/src/main.js', (route) => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await themeState(page)).toMatchObject({ theme: 'rose', mode: 'dark', scheme: 'dark', bg: ROSE_DARK_BG, metas: [ROSE_DARK_BG, ROSE_DARK_BG] });
});

test('an unknown saved theme falls back to the default', async ({ page }) => {
  await openApp(page, '/today');
  await page.evaluate(() => localStorage.setItem('tt.theme.active', JSON.stringify({ theme: 'peach', mode: 'sepia' })));
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  expect(await themeState(page)).toMatchObject({ theme: 'default', mode: 'auto', bg: DEFAULT_LIGHT_BG });
});

test('mode override beats the device setting', async ({ page }) => {
  await openApp(page, '/profile');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await themeState(page)).bg).toBe(DEFAULT_DARK_BG);
  await themeCard(page).getByRole('radio', { name: 'Claro' }).click();
  expect(await themeState(page)).toMatchObject({ mode: 'light', scheme: 'light', bg: DEFAULT_LIGHT_BG, metas: [DEFAULT_LIGHT_BG, DEFAULT_LIGHT_BG] });
  // Still light after a reload on a dark device.
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  expect(await themeState(page)).toMatchObject({ mode: 'light', scheme: 'light' });

  await page.emulateMedia({ colorScheme: 'light' });
  await pickTheme(page, 'Rosa');
  await themeCard(page).getByRole('radio', { name: 'Oscuro' }).click();
  expect(await themeState(page)).toMatchObject({ theme: 'rose', mode: 'dark', scheme: 'dark', bg: ROSE_DARK_BG });
  // Automático follows the device again.
  await themeCard(page).getByRole('radio', { name: 'Automático' }).click();
  expect(await themeState(page)).toMatchObject({ mode: 'auto', scheme: 'light', bg: ROSE_LIGHT_BG });
});

test('editor picks a theme: upserted to their own user_settings row, restored on a fresh device after sign-in', async ({ page, browser }) => {
  const sb = await openApp(page, '/profile', { mode: 'asEditor' });
  await expect(themeCard(page)).toContainText('se guarda en tu cuenta');
  await pickTheme(page, 'Lavanda');
  await themeCard(page).getByRole('radio', { name: 'Oscuro' }).click();
  await expect.poll(() => sb.db.user_settings.map((r) => [r.user_id, r.theme, r.color_mode])).toEqual([[EDITOR_USER.id, 'lavender', 'dark']]);
  const posts = sb.restCalls('user_settings', 'POST');
  expect(posts.length).toBeGreaterThanOrEqual(2);
  expect(posts[0].body).toEqual({ user_id: EDITOR_USER.id, theme: 'lavender', color_mode: 'auto' });
  expect(posts[0].search).toContain('on_conflict=user_id');
  // A visitor choice on this device was not touched.
  expect(await page.evaluate(() => localStorage.getItem('tt.theme.device'))).toBeNull();

  // Fresh device: empty localStorage, signed out, same database.
  const { ctx, page: fresh } = await newDevice(browser);
  const sb2 = await openApp(fresh, '/profile', { fixtures: { user_settings: structuredClone(sb.db.user_settings) } });
  expect(await themeState(fresh)).toMatchObject({ theme: 'default', scheme: 'light' });
  expect(sb2.restCalls('user_settings')).toHaveLength(0); // never requested for visitors
  await signInViaSheet(fresh, 'editor@example.test');
  await expect.poll(async () => (await themeState(fresh)).theme).toBe('lavender');
  expect(await themeState(fresh)).toMatchObject({ mode: 'dark', scheme: 'dark' });
  await expect(themeCard(fresh).getByRole('radio', { name: 'Lavanda' })).toHaveAttribute('aria-checked', 'true');
  // Signing out falls back to this device's own choice (none: default).
  await fresh.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect.poll(async () => (await themeState(fresh)).theme).toBe('default');
  expect(await themeState(fresh)).toMatchObject({ mode: 'auto', scheme: 'light' });
  await ctx.close();
});

test('editor theme write fails: rolls back to the previous theme with a toast', async ({ page }) => {
  const sb = await openApp(page, '/profile', { mode: 'asEditor', failWrites: true });
  await themeCard(page).getByRole('radio', { name: 'Menta' }).click();
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  await expect(themeCard(page).getByRole('radio', { name: 'Predeterminado' })).toHaveAttribute('aria-checked', 'true');
  expect(await themeState(page)).toMatchObject({ theme: 'default', bg: DEFAULT_LIGHT_BG });
  expect(sb.db.user_settings).toEqual([]);
  // The failed choice is not what the next launch paints.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('tt.theme.active')))).toEqual({ theme: 'default', mode: 'auto' });
});

test("one editor's theme affects neither another editor nor a visitor", async ({ browser }) => {
  const fixtures = { editors: twoEditors(), user_settings: [roseRow(EDITOR_USER.id, 'dark')] };

  // Editor 1 sees their rose dark theme.
  const { ctx: c1, page: p1 } = await newDevice(browser);
  await openApp(p1, '/profile', { mode: 'asEditor', fixtures });
  await expect.poll(async () => (await themeState(p1)).theme).toBe('rose');
  expect(await themeState(p1)).toMatchObject({ scheme: 'dark', bg: ROSE_DARK_BG });

  // Editor 2 (own row only, RLS) keeps the default, and their change does not touch editor 1's row.
  const { ctx: c2, page: p2 } = await newDevice(browser);
  const sb2 = await openApp(p2, '/profile', { mode: 'asEditor', fixtures, user: EDITOR_USER_2 });
  await expect.poll(() => sb2.restCalls('user_settings', 'GET').length).toBeGreaterThan(0);
  expect(await themeState(p2)).toMatchObject({ theme: 'default', bg: DEFAULT_LIGHT_BG });
  await pickTheme(p2, 'Cielo');
  await expect.poll(() => sb2.db.user_settings.map((r) => [r.user_id, r.theme]).sort()).toEqual(
    [[EDITOR_USER.id, 'rose'], [EDITOR_USER_2.id, 'sky']].sort(),
  );

  // A visitor keeps the default.
  const { ctx: c3, page: p3 } = await newDevice(browser);
  await openApp(p3, '/profile', { fixtures });
  expect(await themeState(p3)).toMatchObject({ theme: 'default', bg: DEFAULT_LIGHT_BG });
  await Promise.all([c1.close(), c2.close(), c3.close()]);
});

test("same device: the visitor's choice comes back after the editor signs out", async ({ page }) => {
  await mockSupabase(page, { fixtures: { user_settings: [roseRow()] } });
  await page.goto('./#/profile');
  await expect(page.locator('.tabbar')).toBeVisible();
  await pickTheme(page, 'Cielo');
  await signInViaSheet(page, 'editor@example.test');
  await expect.poll(async () => (await themeState(page)).theme).toBe('rose');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect.poll(async () => (await themeState(page)).theme).toBe('sky');
  await expect(themeCard(page).getByRole('radio', { name: 'Cielo' })).toHaveAttribute('aria-checked', 'true');
});

test('theme picker: keyboard arrows move the selection; swatches preview their own colours', async ({ page }) => {
  await openApp(page, '/profile');
  const def = themeCard(page).getByRole('radio', { name: 'Predeterminado' });
  await def.focus();
  await page.keyboard.press('ArrowRight');
  await expect(themeCard(page).getByRole('radio', { name: 'Rosa' })).toBeFocused();
  expect((await themeState(page)).theme).toBe('rose');
  const previewBg = (id) => page.getByTestId(`theme-${id}`).locator('.tp-pill').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await previewBg('default')).toBe('rgb(232, 168, 58)');
  expect(await previewBg('rose')).toBe('rgb(238, 141, 176)');
  // No horizontal scroll on the settings screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
