import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mealSlotStatus, extraMeals, lastSeen, ongoing, todoProgress, clockMinutes } from '../../src/features/today/today-logic.js';

const tz = 'America/Bogota';
const slots = [
  { slot: 1, time: '07:00', grams: 80 },
  { slot: 2, time: '11:00', grams: null },
  { slot: 3, time: '15:00', grams: null },
  { slot: 4, time: '19:00', grams: null },
];
const meal = (id, fed_at, meal_slot) => ({ id, fed_at, meal_slot, amount_g: null, amount_note: null, appetite: null, notes: null, food: null });

test('clockMinutes', () => {
  assert.equal(clockMinutes('07:30'), 450);
  assert.equal(clockMinutes('00:00'), 0);
});

test('meal slots: done, next, pending', () => {
  const feedings = [meal('a', '2026-11-13T12:05:00Z', 1), meal('y', '2026-11-12T23:58:00Z', 4)];
  // 10:30 in Bogota
  const s = mealSlotStatus({ slots, feedings, today: '2026-11-13', now: '2026-11-13T15:30:00Z', tz });
  assert.deepEqual(s.map((x) => x.state), ['done', 'next', 'pending', 'pending']);
  assert.equal(s[0].feeding.id, 'a');
  assert.equal(s[0].grams, 80);
  assert.equal(s[1].minutesUntil, 30);
  // Yesterday's slot-4 feeding does not count today
  assert.equal(s[3].feeding, null);
});

test('meal slots: late after an hour, next skips late ones', () => {
  // 12:30 in Bogota: slot 2 (11:00) is 90 min late
  const s = mealSlotStatus({ slots, feedings: [meal('a', '2026-11-13T12:05:00Z', 1)], today: '2026-11-13', now: '2026-11-13T17:30:00Z', tz });
  assert.deepEqual(s.map((x) => x.state), ['done', 'late', 'next', 'pending']);
  // Within the hour it is still "next"
  const t2 = mealSlotStatus({ slots, feedings: [meal('a', '2026-11-13T12:05:00Z', 1)], today: '2026-11-13', now: '2026-11-13T16:45:00Z', tz });
  assert.equal(t2[1].state, 'next');
});

test('meal slots are sorted by time and all can be done', () => {
  const unsorted = [slots[2], slots[0]];
  const s = mealSlotStatus({ slots: unsorted, feedings: [], today: '2026-11-13', now: '2026-11-14T03:00:00Z', tz });
  assert.deepEqual(s.map((x) => x.slot), [1, 3]);
  assert.deepEqual(s.map((x) => x.state), ['late', 'late']);
});

test('extra meals are today’s feedings outside the slots', () => {
  const feedings = [meal('a', '2026-11-13T12:05:00Z', 1), meal('x', '2026-11-13T14:00:00Z', null), meal('z', '2026-11-13T14:30:00Z', 6), meal('old', '2026-11-12T14:00:00Z', null)];
  assert.deepEqual(extraMeals({ slots, feedings, today: '2026-11-13', tz }).map((f) => f.id), ['x', 'z']);
});

test('lastSeen and ongoing', () => {
  const events = [
    { id: 'p1', type: 'pee', started_at: '2026-11-13T12:20:00Z', ended_at: null },
    { id: 'p2', type: 'pee', started_at: '2026-11-13T14:00:00Z', ended_at: null },
    { id: 'pf', type: 'pee', started_at: '2026-11-13T18:00:00Z', ended_at: null }, // future: ignored
    { id: 's1', type: 'sleep', started_at: '2026-11-13T13:00:00Z', ended_at: '2026-11-13T14:30:00Z' },
    { id: 's2', type: 'sleep', started_at: '2026-11-13T15:00:00Z', ended_at: null },
    { id: 'w1', type: 'walk', started_at: '2026-11-13T15:10:00Z', ended_at: null },
  ];
  const r = lastSeen({ feedings: [meal('a', '2026-11-13T12:05:00Z', 1)], events, now: '2026-11-13T15:30:00Z' });
  assert.equal(r.pee.id, 'p2');
  assert.equal(r.poop, null);
  assert.equal(r.meal.id, 'a');
  assert.equal(r.sleeping.id, 's2');
  assert.equal(r.lastSleep.id, 's1');
  const o = ongoing(events);
  assert.equal(o.walk.id, 'w1');
  assert.equal(o.play, undefined);
  assert.equal(lastSeen({ feedings: [], events: events.slice(0, 4), now: '2026-11-13T15:30:00Z' }).sleeping, null);
});

test('todoProgress', () => {
  const p = todoProgress([{ key: 'a' }, { key: 'b' }], [{ item_key: 'b' }, { item_key: 'zzz' }]);
  assert.equal(p.done, 1);
  assert.equal(p.total, 2);
  assert.deepEqual(p.items.map((i) => i.done), [false, true]);
});
