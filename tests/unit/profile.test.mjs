import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageParts, daysWithUs, buildTimeline, groupByMonth, timelinePhotos, unusedSuggestions, photoDate,
  slotsToDraft, parseGrams, addSlot, removeSlot, moveSlot, sortSlotsByTime, isChronological, validateSlots, MAX_MEAL_SLOTS,
  csvCell, csvColumns, toCsv, buildExportJson, cleanRow, exportFileName, EXPORT_TABLES,
  telHref, parseBuildVersion,
} from '../../src/features/profile/logic.js';

const TZ = 'America/Bogota';

test('ageParts: days, weeks + days, months, before birth', () => {
  assert.deepEqual(ageParts('2026-09-25', '2026-09-28'), { unit: 'days', days: 3 });
  assert.deepEqual(ageParts('2026-09-25', '2026-11-13'), { unit: 'weeks', weeks: 7, days: 0 });
  assert.deepEqual(ageParts('2026-09-25', '2026-11-16'), { unit: 'weeks', weeks: 7, days: 3 });
  assert.deepEqual(ageParts('2026-09-25', '2027-03-01'), { unit: 'months', months: 5 });
  assert.equal(ageParts('2026-09-25', '2026-09-01'), null);
  assert.equal(ageParts('', '2026-09-01'), null);
});

test('daysWithUs', () => {
  assert.equal(daysWithUs('2026-11-10', '2026-11-13'), 3);
  assert.equal(daysWithUs('2026-11-13', '2026-11-13'), 0);
  assert.equal(daysWithUs('2026-11-20', '2026-11-13'), null);
  assert.equal(daysWithUs(null, '2026-11-13'), null);
});

const m = (id, happened_on, title, created_at = `${happened_on}T15:00:00Z`) => ({ id, happened_on, title, story: null, created_at });
const p = (id, opts = {}) => ({ id, storage_path: `milestones/${id}.jpg`, milestone_id: null, caption: null, taken_on: null, width: 10, height: 10, created_at: '2026-11-12T03:00:00Z', ...opts });

test('photoDate falls back to the local day it was added', () => {
  assert.equal(photoDate(p('a', { taken_on: '2026-11-01' }), TZ), '2026-11-01');
  // 03:00 UTC on the 12th is still the 11th in Bogota.
  assert.equal(photoDate(p('a'), TZ), '2026-11-11');
});

test('buildTimeline: milestones with photos, loose photos by day, newest first', () => {
  const milestones = [m('m1', '2026-11-10', 'Llegó a casa'), m('m2', '2026-10-30', 'Primer baño')];
  const photos = [
    p('a', { milestone_id: 'm1', taken_on: '2026-11-10' }),
    p('b', { taken_on: '2026-11-12' }),
    p('c', { taken_on: '2026-11-12', created_at: '2026-11-12T20:00:00Z' }),
    p('d', { taken_on: '2026-11-10' }),
    p('e', { milestone_id: 'gone', taken_on: '2026-10-01' }),
  ];
  const items = buildTimeline(milestones, photos, TZ);
  assert.deepEqual(items.map((i) => i.key), ['p:2026-11-12', 'm:m1', 'p:2026-11-10', 'm:m2', 'p:2026-10-01']);
  assert.deepEqual(items[0].photos.map((x) => x.id), ['c', 'b']);
  assert.deepEqual(items[1].photos.map((x) => x.id), ['a']);
  assert.deepEqual(items[3].photos, []);
  const months = groupByMonth(items);
  assert.deepEqual(months.map((g) => [g.month, g.items.length]), [['2026-11', 3], ['2026-10', 2]]);
  assert.deepEqual(timelinePhotos(items).map((x) => x.id), ['c', 'b', 'a', 'd', 'e']);
  assert.deepEqual(buildTimeline([], [], TZ), []);
});

test('unusedSuggestions ignores case and accents', () => {
  const s = [{ key: 'bath', title: 'Primer baño' }, { key: 'walk', title: 'Primer paseo' }];
  assert.deepEqual(unusedSuggestions(s, [m('x', '2026-11-01', ' primer BANO ')]).map((x) => x.key), ['walk']);
});

test('meal draft: load, add, remove, move, sort', () => {
  const draft = slotsToDraft([{ slot: 2, time: '11:00', grams: 80 }, { slot: 1, time: '07:00', grams: null }]);
  assert.deepEqual(draft, [{ time: '07:00', grams: '' }, { time: '11:00', grams: '80' }]);
  const added = addSlot(draft);
  assert.deepEqual(added[2], { time: '13:00', grams: '80' });
  assert.deepEqual(addSlot([]), [{ time: '07:00', grams: '' }]);
  assert.equal(addSlot([{ time: '23:30', grams: '' }])[1].time, '22:30');
  const full = Array.from({ length: MAX_MEAL_SLOTS }, (_, i) => ({ time: `0${i}:00`, grams: '' }));
  assert.equal(addSlot(full).length, MAX_MEAL_SLOTS);
  assert.deepEqual(removeSlot(added, 0).map((s) => s.time), ['11:00', '13:00']);
  const moved = moveSlot(added, 2, -1);
  assert.deepEqual(moved.map((s) => s.time), ['07:00', '13:00', '11:00']);
  assert.equal(moveSlot(added, 0, -1), added);
  assert.equal(isChronological(moved), false);
  assert.deepEqual(sortSlotsByTime(moved).map((s) => s.time), ['07:00', '11:00', '13:00']);
});

test('parseGrams', () => {
  assert.equal(parseGrams(''), null);
  assert.equal(parseGrams(' 80 '), 80);
  assert.equal(parseGrams('80,5'), 80.5);
  assert.ok(Number.isNaN(parseGrams('80g')));
  assert.ok(Number.isNaN(parseGrams('-3')));
});

test('validateSlots: renumbers in order, flags bad rows', () => {
  const ok = validateSlots([{ time: '08:00', grams: '' }, { time: '07:00', grams: '75,5' }]);
  assert.deepEqual(ok, { ok: true, slots: [{ slot: 1, time: '08:00', grams: null }, { slot: 2, time: '07:00', grams: 75.5 }] });
  const bad = validateSlots([{ time: '', grams: '' }, { time: '07:00', grams: 'x' }, { time: '07:00', grams: '0' }]);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(bad.rows, [{ time: 'timeRequired' }, { grams: 'gramsInvalid' }, { time: 'timeDuplicate', grams: 'gramsInvalid' }]);
    assert.equal(bad.form, null);
  }
  const empty = validateSlots([]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.form, 'noSlots');
  assert.equal(validateSlots([{ time: '24:00', grams: '' }]).ok, false);
});

test('csvCell escaping', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(4.5), '4.5');
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(false), 'false');
  assert.equal(csvCell('Tyler'), 'Tyler');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('dijo "hola"'), '"dijo ""hola"""');
  assert.equal(csvCell('línea 1\nlínea 2'), '"línea 1\nlínea 2"');
  assert.equal(csvCell(' padded'), '" padded"');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('-5 kg'), "'-5 kg");
  assert.equal(csvCell([{ slot: 1, time: '07:00' }]), '"[{""slot"":1,""time"":""07:00""}]"');
});

test('csvColumns and toCsv', () => {
  const rows = [{ id: 1, name: 'a', _pending: true }, { id: 2, extra: 'x' }];
  assert.deepEqual(csvColumns(rows), ['id', 'name', 'extra']);
  assert.deepEqual(csvColumns([], ['id']), ['id']);
  assert.equal(toCsv(rows, { bom: false }), 'id,name,extra\r\n1,a,\r\n2,,x\r\n');
  assert.ok(toCsv(rows).startsWith('﻿id,'));
  assert.equal(toCsv([], { bom: false }), '\r\n');
});

test('buildExportJson orders tables and strips client fields', () => {
  const doc = buildExportJson(
    { photos: [{ id: 'p', _pending: true }], pet_profile: [{ id: 1 }], custom: [{ a: 1 }] },
    { exportedAt: '2026-11-13T15:30:00.000Z', timezone: TZ },
  );
  assert.equal(doc.app, 'tyler-tracker');
  assert.equal(doc.timezone, TZ);
  assert.deepEqual(Object.keys(doc.tables), ['pet_profile', 'photos', 'custom']);
  assert.deepEqual(doc.tables.photos, [{ id: 'p' }]);
  assert.deepEqual(cleanRow({ a: 1, _pending: true }), { a: 1 });
  assert.ok(EXPORT_TABLES.includes('pet_private'));
  assert.equal(exportFileName('2026-11-13'), 'tyler-tracker-2026-11-13.json');
  assert.equal(exportFileName('2026-11-13', '-feedings.csv'), 'tyler-tracker-2026-11-13-feedings.csv');
});

test('telHref', () => {
  assert.equal(telHref('+57 300 000 0000'), 'tel:+573000000000');
  assert.equal(telHref('(604) 000-00-00'), 'tel:6040000000');
  assert.equal(telHref('n/a'), null);
  assert.equal(telHref(null), null);
});

test('build version parsing', () => {
  assert.deepEqual(parseBuildVersion('abc1234-20261113T1530'), { sha: 'abc1234', date: '2026-11-13', raw: 'abc1234-20261113T1530' });
  assert.equal(parseBuildVersion('__SW_VERSION__'), null);
  assert.equal(parseBuildVersion(null), null);
  assert.equal(parseBuildVersion('dev'), null);
  assert.deepEqual(parseBuildVersion('weird'), { sha: 'weird', date: null, raw: 'weird' });
});
