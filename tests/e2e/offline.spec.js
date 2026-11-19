// Offline logging: writes are queued on the device (IndexedDB), shown with a pending mark, survive
// a reload, and are sent exactly once with the logged times when the connection is back. Also:
// edits and deletes offline, two-phone conflicts, refused changes, an ended session, idempotent
// retries after a lost answer, and what needs a connection.
//
// Playwright's context.setOffline() does not stop page.route() handlers, so every test also tells
// the Supabase mock (sb.setOffline). "Lie-fi" (the phone says online, the server is unreachable) is
// the mock alone.
import { test, expect } from 'playwright/test';
import { openApp, toastWith, FIXED_NOW } from './helpers.js';
import { makeSession, AUTH_STORAGE_KEY } from './supabase-mock.js';

const indicator = (page) => page.getByTestId('sync-indicator');

/** @param {import('playwright/test').BrowserContext} context @param {any} sb */
async function goOffline(context, sb) {
  sb.setOffline(true);
  await context.setOffline(true);
}
/** @param {import('playwright/test').BrowserContext} context @param {any} sb */
async function goOnline(context, sb) {
  sb.setOffline(false);
  await context.setOffline(false); // fires 'online': the app sends what is queued
}
/** The app resumes (iOS brings it to the foreground): it tries to sync again. */
const resume = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

const posts = (sb, table) => sb.restCalls(table, 'POST');

test('meal, pee and weight logged offline: pending, kept after a reload, synced once with the logged times', async ({ page, context }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await expect(indicator(page)).toHaveCount(0); // online, nothing waiting: no indicator
  await goOffline(context, sb);
  await expect(indicator(page)).toHaveAttribute('data-online', 'false');

  // Meal 2, one tap: behaves exactly as online, plus the pending mark.
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(toastWith(page, 'Comida 2 registrada')).toBeVisible();
  const meal2 = page.getByTestId('meal-2');
  await expect(meal2).toContainText('Hecha');
  await expect(meal2.getByTestId('pending-mark')).toBeVisible();
  await expect(meal2.getByTestId('pending-mark')).toContainText('Pendiente');

  // Pee outside.
  await page.getByTestId('quick-pee').click();
  await page.getByRole('button', { name: 'Afuera', exact: true }).click();
  await expect(toastWith(page, /Pipí/)).toBeVisible();

  // Weight.
  await page.goto('./#/health/weight');
  await page.getByTestId('fab-add').click();
  await page.getByTestId('weight-form').getByLabel('Peso').fill('5,25');
  await page.getByTestId('form-save').click();
  await expect(page.getByTestId('latest-weight')).toContainText('5,25 kg');
  await expect(page.getByTestId('weight-row').filter({ hasText: '5,25' }).getByTestId('pending-mark')).toBeVisible();
  await expect(indicator(page)).toHaveAttribute('data-pending', '3');
  await expect(indicator(page)).toHaveAccessibleName('Sin conexión, 3 cambios por sincronizar');
  expect(posts(sb, 'feedings')).toHaveLength(0);
  expect(posts(sb, 'routine_events')).toHaveLength(0);
  expect(posts(sb, 'weights')).toHaveLength(0);

  // Reload with the server still unreachable (the phone's network is up, Supabase is not).
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.getByTestId('latest-weight')).toContainText('5,25 kg');
  await page.goto('./#/today');
  await expect(page.getByTestId('meal-2')).toContainText('Hecha');
  await expect(page.getByTestId('meal-2').getByTestId('pending-mark')).toBeVisible();
  await expect(indicator(page)).toHaveAttribute('data-pending', '3');
  await page.goto('./#/log');
  await expect(page.getByTestId('timeline').locator('.tl-item.is-pending')).toHaveCount(2);

  // Two hours later the signal is back: everything is sent once, with the times it was logged.
  await page.clock.setFixedTime(new Date(Date.parse(FIXED_NOW) + 2 * 3600_000));
  sb.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(indicator(page)).toHaveCount(0);
  await expect(page.getByTestId('timeline').getByTestId('pending-mark')).toHaveCount(0);
  expect(posts(sb, 'feedings')).toHaveLength(1);
  expect(posts(sb, 'routine_events')).toHaveLength(1);
  expect(posts(sb, 'weights')).toHaveLength(1);
  expect(sb.db.feedings.filter((f) => f.meal_slot === 2)).toHaveLength(1);
  expect(sb.db.feedings.find((f) => f.meal_slot === 2).fed_at).toBe(FIXED_NOW);
  expect(sb.db.routine_events.at(-1)).toMatchObject({ type: 'pee', location: 'outside', started_at: FIXED_NOW });
  expect(sb.db.weights.find((w) => w.measured_on === '2026-11-13').weight_kg).toBe(5.25);

  // Nothing is sent again later (resume, reconnect: the data is refreshed, nothing re-sent).
  const gets = sb.restCalls('feedings', 'GET').length;
  await resume(page);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => sb.restCalls('feedings', 'GET').length).toBeGreaterThan(gets);
  expect(posts(sb, 'feedings')).toHaveLength(1);
});

test('edit and delete offline; a new entry edited and deleted offline sends nothing', async ({ page, context }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor' });
  const timeline = page.getByTestId('timeline');
  await goOffline(context, sb);

  await timeline.getByRole('button', { name: /Pipí afuera/ }).click();
  const edit = page.getByRole('dialog', { name: 'Editar registro' });
  await edit.getByLabel('Notas').fill('En el parque');
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(edit).toBeHidden();
  await expect(timeline.locator('.tl-item').filter({ hasText: 'En el parque' }).getByTestId('pending-mark')).toBeVisible();

  await timeline.getByRole('button', { name: /Comida 1/ }).click();
  await page.getByTestId('entry-delete').click();
  await page.getByRole('dialog', { name: '¿Eliminar este registro?' }).getByRole('button', { name: 'Eliminar registro' }).click();
  await expect(timeline.locator('.tl-item')).toHaveCount(3);

  // A poop logged, edited and deleted while offline.
  await page.getByTestId('fab-add').click();
  const add = page.getByRole('dialog', { name: 'Agregar al diario' });
  await add.getByLabel('Tipo').selectOption('poop');
  await add.getByLabel('Hora', { exact: true }).fill('08:00');
  await add.getByLabel('Notas').fill('Nueva');
  await add.getByRole('button', { name: 'Guardar' }).click();
  await expect(add).toBeHidden();
  await timeline.getByRole('button', { name: /Popó afuera/ }).filter({ hasText: 'Nueva' }).click();
  await page.getByRole('dialog', { name: 'Editar registro' }).getByLabel('Notas').fill('Blanda');
  await page.getByRole('dialog', { name: 'Editar registro' }).getByRole('button', { name: 'Guardar' }).click();
  await timeline.getByRole('button', { name: /Popó afuera/ }).filter({ hasText: 'Blanda' }).click();
  await page.getByTestId('entry-delete').click();
  await page.getByRole('dialog', { name: '¿Eliminar este registro?' }).getByRole('button', { name: 'Eliminar registro' }).click();
  await expect(indicator(page)).toHaveAttribute('data-pending', '2');

  await goOnline(context, sb);
  await expect(indicator(page)).toHaveCount(0);
  expect(sb.restCalls('routine_events', 'PATCH')).toHaveLength(1);
  expect(sb.restCalls('feedings', 'DELETE')).toHaveLength(1);
  expect(posts(sb, 'routine_events')).toHaveLength(0);
  expect(sb.db.routine_events.find((e) => e.id === 'e0000000-0000-4000-8000-000000000001').notes).toBe('En el parque');
  expect(sb.db.feedings).toHaveLength(1);
  expect(sb.db.routine_events.some((e) => e.notes === 'Blanda')).toBe(false);
});

test('two phones: last write wins on the same row; an entry deleted on the other phone stays deleted', async ({ page, context }) => {
  const sb = await openApp(page, '/log', { mode: 'asEditor' });
  const timeline = page.getByTestId('timeline');
  await goOffline(context, sb);
  // This phone edits the pee note and the sleep note offline...
  await timeline.getByRole('button', { name: /Pipí afuera/ }).click();
  await page.getByRole('dialog', { name: 'Editar registro' }).getByLabel('Notas').fill('Desde este teléfono');
  await page.getByRole('dialog', { name: 'Editar registro' }).getByRole('button', { name: 'Guardar' }).click();
  await timeline.getByRole('button', { name: /Sueño/ }).click();
  await page.getByRole('dialog', { name: 'Editar registro' }).getByLabel('Notas').fill('Durmió bien');
  await page.getByRole('dialog', { name: 'Editar registro' }).getByRole('button', { name: 'Guardar' }).click();
  await expect(indicator(page)).toHaveAttribute('data-pending', '2');
  // ...while the other phone (online) edits the same pee and deletes the sleep.
  sb.db.routine_events.find((e) => e.id === 'e0000000-0000-4000-8000-000000000001').notes = 'Desde el otro teléfono';
  sb.db.routine_events = sb.db.routine_events.filter((e) => e.id !== 'e0000000-0000-4000-8000-000000000003');

  await goOnline(context, sb);
  await expect(indicator(page)).toHaveCount(0);
  // The later write (this phone's, arriving now) wins for the pee.
  expect(sb.db.routine_events.find((e) => e.id === 'e0000000-0000-4000-8000-000000000001').notes).toBe('Desde este teléfono');
  // The sleep stays deleted (the edit is not applied, nothing is re-created), with a quiet note.
  await expect(toastWith(page, 'se eliminó en el otro teléfono')).toBeVisible();
  expect(sb.db.routine_events.some((e) => e.id === 'e0000000-0000-4000-8000-000000000003')).toBe(false);
  await expect(timeline.getByRole('button', { name: /Sueño/ })).toHaveCount(0);
  expect(posts(sb, 'routine_events')).toHaveLength(0);
});

test('a change the server refuses lands in "could not be saved" with its data; retry or discard', async ({ page, context }) => {
  const sb = await openApp(page, '/health/weight', { mode: 'asEditor' });
  await goOffline(context, sb);
  for (const kg of ['5,1', '5,3']) {
    await page.getByTestId('fab-add').click();
    await page.getByTestId('weight-form').getByLabel('Peso').fill(kg);
    if (kg === '5,3') await page.getByTestId('weight-form').getByLabel('Notas').fill('Después de comer');
    await page.getByTestId('form-save').click();
    await expect(page.getByTestId('weight-form')).toBeHidden();
  }
  // Both attempts failed for lack of network (none is still in flight): they are queued.
  await expect(indicator(page)).toHaveAttribute('data-pending', '2');
  await expect(indicator(page)).toHaveAttribute('data-syncing', 'false');
  sb.setReject((table, method) => table === 'weights' && method === 'POST');
  await goOnline(context, sb);
  await expect(toastWith(page, '2 cambios no se pudieron guardar')).toBeVisible();
  await expect(indicator(page)).toHaveAttribute('data-rejected', '2');
  await expect(indicator(page)).toHaveAccessibleName('2 cambios no se pudieron guardar');
  expect(sb.db.weights).toHaveLength(1);
  // The rows are not shown as saved any more...
  await expect(page.getByTestId('weight-row')).toHaveCount(1);
  // ...but nothing is lost: the list has them with their data.
  await indicator(page).click();
  const sheet = page.getByTestId('sync-sheet');
  const items = sheet.getByTestId('rejected-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Peso');
  await expect(items.nth(0)).toContainText('5.1');
  await expect(items.nth(1)).toContainText('Después de comer');
  await expect(items.nth(0)).toContainText('algún dato no es válido');

  sb.setReject(null);
  await items.nth(0).getByTestId('rejected-retry').click();
  await expect(items).toHaveCount(1);
  await expect.poll(() => sb.db.weights.length).toBe(2);
  await items.nth(0).getByTestId('rejected-discard').click();
  await page.getByRole('dialog', { name: '¿Descartar este cambio?' }).getByRole('button', { name: 'Descartar' }).click();
  await expect(items).toHaveCount(0);
  await expect(sheet.getByTestId('sync-status')).toContainText('Todo está sincronizado');
  expect(sb.db.weights).toHaveLength(2);

  // The list survives a reload (stored on the device), and so does an empty list.
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(indicator(page)).toHaveCount(0);
});

test('a refused write while online still rolls back with a toast (not queued)', async ({ page }) => {
  const sb = await openApp(page, '/health/weight', { mode: 'asEditor' });
  sb.setReject((table) => table === 'weights');
  await page.getByTestId('fab-add').click();
  await page.getByTestId('weight-form').getByLabel('Peso').fill('5,1');
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  await expect(page.getByTestId('weight-form').getByLabel('Peso')).toHaveValue('5,1');
  await expect(page.getByTestId('weight-row')).toHaveCount(1);
  await expect(indicator(page)).toHaveCount(0);
});

test('session ended while offline: changes stay queued, sign in asked, synced after signing in', async ({ page, context }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  await goOffline(context, sb);
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(page.getByTestId('meal-2')).toContainText('Hecha');
  // The phone was in a drawer for hours: the token expired, and the refresh token was revoked.
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [AUTH_STORAGE_KEY, makeSession(Date.parse(FIXED_NOW) - 3700_000)]);
  sb.setRefresh('invalid');
  await goOnline(context, sb);
  await expect(toastWith(page, /siguen? guardados? en este teléfono/)).toBeVisible();
  await expect(indicator(page)).toHaveAttribute('data-pending', '1');
  expect(posts(sb, 'feedings')).toHaveLength(0);
  await indicator(page).click();
  await expect(page.getByTestId('sync-status')).toContainText('Inicia sesión para sincronizar');
  sb.setRefresh('ok');
  await page.getByTestId('sync-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Iniciar sesión' });
  await dialog.getByLabel('Correo').fill('editor@example.test');
  await dialog.getByLabel('Contraseña').fill('correct-password');
  await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(indicator(page)).toHaveCount(0);
  expect(posts(sb, 'feedings')).toHaveLength(1);
  expect(sb.db.feedings.find((f) => f.meal_slot === 2).fed_at).toBe(FIXED_NOW);
});

test('an answer lost after the write reached the server: the retry creates no duplicate', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  sb.loseNextWriteResponse();
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(page.getByTestId('meal-2')).toContainText('Hecha');
  await expect.poll(() => sb.db.feedings.filter((f) => f.meal_slot === 2).length).toBe(1); // it did arrive...
  await expect(indicator(page)).toHaveAttribute('data-online', 'false'); // ...but the answer did not
  await expect(indicator(page)).toHaveAttribute('data-pending', '1');
  await resume(page);
  await expect(indicator(page)).toHaveCount(0);
  expect(posts(sb, 'feedings')).toHaveLength(2); // the retry...
  expect(sb.db.feedings.filter((f) => f.meal_slot === 2)).toHaveLength(1); // ...made no second row
  await expect(page.getByTestId('meals-card')).toContainText('2/4');
});

test('offline: sign-in, photos and days not on the phone say they need a connection', async ({ page, context }) => {
  const sb = await openApp(page, '/health/vaccines', { mode: 'asEditor' });
  await goOffline(context, sb);
  await page.getByTestId('fab-add').click();
  const form = page.getByTestId('vaccines-form');
  await form.getByLabel('Vacuna').fill('Refuerzo de prueba');
  await form.getByTestId('photo-input').setInputFiles({ name: 'carne.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
  await expect(form.getByTestId('photo-offline-note')).toContainText('la foto necesita internet');
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'Guardado sin la foto')).toBeVisible();
  await expect(page.getByTestId('vaccines-row').filter({ hasText: 'Refuerzo de prueba' }).getByTestId('pending-mark')).toBeVisible();
  expect(sb.calls.filter((c) => c.path.startsWith('/storage/'))).toHaveLength(0);

  // A day outside the loaded window.
  await page.goto('./#/log?day=2026-10-01');
  await expect(page.getByTestId('day-needs-connection')).toBeVisible();
  await expect(page.getByText('No hay registros este día')).toHaveCount(0);

  // Online again: the vaccine syncs (without a photo) and the day loads.
  await goOnline(context, sb);
  await expect(page.getByTestId('day-needs-connection')).toHaveCount(0);
  await expect(page.getByText('No hay registros este día')).toBeVisible();
  await expect.poll(() => sb.db.vaccinations.filter((v) => v.vaccine === 'Refuerzo de prueba' && !v.photo_path).length).toBe(1);
});

test('visitor offline: sees cached data, an offline indicator and a sign-in note; never any pending count', async ({ page, context }) => {
  const sb = await openApp(page, '/today');
  await expect(page.getByTestId('meal-1')).toContainText('Hecha');
  await goOffline(context, sb);
  await expect(indicator(page)).toHaveAttribute('data-online', 'false');
  await expect(indicator(page)).toHaveAttribute('data-pending', '0');
  await expect(indicator(page)).toHaveAccessibleName('Sin conexión');
  await page.getByTestId('header-sign-in').click();
  await expect(page.getByTestId('sign-in-offline')).toContainText('para iniciar sesión necesitas internet');
  await page.keyboard.press('Escape');
  await indicator(page).click();
  await expect(page.getByTestId('sync-status')).toContainText('Sin conexión');
  await expect(page.getByTestId('pending-list')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await goOnline(context, sb);
  await expect(indicator(page)).toHaveCount(0);
});

test('offline indicator follows real requests, not only navigator.onLine (lie-fi)', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });
  sb.setOffline(true); // the phone says online; the server is unreachable
  await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
  await expect(indicator(page)).toHaveAttribute('data-online', 'false');
  await expect(indicator(page)).toHaveAttribute('data-pending', '1');
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  sb.setOffline(false);
  await resume(page);
  await expect(indicator(page)).toHaveCount(0);
});
