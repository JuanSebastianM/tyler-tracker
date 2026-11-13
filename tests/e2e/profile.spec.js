// Profile feature: profile card, private details, memories, meal schedule, export, photo viewer.
import { test, expect } from 'playwright/test';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { mockSupabase, toastWith } from './helpers.js';
import { SUPABASE_URL } from './supabase-mock.js';

// ---- A small generated PNG (solid colour), served for every public storage URL ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** @param {number} w @param {number} h @param {[number, number, number]} rgb */
function makePng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const shade = ((x >> 3) + (y >> 3)) % 2 ? 1 : 0.85;
      raw[i] = rgb[0] * shade;
      raw[i + 1] = rgb[1] * shade;
      raw[i + 2] = rgb[2] * shade;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(64, 48, [232, 168, 58]);

/**
 * Like openApp, but also serves an image for public storage URLs (registered after the
 * Supabase mock so it wins).
 * @param {import('playwright/test').Page} page @param {string} path @param {any} [opts]
 */
async function open(page, path, opts = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  const sb = await mockSupabase(page, opts);
  await page.route(`${SUPABASE_URL}/storage/v1/object/public/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG }),
  );
  if (opts.locale) await page.addInitScript((l) => localStorage.setItem('tt.locale', JSON.stringify(l)), opts.locale);
  await page.goto(`./#${path}`);
  await expect(page.locator('.tabbar')).toBeVisible();
  if (opts.mode === 'asEditor') await expect(page.getByTestId('header-editor')).toBeVisible();
  return Object.assign(sb, { pageErrors: errors });
}

// Uploads and image resizing are slow when the machine is busy.
test.describe.configure({ timeout: 60_000 });

const storageCalls = (sb, method) => sb.calls.filter((c) => c.path.startsWith('/storage/v1/object/') && !c.path.includes('/public/') && c.method === method);
const photoFile = (name = 'tyler.png') => ({ name, mimeType: 'image/png', buffer: PNG });

// ---------------------------------------------------------------------------
// Profile screen
// ---------------------------------------------------------------------------

test('visitor sees the profile read-only and no private data is requested', async ({ page }) => {
  const sb = await open(page, '/profile');
  const card = page.getByTestId('profile-card');
  await expect(card.getByRole('heading', { name: 'Tyler' })).toBeVisible();
  await expect(page.getByTestId('profile-age')).toHaveText('7 semanas');
  await expect(card.getByText('3 días con nosotros').first()).toBeVisible();
  await expect(page.getByTestId('edit-profile')).toHaveCount(0);
  await expect(page.getByTestId('profile-photo-button')).toHaveCount(0);
  await expect(page.getByTestId('private-card')).toHaveCount(0);
  await expect(page.getByTestId('export-card')).toHaveCount(0);
  await expect(page.getByTestId('edit-meals')).toHaveCount(0);
  await expect(page.getByTestId('meal-schedule').getByText('Comida 4')).toBeVisible();
  await expect(page.getByTestId('timezone')).toContainText('America/Bogota');
  await expect(page.getByText('Datos privados')).toHaveCount(0);
  await expect(page.getByTestId('app-version')).toHaveText('Desarrollo');
  expect(sb.restCalls('pet_private')).toHaveLength(0);
  expect(sb.restCalls('vet_visit_private')).toHaveLength(0);
  expect(sb.pageErrors).toEqual([]);
});

test('editor edits the profile', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor' });
  await page.getByTestId('edit-profile').click();
  const sheet = page.getByRole('dialog', { name: 'Editar perfil' });
  await sheet.getByLabel('Nombre completo').fill('Tyler Prueba');
  await sheet.getByLabel('Comida').fill('Concentrado de prueba');
  await sheet.getByLabel('Sobre él').fill('Le encanta morder medias.');
  await sheet.getByLabel(/^Nombre( \*)?$/).fill('');
  await sheet.getByTestId('save-profile').click();
  await expect(sheet.getByText('Este campo es obligatorio.')).toBeVisible();
  await sheet.getByLabel(/^Nombre( \*)?$/).fill('Tylercito');
  await sheet.getByTestId('save-profile').click();
  await expect(sheet).toBeHidden();
  await expect(toastWith(page, 'Perfil guardado')).toBeVisible();
  await expect(page.getByTestId('profile-card').getByRole('heading', { name: 'Tylercito' })).toBeVisible();
  await expect(page.getByText('Le encanta morder medias.')).toBeVisible();
  expect(sb.db.pet_profile[0]).toMatchObject({ name: 'Tylercito', full_name: 'Tyler Prueba', food: 'Concentrado de prueba', about: 'Le encanta morder medias.' });
  const patch = sb.restCalls('pet_profile', 'PATCH')[0];
  expect(patch.body).not.toHaveProperty('created_at');
});

test('failed profile save rolls back and explains', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor', failWrites: true });
  await page.getByTestId('edit-profile').click();
  const sheet = page.getByRole('dialog', { name: 'Editar perfil' });
  await sheet.getByLabel(/^Nombre( \*)?$/).fill('Otro nombre');
  await sheet.getByTestId('save-profile').click();
  await expect(toastWith(page, 'No se pudo guardar y se deshizo el cambio')).toBeVisible();
  await expect(sheet).toBeVisible(); // stays open so nothing typed is lost
  await sheet.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('profile-card').getByRole('heading', { name: 'Tyler', exact: true })).toBeVisible();
  expect(sb.db.pet_profile[0].name).toBe('Tyler');
});

test('editor uploads a profile photo', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor' });
  await page.getByTestId('profile-photo-input').setInputFiles(photoFile());
  await expect(toastWith(page, 'Foto de perfil actualizada')).toBeVisible();
  await expect.poll(() => sb.db.pet_profile[0].photo_path).toMatch(/^profile\/[0-9a-f-]+\.jpg$/);
  expect(storageCalls(sb, 'POST')).toHaveLength(1);
  await expect(page.getByTestId('profile-photo').locator('img')).toHaveAttribute('src', /storage\/v1\/object\/public\/photos\/profile\//);
});

test('private details: editors see and edit them, phone is tappable', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor' });
  const card = page.getByTestId('private-card');
  await expect(card.getByText('000000000000000')).toBeVisible();
  await card.getByTestId('edit-private').click();
  const sheet = page.getByRole('dialog', { name: 'Datos privados' });
  await sheet.getByLabel('Teléfono del veterinario').fill('+57 300 000 0000');
  await sheet.getByTestId('save-private').click();
  await expect(sheet).toBeHidden();
  await expect(card.getByTestId('vet-phone')).toHaveAttribute('href', 'tel:+573000000000');
  expect(sb.db.pet_private[0].vet_phone).toBe('+57 300 000 0000');
  expect(sb.restCalls('pet_private', 'POST')).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Profile photo viewer
// ---------------------------------------------------------------------------

test('tapping the profile photo opens the full-screen viewer and closing returns focus', async ({ page }) => {
  await open(page, '/profile');
  const photo = page.getByTestId('profile-photo');
  await photo.click();
  const viewer = page.getByTestId('photo-viewer');
  await expect(viewer).toBeVisible();
  // No uploaded photo yet: the app icon photo shown on the screen opens.
  await expect(viewer.locator('img')).toHaveAttribute('src', 'assets/icons/icon-512.png');
  await expect(page.getByTestId('viewer-close')).toBeFocused();
  await page.getByTestId('viewer-close').click();
  await expect(viewer).toBeHidden();
  await expect(photo).toBeFocused();
  await expect(page).toHaveURL(/#\/profile$/);

  // Escape closes too.
  await photo.click();
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  // Back closes it without leaving the screen.
  await photo.click();
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.getByTestId('profile-card')).toBeVisible();
});

test('quickly closing and reopening the viewer never leaves the app or the route', async ({ page }) => {
  await open(page, '/profile');
  const photo = page.getByTestId('profile-photo');
  const viewer = page.getByTestId('photo-viewer');
  const depth = await page.evaluate(() => history.length);
  for (let i = 0; i < 4; i++) {
    await photo.click();
    await expect(viewer).toBeVisible();
    if (i % 2) await page.keyboard.press('Escape');
    else await page.getByTestId('viewer-close').click();
    await expect(viewer).toBeHidden();
  }
  // History is balanced: we are back on the screen's own entry (at most the last overlay entry
  // remains as a forward entry), and no entries piled up.
  await expect.poll(() => page.evaluate(() => !history.state?.ttOverlay)).toBe(true);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(depth + 1);
  await expect(page).toHaveURL(/#\/profile$/);
  // Back from a reopened viewer only closes it.
  await photo.click();
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(page).toHaveURL(/#\/profile$/);
});

test('viewer zooms with double tap and pinch, and pans', async ({ page }) => {
  await open(page, '/profile');
  await page.getByTestId('profile-photo').click();
  const stage = page.getByTestId('viewer-stage');
  await expect(stage).toHaveAttribute('data-scale', '1.00');
  const box = await stage.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.dblclick(cx, cy);
  await expect(stage).toHaveAttribute('data-scale', '2.50');
  await page.getByTestId('viewer-reset').click();
  await expect(stage).toHaveAttribute('data-scale', '1.00');

  // Synthetic two-finger pinch (pointer events, as iOS Safari sends them).
  await page.evaluate(([x, y]) => {
    const el = document.querySelector('[data-testid="viewer-stage"]');
    const fire = (type, id, px, py) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: py, bubbles: true, isPrimary: id === 1 }));
    fire('pointerdown', 1, x - 20, y);
    fire('pointerdown', 2, x + 20, y);
    for (let d = 20; d <= 60; d += 10) {
      fire('pointermove', 1, x - d, y);
      fire('pointermove', 2, x + d, y);
    }
    // Pan with both fingers.
    fire('pointermove', 1, x - 60 + 30, y + 20);
    fire('pointermove', 2, x + 60 + 30, y + 20);
    fire('pointerup', 1, x - 30, y + 20);
    fire('pointerup', 2, x + 90, y + 20);
  }, [cx, cy]);
  await expect(stage).toHaveAttribute('data-scale', '3.00');
  const transform = await stage.locator('img').evaluate((img) => img.style.transform);
  expect(transform).toContain('scale(3)');
  expect(transform).not.toContain('translate3d(0px, 0px');
});

// ---------------------------------------------------------------------------
// Meal schedule
// ---------------------------------------------------------------------------

test('editor changes meal times, adds a meal and reorders', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor' });
  await page.getByTestId('edit-meals').click();
  const sheet = page.getByRole('dialog', { name: 'Horario de comidas' });
  const rows = sheet.getByTestId('meal-row');
  await expect(rows).toHaveCount(4);
  await rows.nth(0).getByLabel('Hora').fill('07:30');
  await rows.nth(0).getByLabel('Gramos').fill('80');
  await sheet.getByTestId('add-meal').click();
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(4).getByLabel('Hora')).toHaveValue('21:00');
  await rows.nth(4).getByLabel('Hora').fill('11:00');
  await sheet.getByTestId('save-meals').click();
  await expect(sheet.getByText('Esta hora ya está en otra comida.')).toBeVisible();
  await rows.nth(4).getByLabel('Hora').fill('22:00');
  await sheet.getByRole('button', { name: 'Quitar comida 3' }).click();
  await sheet.getByRole('button', { name: 'Bajar comida 1' }).click();
  await sheet.getByRole('button', { name: 'Ordenar por hora' }).click();
  await sheet.getByLabel('Nota sobre la cantidad').fill('Según el empaque');
  await sheet.getByTestId('save-meals').click();
  await expect(sheet).toBeHidden();
  await expect(toastWith(page, 'Horario guardado')).toBeVisible();
  expect(sb.db.settings[0].meal_slots).toEqual([
    { slot: 1, time: '07:30', grams: 80 },
    { slot: 2, time: '11:00', grams: null },
    { slot: 3, time: '19:00', grams: null },
    { slot: 4, time: '22:00', grams: null },
  ]);
  expect(sb.db.settings[0].meal_amount_note).toBe('Según el empaque');
  await expect(page.getByTestId('meal-schedule').getByText('Según el empaque')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('export downloads all data as JSON and one table as CSV', async ({ page }) => {
  const sb = await open(page, '/profile', { mode: 'asEditor' });
  const card = page.getByTestId('export-card');
  const [json] = await Promise.all([page.waitForEvent('download'), card.getByTestId('export-json').click()]);
  expect(json.suggestedFilename()).toBe('tyler-tracker-2026-11-13.json');
  const doc = JSON.parse(readFileSync(await json.path(), 'utf8'));
  expect(doc.app).toBe('tyler-tracker');
  expect(doc.timezone).toBe('America/Bogota');
  expect(doc.tables.feedings).toHaveLength(2);
  expect(doc.tables.pet_private[0].microchip).toBe('000000000000000');
  expect(Object.keys(doc.tables)).toContain('vet_visit_private');
  // Ranged tables were loaded over all time, not just the default window.
  expect(sb.restCalls('feedings', 'GET').some((c) => c.search.includes('gte.2000-01-01'))).toBe(true);
  expect(sb.restCalls('routine_events', 'GET').some((c) => c.search.includes('gte.2000-01-01'))).toBe(true);

  await card.getByText('Descargar una tabla en CSV').click();
  const [csv] = await Promise.all([page.waitForEvent('download'), card.getByTestId('export-csv-feedings').click()]);
  expect(csv.suggestedFilename()).toBe('tyler-tracker-2026-11-13-feedings.csv');
  const text = readFileSync(await csv.path(), 'utf8').replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  expect(lines).toHaveLength(3);
  expect(lines[0].split(',')).toEqual(expect.arrayContaining(['id', 'fed_at', 'meal_slot', 'amount_g']));
  await expect(card.getByTestId('export-csv-feedings')).toContainText('2 filas');
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

test('visitor sees the memories timeline without edit controls', async ({ page }) => {
  await open(page, '/profile/memories', {
    fixtures: {
      photos: [{ id: 'p0000000-0000-4000-8000-000000000001', storage_path: 'milestones/a.jpg', milestone_id: 'm0000000-0000-4000-8000-000000000001', caption: 'En el carro', taken_on: '2026-11-10', width: 64, height: 48, created_at: '2026-11-10T15:00:00.000Z' }],
    },
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recuerdos');
  await expect(page.getByRole('heading', { name: 'Noviembre de 2026' })).toBeVisible();
  const entry = page.getByTestId('milestone-entry');
  await expect(entry.getByRole('heading', { name: 'Llegó a casa' })).toBeVisible();
  await expect(entry).toContainText('6 semanas y 4 días');
  await expect(page.getByTestId('fab-add')).toHaveCount(0);
  await expect(page.getByTestId('edit-milestone')).toHaveCount(0);
  await entry.getByTestId('photo-thumb').click();
  const viewer = page.getByTestId('photo-viewer');
  await expect(viewer).toContainText('En el carro');
  await expect(page.getByTestId('viewer-edit')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test('memories empty state offers quick picks to editors', async ({ page }) => {
  await open(page, '/profile/memories', { mode: 'asEditor', fixtures: { milestones: [] } });
  await expect(page.getByText('Aún no hay recuerdos')).toBeVisible();
  await page.getByTestId('quick-picks').getByRole('button', { name: 'Primer baño' }).click();
  const sheet = page.getByRole('dialog', { name: 'Nuevo momento' });
  await expect(sheet.getByLabel('Qué pasó')).toHaveValue('Primer baño');
});

test('editor adds a milestone with photos, then views and deletes a photo', async ({ page }) => {
  const sb = await open(page, '/profile/memories', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  await page.getByTestId('choose-milestone').click();
  const sheet = page.getByRole('dialog', { name: 'Nuevo momento' });
  // "Llegó a casa" already exists, so it is not suggested again.
  await expect(sheet.getByTestId('quick-picks').getByRole('button', { name: 'Llegó a casa' })).toHaveCount(0);
  await sheet.getByTestId('quick-picks').getByRole('button', { name: 'Primer baño' }).click();
  await sheet.getByLabel('Fecha').fill('2026-11-12');
  await sheet.getByLabel('Historia').fill('Se portó muy bien.');
  await sheet.getByTestId('photo-input').setInputFiles([photoFile('a.png'), photoFile('b.png')]);
  await expect(sheet.getByTestId('pending-photo')).toHaveCount(2);
  await sheet.getByTestId('save-milestone').click();
  await expect(sheet).toBeHidden();
  await expect(toastWith(page, 'Momento guardado')).toBeVisible();

  expect(sb.db.milestones).toHaveLength(2);
  const m = sb.db.milestones.find((r) => r.title === 'Primer baño');
  expect(m).toMatchObject({ happened_on: '2026-11-12', story: 'Se portó muy bien.' });
  expect(sb.db.photos).toHaveLength(2);
  expect(sb.db.photos.every((p) => p.milestone_id === m.id && p.taken_on === '2026-11-12' && p.storage_path.startsWith('milestones/'))).toBe(true);
  expect(storageCalls(sb, 'POST')).toHaveLength(2);

  const entry = page.getByTestId('milestone-entry').filter({ hasText: 'Primer baño' });
  await expect(entry.getByTestId('photo-thumb')).toHaveCount(2);
  await expect(entry).toContainText('6 semanas y 6 días');

  // Viewer: next/previous and delete (removes the stored file too).
  await entry.getByTestId('photo-thumb').first().click();
  const viewer = page.getByTestId('photo-viewer');
  await expect(viewer).toContainText('1 de 2');
  await viewer.getByRole('button', { name: 'Foto siguiente' }).click();
  await expect(viewer).toContainText('2 de 2');
  await page.getByTestId('viewer-edit').click();
  await page.getByTestId('delete-photo').click();
  await page.getByRole('dialog', { name: '¿Eliminar esta foto?' }).getByRole('button', { name: 'Eliminar foto' }).click();
  await expect(toastWith(page, 'Foto eliminada')).toBeVisible();
  await expect.poll(() => sb.db.photos.length).toBe(1);
  await expect.poll(() => storageCalls(sb, 'DELETE').length).toBe(1);
  await expect(viewer).not.toContainText('de 2');
});

test('editor adds loose photos with a caption', async ({ page }) => {
  const sb = await open(page, '/profile/memories', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  await page.getByTestId('choose-photos').click();
  const sheet = page.getByRole('dialog', { name: 'Agregar fotos' });
  await sheet.getByTestId('save-photos').click();
  await expect(sheet.getByText('Elige al menos una foto.')).toBeVisible();
  await sheet.getByTestId('photo-input').setInputFiles(photoFile());
  await sheet.getByLabel('Descripción').fill('Dormido en el sofá');
  await sheet.getByTestId('save-photos').click();
  await expect(sheet).toBeHidden();
  await expect(toastWith(page, 'Foto guardada')).toBeVisible();
  expect(sb.db.photos).toHaveLength(1);
  expect(sb.db.photos[0]).toMatchObject({ milestone_id: null, caption: 'Dormido en el sofá', taken_on: '2026-11-13' });
  await expect(page.getByTestId('photos-entry').getByRole('heading', { name: 'Dormido en el sofá' })).toBeVisible();
});

test('failed photo upload shows the failure and retry works', async ({ page }) => {
  const sb = await open(page, '/profile/memories', { mode: 'asEditor' });
  await page.getByTestId('fab-add').click();
  await page.getByTestId('choose-photos').click();
  const sheet = page.getByRole('dialog', { name: 'Agregar fotos' });
  await sheet.getByTestId('photo-input').setInputFiles(photoFile());
  sb.setFailWrites(true);
  await sheet.getByTestId('save-photos').click();
  await expect(sheet.getByTestId('upload-failed')).toContainText('1 foto no se pudo subir');
  await expect(sheet.getByTestId('pending-photo')).toHaveAttribute('data-status', 'failed');
  expect(sb.db.photos).toHaveLength(0);
  sb.setFailWrites(false);
  await sheet.getByRole('button', { name: 'Reintentar' }).click();
  await expect(sheet).toBeHidden();
  expect(sb.db.photos).toHaveLength(1);
});

test('editor deletes a milestone and its photos', async ({ page }) => {
  const sb = await open(page, '/profile/memories', {
    mode: 'asEditor',
    fixtures: {
      photos: [{ id: 'p0000000-0000-4000-8000-000000000001', storage_path: 'milestones/a.jpg', milestone_id: 'm0000000-0000-4000-8000-000000000001', caption: null, taken_on: '2026-11-10', width: 64, height: 48, created_at: '2026-11-10T15:00:00.000Z' }],
    },
  });
  await page.getByTestId('edit-milestone').click();
  const sheet = page.getByRole('dialog', { name: 'Editar momento' });
  await sheet.getByRole('button', { name: 'Eliminar' }).click();
  const confirm = page.getByRole('dialog', { name: '¿Eliminar este momento?' });
  await expect(confirm).toContainText('También se borrará su foto');
  await confirm.getByRole('button', { name: 'Eliminar momento' }).click();
  await expect(toastWith(page, 'Momento eliminado')).toBeVisible();
  await expect.poll(() => sb.db.milestones.length).toBe(0);
  await expect.poll(() => sb.db.photos.length).toBe(0);
  await expect.poll(() => storageCalls(sb, 'DELETE').length).toBe(1);
  await expect(page.getByText('Aún no hay recuerdos')).toBeVisible();
});

test('profile and memories have no horizontal scroll (editor)', async ({ page }) => {
  for (const path of ['/profile', '/profile/memories']) {
    await open(page, path, { mode: 'asEditor' });
    const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - page.viewportSize().width;
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});

// ---------------------------------------------------------------------------
// Review screenshots (only with SCREENSHOT_DIR; not part of `npm run check`):
//   SCREENSHOT_DIR=/home/claude/review/profile npm run test:e2e -- tests/e2e/profile.spec.js -g screenshots
// ---------------------------------------------------------------------------
test.describe('screenshots', () => {
  const dir = process.env.SCREENSHOT_DIR;
  test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
  const COLORS = [[232, 168, 58], [120, 170, 140], [140, 170, 210], [210, 140, 120], [190, 160, 210]];
  const PNGS = COLORS.map((c, i) => makePng(160 + i * 20, 120 + (i % 2) * 60, c));
  const pid = (n) => `p0000000-0000-4000-8000-00000000000${n}`;
  const M1 = 'm0000000-0000-4000-8000-000000000001';
  const M2 = 'm0000000-0000-4000-8000-000000000002';
  const fixtures = {
    pet_profile: [{ id: 1, name: 'Tyler', full_name: 'Tyler Ejemplo', breed: 'Golden Retriever', sex: 'male', birth_date: '2026-09-25', home_date: '2026-11-10', food: 'Concentrado de cachorro', about: 'Le encanta dormir encima de los zapatos y perseguir hojas.', photo_path: 'profile/tyler.jpg', created_at: '2026-11-10T15:00:00.000Z' }],
    milestones: [
      { id: M1, happened_on: '2026-11-10', title: 'Llegó a casa', story: 'Durmió todo el camino en el carro.', created_at: '2026-11-10T15:00:00.000Z' },
      { id: M2, happened_on: '2026-11-12', title: 'Primer baño', story: null, created_at: '2026-11-12T15:00:00.000Z' },
      { id: 'm0000000-0000-4000-8000-000000000003', happened_on: '2026-10-30', title: 'Lo conocimos', story: 'Fue el más curioso de la camada.', created_at: '2026-10-30T15:00:00.000Z' },
    ],
    photos: [
      { id: pid(1), storage_path: 'milestones/1.jpg', milestone_id: M1, caption: 'En el carro', taken_on: '2026-11-10', width: 160, height: 120, created_at: '2026-11-10T15:00:00.000Z' },
      { id: pid(2), storage_path: 'milestones/2.jpg', milestone_id: M1, caption: null, taken_on: '2026-11-10', width: 180, height: 180, created_at: '2026-11-10T15:01:00.000Z' },
      { id: pid(3), storage_path: 'milestones/3.jpg', milestone_id: M1, caption: null, taken_on: '2026-11-10', width: 200, height: 120, created_at: '2026-11-10T15:02:00.000Z' },
      { id: pid(4), storage_path: 'milestones/4.jpg', milestone_id: M2, caption: 'Todo mojado', taken_on: '2026-11-12', width: 220, height: 180, created_at: '2026-11-12T15:00:00.000Z' },
      { id: pid(5), storage_path: 'milestones/5.jpg', milestone_id: null, caption: 'Siesta en el sofá', taken_on: '2026-11-13', width: 240, height: 120, created_at: '2026-11-13T15:00:00.000Z' },
    ],
  };
  const shot = (page, name, fullPage = false) =>
    page.screenshot({ path: `${dir}/${name}.png`, fullPage, style: fullPage ? '.tabbar { display: none !important; }' : undefined });
  const settle = (page) => page.waitForTimeout(500);
  /** Like open() but with a different colour per stored photo. */
  async function openShots(page, path, opts = {}) {
    const sb = await open(page, path === null ? '/today' : path, opts);
    await page.route(`${SUPABASE_URL}/storage/v1/object/public/**`, (route) => {
      const n = Number(/(\d)\.jpg$/.exec(route.request().url())?.[1] || 0);
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNGS[n % PNGS.length] });
    });
    await page.reload();
    await expect(page.locator('.tabbar')).toBeVisible();
    await settle(page);
    return sb;
  }

  for (const [scheme, locale, mode] of [
    ['light', 'es', 'signedOut'],
    ['light', 'es', 'asEditor'],
    ['dark', 'es', 'asEditor'],
    ['light', 'en', 'signedOut'],
    ['dark', 'en', 'signedOut'],
  ]) {
    test(`profile ${locale} ${scheme} ${mode}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShots(page, '/profile', { mode, locale, fixtures });
      const who = mode === 'asEditor' ? 'editor' : 'visitor';
      await shot(page, `profile-${who}-${locale}-${scheme}`);
      await shot(page, `profile-${who}-${locale}-${scheme}-full`, true);
    });
  }

  test('profile with no photo (fallback) and its viewer', async ({ page }) => {
    await openShots(page, '/profile', {});
    await shot(page, 'profile-visitor-no-photo');
    await page.getByTestId('profile-photo').click();
    await settle(page);
    await shot(page, 'viewer-profile-fallback');
  });

  test('profile photo viewer (zoomed)', async ({ page }) => {
    await openShots(page, '/profile', { fixtures });
    await page.getByTestId('profile-photo').click();
    await settle(page);
    await shot(page, 'viewer-profile');
    const box = await page.getByTestId('viewer-stage').boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
    await shot(page, 'viewer-profile-zoomed');
  });

  for (const scheme of ['light', 'dark']) {
    test(`memories timeline ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShots(page, '/profile/memories', { mode: 'asEditor', fixtures });
      await shot(page, `memories-${scheme}`);
      await shot(page, `memories-${scheme}-full`, true);
    });
  }

  test('memories viewer, empty states and forms', async ({ page }) => {
    await openShots(page, '/profile/memories', { mode: 'asEditor', fixtures });
    await page.getByTestId('photo-thumb').first().click();
    await settle(page);
    await shot(page, 'viewer-memories-editor');
    await page.keyboard.press('Escape');
    await page.getByTestId('fab-add').click();
    await settle(page);
    await shot(page, 'memories-add-chooser');
    await page.getByTestId('choose-milestone').click();
    await page.getByRole('dialog').getByTestId('photo-input').setInputFiles([photoFile('a.png'), photoFile('b.png'), photoFile('c.png')]);
    await settle(page);
    await shot(page, 'memories-milestone-sheet');
  });

  test('memories empty (visitor and editor)', async ({ page }) => {
    await openShots(page, '/profile/memories', { fixtures: { milestones: [], photos: [] } });
    await shot(page, 'memories-empty-visitor');
  });
  test('memories empty editor', async ({ page }) => {
    await openShots(page, '/profile/memories', { mode: 'asEditor', fixtures: { milestones: [], photos: [] } });
    await shot(page, 'memories-empty-editor');
  });

  for (const scheme of ['light', 'dark']) {
    test(`meal schedule editor and export ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShots(page, '/profile', { mode: 'asEditor', fixtures });
      await page.getByTestId('edit-meals').click();
      const sheet = page.getByRole('dialog', { name: 'Horario de comidas' });
      await sheet.getByTestId('meal-row').nth(0).getByLabel('Gramos').fill('80');
      await sheet.getByRole('button', { name: 'Bajar comida 1' }).click();
      await settle(page);
      await shot(page, `meals-editor-${scheme}`);
      await sheet.getByRole('button', { name: 'Cancelar' }).click();
      await page.getByTestId('export-card').getByText('Descargar una tabla en CSV').click();
      await page.getByTestId('export-card').scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, `export-${scheme}`);
    });
  }

  test('edit profile and private details sheets', async ({ page }) => {
    await openShots(page, '/profile', { mode: 'asEditor', fixtures });
    await page.getByTestId('edit-profile').click();
    await settle(page);
    await shot(page, 'profile-edit-sheet');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
    await page.getByTestId('private-card').scrollIntoViewIfNeeded();
    await settle(page);
    await shot(page, 'private-card');
  });
});
