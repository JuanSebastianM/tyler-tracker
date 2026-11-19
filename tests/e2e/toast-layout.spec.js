// Toasts never cover the floating add button, the tab bar or the assistant's composer, and taps
// around them pass through. Owner bug: "Comida 4 registrada · Deshacer" sat on top of the "+" button
// for 6 s, so the next entry had to wait.
import { test, expect } from 'playwright/test';
import { openApp } from './helpers.js';

/**
 * Show toasts through the app's own module (same URL, so the same store the shell renders).
 * Uses the real strings so lengths match both languages: an undo toast, the "new version" notice
 * (kept until dismissed) and its longer follow-up.
 * @param {import('playwright/test').Page} page
 */
const showToasts = (page) =>
  page.evaluate(async () => {
    const base = document.baseURI;
    const { toast } = await import(new URL('src/lib/toast.js', base).href);
    const { t } = await import(new URL('src/lib/i18n.js', base).href);
    toast(t('today.meals.logged', { n: 4 }), { tone: 'success', duration: 0, action: { label: t('log.undo'), onClick: () => {} } });
    toast(t('pwa.updateReady'), { duration: 0, action: { label: t('pwa.reload'), onClick: () => {} } });
    toast(t('pwa.updateAfterWork'), { duration: 0 });
  });

/** iPhone-like safe areas (Chromium has none to emulate). @param {import('playwright/test').Page} page */
const withSafeAreas = (page) =>
  page.evaluate(() => {
    const s = document.documentElement.style;
    s.setProperty('--safe-bottom', '34px');
    s.setProperty('--safe-left', '0px');
    s.setProperty('--safe-right', '0px');
  });

/**
 * Overlaps between every visible toast and the controls it must leave free, read in one layout
 * once the toasts' entry animation has finished. Also checks what a tap at each control's centre
 * would hit.
 * @param {import('playwright/test').Page} page
 * @param {string[]} selectors controls that must stay free
 */
const layout = (page, selectors) =>
  page.evaluate((sels) => {
    const toasts = [...document.querySelectorAll('.toast')];
    const settled = toasts.every((el) => el.getAnimations().every((a) => a.playState === 'finished'));
    const problems = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        for (const [i, tEl] of toasts.entries()) {
          const q = tEl.getBoundingClientRect();
          const overlap = q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top;
          if (overlap) problems.push(`toast ${i + 1} covers ${sel}`);
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !el.contains(hit)) problems.push(`a tap on ${sel} hits ${hit?.getAttribute('class') || hit?.tagName || 'nothing'}`);
      }
    }
    const offscreen = toasts.some((el) => {
      const q = el.getBoundingClientRect();
      return q.left < 0 || q.right > innerWidth || q.top < 0;
    });
    if (offscreen) problems.push('a toast is off screen');
    return { count: toasts.length, settled, problems };
  }, selectors);

for (const width of [320, 390, 430]) {
  for (const locale of /** @type {const} */ (['es', 'en'])) {
    test(`toasts leave the add button and tab bar free at ${width} px (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await openApp(page, '/today', { mode: 'asEditor', locale });
      await withSafeAreas(page);
      await showToasts(page);
      await expect.poll(() => layout(page, ['.fab', '.tabbar a'])).toEqual({ count: 3, settled: true, problems: [] });
      await page.getByTestId('fab-add').click({ timeout: 2000 }); // fails if a toast intercepts it
      await expect(page.getByRole('dialog')).toBeVisible();
    });
  }
}

test('toasts leave the tab bar free for visitors, who have no add button', async ({ page }) => {
  await openApp(page, '/today');
  await expect(page.locator('.fab')).toHaveCount(0);
  await withSafeAreas(page);
  await showToasts(page);
  await expect.poll(() => layout(page, ['.tabbar a'])).toEqual({ count: 3, settled: true, problems: [] });
});

test('toasts leave the assistant composer and its send button free', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page, '/assistant', { mode: 'asEditor' });
  await withSafeAreas(page);
  await page.locator('[data-testid="assistant-composer"] textarea').fill('¿Cuánto debe comer?');
  await showToasts(page);
  await expect
    .poll(() => layout(page, ['[data-testid="assistant-composer"]', '[data-testid="assistant-composer"] button', '.tabbar a']))
    .toEqual({ count: 3, settled: true, problems: [] });
});

test('taps beside and between toasts reach the page, and the toasts never take focus', async ({ page }) => {
  await openApp(page, '/today', { mode: 'asEditor' });
  const focused = page.getByTestId('quick-pee');
  await focused.focus();
  await showToasts(page);
  await expect.poll(() => layout(page, ['.fab'])).toEqual({ count: 3, settled: true, problems: [] });
  const through = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('.toast')].map((el) => el.getBoundingClientRect());
    const points = [
      [a.left / 2, a.top + a.height / 2], // left margin of the toast area
      [a.left + 40, (a.bottom + b.top) / 2], // gap between two toasts
    ];
    return points.map(([x, y]) => !document.elementFromPoint(x, y)?.closest('.toaster'));
  });
  expect(through).toEqual([true, true]);
  await expect(focused).toBeFocused();
  // The undo action is a real button in the live region, reachable by keyboard.
  await expect(page.locator('.toaster[aria-live="polite"]')).toHaveCount(1);
  await page.locator('.toast-action').first().focus();
  await expect(page.locator('.toast-action').first()).toBeFocused();
});

/**
 * Tap the way a person does: at the control's centre, right away, without waiting for toasts.
 * Fails if anything else is on top at that point.
 * @param {import('playwright/test').Page} page @param {import('playwright/test').Locator} target
 */
async function tap(page, target) {
  await target.scrollIntoViewIfNeeded();
  const at = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, lands: !!hit && el.contains(hit), hit: hit?.getAttribute('class') || hit?.tagName || '' };
  });
  expect(at.lands, `tap lands on its target, not on "${at.hit}"`).toBe(true);
  await page.touchscreen.tap(at.x, at.y);
}

for (const scheme of ['light', 'dark']) {
  test(`pee, poop, a meal and the add button in a row: every tap lands (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const sb = await openApp(page, '/today', { mode: 'asEditor' });
    const events = sb.db.routine_events.length;
    const meals = sb.db.feedings.length;
    // Keep the quick-log card low on the screen, just above where the toasts appear.
    await page.getByTestId('quick-log').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - innerHeight + 420));
    await tap(page, page.getByTestId('quick-pee'));
    await tap(page, page.getByRole('button', { name: 'Afuera', exact: true }));
    await tap(page, page.getByTestId('quick-poop'));
    await tap(page, page.getByRole('button', { name: 'Afuera', exact: true }));
    await tap(page, page.getByRole('button', { name: 'Registrar comida 2', exact: true }));
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/quick-log-toasts-${scheme}.png` });
    await tap(page, page.getByTestId('fab-add'));
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect.poll(() => sb.db.routine_events.length).toBe(events + 2);
    await expect.poll(() => sb.db.feedings.length).toBe(meals + 1);
    expect(sb.db.routine_events.slice(-2).map((e) => e.type)).toEqual(['pee', 'poop']);
    expect(sb.pageErrors).toEqual([]);
  });
}
