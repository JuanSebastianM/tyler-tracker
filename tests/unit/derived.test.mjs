import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDueItems, dueStatus, getToday } from '../../src/data/derived.js';

const today = '2026-11-13';

test('dueStatus thresholds', () => {
  assert.equal(dueStatus(-1), 'overdue');
  assert.equal(dueStatus(0), 'today');
  assert.equal(dueStatus(7), 'soon');
  assert.equal(dueStatus(8), 'upcoming');
  assert.equal(dueStatus(3, 2), 'upcoming');
});

test('getToday uses the settings timezone', () => {
  const r = getToday('America/Bogota', new Date('2026-11-14T03:00:00Z'));
  assert.equal(r.date, '2026-11-13');
  assert.equal(r.start, '2026-11-13T05:00:00.000Z');
});

test('combines all sources, sorted by date', () => {
  const items = getDueItems(
    {
      vaccinations: [{ id: 'v1', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29' }],
      dewormings: [{ id: 'd1', product: 'X', kind: 'internal', given_on: '2026-11-01', next_due_on: '2026-11-15' }],
      vetVisits: [{ id: 'vv1', visited_on: '2026-11-08', reason: 'Chequeo', follow_up_on: '2026-11-10' }],
      reminders: [
        { id: 'r1', title: 'Comprar comida', due_on: '2026-11-13', due_time: '18:00:00', done_at: null },
        { id: 'r2', title: 'Hecho', due_on: '2026-11-12', due_time: null, done_at: '2026-11-12T10:00:00Z' },
      ],
    },
    today,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.dueOn, i.status, i.daysUntil]),
    [
      ['vet_follow_up', '2026-11-10', 'overdue', -3],
      ['reminder', '2026-11-13', 'today', 0],
      ['deworming', '2026-11-15', 'soon', 2],
      ['vaccination', '2026-11-29', 'upcoming', 16],
    ],
  );
  assert.equal(items[1].dueTime, '18:00');
  assert.equal(items[1].id, 'reminder:r1');
  assert.equal(items[3].title, 'Puppy DP');
});

test('only the latest dose per vaccine (case-insensitive) counts', () => {
  const items = getDueItems(
    {
      vaccinations: [
        { id: 'a', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29' },
        { id: 'b', vaccine: 'puppy dp ', given_on: '2026-11-29', next_due_on: '2026-12-20' },
        { id: 'c', vaccine: 'Rabia', given_on: '2026-12-01', next_due_on: null },
      ],
    },
    today,
  );
  assert.deepEqual(items.map((i) => i.id), ['vaccination:b']);
});

test('dewormings are tracked per kind', () => {
  const items = getDueItems(
    {
      dewormings: [
        { id: 'i1', kind: 'internal', given_on: '2026-10-01', next_due_on: '2026-10-15' },
        { id: 'i2', kind: 'internal', given_on: '2026-11-01', next_due_on: '2026-11-15' },
        { id: 'e1', kind: 'external', given_on: '2026-10-20', next_due_on: '2026-11-20' },
      ],
    },
    today,
  );
  assert.deepEqual(items.map((i) => i.id), ['deworming:i2', 'deworming:e1']);
});

test('a later visit clears a follow-up', () => {
  const items = getDueItems(
    {
      vetVisits: [
        { id: 'v1', visited_on: '2026-11-01', reason: 'A', follow_up_on: '2026-11-10' },
        { id: 'v2', visited_on: '2026-11-10', reason: 'B', follow_up_on: null },
      ],
    },
    today,
  );
  assert.equal(items.length, 0);
});

test('horizonDays drops far items; empty input is fine', () => {
  const items = getDueItems({ reminders: [{ id: 'r', title: 'x', due_on: '2027-01-01', done_at: null }] }, today, { horizonDays: 30 });
  assert.equal(items.length, 0);
  assert.deepEqual(getDueItems({}, today), []);
});
