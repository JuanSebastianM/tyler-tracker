// Health feature: overview, sections, growth chart, private vet costs, reminders, calendar, rollback.
import { test, expect } from 'playwright/test';
import { openApp, toastWith, EDITOR_NAME } from './helpers.js';

const VISIT_ID = 'a0000000-0000-4000-8000-000000000001';
const visitFixtures = {
  vet_visits: [
    {
      id: VISIT_ID, visited_on: '2026-11-11', reason: 'Chequeo general', vet: 'Dra. Prueba', findings: 'Todo bien',
      treatment: null, follow_up_on: '2026-11-25', notes: null,
      created_at: '2026-11-11T15:00:00.000Z', updated_at: '2026-11-11T15:00:00.000Z', created_by: null, created_by_name: 'Alex',
    },
  ],
  vet_visit_private: [
    { visit_id: VISIT_ID, cost: 85000, currency: 'COP', private_notes: 'Pagado con tarjeta de prueba', created_at: '2026-11-11T15:00:00.000Z', updated_at: '2026-11-11T15:00:00.000Z', created_by: null, created_by_name: 'Alex' },
  ],
};

const dialog = (page) => page.getByRole('dialog');

test('visitor sees the overview read-only', async ({ page }) => {
  const sb = await openApp(page, '/health');
  await expect(page.getByTestId('due-card')).toContainText('Puppy DP');
  await expect(page.getByTestId('due-card')).toContainText('Antiparasitario de prueba');
  // Deworming (15 nov) comes before the vaccine (29 nov).
  await expect(page.getByTestId('due-item').first()).toContainText('Antiparasitario de prueba');
  await expect(page.getByTestId('latest-weight')).toContainText('4,6 kg');
  await expect(page.getByTestId('section-vaccines')).toContainText('1 registro');
  await expect(page.getByTestId('fab-add')).toHaveCount(0);
  await page.getByTestId('section-vaccines').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vacunas');
  await page.getByTestId('vaccines-row').click();
  await expect(dialog(page)).toContainText(`Registrado por ${EDITOR_NAME}`);
  await expect(dialog(page).getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Eliminar' })).toHaveCount(0);
  expect(sb.pageErrors).toEqual([]);
});

test('editor adds a vaccine with a next due date and sees it in due items', async ({ page }) => {
  const sb = await openApp(page, '/health/vaccines', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  const form = page.getByTestId('vaccines-form');
  await form.getByLabel('Vacuna').fill('Rabia');
  await form.getByLabel('Fecha de aplicación').fill('2026-11-13');
  await form.getByLabel('Próxima dosis').fill('2026-11-20');
  await form.getByLabel('Veterinario').fill('Clínica de prueba');
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'Vacuna guardada')).toBeVisible();
  await expect.poll(() => sb.db.vaccinations.length).toBe(2);
  const saved = sb.db.vaccinations.find((v) => v.vaccine === 'Rabia');
  expect(saved).toMatchObject({ given_on: '2026-11-13', next_due_on: '2026-11-20', vet: 'Clínica de prueba', batch: null });
  await expect(page.getByTestId('vaccines-row').filter({ hasText: 'Rabia' })).toContainText('Pronto');

  await page.locator('.tabbar a[data-tab="health"]').click();
  await expect(page.getByTestId('health-overview')).toBeVisible();
  await expect(page.getByTestId('due-item').filter({ hasText: 'Rabia' })).toContainText('Pronto');
  expect(sb.pageErrors).toEqual([]);
});

test('validation: required fields and date order', async ({ page }) => {
  const sb = await openApp(page, '/health/vaccines', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  const form = page.getByTestId('vaccines-form');
  await form.getByLabel('Próxima dosis').fill('2026-11-01');
  await page.getByTestId('form-save').click();
  await expect(form.getByText('Este campo es obligatorio.')).toBeVisible();
  await expect(form.getByText('no puede ser anterior')).toBeVisible();
  expect(sb.restCalls('vaccinations', 'POST')).toHaveLength(0);
});

test('editor adds a weight with a comma and the chart updates', async ({ page }) => {
  const sb = await openApp(page, '/health/weight', { mode: 'asEditor' });
  const svg = page.getByTestId('growth-chart').locator('svg[role="img"]');
  await expect(svg).toHaveAttribute('data-points', '1');
  await expect(page.getByTestId('growth-band')).toHaveCount(1);
  await expect(page.getByTestId('growth-placeholder')).toBeVisible();
  await expect(page.getByTestId('growth-chart').locator('.disclaimer')).toBeVisible();
  await page.getByTestId('fab-add').click();
  const form = page.getByTestId('weight-form');
  await form.getByLabel('Peso').fill('5,25');
  await page.getByTestId('form-save').click();
  await expect(svg).toHaveAttribute('data-points', '2');
  await expect(page.getByTestId('growth-chart').locator('.hc-line')).toHaveCount(1);
  await expect(page.getByTestId('latest-weight')).toContainText('5,25 kg');
  await expect(page.getByTestId('latest-weight')).toContainText('+0,65 kg en 5 días');
  await expect.poll(() => sb.db.weights.length).toBe(2);
  expect(sb.db.weights.find((w) => w.measured_on === '2026-11-13').weight_kg).toBe(5.25);
});

test('invalid weight is rejected', async ({ page }) => {
  const sb = await openApp(page, '/health/weight', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  await page.getByTestId('weight-form').getByLabel('Peso').fill('4,6,1');
  await page.getByTestId('form-save').click();
  await expect(page.getByTestId('weight-form').getByText('Escribe un peso válido')).toBeVisible();
  expect(sb.restCalls('weights', 'POST')).toHaveLength(0);
});

test('chart renders without a reference file', async ({ page }) => {
  await page.route('**/content/growth.json', (r) => r.fulfill({ status: 404, body: '' }));
  await openApp(page, '/health/weight');
  await expect(page.getByTestId('growth-chart').locator('svg[role="img"]')).toHaveAttribute('data-points', '1');
  await expect(page.getByTestId('growth-no-reference')).toBeVisible();
  await expect(page.getByTestId('growth-band')).toHaveCount(0);
});

test('private visit cost: visible to editors only, never requested for visitors', async ({ page }) => {
  const sb = await openApp(page, '/health/visits', { fixtures: visitFixtures });
  await page.getByTestId('visits-row').click();
  await expect(dialog(page)).toContainText('Todo bien');
  await expect(page.getByTestId('visit-private')).toHaveCount(0);
  await expect(dialog(page)).not.toContainText('85');
  expect(sb.restCalls('vet_visit_private')).toHaveLength(0);
});

test('editor sees and edits the private visit cost', async ({ page }) => {
  const sb = await openApp(page, '/health/visits', { mode: 'asEditor', fixtures: visitFixtures });
  await page.getByTestId('visits-row').click();
  await expect(page.getByTestId('visit-private')).toContainText('85.000');
  await expect(page.getByTestId('visit-private')).toContainText('Pagado con tarjeta de prueba');
  await dialog(page).getByRole('button', { name: 'Editar' }).click();
  const form = page.getByTestId('visits-form');
  await expect(form.getByLabel('Costo')).toHaveValue('85000');
  await form.getByLabel('Costo').fill('90000');
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'Visita guardada')).toBeVisible();
  await expect.poll(() => sb.db.vet_visit_private[0].cost).toBe(90000);
  expect(sb.restCalls('vet_visit_private', 'POST').length).toBeGreaterThan(0);
});

test('follow-up date shows in due items with an Add to Calendar file', async ({ page }) => {
  await openApp(page, '/health', { fixtures: visitFixtures });
  const item = page.getByTestId('due-item').filter({ hasText: 'Chequeo general' });
  await expect(item).toContainText('Control veterinario');
  const download = page.waitForEvent('download');
  await item.getByTestId('add-to-calendar').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('tyler-control-veterinario-chequeo-general-2026-11-25.ics');
  const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toContain('BEGIN:VCALENDAR\r\n');
  expect(text).toContain('DTSTART;VALUE=DATE:20261125');
  expect(text.replace(/\r\n /g, '')).toContain(`UID:vet_follow_up-${VISIT_ID}-20261125@tyler-tracker`);
  expect(text.match(/BEGIN:VALARM/g)).toHaveLength(2);
});

test('reminders: add with a time, mark done, reopen', async ({ page }) => {
  const sb = await openApp(page, '/health/reminders', { mode: 'asEditor' });
  await expect(page.getByText('Sin recordatorios')).toBeVisible();
  await page.getByRole('button', { name: 'Agregar recordatorio' }).first().click();
  const form = page.getByTestId('reminders-form');
  await form.getByLabel('Qué hay que hacer').fill('Comprar comida');
  await form.getByLabel('Fecha').fill('2026-11-14');
  await form.getByLabel('Hora').fill('18:30');
  await page.getByTestId('form-save').click();
  await expect.poll(() => sb.db.reminders.length).toBe(1);
  expect(sb.db.reminders[0]).toMatchObject({ title: 'Comprar comida', due_on: '2026-11-14', due_time: '18:30' });
  expect(sb.db.reminders[0].done_at ?? null).toBeNull();

  // Timed calendar event from the detail sheet.
  await page.getByTestId('reminders-row').click();
  const download = page.waitForEvent('download');
  await dialog(page).getByTestId('add-to-calendar').click();
  const text = await (await (await download).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toContain('DTSTART;TZID=America/Bogota:20261114T183000');
  await page.keyboard.press('Escape');

  await page.getByTestId('reminder-toggle').click();
  await expect(toastWith(page, 'Recordatorio hecho')).toBeVisible();
  await expect.poll(() => sb.db.reminders[0].done_at).not.toBeNull();
  await expect(page.getByRole('heading', { name: 'Hechos' })).toBeVisible();
  await expect(page.getByText('Nada pendiente.')).toBeVisible();

  await page.getByTestId('reminder-toggle').click();
  await expect.poll(() => sb.db.reminders[0].done_at).toBeNull();
});

test('medications split into active and finished', async ({ page }) => {
  const base = { notes: null, created_at: '2026-11-01T15:00:00.000Z', updated_at: '2026-11-01T15:00:00.000Z', created_by: null, created_by_name: 'Alex' };
  await openApp(page, '/health/medications', {
    fixtures: {
      medications: [
        { id: 'c0000000-0000-4000-8000-000000000001', name: 'Antibiótico de prueba', dose: '1/2 tableta', frequency: 'cada 12 h', start_on: '2026-11-01', end_on: '2026-11-05', ...base },
        { id: 'c0000000-0000-4000-8000-000000000002', name: 'Probiótico de prueba', dose: null, frequency: null, start_on: '2026-11-12', end_on: null, ...base },
      ],
    },
  });
  const cards = page.locator('.health-list-card');
  await expect(cards.nth(0)).toContainText('Activos');
  await expect(cards.nth(0)).toContainText('Probiótico de prueba');
  await expect(cards.nth(1)).toContainText('Terminados');
  await expect(cards.nth(1)).toContainText('Antibiótico de prueba');
});

test('rollback: a failed write removes the row, toasts and reopens the form', async ({ page }) => {
  const sb = await openApp(page, '/health/weight', { mode: 'asEditor', failWrites: true });
  await page.getByTestId('fab-add').click();
  await page.getByTestId('weight-form').getByLabel('Peso').fill('5,1');
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  await expect(page.getByTestId('weight-row')).toHaveCount(1);
  await expect(page.getByTestId('weight-form').getByLabel('Peso')).toHaveValue('5,1');
  expect(sb.db.weights).toHaveLength(1);

  // Deleting also rolls back.
  await page.keyboard.press('Escape');
  await page.getByTestId('weight-row').click();
  await dialog(page).getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).last().click();
  await expect(toastWith(page, 'No se pudo eliminar')).toBeVisible();
  await expect(page.getByTestId('weight-row')).toHaveCount(1);
});

test('editor deletes a deworming', async ({ page }) => {
  const sb = await openApp(page, '/health/deworming', { mode: 'asEditor' });
  await page.getByTestId('deworming-row').click();
  await dialog(page).getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).last().click();
  await expect(toastWith(page, 'Eliminado')).toBeVisible();
  await expect.poll(() => sb.db.dewormings.length).toBe(0);
  await expect(page.getByText('Aún no hay desparasitaciones')).toBeVisible();
});

test('overview add button opens the chosen form', async ({ page }) => {
  await openApp(page, '/health', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  await dialog(page).getByRole('button', { name: 'Agregar medicamento' }).click();
  await expect(page).toHaveURL(/#\/health\/medications$/);
  await expect(page.getByTestId('medications-form')).toBeVisible();
});

test('vaccine photo uploads and opens full screen', async ({ page }) => {
  const sb = await openApp(page, '/health/vaccines', { mode: 'asEditor' });
  // A real 4x4 PNG so createImageBitmap can decode it.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWN4scIKjhiI4wAA83IcoYeH8cwAAAAASUVORK5CYII=', 'base64');
  await page.route('**/storage/v1/object/public/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.getByTestId('vaccines-row').click();
  await dialog(page).getByRole('button', { name: 'Editar' }).click();
  await page.getByTestId('photo-input').setInputFiles({ name: 'carne.png', mimeType: 'image/png', buffer: png });
  await page.getByTestId('form-save').click();
  await expect(toastWith(page, 'Vacuna guardada')).toBeVisible();
  await expect.poll(() => sb.db.vaccinations[0].photo_path).toMatch(/^vaccines\/[0-9a-f-]{36}\.jpg$/);
  expect(sb.calls.some((c) => c.method === 'POST' && c.path.startsWith('/storage/v1/object/photos/vaccines/'))).toBe(true);
  await page.getByTestId('vaccines-row').click();
  await dialog(page).getByRole('button', { name: 'Ver foto en pantalla completa' }).click();
  await expect(page.getByTestId('photo-viewer')).toBeVisible();
  await page.getByTestId('photo-viewer').click();
  await expect(page.getByTestId('photo-viewer')).toHaveCount(0);
});

test('English overview', async ({ page }) => {
  await openApp(page, '/health', { locale: 'en' });
  await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await expect(page.getByTestId('section-weight')).toContainText('1 record');
});
