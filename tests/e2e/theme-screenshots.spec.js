// Review screenshots of every colour theme in light and dark (not part of `npm run check`).
//   SCREENSHOT_DIR=/home/claude/review/theme E2E_PORT=4193 npm run test:e2e -- tests/e2e/theme-screenshots.spec.js
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { openApp, EDITOR_USER } from './helpers.js';
import { richFixtures } from './today-log-fixtures.js';

const dir = process.env.SCREENSHOT_DIR;
test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
test.describe.configure({ timeout: 60_000 });

const THEMES = ['default', 'rose', 'lavender', 'mint', 'sky'];
const shot = (page, name, fullPage = false) => page.screenshot({ path: resolve(dir || '.', `${name}.png`), fullPage });
const settle = (page) => page.waitForTimeout(500);
const by = { created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const at = (iso) => ({ created_at: iso, updated_at: iso });
const T = 'c0000000-0000-4000-8000-000000000001';
const article = JSON.parse(readFileSync(new URL('../../content/must-know.json', import.meta.url), 'utf8')).items.find((i) => !i.sample) ;

const fixtures = (theme, mode) => ({
  ...richFixtures(),
  dewormings: [
    { id: 'd0000000-0000-4000-8000-000000000001', product: null, kind: 'internal', given_on: '2026-11-01', weight_kg: null, next_due_on: '2026-11-15', notes: null, ...at('2026-11-10T15:00:00.000Z'), ...by },
  ],
  chat_threads: [{ id: T, title: '¿Cuántas veces al día debe comer?', ...at('2026-11-13T15:00:00.000Z'), ...by }],
  chat_messages: [
    { id: 'm1', thread_id: T, role: 'user', content: '¿Cuántas veces al día debe comer Tyler?', sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, ...at('2026-11-13T15:00:01.000Z'), ...by },
    { id: 'm2', thread_id: T, role: 'assistant', content: 'A las **7 semanas** lo normal son **4 comidas al día**.\n\n- Reparte la ración de la bolsa.\n- Pésalo cada semana.', sources: [{ title: 'AKC: Puppy Feeding Fundamentals', url: 'https://www.akc.org/expert-advice/nutrition/puppy-feeding-fundamentals/' }], model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 100, web_searches: 1, cost_usd: 0.015, ...at('2026-11-13T15:00:05.000Z'), ...by },
  ],
  user_settings: [{ user_id: EDITOR_USER.id, theme, color_mode: mode, ...at('2026-11-13T15:00:00.000Z'), ...by }],
});

for (const theme of THEMES) {
  for (const mode of ['light', 'dark']) {
    test(`${theme} ${mode}`, async ({ page }) => {
      // The editor's saved theme, also cached as the launch theme so the first paint matches.
      await page.addInitScript((c) => localStorage.setItem('tt.theme.active', JSON.stringify(c)), { theme, mode });
      // Budget at 84 %: the meter shows the warning tone.
      const sb = await openApp(page, '/today', { mode: 'asEditor', fixtures: fixtures(theme, mode), content: 'real', chat: { budget: { used_usd: 21, budget_usd: 25 } } });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-scheme', mode);
      const name = (screen) => `${screen}-${theme}-${mode}`;
      await settle(page);
      await shot(page, name('today'));
      // What is due ("Hoy", "Pronto" in the warning tone).
      await page.getByTestId('due-card').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settle(page);
      await shot(page, name('today-due'));
      await page.goto(`./#/health`);
      await settle(page);
      await shot(page, name('health'));
      await page.goto(`./#/learn/must-know/${article.id}`);
      await settle(page);
      await shot(page, name('learn-article'));
      await page.goto(`./#/assistant?t=${T}`);
      await expect(page.locator('.msg')).toHaveCount(2);
      await settle(page);
      await shot(page, name('assistant'));
      // A failed question: the error sits above the composer, the question is back in it.
      sb.setChat({ refuse: 'upstream_error' });
      await page.getByLabel('Tu pregunta').fill('¿Puede comer zanahoria?');
      await page.getByTestId('assistant-send').click();
      await expect(page.getByTestId('assistant-error')).toBeVisible();
      await settle(page);
      await shot(page, name('assistant-error'));
      await page.goto('./#/profile');
      await page.getByTestId('theme-settings').scrollIntoViewIfNeeded();
      await page.evaluate(() => document.querySelector('[data-testid="theme-settings"]')?.scrollIntoView({ block: 'center' }));
      await settle(page);
      await shot(page, name('picker'));
    });
  }
}
