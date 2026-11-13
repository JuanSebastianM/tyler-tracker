// Pure selectors over table rows. Keep them free of I/O so they are easy to unit test.
import { dayRange, diffDays, getAge, todayIn } from '../lib/dates.js';
import { SOON_DAYS } from '../config.js';

export { getAge };

/**
 * @typedef {'vaccination' | 'deworming' | 'vet_follow_up' | 'reminder'} DueKind
 * @typedef {'overdue' | 'today' | 'soon' | 'upcoming'} DueStatus
 * @typedef {object} DueItem
 * @property {string} id        `${kind}:${row id}`
 * @property {DueKind} kind
 * @property {string} dueOn     'YYYY-MM-DD'
 * @property {string | null} dueTime  'HH:MM' for reminders with a time
 * @property {number} daysUntil negative when overdue
 * @property {DueStatus} status
 * @property {string} title     free text from the row (vaccine name, product, reason, title)
 * @property {any} row          source row
 */

const norm = (/** @type {string | null | undefined} */ s) => (s || '').trim().toLowerCase();

/**
 * Keep only the most recent row per group (by date column).
 * @param {any[]} rows @param {(r: any) => string} group @param {string} dateCol
 */
function latestPerGroup(rows, group, dateCol) {
  /** @type {Map<string, any>} */
  const best = new Map();
  for (const r of rows) {
    const g = group(r);
    const cur = best.get(g);
    if (!cur || r[dateCol] > cur[dateCol]) best.set(g, r);
  }
  return [...best.values()];
}

/**
 * Status for a due date.
 * @param {number} daysUntil
 * @param {number} soonDays
 * @returns {DueStatus}
 */
export function dueStatus(daysUntil, soonDays = SOON_DAYS) {
  if (daysUntil < 0) return 'overdue';
  if (daysUntil === 0) return 'today';
  if (daysUntil <= soonDays) return 'soon';
  return 'upcoming';
}

/**
 * Everything that is due: next vaccine doses, next dewormings, vet follow-ups and open reminders,
 * sorted by date (overdue first).
 *
 * Only the latest vaccination per vaccine name and the latest deworming per kind count, so giving
 * the next dose clears the previous "next due". A vet follow-up is cleared by any later visit on
 * or after the follow-up date.
 *
 * @param {{ vaccinations?: any[], dewormings?: any[], vetVisits?: any[], reminders?: any[] }} data
 * @param {string} today 'YYYY-MM-DD' in the settings timezone
 * @param {{ soonDays?: number, horizonDays?: number }} [opts] horizonDays: drop items further away
 * @returns {DueItem[]}
 */
export function getDueItems(data, today, opts = {}) {
  const soonDays = opts.soonDays ?? SOON_DAYS;
  /** @type {DueItem[]} */
  const items = [];
  /** @param {DueKind} kind @param {any} row @param {string} dueOn @param {string} title @param {string | null} [dueTime] */
  const push = (kind, row, dueOn, title, dueTime = null) => {
    const daysUntil = diffDays(today, dueOn);
    items.push({ id: `${kind}:${row.id}`, kind, dueOn, dueTime, daysUntil, status: dueStatus(daysUntil, soonDays), title, row });
  };

  for (const v of latestPerGroup(data.vaccinations || [], (r) => norm(r.vaccine), 'given_on')) {
    if (v.next_due_on) push('vaccination', v, v.next_due_on, v.vaccine);
  }
  for (const d of latestPerGroup(data.dewormings || [], (r) => r.kind || 'internal', 'given_on')) {
    if (d.next_due_on) push('deworming', d, d.next_due_on, d.product || '');
  }
  const visits = data.vetVisits || [];
  for (const v of visits) {
    if (!v.follow_up_on) continue;
    const done = visits.some((o) => o !== v && o.visited_on >= v.follow_up_on);
    if (!done) push('vet_follow_up', v, v.follow_up_on, v.reason);
  }
  for (const r of data.reminders || []) {
    if (!r.done_at) push('reminder', r, r.due_on, r.title, r.due_time ? String(r.due_time).slice(0, 5) : null);
  }

  const filtered = opts.horizonDays == null ? items : items.filter((i) => i.daysUntil <= /** @type {number} */ (opts.horizonDays));
  return filtered.sort(
    (a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : (a.dueTime || '') < (b.dueTime || '') ? -1 : (a.dueTime || '') > (b.dueTime || '') ? 1 : a.kind.localeCompare(b.kind)),
  );
}

/**
 * Today's calendar date and its [start, end) instants in a timezone.
 * @param {string} tz
 * @param {Date} [now]
 */
export function getToday(tz, now = new Date()) {
  const date = todayIn(tz, now);
  return { date, ...dayRange(date, tz) };
}
