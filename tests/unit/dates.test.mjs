import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, diffDays, dayRange, daysRange, getAge, localDateOf, localTimeOf, todayIn, tzOffsetMinutes, zonedToUtc } from '../../src/lib/dates.js';

const TZ = 'America/Bogota';

test('addDays / diffDays across month and year boundaries', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-09-25', '2026-11-13'), 49);
  assert.equal(diffDays('2026-11-13', '2026-11-10'), -3);
});

test('Bogota offset is -5h', () => {
  assert.equal(tzOffsetMinutes(new Date('2026-11-13T12:00:00Z'), TZ), -300);
});

test('today in Bogota differs from UTC late in the evening', () => {
  // 2026-11-14 03:00 UTC = 2026-11-13 22:00 in Bogota
  assert.equal(todayIn(TZ, new Date('2026-11-14T03:00:00Z')), '2026-11-13');
  assert.equal(todayIn('UTC', new Date('2026-11-14T03:00:00Z')), '2026-11-14');
});

test('dayRange gives local midnight boundaries in UTC', () => {
  assert.deepEqual(dayRange('2026-11-13', TZ), { start: '2026-11-13T05:00:00.000Z', end: '2026-11-14T05:00:00.000Z' });
});

test('dayRange handles DST days in other zones', () => {
  // New York 2026-03-08 is 23 hours long (DST starts).
  const r = dayRange('2026-03-08', 'America/New_York');
  assert.equal(r.start, '2026-03-08T05:00:00.000Z');
  assert.equal(r.end, '2026-03-09T04:00:00.000Z');
});

test('daysRange covers N days ending today', () => {
  assert.deepEqual(daysRange('2026-11-13', 14, TZ), { start: '2026-10-31T05:00:00.000Z', end: '2026-11-14T05:00:00.000Z' });
});

test('zonedToUtc and back', () => {
  const d = zonedToUtc('2026-11-13', '07:30', TZ);
  assert.equal(d.toISOString(), '2026-11-13T12:30:00.000Z');
  assert.equal(localDateOf(d, TZ), '2026-11-13');
  assert.equal(localTimeOf(d, TZ), '07:30');
  assert.equal(localTimeOf('2026-11-14T04:59:00Z', TZ), '23:59');
});

test('getAge: weeks + days and completed months', () => {
  assert.deepEqual(getAge('2026-09-25', '2026-11-13'), { totalDays: 49, weeks: 7, days: 0, months: 1 });
  assert.deepEqual(getAge('2026-09-25', '2026-11-16'), { totalDays: 52, weeks: 7, days: 3, months: 1 });
  assert.equal(getAge('2026-09-25', '2026-10-24').months, 0);
  assert.equal(getAge('2026-09-25', '2026-10-25').months, 1);
  assert.equal(getAge('2026-09-25', '2027-09-25').months, 12);
  assert.equal(getAge('2026-09-25', '2026-09-20').totalDays, 0);
});

test('invalid dates throw', () => {
  assert.throws(() => addDays('13/11/2026', 1), RangeError);
});
