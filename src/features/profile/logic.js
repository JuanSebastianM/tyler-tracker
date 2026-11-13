// Pure helpers for the profile feature: age labels, memories timeline, meal schedule editing,
// export builders (CSV / JSON), phone links and version parsing. No DOM, no I/O: unit tested in
// tests/unit/profile.test.mjs.
import { diffDays, getAge, localDateOf } from '../../lib/dates.js';

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * Age at a calendar date, as the pieces the UI turns into words.
 * Under 16 weeks: weeks + days. From 16 weeks: months. Before birth: null.
 * @param {string} birthDate 'YYYY-MM-DD'
 * @param {string} date 'YYYY-MM-DD'
 * @returns {{ unit: 'days', days: number } | { unit: 'weeks', weeks: number, days: number } | { unit: 'months', months: number } | null}
 */
export function ageParts(birthDate, date) {
  if (!birthDate || !date || date < birthDate) return null;
  const age = getAge(birthDate, date);
  if (age.totalDays < 7) return { unit: 'days', days: age.totalDays };
  if (age.weeks < 16) return { unit: 'weeks', weeks: age.weeks, days: age.days };
  return { unit: 'months', months: Math.max(age.months, 3) };
}

/**
 * Days since he came home (0 on the day itself). Null without a home date or before it.
 * @param {string | null | undefined} homeDate @param {string} today
 */
export function daysWithUs(homeDate, today) {
  if (!homeDate) return null;
  const d = diffDays(homeDate, today);
  return d < 0 ? null : d;
}

// ---------------------------------------------------------------------------
// Memories timeline
// ---------------------------------------------------------------------------

/**
 * @typedef {import('../../data/types').Milestone} Milestone
 * @typedef {import('../../data/types').Photo} Photo
 * @typedef {{ kind: 'milestone', key: string, date: string, milestone: Milestone, photos: Photo[] }
 *   | { kind: 'photos', key: string, date: string, photos: Photo[] }} TimelineItem
 * @typedef {{ month: string, items: TimelineItem[] }} TimelineMonth
 */

/** Calendar date of a photo: taken_on, else the day it was added (in tz). @param {Photo} p @param {string} tz */
export function photoDate(p, tz) {
  if (p.taken_on) return p.taken_on;
  return p.created_at ? localDateOf(p.created_at, tz) : '';
}

/** @param {string | undefined} a @param {string | undefined} b newest first */
const desc = (a, b) => ((a || '') < (b || '') ? 1 : (a || '') > (b || '') ? -1 : 0);

/**
 * Milestones (with their photos) and loose photos grouped by day, newest first.
 * Photos whose milestone is unknown (deleted, not loaded) count as loose photos.
 * @param {Milestone[]} milestones
 * @param {Photo[]} photos
 * @param {string} tz
 * @returns {TimelineItem[]}
 */
export function buildTimeline(milestones, photos, tz) {
  const ids = new Set(milestones.map((m) => m.id));
  /** @type {Map<string, Photo[]>} */
  const byMilestone = new Map();
  /** @type {Map<string, Photo[]>} */
  const looseByDay = new Map();
  const sortedPhotos = [...photos].sort((a, b) => desc(photoDate(a, tz), photoDate(b, tz)) || desc(a.created_at, b.created_at));
  for (const p of sortedPhotos) {
    if (p.milestone_id && ids.has(p.milestone_id)) {
      const list = byMilestone.get(p.milestone_id) || [];
      list.push(p);
      byMilestone.set(p.milestone_id, list);
    } else {
      const day = photoDate(p, tz);
      const list = looseByDay.get(day) || [];
      list.push(p);
      looseByDay.set(day, list);
    }
  }
  /** @type {TimelineItem[]} */
  const items = [
    ...milestones.map((m) => /** @type {TimelineItem} */ ({ kind: 'milestone', key: `m:${m.id}`, date: m.happened_on, milestone: m, photos: byMilestone.get(m.id) || [] })),
    ...[...looseByDay].map(([day, list]) => /** @type {TimelineItem} */ ({ kind: 'photos', key: `p:${day}`, date: day, photos: list })),
  ];
  return items.sort(
    (a, b) =>
      desc(a.date, b.date) ||
      // Same day: milestones before loose photos, newer milestones first.
      (a.kind === b.kind ? (a.kind === 'milestone' && b.kind === 'milestone' ? desc(a.milestone.created_at, b.milestone.created_at) : 0) : a.kind === 'milestone' ? -1 : 1),
  );
}

/**
 * Group timeline items by month ('YYYY-MM'), keeping their order.
 * @param {TimelineItem[]} items
 * @returns {TimelineMonth[]}
 */
export function groupByMonth(items) {
  /** @type {TimelineMonth[]} */
  const out = [];
  for (const item of items) {
    const month = (item.date || '').slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.month === month) last.items.push(item);
    else out.push({ month, items: [item] });
  }
  return out;
}

/** Every photo in timeline order (for the viewer's next/previous). @param {TimelineItem[]} items */
export function timelinePhotos(items) {
  return items.flatMap((i) => i.photos);
}

/**
 * Suggested first milestones not used yet (compared by title, case- and accent-insensitive).
 * @param {Array<{ key: string, title: string }>} suggestions
 * @param {Milestone[]} milestones
 */
export function unusedSuggestions(suggestions, milestones) {
  const norm = (/** @type {string} */ s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const used = new Set(milestones.map((m) => norm(m.title || '')));
  return suggestions.filter((s) => !used.has(norm(s.title)));
}

// ---------------------------------------------------------------------------
// Meal schedule
// ---------------------------------------------------------------------------

/** Most meal slots a day (feedings.meal_slot is checked between 1 and 6). */
export const MAX_MEAL_SLOTS = 6;

/**
 * Editable draft row: strings as typed.
 * @typedef {{ time: string, grams: string }} MealDraft
 */

/** @param {Array<{ time: string, grams: number | null }>} slots @returns {MealDraft[]} */
export function slotsToDraft(slots) {
  return [...(slots || [])]
    .sort((a, b) => (/** @type {any} */ (a).slot ?? 0) - (/** @type {any} */ (b).slot ?? 0))
    .map((s) => ({ time: s.time || '', grams: s.grams == null ? '' : String(s.grams) }));
}

/** Parse grams typed by a person ('80', '80,5', ''). NaN when invalid. @param {string} v */
export function parseGrams(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

/**
 * A new slot to append: two hours after the last one (capped at 22:00), or 07:00.
 * @param {MealDraft[]} draft
 * @returns {MealDraft[]}
 */
export function addSlot(draft) {
  if (draft.length >= MAX_MEAL_SLOTS) return draft;
  const last = draft[draft.length - 1]?.time;
  let time = '07:00';
  if (/^\d{2}:\d{2}$/.test(last || '')) {
    const [h, m] = /** @type {string} */ (last).split(':').map(Number);
    const next = Math.min(h + 2, 22);
    time = `${String(next).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return [...draft, { time, grams: draft[draft.length - 1]?.grams || '' }];
}

/** @param {MealDraft[]} draft @param {number} index */
export function removeSlot(draft, index) {
  return draft.filter((_, i) => i !== index);
}

/** Move a slot up (-1) or down (+1). @param {MealDraft[]} draft @param {number} index @param {-1 | 1} dir */
export function moveSlot(draft, index, dir) {
  const j = index + dir;
  if (j < 0 || j >= draft.length) return draft;
  const out = [...draft];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

/** Sort slots by time of day. @param {MealDraft[]} draft */
export function sortSlotsByTime(draft) {
  return [...draft].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** True when the slots are in time order. @param {MealDraft[]} draft */
export function isChronological(draft) {
  return draft.every((s, i) => i === 0 || draft[i - 1].time <= s.time);
}

/**
 * Validate a draft. Returns per-row errors (i18n key suffixes) and a form error, or the slots
 * ready to save ([{ slot: 1.., time, grams }]).
 * @param {MealDraft[]} draft
 * @returns {{ ok: true, slots: import('../../data/types').MealSlot[] } |
 *   { ok: false, rows: Array<{ time?: string, grams?: string }>, form: string | null }}
 */
export function validateSlots(draft) {
  /** @type {Array<{ time?: string, grams?: string }>} */
  const rows = draft.map(() => ({}));
  let form = null;
  if (draft.length === 0) form = 'noSlots';
  if (draft.length > MAX_MEAL_SLOTS) form = 'tooMany';
  const seen = new Map();
  draft.forEach((s, i) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) rows[i].time = 'timeRequired';
    else if (seen.has(s.time)) rows[i].time = 'timeDuplicate';
    else seen.set(s.time, i);
    const g = parseGrams(s.grams);
    if (Number.isNaN(g) || (g != null && (g <= 0 || g > 2000))) rows[i].grams = 'gramsInvalid';
  });
  if (form || rows.some((r) => r.time || r.grams)) return { ok: false, rows, form };
  return {
    ok: true,
    slots: draft.map((s, i) => ({ slot: i + 1, time: s.time, grams: parseGrams(s.grams) })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Tables in the export, in this order. Private ones are editors-only. */
export const EXPORT_TABLES = [
  'pet_profile', 'settings', 'feedings', 'routine_events', 'weights', 'vaccinations', 'dewormings',
  'vet_visits', 'medications', 'reminders', 'training_skills', 'checklist_done', 'milestones', 'photos',
  'faq_entries', 'pet_private', 'vet_visit_private',
];
export const PRIVATE_EXPORT_TABLES = ['pet_private', 'vet_visit_private'];

/** Client-only fields that never go in an export. */
const CLIENT_FIELDS = ['_pending'];

/** @param {Record<string, any>} row */
export function cleanRow(row) {
  const out = { ...row };
  for (const f of CLIENT_FIELDS) delete out[f];
  return out;
}

/**
 * One CSV cell (RFC 4180). null/undefined -> empty, objects -> JSON. Text that a spreadsheet would
 * run as a formula (starting with =, +, -, the at sign, tab or CR) gets a leading apostrophe.
 * @param {any} value
 */
export function csvCell(value) {
  if (value == null) return '';
  let s;
  if (typeof value === 'object') s = JSON.stringify(value);
  else if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  else s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Column order: `preferred` first (when given), then every other key in first-seen order.
 * @param {Record<string, any>[]} rows @param {string[]} [preferred]
 */
export function csvColumns(rows, preferred = []) {
  const cols = [...preferred];
  const seen = new Set(cols);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k) && !CLIENT_FIELDS.includes(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/**
 * CSV text for rows (header line, CRLF line endings, UTF-8 BOM so spreadsheets read accents).
 * @param {Record<string, any>[]} rows @param {{ columns?: string[], bom?: boolean }} [opts]
 */
export function toCsv(rows, opts = {}) {
  const cols = opts.columns || csvColumns(rows);
  const lines = [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
  return (opts.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
}

/**
 * The full export document.
 * @param {Record<string, any[]>} tables rows per table
 * @param {{ exportedAt: string, timezone: string, app?: string }} meta
 */
export function buildExportJson(tables, meta) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const name of EXPORT_TABLES) if (tables[name]) out[name] = tables[name].map(cleanRow);
  for (const name of Object.keys(tables)) if (!(name in out)) out[name] = tables[name].map(cleanRow);
  return {
    app: meta.app || 'tyler-tracker',
    format: 1,
    exported_at: meta.exportedAt,
    timezone: meta.timezone,
    tables: out,
  };
}

/** 'tyler-tracker-2026-11-13' + suffix. @param {string} date @param {string} [suffix] */
export function exportFileName(date, suffix = '.json') {
  return `tyler-tracker-${date}${suffix}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** 'tel:' link for a typed phone number, or null when there are no digits. @param {string | null | undefined} phone */
export function telHref(phone) {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 3) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/**
 * Parse a build version 'abc1234-20261113T1530' (stamped by scripts/build-site.mjs).
 * Unstamped ('dev' locally, or a '__…__' placeholder) -> null.
 * @param {string | null | undefined} version
 * @returns {{ sha: string, date: string | null, raw: string } | null}
 */
export function parseBuildVersion(version) {
  if (!version || version === 'dev' || version.includes('__')) return null;
  const m = /^([0-9a-z]+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/i.exec(version);
  if (!m) return { sha: version, date: null, raw: version };
  return { sha: m[1], date: `${m[2]}-${m[3]}-${m[4]}`, raw: version };
}

