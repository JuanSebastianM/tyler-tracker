// Pure helpers for the log timeline and the house-training stats. No DOM, no I/O: unit tested in
// tests/unit/log.test.mjs. Instants are ISO strings; calendar dates are 'YYYY-MM-DD' in the
// settings timezone.
import { addDays, dayRange, localDateOf, zonedParts } from '../../lib/dates.js';

/** @typedef {import('../../data/types').Feeding} Feeding */
/** @typedef {import('../../data/types').RoutineEvent} RoutineEvent */
/** @typedef {'meal' | 'pee' | 'poop' | 'sleep' | 'walk' | 'play'} EntryKind */

/** Every entry kind, in filter-chip order. */
export const ENTRY_KINDS = /** @type {EntryKind[]} */ (['meal', 'pee', 'poop', 'sleep', 'walk', 'play']);
/** Routine kinds that have a duration (started and stopped). */
export const DURATION_KINDS = /** @type {EntryKind[]} */ (['sleep', 'walk', 'play']);

/** Icon and tone per entry kind (UI kit icon names). */
export const KIND_ICON = { meal: 'bowl', pee: 'drop', poop: 'poop', sleep: 'moon', walk: 'walk', play: 'ball' };
export const KIND_TONE = { meal: 'gold', pee: 'blue', poop: 'neutral', sleep: 'blue', walk: 'green', play: 'green' };

/**
 * @typedef {object} TimelineEntry
 * @property {string} id
 * @property {EntryKind} kind
 * @property {'feedings' | 'routine_events'} table
 * @property {string} at     instant the entry happened (fed_at / started_at)
 * @property {any} row
 */

/**
 * Feedings and routine events merged into one list in time order (oldest first).
 * @param {Feeding[]} feedings
 * @param {RoutineEvent[]} events
 * @param {{ kinds?: Iterable<EntryKind> | null }} [opts] kinds: keep only these (empty/null = all)
 * @returns {TimelineEntry[]}
 */
export function buildTimeline(feedings, events, opts = {}) {
  const only = opts.kinds ? new Set(opts.kinds) : null;
  const keep = (/** @type {EntryKind} */ k) => !only || only.size === 0 || only.has(k);
  /** @type {TimelineEntry[]} */
  const out = [];
  for (const f of feedings || []) if (keep('meal')) out.push({ id: f.id, kind: 'meal', table: 'feedings', at: f.fed_at, row: f });
  for (const e of events || []) if (keep(e.type)) out.push({ id: e.id, kind: e.type, table: 'routine_events', at: e.started_at, row: e });
  return out.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1));
}

/** Count entries per kind. @param {TimelineEntry[]} entries */
export function countByKind(entries) {
  /** @type {Record<EntryKind, number> & { accidents: number }} */
  const c = { meal: 0, pee: 0, poop: 0, sleep: 0, walk: 0, play: 0, accidents: 0 };
  for (const e of entries) {
    c[e.kind]++;
    if (e.row.accident) c.accidents++;
  }
  return c;
}

/**
 * Whole minutes between two instants (b - a), never negative.
 * @param {string} a @param {string} b
 */
export function minutesBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}

/** { h, m } for a number of minutes. @param {number} minutes */
export function splitMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return { h: Math.floor(total / 60), m: total % 60 };
}

/**
 * Minutes of [start, end) that fall inside [from, to). Ongoing events (end null) run until `now`.
 * @param {string} start @param {string | null} end @param {string} from @param {string} to @param {string} now
 */
export function overlapMinutes(start, end, from, to, now) {
  const s = Math.max(Date.parse(start), Date.parse(from));
  const e = Math.min(Date.parse(end || now), Date.parse(to), Date.parse(now));
  return e > s ? (e - s) / 60000 : 0;
}

/**
 * Calendar dates of the last `days` days ending on `today` (oldest first).
 * @param {string} today @param {number} days
 */
export function lastDays(today, days) {
  return Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1)));
}

/**
 * @typedef {object} DayStats
 * @property {string} date
 * @property {number} accidents   pee/poop events marked as accidents
 * @property {number} pee
 * @property {number} poop
 * @property {number} meals
 * @property {number} sleepMinutes  sleep inside this calendar day (split across midnight)
 */

/**
 * Per-day counts for a list of dates.
 * @param {{ feedings: Feeding[], events: RoutineEvent[], dates: string[], tz: string, now: string }} input
 * @returns {DayStats[]}
 */
export function dailyStats({ feedings, events, dates, tz, now }) {
  /** @type {Map<string, DayStats>} */
  const byDate = new Map(dates.map((d) => [d, { date: d, accidents: 0, pee: 0, poop: 0, meals: 0, sleepMinutes: 0 }]));
  for (const f of feedings || []) {
    const s = byDate.get(localDateOf(f.fed_at, tz));
    if (s) s.meals++;
  }
  for (const e of events || []) {
    if (e.type === 'pee' || e.type === 'poop') {
      const s = byDate.get(localDateOf(e.started_at, tz));
      if (!s) continue;
      s[e.type]++;
      if (e.accident) s.accidents++;
    }
  }
  for (const d of dates) {
    const { start, end } = dayRange(d, tz);
    const s = /** @type {DayStats} */ (byDate.get(d));
    let total = 0;
    for (const e of events || []) {
      if (e.type === 'sleep') total += overlapMinutes(e.started_at, e.ended_at, start, end, now);
    }
    s.sleepMinutes = Math.round(total);
  }
  return dates.map((d) => /** @type {DayStats} */ (byDate.get(d)));
}

/**
 * Pee and poop events per local hour of the day (0-23).
 * @param {RoutineEvent[]} events @param {string} tz
 * @returns {number[]}
 */
export function pottyHourHistogram(events, tz) {
  const hist = new Array(24).fill(0);
  for (const e of events || []) {
    if (e.type === 'pee' || e.type === 'poop') hist[zonedParts(e.started_at, tz).hh]++;
  }
  return hist;
}

/**
 * The busiest hours, most events first (ties: earlier hour first). Hours with no events are skipped.
 * @param {number[]} hist @param {number} [n]
 * @returns {Array<{ hour: number, count: number }>}
 */
export function topHours(hist, n = 3) {
  return hist
    .map((count, hour) => ({ hour, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, n);
}

/**
 * Average minutes from a meal to the next poop. Only pairs where the poop comes before the next
 * meal and within `maxMinutes` count.
 * @param {Feeding[]} feedings @param {RoutineEvent[]} events
 * @param {{ maxMinutes?: number }} [opts]
 * @returns {{ average: number | null, samples: number }}
 */
export function mealToPoop(feedings, events, opts = {}) {
  const max = opts.maxMinutes ?? 240;
  const meals = [...(feedings || [])].map((f) => f.fed_at).sort();
  const poops = (events || []).filter((e) => e.type === 'poop').map((e) => e.started_at).sort();
  const gaps = [];
  for (let i = 0; i < meals.length; i++) {
    const at = meals[i];
    const nextMeal = meals[i + 1];
    const poop = poops.find((p) => p > at && (!nextMeal || p < nextMeal));
    if (!poop) continue;
    const gap = minutesBetween(at, poop);
    if (gap <= max) gaps.push(gap);
  }
  if (!gaps.length) return { average: null, samples: 0 };
  return { average: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), samples: gaps.length };
}

/**
 * Meals logged vs expected over some days. Days before `firstDay` (e.g. the day he came home)
 * expect nothing unless something was logged on them.
 * @param {DayStats[]} days @param {number} slotsPerDay @param {string | null} [firstDay]
 */
export function mealsVsExpected(days, slotsPerDay, firstDay = null) {
  let logged = 0;
  let expected = 0;
  for (const d of days) {
    logged += d.meals;
    // Days before he came home expect nothing, unless meals were logged anyway.
    if (!firstDay || d.date >= firstDay || d.meals > 0) expected += slotsPerDay;
  }
  return { logged, expected, ratio: expected ? logged / expected : null };
}

/**
 * Everything the "Resumen" screen shows for one window.
 * @param {{ feedings: Feeding[], events: RoutineEvent[], today: string, days: number, tz: string,
 *   now: string, slotsPerDay: number, firstDay?: string | null }} input
 */
export function summarize({ feedings, events, today, days, tz, now, slotsPerDay, firstDay = null }) {
  const dates = lastDays(today, days);
  const from = dayRange(dates[0], tz).start;
  const to = dayRange(today, tz).end;
  const f = (feedings || []).filter((x) => x.fed_at >= from && x.fed_at < to);
  // Sleep that started the day before the window can still overlap it.
  const e = (events || []).filter((x) => (x.started_at >= from && x.started_at < to) || (x.type === 'sleep' && x.started_at < from && (!x.ended_at || x.ended_at > from)));
  const inWindow = e.filter((x) => x.started_at >= from);
  const perDay = dailyStats({ feedings: f, events: e, dates, tz, now });
  const hist = pottyHourHistogram(inWindow, tz);
  const totals = perDay.reduce(
    (acc, d) => ({ accidents: acc.accidents + d.accidents, pee: acc.pee + d.pee, poop: acc.poop + d.poop, sleepMinutes: acc.sleepMinutes + d.sleepMinutes }),
    { accidents: 0, pee: 0, poop: 0, sleepMinutes: 0 },
  );
  const sleepDays = perDay.filter((d) => d.sleepMinutes > 0).length;
  return {
    dates,
    perDay,
    totals,
    avgSleepMinutes: sleepDays ? Math.round(totals.sleepMinutes / sleepDays) : null,
    pottyHours: hist,
    topPottyHours: topHours(hist, 3),
    mealToPoop: mealToPoop(f, inWindow),
    meals: mealsVsExpected(perDay, slotsPerDay, firstDay && firstDay > dates[0] ? firstDay : null),
    hasData: f.length + inWindow.length > 0,
  };
}
