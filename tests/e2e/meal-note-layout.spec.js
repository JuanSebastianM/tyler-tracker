// A long portion note ("40g. 20g de … y 20g de …") wraps inside its row wherever it is shown or
// edited, on every meal state, at 390 px and 320 px, in both languages, and never pushes the
// "Ya comió" button off the card. Screenshots (light and dark) when SCREENSHOT_DIR is set.
import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';
import { openApp, defaultFixtures } from './helpers.js';

const NOTE = '40g. 20g de Ringo Cachorros y 20g de Agility Gold Grandes Cachorros, mezclados con un poco de agua tibia';
const dir = process.env.SCREENSHOT_DIR;

function fixtures() {
  const f = defaultFixtures();
  // 10:30 in Bogota on the fixed clock: 07:00 done, 08:00 late, 11:00 next, 15:00 pending.
  f.settings[0].meal_slots = [
    { slot: 1, time: '07:00', grams: 40 },
    { slot: 2, time: '08:00', grams: 40 },
    { slot: 3, time: '11:00', grams: 40 },
    { slot: 4, time: '15:00', grams: 40 },
  ];
  f.settings[0].meal_amount_note = NOTE;
  f.feedings[0].amount_note = NOTE;
  f.feedings[0].notes = 'Comió todo y pidió más, luego durmió una siesta larguísima en su cama nueva';
  return f;
}

/** Elements (by selector) whose content is wider than their box, or that stick out of `within`. */
async function overflowing(page, selector, within) {
  return page.evaluate(
    ([sel, box]) => {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const outer = el.closest(box)?.getBoundingClientRect();
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${sel} content ${el.scrollWidth}>${el.clientWidth}`);
        if (outer && (r.right > outer.right + 1 || r.left < outer.left - 1)) out.push(`${sel} outside ${box}: ${Math.round(r.right)}>${Math.round(outer.right)}`);
      }
      if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth}>${window.innerWidth}`);
      return out;
    },
    [selector, within],
  );
}

for (const width of [390, 320]) {
  for (const locale of ['es', 'en']) {
    test(`long portion note wraps on Today, Log and Profile (${width}px, ${locale})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openApp(page, '/today', { mode: 'asEditor', locale, fixtures: fixtures() });
      const card = page.getByTestId('meals-card');
      await expect(card.locator('.meal')).toHaveCount(4);
      for (const [slot, state] of [[1, 'done'], [2, 'late'], [3, 'next'], [4, 'pending']]) {
        await expect(page.getByTestId(`meal-${slot}`)).toHaveClass(new RegExp(`meal-${state}`));
      }
      // Every row that shows the note shows all of it, wrapped over several lines.
      const sub = page.getByTestId('meal-3').locator('.meal-sub');
      await expect(sub).toContainText('Agility Gold Grandes Cachorros');
      const lines = await sub.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '20')));
      expect(lines).toBeGreaterThan(1);
      expect(await overflowing(page, '.today .meal-sub, .today .meal-title, .today .meal-log, .today .meal-main', '.card')).toEqual([]);
      // The log buttons stay fully inside the card, at their natural width.
      for (const slot of [2, 3, 4]) {
        const btn = page.getByTestId(`meal-${slot}`).locator('.meal-log');
        await btn.scrollIntoViewIfNeeded();
        await expect(btn).toBeInViewport({ ratio: 1 });
      }
      // Words are not split mid-word: the note's width holds its longest word.
      const narrowest = await sub.evaluate((el) => el.clientWidth);
      expect(narrowest).toBeGreaterThan(100);

      // The meal sheet edits the note in a box that wraps.
      await page.getByTestId('meal-3').locator('.meal-main').click();
      const field = page.getByRole('dialog').locator('textarea').first();
      await expect(field).toHaveValue(NOTE);
      expect(await overflowing(page, '.sheet .field, .sheet textarea', '.sheet')).toEqual([]);
      await page.keyboard.press('Escape');

      // Log: the saved feeding with the note.
      await page.goto('./#/log');
      const details = page.locator('.log .tl-details').filter({ hasText: 'Ringo' });
      await expect(details).toBeVisible();
      expect(await overflowing(page, '.log .tl-details, .log .tl-text', '.card')).toEqual([]);

      // Profile → meal schedule.
      await page.goto('./#/profile');
      const note = page.getByTestId('meal-schedule').locator('.meal-note');
      await expect(note).toContainText('Agility Gold');
      expect(await overflowing(page, '.profile .meal-note, .profile .meal-note span', '.card')).toEqual([]);
    });
  }
}

test.describe('screenshots', () => {
  test.skip(!dir, 'set SCREENSHOT_DIR to take review screenshots');
  for (const scheme of ['light', 'dark']) {
    for (const width of [390, 320]) {
      test(`today meals with a long note, ${scheme}, ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: scheme });
        await openApp(page, '/today', { mode: 'asEditor', fixtures: fixtures() });
        const card = page.getByTestId('meals-card');
        await expect(card.locator('.meal')).toHaveCount(4);
        await page.waitForTimeout(300);
        await card.screenshot({ path: resolve(dir || '.', `today-meals-long-note-${scheme}-${width}.png`), style: '.app-header, .tabbar, .fab { visibility: hidden !important; }' });
      });
    }
  }
});
