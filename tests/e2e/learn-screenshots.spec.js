// Review screenshots for the Learn tab (not part of `npm run check`).
//   SCREENSHOT_DIR=../review/learn E2E_PORT=4183 npm run test:e2e -- tests/e2e/learn-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, EDITOR_USER } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
const root = resolve(import.meta.dirname, '../..');
const content = (name) => JSON.parse(readFileSync(resolve(root, 'content', `${name}.json`), 'utf8')).items;
const shot = (page, name, fullPage = false) =>
  page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage, style: fullPage ? '.tabbar { display: none !important; }' : undefined });
const settle = (page) => page.waitForTimeout(400);

const audit = { created_at: '2026-11-13T14:00:00.000Z', updated_at: '2026-11-13T14:00:00.000Z', created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const fixtures = () => {
  const stage = [...content('roadmap')].sort((a, b) => a.from_weeks - b.from_weeks)[0];
  const guides = content('training');
  return {
    checklist_done: stage.todos.slice(0, 1).map((td) => ({ item_key: td.key, done_at: audit.created_at, ...audit })),
    training_skills: [
      { skill_key: guides[0].id, status: 'reliable', started_on: '2026-11-10', mastered_on: null, notes: 'Responde bien en casa; con visitas le cuesta.', ...audit },
      ...(guides[1] ? [{ skill_key: guides[1].id, status: 'learning', started_on: '2026-11-12', mastered_on: null, notes: null, ...audit }] : []),
    ],
    faq_entries: [
      {
        id: 'a0000000-0000-4000-8000-0000000000f1', category: 'training',
        question_es: '¿Cómo le enseño a no morder las manos?', question_en: 'How do I teach him not to bite hands?',
        answer_es: 'Es normal que muerda: está explorando y le salen los dientes.\n\n- Redirige a un **juguete** cada vez que muerda.\n- Si insiste, pausa el juego 20 segundos.',
        answer_en: 'Biting is normal: he is exploring and teething.\n\n- Redirect him to a **toy** every time he bites.\n- If he keeps going, pause play for 20 seconds.',
        sources: [{ title: 'Fuente de prueba', url: 'https://example.org/bite' }], source_thread_id: null, ...audit,
      },
    ],
  };
};

const pages = [
  ['home', '/learn'],
  ['must-know', '/learn/must-know'],
  ['roadmap', '/learn/roadmap'],
  ['training', '/learn/training'],
  ['health', '/learn/health'],
  ['parents', '/learn/parents'],
  ['faq', '/learn/faq'],
  ['facts', '/learn/facts'],
];

for (const [name, path] of pages) {
  test(`${name} (es, light)`, async ({ page }) => {
    await openApp(page, path, { fixtures: fixtures() });
    await settle(page);
    await shot(page, `${name}-es-light`);
    await shot(page, `${name}-es-light-full`, true);
  });
}

test('home (en, light) and (es, dark)', async ({ page }) => {
  await openApp(page, '/learn', { locale: 'en', fixtures: fixtures() });
  await settle(page);
  await shot(page, 'home-en-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => localStorage.setItem('tt.locale', JSON.stringify('es')));
  await page.reload();
  await settle(page);
  await shot(page, 'home-es-dark');
});

test('search results', async ({ page }) => {
  await openApp(page, '/learn', { fixtures: fixtures() });
  await page.getByTestId('learn-search').fill('vacunas');
  await settle(page);
  await shot(page, 'search-es-light');
});

test('article es/en light/dark', async ({ page }) => {
  const item = content('must-know')[0];
  await openApp(page, `/learn/must-know/${item.id}`);
  await settle(page);
  await shot(page, 'article-es-light', true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  await shot(page, 'article-es-dark', true);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.setItem('tt.locale', JSON.stringify('en')));
  await page.reload();
  await settle(page);
  await shot(page, 'article-en-light', true);
});

test('roadmap as editor (light + dark)', async ({ page }) => {
  await openApp(page, '/learn/roadmap', { mode: 'asEditor', fixtures: fixtures() });
  await settle(page);
  await shot(page, 'roadmap-editor-light', true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  await shot(page, 'roadmap-editor-dark', true);
});

test('training guide as editor', async ({ page }) => {
  const guide = content('training')[0];
  await openApp(page, `/learn/training/${guide.id}`, { mode: 'asEditor', fixtures: fixtures() });
  await settle(page);
  await shot(page, 'training-guide-editor', true);
  await page.getByTestId('training-status').selectOption('mastered');
  await settle(page);
  await shot(page, 'training-guide-editor-mastered');
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  await shot(page, 'training-guide-editor-dark', true);
});

test('training guide as visitor', async ({ page }) => {
  const guide = content('training')[0];
  await openApp(page, `/learn/training/${guide.id}`, { fixtures: fixtures() });
  await settle(page);
  await shot(page, 'training-guide-visitor', true);
});

test('faq empty, saved entry article as editor, delete confirm', async ({ page }) => {
  await page.route('**/content/faq.json', (route) => route.fulfill({ json: { version: 1, items: [] } }));
  await openApp(page, '/learn/faq');
  await expect(page.getByText('Aún no hay preguntas')).toBeVisible();
  await settle(page);
  await shot(page, 'faq-empty');
});

test('faq saved article (editor)', async ({ page }) => {
  await openApp(page, '/learn/faq/saved-a0000000-0000-4000-8000-0000000000f1', { mode: 'asEditor', fixtures: fixtures() });
  await settle(page);
  await shot(page, 'faq-article-editor', true);
  await page.getByTestId('faq-delete').click();
  await settle(page);
  await shot(page, 'faq-delete-confirm');
});

test('faq list (dark) and not found', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, '/learn/faq', { fixtures: fixtures() });
  await settle(page);
  await shot(page, 'faq-es-dark');
  await page.goto('./#/learn/health/nope');
  await settle(page);
  await shot(page, 'not-found');
});
