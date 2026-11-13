// Foundation smoke tests: shell, navigation, i18n, auth gating.
import { test, expect } from 'playwright/test';
import { openApp, tab, toastWith, EDITOR_NAME, contentItems } from './helpers.js';

const TABS = [
  ['today', 'Hoy', 'Today'],
  ['log', 'Diario', 'Log'],
  ['health', 'Salud', 'Health'],
  ['learn', 'Aprender', 'Learn'],
  ['profile', 'Tyler', 'Tyler'],
];

test('app loads in Spanish with Tyler’s age', async ({ page }) => {
  const sb = await openApp(page, '/today');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hoy');
  // 2026-09-25 -> 2026-11-13 = 49 days = 7 weeks
  await expect(page.getByTestId('age-card')).toContainText('7 semanas');
  expect(sb.pageErrors).toEqual([]);
});

test('all five tabs navigate', async ({ page }) => {
  await openApp(page, '/today');
  for (const [id, es] of TABS) {
    await tab(page, id).click();
    await expect(page).toHaveURL(new RegExp(`#/${id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(es);
    await expect(tab(page, id)).toHaveAttribute('aria-current', 'page');
  }
});

for (const mode of ['signedOut', 'asEditor']) {
  test(`no screen scrolls horizontally at 390 px (${mode})`, async ({ page }) => {
    await openApp(page, '/today', { mode });
    for (const [id] of TABS) {
      await tab(page, id).click();
      await expect(page).toHaveURL(new RegExp(`#/${id}$`));
      // Compare with the device width: mobile emulation widens innerWidth when content overflows.
      const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - page.viewportSize().width;
      expect(overflow, `#/${id} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
}

test('unknown routes redirect to Today', async ({ page }) => {
  await openApp(page, '/nope/nothing');
  await expect(page).toHaveURL(/#\/today$/);
});

test('language switch changes labels and <html lang>, and persists', async ({ page }) => {
  await openApp(page, '/profile');
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  for (const [id, , en] of TABS) await expect(tab(page, id)).toContainText(en);
  await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(tab(page, 'today')).toContainText('Today');
  await page.getByRole('radio', { name: 'Español' }).click();
  await expect(tab(page, 'today')).toContainText('Hoy');
});

test('signed out: no editor controls, no private data requests', async ({ page }) => {
  const sb = await openApp(page, '/today');
  await expect(page.getByTestId('header-sign-in')).toBeVisible();
  for (const [id] of TABS) {
    await tab(page, id).click();
    await expect(page.getByTestId('fab-add')).toHaveCount(0);
    await expect(page.getByTestId('edit-profile')).toHaveCount(0);
  }
  expect(sb.restCalls('pet_private')).toHaveLength(0);
  expect(sb.restCalls('vet_visit_private')).toHaveLength(0);
});

test('editor mode shows editor controls and loads private tables', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await expect(page.getByTestId('fab-add')).toBeVisible();
  await tab(page, 'profile').click();
  await expect(page.getByTestId('edit-profile')).toBeVisible();
  await expect(page.getByText(`Hola, ${EDITOR_NAME}`)).toBeVisible();
  await expect.poll(() => sb.restCalls('pet_private').length).toBeGreaterThan(0);
});

test('sign in: wrong password shows a clear error, right password makes you an editor', async ({ page }) => {
  await openApp(page, '/profile');
  await page.getByTestId('header-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Iniciar sesión' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Correo').fill('editor@example.test');
  await dialog.getByLabel('Contraseña').fill('wrong-password');
  await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('El correo o la contraseña no son correctos.');
  await dialog.getByLabel('Contraseña').fill('correct-password');
  await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(dialog).toBeHidden();
  await expect(toastWith(page, 'Sesión iniciada')).toBeVisible();
  await expect(page.getByTestId('edit-profile')).toBeVisible();
  await expect(page.getByTestId('header-editor')).toBeVisible();
});

test('sign out hides editor controls again', async ({ page }) => {
  await openApp(page, '/profile', { mode: 'asEditor' });
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByTestId('edit-profile')).toHaveCount(0);
  await expect(page.getByTestId('header-sign-in')).toBeVisible();
});

test('learn tab renders served content (fact of the day)', async ({ page }) => {
  await openApp(page, '/learn');
  await expect(page.getByTestId('fact-of-the-day')).toBeVisible();
  const critical = contentItems('must-know').find((i) => i.priority === 'critical');
  await expect(page.getByText(critical.title.es, { exact: true })).toBeVisible();
});

test('kitchen sink renders and the sheet traps Escape', async ({ page }) => {
  await openApp(page, '/dev/ui');
  await page.getByRole('button', { name: 'Abrir hoja' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('header back on a deep link goes to the parent route instead of leaving the app', async ({ page }) => {
  await openApp(page, '/learn/faq/test-faq-newer');
  await page.locator('.header-back').click();
  await expect(page).toHaveURL(/#\/learn\/faq$/);
  await page.locator('.header-back').click();
  await expect(page).toHaveURL(/#\/learn$/);
  await expect(page.locator('.header-back')).toHaveCount(0);
});

test('header back after navigating inside the app goes back in history', async ({ page }) => {
  await openApp(page, '/health');
  await page.goto('./#/learn/faq');
  await page.goto('./#/learn/faq/test-faq-older');
  await page.locator('.header-back').click();
  await expect(page).toHaveURL(/#\/learn\/faq$/);
  await page.locator('.header-back').click();
  // The entry before /learn/faq was /health: real history, not the fallback.
  await expect(page).toHaveURL(/#\/health$/);
});

test('navigation focuses the page title for screen readers without drawing a ring; controls keep theirs', async ({ page }) => {
  await openApp(page, '/today');
  const title = page.getByRole('heading', { level: 1 });
  const outline = (loc) => loc.evaluate((el) => getComputedStyle(el).outlineStyle);
  // Keyboard: follow a tab link with Enter, then the title gets focus (script) and shows no outline.
  await tab(page, 'health').focus();
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('Salud');
  await expect(title).toBeFocused();
  expect(await outline(title)).toBe('none');
  // Hash navigation without any prior interaction (what the review screenshots do).
  await page.goto('./#/profile');
  await expect(title).toHaveText('Tyler');
  await expect(title).toBeFocused();
  expect(await outline(title)).toBe('none');
  // Real keyboard focus on a control still shows the ring.
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveCount(1);
  expect(await focused.evaluate((el) => el.tagName)).not.toBe('H1');
  expect(await outline(focused)).toBe('solid');
});
