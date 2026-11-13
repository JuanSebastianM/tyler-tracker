// Cross-feature review screenshots with the REAL content files (not part of `npm run check`; the
// rest of the suite uses fake content). Every tab, its sub-screens and the assistant.
//   SCREENSHOT_DIR=/home/claude/review/integration E2E_PORT=4190 npm run test:e2e -- tests/e2e/integration-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp, EDITOR_USER } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
test.describe.configure({ timeout: 40_000 });

const shot = (page, name, fullPage = true) =>
  page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage, style: fullPage ? '.tabbar { display: none !important; }' : undefined });
const settle = (page) => page.waitForTimeout(500);

const by = { created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const at = (iso) => ({ created_at: iso, updated_at: iso });
const T = 'c0000000-0000-4000-8000-000000000001';
const fixtures = () => ({
  ...richFixtures(),
  weights: [
    { id: 'w0000000-0000-4000-8000-000000000001', measured_on: '2026-11-08', weight_kg: 4.6, notes: null, ...at('2026-11-08T15:00:00.000Z'), ...by },
    { id: 'w0000000-0000-4000-8000-000000000002', measured_on: '2026-11-12', weight_kg: 5.1, notes: null, ...at('2026-11-12T15:00:00.000Z'), ...by },
  ],
  dewormings: [
    { id: 'd0000000-0000-4000-8000-000000000001', product: null, kind: 'internal', given_on: '2026-11-01', weight_kg: null, next_due_on: '2026-11-15', notes: null, ...at('2026-11-10T15:00:00.000Z'), ...by },
  ],
  faq_entries: [
    {
      id: 'a0000000-0000-4000-8000-0000000000f1', category: 'feeding',
      question_es: '¿Cuántas veces al día come Tyler?', question_en: 'How many times a day does Tyler eat?',
      answer_es: 'Cuatro comidas al día mientras es cachorro.', answer_en: 'Four meals a day while he is a puppy.',
      sources: [{ title: 'AKC: Puppy Feeding Fundamentals', url: 'https://www.akc.org/expert-advice/nutrition/puppy-feeding-fundamentals/' }],
      source_thread_id: T, ...at('2026-11-13T15:02:00.000Z'), ...by,
    },
  ],
  chat_threads: [{ id: T, title: '¿Cuántas veces al día debe comer?', ...at('2026-11-13T15:00:00.000Z'), ...by }],
  chat_messages: [
    { id: 'm1', thread_id: T, role: 'user', content: '¿Cuántas veces al día debe comer Tyler?', sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, ...at('2026-11-13T15:00:01.000Z'), ...by },
    { id: 'm2', thread_id: T, role: 'assistant', content: 'A las **7 semanas**, **4 comidas al día**.\n\n## Cómo repartirlas\n- Horas fijas.\n- Retira el plato a los 15–20 minutos.', sources: [{ title: 'AKC', url: 'https://www.akc.org/' }], model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 100, web_searches: 1, cost_usd: 0.015, ...at('2026-11-13T15:00:05.000Z'), ...by },
  ],
});

const ROUTES = [
  ['today', '/today'],
  ['log', '/log'],
  ['log-stats', '/log/stats'],
  ['health', '/health'],
  ['health-vaccines', '/health/vaccines'],
  ['health-deworming', '/health/deworming'],
  ['health-weight', '/health/weight'],
  ['health-visits', '/health/visits'],
  ['health-medications', '/health/medications'],
  ['health-reminders', '/health/reminders'],
  ['learn', '/learn'],
  ['learn-must-know', '/learn/must-know'],
  ['learn-roadmap', '/learn/roadmap'],
  ['learn-training', '/learn/training'],
  ['learn-health', '/learn/health'],
  ['learn-parents', '/learn/parents'],
  ['learn-faq', '/learn/faq'],
  ['learn-facts', '/learn/facts'],
  ['profile', '/profile'],
  ['profile-memories', '/profile/memories'],
  ['assistant', `/assistant?t=${T}`],
  ['assistant-threads', '/assistant/threads'],
];

for (const [name, path] of ROUTES) {
  test(`editor ${name}`, async ({ page }) => {
    const sb = await openApp(page, path, { mode: 'asEditor', fixtures: fixtures(), content: 'real' });
    await settle(page);
    await shot(page, `${name}-editor`);
    expect(sb.pageErrors).toEqual([]);
  });
}

for (const [name, path] of ROUTES.filter(([n]) => !n.startsWith('assistant'))) {
  test(`visitor ${name}`, async ({ page }) => {
    const sb = await openApp(page, path, { fixtures: fixtures(), content: 'real' });
    await settle(page);
    await shot(page, `${name}-visitor`);
    expect(sb.pageErrors).toEqual([]);
  });
}

test('article deep links (real content)', async ({ page }) => {
  await openApp(page, '/learn/must-know', { content: 'real' });
  await page.locator('.learn a.list-row, .learn a[href*="/learn/must-know/"]').first().click();
  await settle(page);
  await shot(page, 'learn-must-know-article');
  await page.goto('./#/learn/roadmap/weeks-6-8');
  await settle(page);
  await shot(page, 'learn-roadmap-current');
});

for (const name of ['today', 'health-weight', 'learn', 'profile', 'assistant']) {
  test(`dark ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const path = ROUTES.find(([n]) => n === name)[1];
    await openApp(page, path, { mode: 'asEditor', fixtures: fixtures(), content: 'real' });
    await settle(page);
    await shot(page, `${name}-editor-dark`);
  });
}

test('english today and learn', async ({ page }) => {
  await openApp(page, '/today', { mode: 'asEditor', fixtures: fixtures(), content: 'real', locale: 'en' });
  await settle(page);
  await shot(page, 'today-editor-en');
  await page.goto('./#/learn');
  await settle(page);
  await shot(page, 'learn-editor-en');
});

test('sheets: deworming form, vaccine detail', async ({ page }) => {
  await openApp(page, '/health/deworming', { mode: 'asEditor', fixtures: fixtures(), content: 'real' });
  await page.getByTestId('fab-add').click();
  await settle(page);
  await shot(page, 'sheet-deworming-form', false);
  await page.goto('./#/health/vaccines');
  await page.getByTestId('vaccines-row').click();
  await settle(page);
  await shot(page, 'sheet-vaccine-detail', false);
});
