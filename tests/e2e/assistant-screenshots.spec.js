// Review screenshots for the assistant (not part of `npm run check`).
//   SCREENSHOT_DIR=/home/claude/review/assistant npx playwright test tests/e2e/assistant-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp, EDITOR_USER } from './helpers.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
test.describe.configure({ timeout: 40_000 });

const shot = (page, name) => page.screenshot({ path: resolve(dir || '.', `${name}.png`) });
const settle = (page) => page.waitForTimeout(400);
const T = 'c0000000-0000-4000-8000-000000000001';
const by = { created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const answer =
  'A las **7 semanas** lo normal son **4 comidas al día**, a horas fijas.\n\n- Reparte la ración diaria de la bolsa entre las 4 comidas.\n- Retira el plato a los 15–20 minutos.\n- Pésalo cada semana y ajusta con su veterinario.';
const fixtures = (locale = 'es') => ({
  chat_threads: [
    { id: T, title: locale === 'es' ? '¿Cuántas veces al día debe comer?' : 'How many meals a day?', created_at: '2026-11-13T15:00:00.000Z', updated_at: '2026-11-13T15:01:00.000Z', ...by },
    { id: 'c0000000-0000-4000-8000-000000000002', title: 'Mordiscos en las manos y cómo redirigirlos con juguetes', created_at: '2026-11-11T15:00:00.000Z', updated_at: '2026-11-11T15:00:00.000Z', created_by: 'x', created_by_name: 'Sam' },
  ],
  chat_messages: [
    { id: 'm1', thread_id: T, role: 'user', content: locale === 'es' ? '¿Cuántas veces al día debe comer Tyler?' : 'How many times a day should Tyler eat?', sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, created_at: '2026-11-13T15:00:01.000Z', updated_at: '2026-11-13T15:00:01.000Z', ...by },
    { id: 'm2', thread_id: T, role: 'assistant', content: answer, sources: [{ title: 'AKC: Puppy Feeding Fundamentals', url: 'https://www.akc.org/expert-advice/nutrition/puppy-feeding-fundamentals/' }, { title: 'WSAVA Global Nutrition Guidelines', url: 'https://wsava.org/global-guidelines/global-nutrition-guidelines/' }], model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 100, web_searches: 1, cost_usd: 0.015, created_at: '2026-11-13T15:00:05.000Z', updated_at: '2026-11-13T15:00:05.000Z', ...by },
  ],
});

for (const scheme of ['light', 'dark']) {
  test(`empty chat with starters (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await expect(page.getByTestId('assistant-budget')).toBeVisible();
    await settle(page);
    await shot(page, `chat-empty-es-${scheme}`);
  });

  test(`conversation with sources (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, `/assistant?t=${T}`, { mode: 'asEditor', fixtures: fixtures() });
    await expect(page.locator('.msg')).toHaveCount(2);
    await settle(page);
    await shot(page, `chat-thread-es-${scheme}`);
  });

  test(`thread list (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, '/assistant/threads', { mode: 'asEditor', fixtures: fixtures() });
    await expect(page.getByTestId('thread-row').first()).toBeVisible();
    await settle(page);
    await shot(page, `threads-es-${scheme}`);
  });

  test(`FAQ draft preview (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, `/assistant?t=${T}`, { mode: 'asEditor', fixtures: fixtures() });
    await page.getByTestId('assistant-save-faq').click();
    await expect(page.getByTestId('faq-confirm')).toBeVisible();
    await settle(page);
    await shot(page, `faq-draft-es-${scheme}`);
  });
}

test('error state (budget exhausted)', async ({ page }) => {
  await openApp(page, '/assistant', { mode: 'asEditor', chat: { refuse: 'budget_exhausted', budget: { used_usd: 25, budget_usd: 25 } } });
  await page.getByLabel('Tu pregunta').fill('¿Puede comer zanahoria?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-error')).toBeVisible();
  await settle(page);
  await shot(page, 'chat-error-budget-es-light');
});

test('error state (upstream, dark)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, `/assistant?t=${T}`, { mode: 'asEditor', fixtures: fixtures(), chat: { streamError: true } });
  await page.getByLabel('Tu pregunta').fill('¿Y cuánta agua?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-error')).toBeVisible();
  await settle(page);
  await shot(page, 'chat-error-upstream-es-dark');
});

test('English chat (empty)', async ({ page }) => {
  await openApp(page, '/assistant', { mode: 'asEditor', locale: 'en' });
  await settle(page);
  await shot(page, 'chat-empty-en-light');
});

test('English chat (thread)', async ({ page }) => {
  await openApp(page, `/assistant?t=${T}`, { mode: 'asEditor', locale: 'en', fixtures: fixtures('en') });
  await expect(page.locator('.msg')).toHaveCount(2);
  await settle(page);
  await shot(page, 'chat-thread-en-light');
});

test('signed out', async ({ page }) => {
  await openApp(page, '/assistant');
  await settle(page);
  await shot(page, 'chat-signed-out-es-light');
});
