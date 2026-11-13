// Visual review screenshots for the Health feature (not part of `npm run check`).
//   SCREENSHOT_DIR=/home/claude/review/health npx playwright test tests/e2e/health-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
const shot = (page, name, fullPage = true) =>
  page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage, style: fullPage ? '.tabbar, .fab { display: none !important; }' : undefined });
const settle = (page) => page.waitForTimeout(400);

const audit = { created_at: '2026-11-10T15:00:00.000Z', updated_at: '2026-11-10T15:00:00.000Z', created_by: null, created_by_name: 'Alex' };
const id = (p, n) => `${p}0000000-0000-4000-8000-00000000000${n}`;
const rich = {
  weights: [
    { id: id('a', 1), measured_on: '2026-11-01', weight_kg: 4.1, notes: null, ...audit },
    { id: id('a', 2), measured_on: '2026-11-08', weight_kg: 4.6, notes: null, ...audit },
    { id: id('a', 3), measured_on: '2026-11-13', weight_kg: 5.25, notes: 'Después del desayuno', ...audit },
  ],
  vaccinations: [
    { id: id('b', 1), vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29', vet: 'Clínica de prueba', batch: 'L-0000', photo_path: 'vaccines/sample.jpg', notes: null, ...audit },
  ],
  vet_visits: [
    { id: id('c', 1), visited_on: '2026-11-11', reason: 'Chequeo general', vet: 'Dra. Prueba', findings: 'Todo bien, buen peso.', treatment: null, follow_up_on: '2026-11-25', notes: null, ...audit },
  ],
  vet_visit_private: [{ visit_id: id('c', 1), cost: 85000, currency: 'COP', private_notes: 'Nota privada de prueba', ...audit }],
  medications: [
    { id: id('d', 1), name: 'Probiótico de prueba', dose: '1 sobre', frequency: 'cada 24 horas', start_on: '2026-11-12', end_on: '2026-11-19', notes: null, ...audit },
    { id: id('d', 2), name: 'Antibiótico de prueba', dose: '1/2 tableta', frequency: 'cada 12 horas', start_on: '2026-11-01', end_on: '2026-11-05', notes: null, ...audit },
  ],
  reminders: [
    { id: id('e', 1), title: 'Comprar comida', due_on: '2026-11-14', due_time: '18:30:00', done_at: null, notes: null, ...audit },
    { id: id('e', 2), title: 'Llamar a la veterinaria', due_on: '2026-11-12', due_time: null, done_at: null, notes: null, ...audit },
    { id: id('e', 3), title: 'Bañarlo', due_on: '2026-11-10', due_time: null, done_at: '2026-11-10T20:00:00.000Z', notes: null, ...audit },
  ],
};
const empty = { weights: [], vaccinations: [], dewormings: [], vet_visits: [], vet_visit_private: [], medications: [], reminders: [] };

for (const scheme of ['light', 'dark']) {
  for (const locale of ['es', 'en']) {
    test(`overview ${locale} ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page, '/health', { mode: 'asEditor', fixtures: rich, locale });
      await settle(page);
      await shot(page, `overview-${locale}-${scheme}`);
    });
  }
}

test('overview empty (visitor)', async ({ page }) => {
  await openApp(page, '/health', { fixtures: empty });
  await settle(page);
  await shot(page, 'overview-empty-visitor');
});

for (const s of ['vaccines', 'deworming', 'weight', 'visits', 'medications', 'reminders']) {
  test(`${s} with data`, async ({ page }) => {
    await openApp(page, `/health/${s}`, { mode: 'asEditor', fixtures: rich });
    await settle(page);
    await shot(page, `${s}-data`);
  });
  test(`${s} empty`, async ({ page }) => {
    await openApp(page, `/health/${s}`, { mode: 'asEditor', fixtures: empty });
    await settle(page);
    await shot(page, `${s}-empty`, false);
  });
}

test('growth chart dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, '/health/weight', { fixtures: rich });
  await settle(page);
  await page.getByTestId('growth-chart').screenshot({ path: resolve(dir || '.', 'growth-chart-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await settle(page);
  await page.getByTestId('growth-chart').screenshot({ path: resolve(dir || '.', 'growth-chart-light.png') });
});

test('add sheets', async ({ page }) => {
  await openApp(page, '/health/vaccines', { mode: 'asEditor', fixtures: rich });
  await page.getByTestId('fab-add').click();
  await settle(page);
  await shot(page, 'sheet-add-vaccine', false);
  await page.goto('./#/health/visits?add=1');
  await expect(page.getByTestId('visits-form')).toBeVisible();
  await settle(page);
  await shot(page, 'sheet-add-visit', false);
});

test('detail sheets', async ({ page }) => {
  await openApp(page, '/health/visits', { mode: 'asEditor', fixtures: rich });
  await page.getByTestId('visits-row').click();
  await settle(page);
  await shot(page, 'detail-visit-editor', false);
  await page.goto('./#/health/vaccines');
  await page.getByTestId('vaccines-row').click();
  await settle(page);
  await shot(page, 'detail-vaccine', false);
});

test('overview chooser (dark)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, '/health', { mode: 'asEditor', fixtures: rich });
  await page.getByTestId('fab-add').click();
  await settle(page);
  await shot(page, 'sheet-chooser-dark', false);
});
