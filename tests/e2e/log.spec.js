// Log tab: day timeline, filters, edit/delete, past entries, rollback, stats, visitor read-only.
import { test, expect } from 'playwright/test';
import { openApp, toastWith } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const timeline = (page) => page.getByTestId('timeline');

test('day view lists the day in time order with who logged it', async ({ page }) => {
  await openApp(page, '/log');
  await expect(page.getByTestId('log-day-label')).toHaveText(/13 de noviembre/);
  const items = timeline(page).locator('.tl-item');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText('7:05');
  await expect(items.nth(0)).toContainText('Comida 1');
  await expect(items.nth(1)).toContainText('Pipí afuera');
  await expect(items.nth(3)).toContainText('1 h 30 min');
  await expect(items.nth(0)).toContainText('Registrado por Alex');
  await expect(page.getByTestId('log-next')).toBeDisabled();
});

test('filters and day navigation, loading days outside the default window', async ({ page }) => {
  const sb = await openApp(page, '/log', { fixtures: richFixtures() });
  await page.getByRole('button', { name: 'Pipís' }).click();
  await expect(timeline(page).locator('.tl-item')).toHaveCount(2);
  await expect(timeline(page).locator('.tl-item[data-kind="meal"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pipís' }).click();
  await page.getByTestId('log-prev').click();
  await expect(page).toHaveURL(/#\/log\?day=2026-11-12$/);
  await expect(page.getByTestId('log-day-label')).toHaveText(/12 de noviembre/);
  await expect(timeline(page).locator('.tl-item[data-kind="meal"]')).toHaveCount(5);
  await page.getByRole('button', { name: 'Ir a hoy' }).click();
  await expect(page).toHaveURL(/#\/log$/);
  const before = sb.restCalls('feedings', 'GET').length;
  await page.getByLabel('Elegir día').fill('2026-10-01');
  await expect(page.getByText('No hay registros este día')).toBeVisible();
  await expect.poll(() => sb.restCalls('feedings', 'GET').length).toBeGreaterThan(before);
  const search = decodeURIComponent(sb.restCalls('feedings', 'GET').at(-1).search);
  expect(search).toContain('fed_at=gte.2026-10-01T05:00:00.000Z');
  expect(search).toContain('fed_at=lt.2026-10-02T05:00:00.000Z');
});

test('editor edits an entry', async ({ page }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor' });
  await timeline(page).getByRole('button', { name: /Pipí afuera/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar registro' });
  await dialog.getByRole('radio', { name: 'Adentro' }).click();
  await dialog.getByLabel('Notas').fill('En la cocina');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();
  await expect(timeline(page)).toContainText('Pipí adentro');
  await expect(timeline(page)).toContainText('Accidente');
  await expect.poll(() => sb.db.routine_events.find((e) => e.id === 'e0000000-0000-4000-8000-000000000001')).toMatchObject({ location: 'inside', accident: true, notes: 'En la cocina' });
});

test('editor deletes an entry after confirming, and can undo', async ({ page }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor' });
  await timeline(page).getByRole('button', { name: /Comida 1/ }).click();
  await page.getByTestId('entry-delete').click();
  const confirm = page.getByRole('dialog', { name: '¿Eliminar este registro?' });
  await expect(confirm).toContainText('Comida 1');
  await confirm.getByRole('button', { name: 'Eliminar registro' }).click();
  await expect(toastWith(page, 'Eliminado')).toBeVisible();
  await expect(timeline(page).locator('.tl-item')).toHaveCount(3);
  await expect.poll(() => sb.db.feedings.length).toBe(1);
  await page.locator('.toast').getByRole('button', { name: 'Deshacer' }).click();
  await expect(timeline(page).locator('.tl-item')).toHaveCount(4);
  await expect.poll(() => sb.db.feedings.length).toBe(2);
});

test('editor adds a past entry on another day', async ({ page }) => {
  const sb = await openApp(page, '/log?day=2026-11-12', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  const dialog = page.getByRole('dialog', { name: 'Agregar al diario' });
  await dialog.getByLabel('Tipo').selectOption('poop');
  await expect(dialog.getByLabel('Fecha')).toHaveValue('2026-11-12');
  await dialog.getByLabel('Hora', { exact: true }).fill('08:00');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sb.db.routine_events.at(-1)).toMatchObject({ type: 'poop', started_at: '2026-11-12T13:00:00.000Z', location: 'outside', accident: false });
  await expect(timeline(page)).toContainText('Popó afuera');
});

test('the entry sheet validates times in the future and bad durations', async ({ page }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tipo').selectOption('sleep');
  await dialog.getByLabel('Hora de inicio').fill('23:00');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog.getByText('La hora no puede estar en el futuro.')).toBeVisible();
  await expect(dialog.getByText('Escribe los minutos, por ejemplo 30.')).toBeVisible();
  expect(sb.restCalls('routine_events', 'POST')).toHaveLength(0);
});

test('a failed edit rolls back with an error toast', async ({ page }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor', failWrites: true });
  await timeline(page).getByRole('button', { name: /Popó afuera/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar registro' });
  await dialog.getByRole('radio', { name: 'Adentro' }).click();
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  // The sheet stays open with the user's changes; the timeline shows the original row.
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await expect(timeline(page)).toContainText('Popó afuera');
  await expect(timeline(page)).not.toContainText('Popó adentro');
  expect(sb.db.routine_events.find((e) => e.type === 'poop').location).toBe('outside');
});

test('a failed delete restores the entry', async ({ page }) => {
  await openApp(page, '/log', { mode: 'asEditor', failWrites: true });
  await timeline(page).getByRole('button', { name: /Comida 1/ }).click();
  await page.getByTestId('entry-delete').click();
  await page.getByRole('button', { name: 'Eliminar registro' }).click();
  await expect(toastWith(page, 'No se pudo eliminar')).toBeVisible();
  await expect(timeline(page).locator('.tl-item')).toHaveCount(4);
});

test('visitor sees the log read-only', async ({ page }) => {
  await openApp(page, '/log');
  await expect(timeline(page).locator('.tl-item')).toHaveCount(4);
  await expect(timeline(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('fab-add')).toHaveCount(0);
});

test('stats summarise the last 7 and 14 days', async ({ page }) => {
  const sb = await openApp(page, '/log', { fixtures: richFixtures() });
  await page.getByTestId('open-stats').click();
  await expect(page).toHaveURL(/#\/log\/stats$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Resumen');
  await expect(page.getByTestId('chart-potty')).toBeVisible();
  await expect(page.getByTestId('chart-accidents').locator('.bars-col')).toHaveCount(7);
  const accidents7 = await page.getByTestId('stat-accidents').locator('.stat-num').textContent();
  await page.getByRole('radio', { name: 'Últimos 14 días' }).click();
  await expect(page.getByTestId('chart-accidents').locator('.bars-col')).toHaveCount(14);
  expect(Number(accidents7)).toBeGreaterThan(0);
  await expect(page.getByTestId('stat-meal-poop')).toContainText('min');
  expect(sb.pageErrors).toEqual([]);
});

test('stats empty state', async ({ page }) => {
  await openApp(page, '/log/stats', { fixtures: { feedings: [], routine_events: [] } });
  await expect(page.getByText('Aún no hay datos para el resumen')).toBeVisible();
});
