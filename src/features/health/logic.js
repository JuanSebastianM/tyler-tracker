// Pure helpers for the Health feature (no DOM, no I/O) so they are easy to unit test.
import { diffDays } from '../../lib/dates.js';

/**
 * Parse a decimal typed by a person: accepts "4,6", "4.6", " 4 ". Returns null when empty or
 * invalid.
 * @param {string | number | null | undefined} input
 * @returns {number | null}
 */
export function parseDecimal(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = input.trim().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^\d+([.,]\d+)?$|^[.,]\d+$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Number to an editable string in the current locale style ("4,6" for es). @param {number | null | undefined} n @param {'es' | 'en'} [locale] */
export function decimalToInput(n, locale = 'es') {
  if (n == null) return '';
  const s = String(Number(n));
  return locale === 'es' ? s.replace('.', ',') : s;
}

/** Valid weight in kg (database check: 0 < kg < 100). @param {number | null} kg */
export function isValidWeight(kg) {
  return kg != null && kg > 0 && kg < 100;
}

/** Empty strings become null (optional text and date columns). @param {string | null | undefined} s */
export function orNull(s) {
  const v = (s ?? '').trim();
  return v ? v : null;
}

/**
 * Age at a date, in weeks (fractional) and whole weeks + days.
 * @param {string} birthDate @param {string} date
 */
export function ageAt(birthDate, date) {
  const totalDays = Math.max(0, diffDays(birthDate, date));
  return { totalDays, weeksExact: totalDays / 7, weeks: Math.floor(totalDays / 7), days: totalDays % 7 };
}

/**
 * Weights sorted oldest first with age and change since the previous measurement.
 * @param {Array<{ id: string, measured_on: string, weight_kg: number | string }>} rows
 * @param {string} birthDate
 */
export function weightSeries(rows, birthDate) {
  const sorted = [...rows].sort((a, b) =>
    a.measured_on === b.measured_on ? 0 : a.measured_on < b.measured_on ? -1 : 1,
  );
  /** @type {Array<{ row: any, kg: number, date: string, age: ReturnType<typeof ageAt>, delta: number | null }>} */
  const out = [];
  for (const row of sorted) {
    const kg = Number(row.weight_kg);
    if (!Number.isFinite(kg)) continue;
    const prev = out[out.length - 1];
    out.push({ row, kg, date: row.measured_on, age: ageAt(birthDate, row.measured_on), delta: prev ? round2(kg - prev.kg) : null });
  }
  return out;
}

/** @param {number} n */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Latest weight and the change since the previous one.
 * @param {Array<{ id: string, measured_on: string, weight_kg: number | string }>} rows
 * @param {string} birthDate
 */
export function latestWeight(rows, birthDate) {
  const s = weightSeries(rows, birthDate);
  if (!s.length) return null;
  const last = s[s.length - 1];
  const prev = s.length > 1 ? s[s.length - 2] : null;
  return { ...last, prev, daysSincePrev: prev ? diffDays(prev.date, last.date) : null };
}

/**
 * Split medications into active (no end date, or ending today or later) and finished.
 * Active sorted by start date (newest first), finished by end date (newest first).
 * @param {Array<{ start_on: string, end_on: string | null }>} rows
 * @param {string} today
 */
export function splitMedications(rows, today) {
  const active = [];
  const finished = [];
  for (const r of rows) (r.end_on && r.end_on < today ? finished : active).push(r);
  active.sort((a, b) => (a.start_on < b.start_on ? 1 : a.start_on > b.start_on ? -1 : 0));
  finished.sort((a, b) => ((a.end_on || '') < (b.end_on || '') ? 1 : (a.end_on || '') > (b.end_on || '') ? -1 : 0));
  return { active, finished };
}

/**
 * Split reminders into open (soonest first) and done (most recently done first).
 * @param {Array<{ due_on: string, due_time: string | null, done_at: string | null }>} rows
 */
export function splitReminders(rows) {
  const key = (/** @type {any} */ r) => `${r.due_on}T${r.due_time || '99'}`;
  const open = rows.filter((r) => !r.done_at).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const done = rows.filter((r) => r.done_at).sort((a, b) => (a.done_at < b.done_at ? 1 : a.done_at > b.done_at ? -1 : 0));
  return { open, done };
}

/** 'HH:MM:SS' or 'HH:MM' -> 'HH:MM' (or null). @param {string | null | undefined} time */
export function hhmm(time) {
  return time ? String(time).slice(0, 5) : null;
}

/**
 * Validate required fields and date order. Returns a map of field -> i18n error key.
 * @param {Record<string, any>} values
 * @param {{ required?: string[], after?: Array<[string, string]> }} rules after: [laterField, earlierField]
 */
export function validate(values, rules) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const f of rules.required || []) {
    if (values[f] == null || String(values[f]).trim() === '') errors[f] = 'errors.required';
  }
  for (const [later, earlier] of rules.after || []) {
    if (!errors[later] && values[later] && values[earlier] && values[later] < values[earlier]) errors[later] = 'health.form.dateBefore';
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Growth chart geometry
// ---------------------------------------------------------------------------

/**
 * A "nice" step for about `count` ticks across `span` (1, 2, 2.5, 5 x 10^n).
 * @param {number} span @param {number} count
 */
export function niceStep(span, count = 5) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/**
 * Ticks from `min` to at least `max` with a nice step.
 * @param {number} min @param {number} max @param {number} [count]
 */
export function niceTicks(min, max, count = 5) {
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  /** @type {number[]} */
  const ticks = [];
  for (let v = start; v <= end + step / 1e6; v += step) ticks.push(round2(v));
  return ticks;
}

/**
 * Linear scale from a domain to a range.
 * @param {[number, number]} domain @param {[number, number]} range
 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (/** @type {number} */ v) => r0 + (v - d0) * k;
}

/**
 * Reference band (min/max kg by age) clipped to [from, to] weeks, interpolating at the edges.
 * @param {Array<{ age_weeks: number, min_kg: number, max_kg: number }>} points sorted by age
 * @param {number} from @param {number} to
 */
export function clipBand(points, from, to) {
  const pts = [...(points || [])].sort((a, b) => a.age_weeks - b.age_weeks);
  if (pts.length < 2) return pts.filter((p) => p.age_weeks >= from && p.age_weeks <= to);
  /** @param {number} x */
  const at = (x) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (x >= a.age_weeks && x <= b.age_weeks) {
        const f = b.age_weeks === a.age_weeks ? 0 : (x - a.age_weeks) / (b.age_weeks - a.age_weeks);
        return { age_weeks: x, min_kg: a.min_kg + (b.min_kg - a.min_kg) * f, max_kg: a.max_kg + (b.max_kg - a.max_kg) * f };
      }
    }
    return null;
  };
  const lo = Math.max(from, pts[0].age_weeks);
  const hi = Math.min(to, pts[pts.length - 1].age_weeks);
  if (lo > hi) return [];
  const out = [at(lo), ...pts.filter((p) => p.age_weeks > lo && p.age_weeks < hi), at(hi)].filter(Boolean);
  return out.filter((p, i) => i === 0 || p.age_weeks !== out[i - 1].age_weeks);
}

/** SVG path through points. @param {Array<[number, number]>} pts */
export function linePath(pts) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${fmt(x)} ${fmt(y)}`).join(' ');
}

/** @param {number} n */
const fmt = (n) => String(Math.round(n * 10) / 10);

/**
 * Everything the growth chart needs, in SVG user units.
 *
 * X: age in weeks, from a little before the first point to a little after the latest of
 * (last weight, today), at least `minSpanWeeks` wide. Y: kg from 0 to above the highest value
 * shown (weights and the visible part of the band).
 *
 * @param {{ weights: Array<{ ageWeeks: number, kg: number }>,
 *   band?: Array<{ age_weeks: number, min_kg: number, max_kg: number }> | null,
 *   nowWeeks?: number, width?: number, height?: number,
 *   pad?: { top: number, right: number, bottom: number, left: number }, minSpanWeeks?: number }} input
 */
export function growthChartModel(input) {
  const width = input.width ?? 340;
  const height = input.height ?? 220;
  const pad = input.pad ?? { top: 12, right: 12, bottom: 30, left: 36 };
  const minSpan = input.minSpanWeeks ?? 8;
  const weights = [...input.weights].sort((a, b) => a.ageWeeks - b.ageWeeks);
  const xsData = [...weights.map((w) => w.ageWeeks), ...(input.nowWeeks != null ? [input.nowWeeks] : [])];
  let x0 = xsData.length ? Math.max(0, Math.floor(Math.min(...xsData) - 1)) : 6;
  let x1 = xsData.length ? Math.ceil(Math.max(...xsData) + 2) : x0 + minSpan;
  if (x1 - x0 < minSpan) x1 = x0 + minSpan;

  const band = input.band ? clipBand(input.band, x0, x1) : [];
  const yMaxData = Math.max(1, ...weights.map((w) => w.kg), ...band.map((b) => b.max_kg));
  const yTicks = niceTicks(0, yMaxData * 1.1, 4);
  const y1 = yTicks[yTicks.length - 1];
  const xTicks = niceTicks(x0, x1, 5).filter((v) => v >= x0 && v <= x1);

  const sx = linearScale([x0, x1], [pad.left, width - pad.right]);
  const sy = linearScale([0, y1], [height - pad.bottom, pad.top]);

  const points = weights.map((w) => ({ ...w, x: sx(w.ageWeeks), y: sy(w.kg) }));
  const bandPath = band.length >= 2
    ? linePath([...band.map((b) => /** @type {[number, number]} */ ([sx(b.age_weeks), sy(b.max_kg)])), ...[...band].reverse().map((b) => /** @type {[number, number]} */ ([sx(b.age_weeks), sy(b.min_kg)]))]) + ' Z'
    : '';
  return {
    width,
    height,
    pad,
    domain: { x: /** @type {[number, number]} */ ([x0, x1]), y: /** @type {[number, number]} */ ([0, y1]) },
    xTicks: xTicks.map((v) => ({ value: v, x: sx(v) })),
    yTicks: yTicks.map((v) => ({ value: v, y: sy(v) })),
    points,
    linePath: points.length >= 2 ? linePath(points.map((p) => [p.x, p.y])) : '',
    bandPath,
    nowX: input.nowWeeks != null ? sx(input.nowWeeks) : null,
  };
}
