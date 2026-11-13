import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline, countByKind, dailyStats, lastDays, mealToPoop, mealsVsExpected, minutesBetween, overlapMinutes,
  pottyHourHistogram, splitMinutes, summarize, topHours,
} from '../../src/features/log/log-logic.js';
import { emptyForm, formFromRow, formToValues, parseAmount } from '../../src/features/log/entry-form.js';

const tz = 'America/Bogota'; // UTC-5, no DST
const ev = (id, type, started_at, extra = {}) => ({ id, type, started_at, ended_at: null, location: null, accident: false, notes: null, ...extra });
const meal = (id, fed_at, extra = {}) => ({ id, fed_at, meal_slot: null, amount_g: null, amount_note: null, appetite: null, notes: null, ...extra });

test('buildTimeline merges and sorts, and filters by kind', () => {
  const f = [meal('m1', '2026-11-13T12:00:00.000Z')];
  const e = [ev('e2', 'poop', '2026-11-13T12:30:00.000Z'), ev('e1', 'pee', '2026-11-13T11:00:00.000Z')];
  assert.deepEqual(buildTimeline(f, e).map((x) => x.id), ['e1', 'm1', 'e2']);
  assert.deepEqual(buildTimeline(f, e).map((x) => x.kind), ['pee', 'meal', 'poop']);
  assert.deepEqual(buildTimeline(f, e, { kinds: ['meal', 'poop'] }).map((x) => x.id), ['m1', 'e2']);
  assert.equal(buildTimeline(f, e, { kinds: [] }).length, 3);
  assert.equal(buildTimeline(f, e)[0].table, 'routine_events');
});

test('countByKind counts accidents', () => {
  const tl = buildTimeline([], [ev('a', 'pee', '2026-11-13T11:00:00Z', { accident: true }), ev('b', 'pee', '2026-11-13T12:00:00Z')]);
  const c = countByKind(tl);
  assert.equal(c.pee, 2);
  assert.equal(c.accidents, 1);
});

test('minute helpers', () => {
  assert.equal(minutesBetween('2026-11-13T10:00:00Z', '2026-11-13T11:30:00Z'), 90);
  assert.equal(minutesBetween('2026-11-13T11:00:00Z', '2026-11-13T10:00:00Z'), 0);
  assert.deepEqual(splitMinutes(95), { h: 1, m: 35 });
  assert.equal(overlapMinutes('2026-11-13T04:00:00Z', '2026-11-13T06:00:00Z', '2026-11-13T05:00:00Z', '2026-11-14T05:00:00Z', '2026-11-13T20:00:00Z'), 60);
  // Ongoing: counts until now
  assert.equal(overlapMinutes('2026-11-13T19:00:00Z', null, '2026-11-13T05:00:00Z', '2026-11-14T05:00:00Z', '2026-11-13T19:45:00Z'), 45);
});

test('lastDays is oldest first and inclusive', () => {
  assert.deepEqual(lastDays('2026-11-13', 3), ['2026-11-11', '2026-11-12', '2026-11-13']);
});

test('dailyStats groups by Bogota day and splits sleep across midnight', () => {
  const events = [
    ev('p1', 'pee', '2026-11-13T04:30:00Z'), // 23:30 on the 12th in Bogota
    ev('p2', 'pee', '2026-11-13T06:00:00Z', { accident: true, location: 'inside' }),
    ev('k1', 'poop', '2026-11-13T15:00:00Z'),
    ev('s1', 'sleep', '2026-11-13T04:00:00Z', { ended_at: '2026-11-13T07:00:00Z' }), // 23:00 -> 02:00
  ];
  const feedings = [meal('m1', '2026-11-13T12:00:00Z'), meal('m2', '2026-11-13T04:59:00Z')];
  const [d12, d13] = dailyStats({ feedings, events, dates: ['2026-11-12', '2026-11-13'], tz, now: '2026-11-13T20:00:00Z' });
  assert.deepEqual(d12, { date: '2026-11-12', accidents: 0, pee: 1, poop: 0, meals: 1, sleepMinutes: 60 });
  assert.deepEqual(d13, { date: '2026-11-13', accidents: 1, pee: 1, poop: 1, meals: 1, sleepMinutes: 120 });
});

test('potty hours histogram and top hours', () => {
  const events = [
    ev('a', 'pee', '2026-11-13T12:10:00Z'), // 07:10
    ev('b', 'poop', '2026-11-13T12:40:00Z'), // 07:40
    ev('c', 'pee', '2026-11-12T12:05:00Z'), // 07:05
    ev('d', 'pee', '2026-11-13T22:00:00Z'), // 17:00
    ev('e', 'sleep', '2026-11-13T13:00:00Z'),
  ];
  const hist = pottyHourHistogram(events, tz);
  assert.equal(hist[7], 3);
  assert.equal(hist[17], 1);
  assert.equal(hist.reduce((a, b) => a + b, 0), 4);
  assert.deepEqual(topHours(hist, 2), [{ hour: 7, count: 3 }, { hour: 17, count: 1 }]);
  assert.deepEqual(topHours(new Array(24).fill(0)), []);
});

test('mealToPoop uses the first poop before the next meal, within the limit', () => {
  const feedings = [meal('m1', '2026-11-13T12:00:00Z'), meal('m2', '2026-11-13T16:00:00Z'), meal('m3', '2026-11-13T20:00:00Z')];
  const events = [
    ev('k1', 'poop', '2026-11-13T12:20:00Z'), // 20 min after m1
    ev('k2', 'poop', '2026-11-13T12:50:00Z'), // ignored: second poop
    ev('k3', 'poop', '2026-11-13T16:40:00Z'), // 40 min after m2
  ];
  assert.deepEqual(mealToPoop(feedings, events), { average: 30, samples: 2 });
  assert.deepEqual(mealToPoop(feedings, events, { maxMinutes: 30 }), { average: 20, samples: 1 });
  assert.deepEqual(mealToPoop([], events), { average: null, samples: 0 });
});

test('mealsVsExpected skips days before he came home', () => {
  const days = [{ date: '2026-11-09', meals: 0 }, { date: '2026-11-10', meals: 3 }, { date: '2026-11-11', meals: 4 }].map((d) => ({ ...d, accidents: 0, pee: 0, poop: 0, sleepMinutes: 0 }));
  assert.deepEqual(mealsVsExpected(days, 4, '2026-11-10'), { logged: 7, expected: 8, ratio: 7 / 8 });
  assert.equal(mealsVsExpected(days, 4).expected, 12);
  // A day before he came home still counts if meals were logged on it
  assert.equal(mealsVsExpected([{ ...days[0], meals: 2 }, ...days.slice(1)], 4, '2026-11-10').expected, 12);
  assert.equal(mealsVsExpected([], 4).ratio, null);
});

test('summarize builds a 7-day window', () => {
  const s = summarize({
    feedings: [meal('m1', '2026-11-13T12:00:00Z'), meal('old', '2026-11-01T12:00:00Z')],
    events: [ev('p', 'pee', '2026-11-13T12:30:00Z', { accident: true }), ev('k', 'poop', '2026-11-13T12:45:00Z')],
    today: '2026-11-13', days: 7, tz, now: '2026-11-13T15:30:00Z', slotsPerDay: 4, firstDay: '2026-11-10',
  });
  assert.equal(s.dates.length, 7);
  assert.equal(s.totals.accidents, 1);
  assert.equal(s.meals.logged, 1);
  assert.equal(s.meals.expected, 16);
  assert.deepEqual(s.mealToPoop, { average: 45, samples: 1 });
  assert.equal(s.hasData, true);
  assert.equal(summarize({ feedings: [], events: [], today: '2026-11-13', days: 14, tz, now: '2026-11-13T15:30:00Z', slotsPerDay: 4 }).hasData, false);
});

test('parseAmount', () => {
  assert.equal(parseAmount('80'), 80);
  assert.equal(parseAmount('80,5'), 80.5);
  assert.equal(parseAmount(' '), null);
  assert.ok(Number.isNaN(parseAmount('abc')));
});

const ctx = { tz, now: '2026-11-13T15:30:00.000Z' };

test('meal form -> feeding values in the settings timezone', () => {
  const f = { ...emptyForm('meal', { date: '2026-11-13', time: '07:05', slot: 1, grams: 80, amountNote: '1 taza' }) };
  const { errors, table, values } = formToValues(f, ctx);
  assert.deepEqual(errors, {});
  assert.equal(table, 'feedings');
  assert.deepEqual(values, { fed_at: '2026-11-13T12:05:00.000Z', meal_slot: 1, appetite: 'all', amount_g: 80, amount_note: '1 taza', notes: null });
  const extra = formToValues({ ...f, slot: '', amountG: 'x' }, ctx);
  assert.equal(extra.values.meal_slot, null);
  assert.equal(extra.errors.amountG, 'amount');
});

test('potty form: accident only when inside', () => {
  const base = emptyForm('pee', { date: '2026-11-13', time: '09:00' });
  assert.deepEqual(formToValues({ ...base, location: 'inside', accident: true }, ctx).values, {
    type: 'pee', started_at: '2026-11-13T14:00:00.000Z', notes: null, location: 'inside', accident: true, ended_at: null,
  });
  assert.equal(formToValues({ ...base, location: 'outside', accident: true }, ctx).values.accident, false);
});

test('duration form: ongoing or minutes', () => {
  const base = emptyForm('sleep', { date: '2026-11-13', time: '08:00' });
  assert.equal(formToValues({ ...base, ongoing: true }, ctx).values.ended_at, null);
  assert.equal(formToValues({ ...base, duration: '90' }, ctx).values.ended_at, '2026-11-13T14:30:00.000Z');
  assert.equal(formToValues({ ...base, duration: '' }, ctx).errors.duration, 'duration');
  assert.equal(formToValues({ ...base, duration: '1,5' }, ctx).errors.duration, 'duration');
});

test('form validation: required and future', () => {
  const base = emptyForm('poop', { date: '', time: '' });
  assert.deepEqual(formToValues(base, ctx).errors, { date: 'required', time: 'required' });
  assert.equal(formToValues({ ...base, date: '2026-11-13', time: '11:00' }, ctx).errors.time, 'future');
  assert.deepEqual(formToValues({ ...base, date: '2026-11-13', time: '10:33' }, ctx).errors, {});
});

test('formFromRow round-trips', () => {
  const row = { id: 'x', type: 'walk', started_at: '2026-11-13T14:00:00.000Z', ended_at: '2026-11-13T14:25:00.000Z', location: null, accident: false, notes: 'parque' };
  const f = formFromRow('walk', row, tz);
  assert.equal(f.date, '2026-11-13');
  assert.equal(f.time, '09:00');
  assert.equal(f.duration, '25');
  assert.equal(f.ongoing, false);
  assert.equal(formToValues(f, ctx).values.ended_at, row.ended_at);
  const m = formFromRow('meal', { id: 'm', fed_at: '2026-11-13T12:05:00.000Z', meal_slot: 2, amount_g: 80.5, amount_note: null, appetite: 'most', notes: null }, tz);
  assert.equal(m.amountG, '80,5');
  assert.equal(m.slot, '2');
  assert.equal(formToValues(m, ctx).values.amount_g, 80.5);
});
