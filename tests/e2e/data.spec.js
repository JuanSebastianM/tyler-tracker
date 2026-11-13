// Data layer through the real supabase-js client against the mock: optimistic writes, rollback
// toast, RLS for signed-out users. Feature tests should drive the UI instead; this checks plumbing.
import { test, expect } from 'playwright/test';
import { openApp, toastWith } from './helpers.js';

// The helper passes store code as a string, which the app's CSP (no eval) would block.
test.use({ bypassCSP: true });

/** Run `fn(stores, arg)` in the page against the app's own store instances. */
const callStore = (page, fn, arg) =>
  page.evaluate(
    async ([fnSrc, a]) => {
      const stores = await import('./src/data/stores.js');
      return new Function('stores', 'arg', `return (${fnSrc})(stores, arg)`)(stores, a);
    },
    [fn.toString(), arg],
  );

test('editor insert, update and delete reach the database', async ({ page }) => {
  const sb = await openApp(page, '/health', { mode: 'asEditor' });
  const inserted = await callStore(page, async ({ weights }) => {
    const r = await weights.insert({ measured_on: '2026-11-13', weight_kg: 5.1 });
    return r.data;
  });
  expect(inserted.weight_kg).toBe(5.1);
  expect(inserted.created_by_name).toBe('Alex');
  expect(sb.db.weights).toHaveLength(2);
  await callStore(page, ({ weights }, id) => weights.update(id, { notes: 'después de comer' }), inserted.id);
  expect(sb.db.weights.find((w) => w.id === inserted.id).notes).toBe('después de comer');
  await callStore(page, ({ weights }, id) => weights.remove(id), inserted.id);
  expect(sb.db.weights).toHaveLength(1);
});

test('a failed write rolls back and shows an error toast', async ({ page }) => {
  const sb = await openApp(page, '/health', { mode: 'asEditor', failWrites: true });
  const result = await callStore(page, async ({ weights }) => {
    const r = await weights.insert({ measured_on: '2026-11-13', weight_kg: 5.1 });
    return { failed: !!r.error, count: weights.rows().length };
  });
  expect(result).toEqual({ failed: true, count: 1 });
  await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
  expect(sb.db.weights).toHaveLength(1);
});

test('signed-out writes are rejected (RLS) and rolled back', async ({ page }) => {
  const sb = await openApp(page, '/health');
  const failed = await callStore(page, async ({ weights }) => !!(await weights.insert({ measured_on: '2026-11-13', weight_kg: 5 })).error);
  expect(failed).toBe(true);
  expect(sb.db.weights).toHaveLength(1);
});

test('feedings load only the recent window', async ({ page }) => {
  const sb = await openApp(page, '/today');
  await expect.poll(() => sb.restCalls('feedings', 'GET').length).toBeGreaterThan(0);
  const search = decodeURIComponent(sb.restCalls('feedings', 'GET')[0].search);
  // 14 days ending 2026-11-13 in Bogota
  expect(search).toContain('fed_at=gte.2026-10-31T05:00:00.000Z');
  expect(search).toContain('fed_at=lt.2026-11-14T05:00:00.000Z');
});
