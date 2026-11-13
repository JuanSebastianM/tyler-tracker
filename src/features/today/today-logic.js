// Pure helpers for the Today screen: meal slot status, "last time" summaries and ongoing events.
// No DOM, no I/O: unit tested in tests/unit/today.test.mjs.
import { localDateOf, localTimeOf } from '../../lib/dates.js';

/** @typedef {import('../../data/types').Feeding} Feeding */
/** @typedef {import('../../data/types').RoutineEvent} RoutineEvent */
/** @typedef {import('../../data/types').MealSlot} MealSlot */

/** A pending meal is "late" this many minutes after its slot time. */
export const LATE_AFTER_MINUTES = 60;

/** @param {string} hhmm */
export const clockMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * @typedef {object} SlotStatus
 * @property {number} slot
 * @property {string} time       'HH:MM'
 * @property {number | null} grams
 * @property {Feeding | null} feeding  today's feeding for this slot (latest if several)
 * @property {'done' | 'next' | 'late' | 'pending'} state
 * @property {number} minutesUntil  slot time minus now (negative when past)
 */

/**
 * Status of each meal slot today. A slot is done when a feeding on `today` has that meal_slot.
 * Pending slots more than `lateAfter` minutes past their time are late; the earliest pending slot
 * that is not late is next.
 * @param {{ slots: MealSlot[], feedings: Feeding[], today: string, now: string, tz: string, lateAfter?: number }} input
 * @returns {SlotStatus[]}
 */
export function mealSlotStatus({ slots, feedings, today, now, tz, lateAfter = LATE_AFTER_MINUTES }) {
  const nowMin = clockMinutes(localTimeOf(now, tz));
  const todays = (feedings || []).filter((f) => localDateOf(f.fed_at, tz) === today);
  const sorted = [...(slots || [])].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time) || a.slot - b.slot);
  let nextGiven = false;
  return sorted.map((s) => {
    const feeding = todays.filter((f) => f.meal_slot === s.slot).sort((a, b) => (a.fed_at < b.fed_at ? 1 : -1))[0] || null;
    const minutesUntil = clockMinutes(s.time) - nowMin;
    /** @type {SlotStatus['state']} */
    let state = 'pending';
    if (feeding) state = 'done';
    else if (minutesUntil < -lateAfter) state = 'late';
    else if (!nextGiven) {
      state = 'next';
      nextGiven = true;
    }
    return { slot: s.slot, time: s.time, grams: s.grams ?? null, feeding, state, minutesUntil };
  });
}

/**
 * Today's feedings that do not belong to a configured slot (extra meals), oldest first.
 * @param {{ slots: MealSlot[], feedings: Feeding[], today: string, tz: string }} input
 */
export function extraMeals({ slots, feedings, today, tz }) {
  const known = new Set((slots || []).map((s) => s.slot));
  return (feedings || [])
    .filter((f) => localDateOf(f.fed_at, tz) === today && (f.meal_slot == null || !known.has(f.meal_slot)))
    .sort((a, b) => (a.fed_at < b.fed_at ? -1 : 1));
}

/**
 * Most recent row (by a time column) that is not in the future.
 * @template T
 * @param {T[]} rows @param {string} col @param {string} now
 * @returns {T | null}
 */
function latest(rows, col, now) {
  /** @type {any} */
  let best = null;
  for (const r of rows) {
    const at = /** @type {any} */ (r)[col];
    if (at && at <= now && (!best || at > best[col])) best = r;
  }
  return best;
}

/**
 * Last pee, poop and meal, plus the ongoing sleep (if he is asleep now).
 * @param {{ feedings: Feeding[], events: RoutineEvent[], now: string }} input
 */
export function lastSeen({ feedings, events, now }) {
  const ev = events || [];
  return {
    pee: latest(ev.filter((e) => e.type === 'pee'), 'started_at', now),
    poop: latest(ev.filter((e) => e.type === 'poop'), 'started_at', now),
    meal: latest(feedings || [], 'fed_at', now),
    sleeping: ongoing(ev).sleep || null,
    lastSleep: latest(ev.filter((e) => e.type === 'sleep' && e.ended_at), 'ended_at', now),
  };
}

/**
 * Ongoing duration events (sleep, walk, play with ended_at null), latest per type.
 * @param {RoutineEvent[]} events
 * @returns {Partial<Record<'sleep' | 'walk' | 'play', RoutineEvent>>}
 */
export function ongoing(events) {
  /** @type {Partial<Record<'sleep' | 'walk' | 'play', RoutineEvent>>} */
  const out = {};
  for (const e of events || []) {
    if ((e.type === 'sleep' || e.type === 'walk' || e.type === 'play') && !e.ended_at) {
      const cur = out[e.type];
      if (!cur || e.started_at > cur.started_at) out[e.type] = e;
    }
  }
  return out;
}

/**
 * Which roadmap to-dos are done.
 * @template {{ key: string }} T
 * @param {T[]} todos @param {Array<{ item_key: string }>} doneRows
 * @returns {{ items: Array<T & { done: boolean }>, done: number, total: number }}
 */
export function todoProgress(todos, doneRows) {
  const done = new Set((doneRows || []).map((r) => r.item_key));
  const items = (todos || []).map((t) => ({ ...t, done: done.has(t.key) }));
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}
