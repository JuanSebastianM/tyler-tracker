import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStage, factOfTheDay, findById, loadContent, withoutSamples, hash32 } from '../../src/lib/content.js';
import { parseHash, matchPath, resolveRoute } from '../../src/lib/router.js';
import { createStore } from '../../src/lib/store.js';
import { addDays } from '../../src/lib/dates.js';

const stages = [
  { id: 'a', from_weeks: 6, to_weeks: 10 },
  { id: 'b', from_weeks: 10, to_weeks: 16 },
  { id: 'c', from_weeks: 16, to_weeks: 26 },
];

test('currentStage picks [from, to) and clamps', () => {
  assert.equal(currentStage(stages, 7).id, 'a');
  assert.equal(currentStage(stages, 10).id, 'b');
  assert.equal(currentStage(stages, 3).id, 'a');
  assert.equal(currentStage(stages, 80).id, 'c');
  assert.equal(currentStage([], 7), null);
});

test('factOfTheDay is deterministic and changes day to day', () => {
  const facts = ['f0', 'f1', 'f2', 'f3', 'f4'];
  assert.equal(factOfTheDay(facts, '2026-11-13'), factOfTheDay(facts, '2026-11-13'));
  let d = '2026-11-01';
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const next = factOfTheDay(facts, addDays(d, 1));
    assert.notEqual(factOfTheDay(facts, d), next);
    seen.add(next);
    d = addDays(d, 1);
  }
  assert.equal(seen.size, 5, 'cycles through every fact');
  assert.equal(factOfTheDay([], '2026-11-13'), null);
  assert.equal(factOfTheDay(['only'], '2026-11-13'), 'only');
  assert.equal(hash32('tyler'), hash32('tyler'));
});

test('findById and sample filtering', () => {
  assert.deepEqual(findById([{ id: 'x' }], 'x'), { id: 'x' });
  assert.equal(findById(undefined, 'x'), null);
  const data = { version: 1, items: [{ id: 'a', sample: true }, { id: 'b' }] };
  assert.deepEqual(withoutSamples(data, false).items.map((i) => i.id), ['b']);
  assert.equal(withoutSamples(data, true), data);
});

test('loadContent is network-first and falls back to the last copy', async () => {
  const faq = { version: 1, items: [{ id: 'fake-a' }, { id: 'fake-b' }] };
  let calls = 0;
  const ok = async () => (calls++, { ok: true, json: async () => faq });
  const data = await loadContent('faq', { fetchImpl: /** @type {any} */ (ok) });
  assert.equal(data.items.length, faq.items.length);
  const down = async () => {
    calls++;
    throw new TypeError('offline');
  };
  const again = await loadContent('faq', { fetchImpl: /** @type {any} */ (down) });
  assert.equal(calls, 2);
  assert.equal(again.items.length, faq.items.length);
});

test('router parsing and matching', () => {
  assert.deepEqual(parseHash('#/health/vaccines?tab=due'), { path: '/health/vaccines', query: { tab: 'due' } });
  assert.deepEqual(parseHash(''), { path: '/', query: {} });
  assert.deepEqual(parseHash('#learn/'), { path: '/learn', query: {} });
  assert.deepEqual(matchPath('/learn/guide/:id', '/learn/guide/sit'), { id: 'sit' });
  assert.equal(matchPath('/learn/guide/:id', '/learn/guide'), null);
  const r = resolveRoute([{ path: '/learn' }, { path: '/learn/guide/:id' }], '/learn/guide/a%20b');
  assert.deepEqual(r && r.params, { id: 'a b' });
});

test('createStore notifies subscribers and skips identical values', () => {
  const s = createStore(1);
  const seen = [];
  const off = s.subscribe((v) => seen.push(v));
  s.set(2);
  s.set(2);
  s.set((p) => p + 1);
  off();
  s.set(10);
  assert.deepEqual(seen, [2, 3]);
  assert.equal(s.get(), 10);
});
