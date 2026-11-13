import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal, decimalToInput, isValidWeight, orNull, ageAt, weightSeries, latestWeight, splitMedications,
  splitReminders, hhmm, validate, niceStep, niceTicks, linearScale, clipBand, linePath, growthChartModel,
} from '../../src/features/health/logic.js';
import {
  escapeText, foldLine, buildIcs, eventUid, icsUtc, icsDate, icsLocal, icsOffset, icsFileName,
} from '../../src/features/health/ics.js';

// ---- Parsing and small helpers ----

test('parseDecimal accepts comma and dot decimals', () => {
  assert.equal(parseDecimal('4,6'), 4.6);
  assert.equal(parseDecimal('4.6'), 4.6);
  assert.equal(parseDecimal(' 12 '), 12);
  assert.equal(parseDecimal(',5'), 0.5);
  assert.equal(parseDecimal(7.25), 7.25);
  for (const bad of ['', '  ', 'abc', '4,6,1', '1.2.3', '-3', '4kg', null, undefined, NaN]) {
    assert.equal(parseDecimal(/** @type {any} */ (bad)), null, String(bad));
  }
});

test('decimalToInput uses the locale separator', () => {
  assert.equal(decimalToInput(4.6, 'es'), '4,6');
  assert.equal(decimalToInput(4.6, 'en'), '4.6');
  assert.equal(decimalToInput(null), '');
});

test('isValidWeight mirrors the database check', () => {
  assert.equal(isValidWeight(4.6), true);
  assert.equal(isValidWeight(0), false);
  assert.equal(isValidWeight(100), false);
  assert.equal(isValidWeight(null), false);
});

test('orNull and hhmm', () => {
  assert.equal(orNull('  '), null);
  assert.equal(orNull(' x '), 'x');
  assert.equal(hhmm('18:30:00'), '18:30');
  assert.equal(hhmm(null), null);
});

test('validate: required fields and date order', () => {
  const e = validate({ name: ' ', start: '2026-11-10', end: '2026-11-09' }, { required: ['name', 'start'], after: [['end', 'start']] });
  assert.deepEqual(e, { name: 'errors.required', end: 'health.form.dateBefore' });
  assert.deepEqual(validate({ name: 'x', start: '2026-11-10', end: '' }, { required: ['name'], after: [['end', 'start']] }), {});
});

test('ageAt counts weeks and days from birth', () => {
  assert.deepEqual(ageAt('2026-09-25', '2026-11-13'), { totalDays: 49, weeksExact: 7, weeks: 7, days: 0 });
  assert.equal(ageAt('2026-09-25', '2026-11-16').days, 3);
  assert.equal(ageAt('2026-09-25', '2026-09-01').totalDays, 0);
});

// ---- Weights ----

const W = [
  { id: 'b', measured_on: '2026-11-13', weight_kg: '5.10' },
  { id: 'a', measured_on: '2026-11-08', weight_kg: 4.6 },
  { id: 'c', measured_on: '2026-11-20', weight_kg: 5.9 },
];

test('weightSeries sorts oldest first with age and change', () => {
  const s = weightSeries(W, '2026-09-25');
  assert.deepEqual(s.map((p) => [p.row.id, p.kg, p.delta, p.age.weeks]), [
    ['a', 4.6, null, 6],
    ['b', 5.1, 0.5, 7],
    ['c', 5.9, 0.8, 8],
  ]);
});

test('latestWeight returns the newest point and the previous one', () => {
  const l = latestWeight(W, '2026-09-25');
  assert.equal(l.kg, 5.9);
  assert.equal(l.delta, 0.8);
  assert.equal(l.prev.kg, 5.1);
  assert.equal(l.daysSincePrev, 7);
  assert.equal(latestWeight([], '2026-09-25'), null);
  assert.equal(latestWeight([W[0]], '2026-09-25').delta, null);
});

// ---- Medications and reminders ----

test('splitMedications: active includes open-ended and ending today', () => {
  const { active, finished } = splitMedications(
    [
      { id: 1, start_on: '2026-11-01', end_on: '2026-11-05' },
      { id: 2, start_on: '2026-11-10', end_on: null },
      { id: 3, start_on: '2026-11-12', end_on: '2026-11-13' },
      { id: 4, start_on: '2026-10-01', end_on: '2026-10-10' },
    ].map((r) => /** @type {any} */ (r)),
    '2026-11-13',
  );
  assert.deepEqual(active.map((r) => r.id), [3, 2]);
  assert.deepEqual(finished.map((r) => r.id), [1, 4]);
});

test('splitReminders: open by date and time, done newest first', () => {
  const { open, done } = splitReminders([
    { id: 'a', due_on: '2026-11-14', due_time: null, done_at: null },
    { id: 'b', due_on: '2026-11-14', due_time: '08:00:00', done_at: null },
    { id: 'c', due_on: '2026-11-12', due_time: null, done_at: null },
    { id: 'd', due_on: '2026-11-01', due_time: null, done_at: '2026-11-02T10:00:00Z' },
    { id: 'e', due_on: '2026-11-03', due_time: null, done_at: '2026-11-05T10:00:00Z' },
  ].map((r) => /** @type {any} */ (r)));
  assert.deepEqual(open.map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(done.map((r) => r.id), ['e', 'd']);
});

// ---- Chart maths ----

test('niceStep and niceTicks', () => {
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(7, 4), 2);
  assert.equal(niceStep(0, 4), 1);
  assert.deepEqual(niceTicks(0, 7.7, 4), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(6, 16, 5), [6, 8, 10, 12, 14, 16]);
});

test('linearScale maps domain to range (y inverted)', () => {
  const s = linearScale([0, 10], [200, 0]);
  assert.equal(s(0), 200);
  assert.equal(s(5), 100);
  assert.equal(s(10), 0);
  assert.equal(linearScale([3, 3], [0, 100])(3), 0);
});

const BAND = [
  { age_weeks: 8, min_kg: 5, max_kg: 7 },
  { age_weeks: 12, min_kg: 8, max_kg: 11 },
  { age_weeks: 16, min_kg: 12, max_kg: 16 },
];

test('clipBand interpolates at the edges', () => {
  assert.deepEqual(clipBand(BAND, 10, 14), [
    { age_weeks: 10, min_kg: 6.5, max_kg: 9 },
    { age_weeks: 12, min_kg: 8, max_kg: 11 },
    { age_weeks: 14, min_kg: 10, max_kg: 13.5 },
  ]);
  assert.deepEqual(clipBand(BAND, 0, 9).map((p) => p.age_weeks), [8, 9]);
  assert.deepEqual(clipBand(BAND, 20, 30), []);
  assert.deepEqual(clipBand([], 0, 10), []);
});

test('linePath builds an SVG path', () => {
  assert.equal(linePath([[0, 10], [5.04, 2.26]]), 'M0 10 L5 2.3');
  assert.equal(linePath([]), '');
});

test('growthChartModel: domains, ticks, points and band', () => {
  const m = growthChartModel({
    weights: [{ ageWeeks: 6.1, kg: 4.6 }, { ageWeeks: 7, kg: 5.1 }],
    band: BAND,
    nowWeeks: 7,
    width: 300,
    height: 200,
    pad: { top: 10, right: 10, bottom: 30, left: 30 },
  });
  assert.deepEqual(m.domain.x, [5, 13]); // floor(6.1 - 1) .. at least 8 weeks wide
  assert.equal(m.domain.y[0], 0);
  assert.ok(m.domain.y[1] >= 12 * 1.1 - 1e-9, 'y covers the visible band'); // band max at 13 w = 12
  assert.equal(m.points.length, 2);
  assert.equal(m.points[0].x > 30 && m.points[1].x < 290, true);
  assert.equal(m.points[1].y < m.points[0].y, true, 'heavier is higher');
  assert.match(m.linePath, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  assert.match(m.bandPath, / Z$/);
  assert.ok(m.xTicks.every((tk) => tk.x >= 30 && tk.x <= 290), 'x ticks inside the plot');
  assert.deepEqual(m.xTicks.map((tk) => tk.value), [6, 8, 10, 12]);
  assert.equal(m.yTicks[0].y, 170);
  assert.equal(m.nowX, m.points[1].x);
});

test('growthChartModel works without weights or reference', () => {
  const m = growthChartModel({ weights: [], band: null, nowWeeks: 7 });
  assert.equal(m.points.length, 0);
  assert.equal(m.linePath, '');
  assert.equal(m.bandPath, '');
  assert.ok(m.domain.x[1] - m.domain.x[0] >= 8);
  const single = growthChartModel({ weights: [{ ageWeeks: 7, kg: 5 }] });
  assert.equal(single.linePath, '', 'one point draws no line');
});

// ---- iCalendar ----

test('escapeText escapes special characters', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  assert.equal(escapeText(null), '');
});

test('foldLine folds at 75 octets without splitting UTF-8 characters', () => {
  const long = 'SUMMARY:' + 'é'.repeat(60);
  const folded = foldLine(long);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  const enc = new TextEncoder();
  for (const p of parts) assert.ok(enc.encode(p).length <= 75, p);
  for (const p of parts.slice(1)) assert.equal(p[0], ' ');
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), long);
  assert.equal(foldLine('SHORT:x'), 'SHORT:x');
});

test('date helpers', () => {
  assert.equal(icsDate('2026-11-29'), '20261129');
  assert.equal(icsUtc(new Date('2026-11-13T15:30:05Z')), '20261113T153005Z');
  assert.equal(icsLocal('2026-11-29', '7:05'), '20261129T070500');
  assert.equal(icsOffset(-300), '-0500');
  assert.equal(icsOffset(330), '+0530');
});

test('eventUid is stable and safe', () => {
  assert.equal(eventUid('vaccination', 'V0-1_x', '2026-11-29'), 'vaccination-v0-1x-20261129@tyler-tracker');
});

test('icsFileName slugifies Spanish text', () => {
  assert.equal(icsFileName('Vacuna: Puppy DP (2ª dosis)', '2026-11-29'), 'tyler-vacuna-puppy-dp-2-dosis-2026-11-29.ics');
  assert.equal(icsFileName('¡!', '2026-11-29'), 'tyler-evento-2026-11-29.ics');
});

const NOW = new Date('2026-11-13T15:30:00Z');

test('buildIcs: all-day event with two alerts', () => {
  const text = buildIcs({ uid: 'u1@tyler-tracker', title: 'Vacuna, refuerzo', date: '2026-11-29', description: 'Línea 1\nLínea 2', now: NOW });
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every newline is CRLF');
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  for (const l of ['VERSION:2.0', 'UID:u1@tyler-tracker', 'DTSTAMP:20261113T153000Z', 'DTSTART;VALUE=DATE:20261129',
    'DTEND;VALUE=DATE:20261130', 'SUMMARY:Vacuna\\, refuerzo', 'DESCRIPTION:Línea 1\\nLínea 2', 'TRIGGER:-PT15H', 'TRIGGER:PT9H', 'END:VCALENDAR']) {
    assert.ok(lines.includes(l), `missing ${l}`);
  }
  assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, 2);
  assert.ok(!text.includes('VTIMEZONE'));
});

test('buildIcs: timed event in America/Bogota', () => {
  const text = buildIcs({ uid: 'u2@tyler-tracker', title: 'Control', date: '2026-11-29', time: '23:45', tz: 'America/Bogota', now: NOW });
  const lines = text.split('\r\n');
  for (const l of ['TZID:America/Bogota', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0500', 'DTSTART;TZID=America/Bogota:20261129T234500',
    'DTEND;TZID=America/Bogota:20261130T001500', 'TRIGGER:-P1D', 'TRIGGER:PT0M']) {
    assert.ok(lines.includes(l), `missing ${l}`);
  }
  // VTIMEZONE comes before VEVENT, and BEGIN/END pairs balance.
  assert.ok(lines.indexOf('BEGIN:VTIMEZONE') < lines.indexOf('BEGIN:VEVENT'));
  for (const c of ['VCALENDAR', 'VTIMEZONE', 'STANDARD', 'VEVENT', 'VALARM']) {
    assert.equal(lines.filter((l) => l === `BEGIN:${c}`).length, lines.filter((l) => l === `END:${c}`).length, c);
  }
});
