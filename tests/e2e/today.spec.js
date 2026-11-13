// Today tab: one-tap meals, quick potty/sleep logging with undo, rollback, visitor read-only.
import { test, expect } from 'playwright/test';
import { openApp, toastWith } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const undo = (page) => page.locator('.toast').getByRole('button', { name: 'Deshacer' });

test('editor logs a meal with one tap and can undo it', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  const meal2 = page.getByTestId('meal-2');
  await expect(meal2).toContainText('Siguiente');
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(meal2).toContainText('Hecha');
  await expect(toastWith(page, 'Comida 2 registrada')).toBeVisible();
  await expect.poll(() => sb.db.feedings.length).toBe(3);
  const row = sb.db.feedings.at(-1);
  expect(row.meal_slot).toBe(2);
  expect(row.fed_at).toBe('2026-11-13T15:30:00.000Z');
  await expect(page.getByTestId('meals-card')).toContainText('2/4');
  await undo(page).click();
  await expect.poll(() => sb.db.feedings.length).toBe(2);
  await expect(meal2).toContainText('Siguiente');
  await expect(toastWith(page, 'Cambio deshecho')).toBeVisible();
});

test('pee inside takes two taps, is marked as an accident and can be undone', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await page.getByTestId('quick-pee').click();
  await page.getByRole('button', { name: 'Adentro (accidente)' }).click();
  await expect(toastWith(page, 'Accidente de pipí registrado')).toBeVisible();
  await expect.poll(() => sb.db.routine_events.length).toBe(4);
  const ev = sb.db.routine_events.at(-1);
  expect(ev).toMatchObject({ type: 'pee', location: 'inside', accident: true, ended_at: null, started_at: '2026-11-13T15:30:00.000Z' });
  await expect(page.getByTestId('last-pee')).toContainText('Accidente');
  await undo(page).click();
  await expect.poll(() => sb.db.routine_events.length).toBe(3);
  await expect(page.getByTestId('last-pee')).not.toContainText('Accidente');
});

test('poop outside and an extra meal from the sheet', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await page.getByTestId('quick-poop').click();
  await page.getByRole('button', { name: 'Afuera', exact: true }).click();
  await expect.poll(() => sb.db.routine_events.at(-1)).toMatchObject({ type: 'poop', location: 'outside', accident: false });
  await page.getByTestId('add-extra-meal').click();
  const dialog = page.getByRole('dialog', { name: 'Agregar comida extra' });
  await dialog.getByLabel('Hora', { exact: true }).fill('09:30');
  await dialog.getByLabel('Cantidad').fill('20');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sb.db.feedings.length).toBe(3);
  expect(sb.db.feedings.at(-1)).toMatchObject({ meal_slot: null, amount_g: 20, fed_at: '2026-11-13T14:30:00.000Z' });
  await expect(page.getByTestId('meals-card')).toContainText('Comida extra');
});

test('sleep can be started and stopped', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await expect(page.getByTestId('last-sleep')).toContainText('Despierto');
  await page.getByTestId('quick-sleep').click();
  await page.getByRole('button', { name: 'Empezar ahora' }).click();
  await expect(page.getByTestId('last-sleep')).toContainText('Durmiendo');
  await expect(page.getByTestId('quick-sleep')).toContainText('Despertó');
  await expect.poll(() => sb.db.routine_events.at(-1)).toMatchObject({ type: 'sleep', ended_at: null });
  await page.getByTestId('quick-sleep').click();
  await expect(toastWith(page, 'Siesta terminada')).toBeVisible();
  await expect.poll(() => sb.db.routine_events.at(-1).ended_at).toBe('2026-11-13T15:30:00.000Z');
  await expect(page.getByTestId('last-sleep')).toContainText('Despierto');
});

test('a walk can be logged with a duration', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await page.getByTestId('quick-walk').click();
  await page.getByRole('button', { name: 'Ya terminó' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Hora de inicio').fill('09:00');
  await dialog.getByLabel('Duración').fill('25');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect.poll(() => sb.db.routine_events.at(-1)).toMatchObject({ type: 'walk', started_at: '2026-11-13T14:00:00.000Z', ended_at: '2026-11-13T14:25:00.000Z' });
});

test('a failed one-tap meal rolls back with an error toast', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor', failWrites: true });
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  await expect(page.getByTestId('meal-2')).toContainText('Siguiente');
  await expect(page.getByTestId('meals-card')).toContainText('1/4');
  await expect(toastWith(page, 'Comida 2 registrada')).toHaveCount(0);
  expect(sb.db.feedings).toHaveLength(2);
});

test('editor ticks a roadmap to-do from Today', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  const todo = page.getByTestId('week-card').getByRole('checkbox').first();
  await expect(todo).toHaveAttribute('aria-checked', 'false');
  await todo.click();
  await expect(todo).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => sb.db.checklist_done.length).toBe(1);
  await todo.click();
  await expect.poll(() => sb.db.checklist_done.length).toBe(0);
});

test('visitor sees Today read-only: no logging controls', async ({ page }) => {
  const sb = await openApp(page, '/today', { fixtures: richFixtures() });
  await expect(page.getByTestId('meals-card')).toBeVisible();
  await expect(page.getByTestId('meal-1')).toContainText('Hecha');
  await expect(page.getByRole('button', { name: /Registrar comida/ })).toHaveCount(0);
  await expect(page.getByTestId('quick-log')).toHaveCount(0);
  await expect(page.getByTestId('add-extra-meal')).toHaveCount(0);
  await expect(page.getByTestId('fab-add')).toHaveCount(0);
  await expect(page.getByTestId('meals-card').getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('week-card').getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('last-sleep')).toContainText('Durmiendo');
  await expect(page.getByTestId('due-card')).toContainText('Atrasado');
  await expect(page.getByTestId('today-fact')).toBeVisible();
  expect(sb.restCalls('pet_private')).toHaveLength(0);
  expect(sb.pageErrors).toEqual([]);
});

test('Today in English', async ({ page }) => {
  await openApp(page, '/today', { mode: 'asEditor', locale: 'en' });
  await expect(page.getByRole('heading', { name: 'Today’s meals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log meal 2', exact: true })).toBeVisible();
  await expect(page.getByTestId('quick-log')).toContainText('Pee');
});

for (const mode of ['signedOut', 'asEditor']) {
  test(`Today and Log do not scroll sideways with lots of data (${mode})`, async ({ page }) => {
    await openApp(page, '/today', { mode, fixtures: richFixtures() });
    for (const path of ['/today', '/log', '/log/stats']) {
      await page.goto(`./#${path}`);
      await page.waitForTimeout(150);
      const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - page.viewportSize().width;
      expect(overflow, `#${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
}

test('Today links to the health section of a due item and to the current roadmap stage', async ({ page }) => {
  await openApp(page, '/today');
  await page.getByTestId('due-card').getByRole('link', { name: /Desparasitación/ }).click();
  await expect(page).toHaveURL(/#\/health\/deworming$/);
  await page.goto('./#/today');
  await page.getByTestId('week-card').locator('a.week-stage').click();
  await expect(page).toHaveURL(/#\/learn\/roadmap\/stage-early$/);
  await expect(page.locator('.stage[data-stage="stage-early"] .stage-head')).toHaveAttribute('aria-expanded', 'true');
});
