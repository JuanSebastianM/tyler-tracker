// What should be notified now. Pure functions (no I/O), unit-tested under Node.
//
// Owner's rules (2026-11-18):
//  - Meals: for each slot in settings.meal_slots, a notification at the slot time if no feeding is
//    logged for that slot that day, and a second one 30 minutes later if it is still not logged.
//    Times are wall-clock in settings.timezone.
//  - Due dates: vaccination / deworming next_due_on, vet visit follow_up_on and open reminders, at
//    08:00 the day before and at 08:00 on the day; reminders with a due_time also at that time.
//    Nothing for items already done (same rules as src/data/derived.js getDueItems).
//
// Timing: the scheduler calls `tick` every 5 minutes. A notification whose time falls in
// (now - TOLERANCE_MS, now + LEAD_MS] is sent; the send ledger (push_sends, keyed by `id`) makes
// overlapping or repeated ticks send it once. Anything older than TOLERANCE_MS (the scheduler or the
// function was down) is skipped instead of arriving late.
import { addDays, clockMinutes, diffDays, localDate, zonedToUtcMs } from './dates.ts';

/** A tick may send this early (cron fires on the minute; the request reaches us a moment later). */
export const LEAD_MS = 30_000;
/** A notification later than this is stale and skipped (a missed tick still catches up within it). */
export const TOLERANCE_MS = 20 * 60_000;
/** Second meal reminder, minutes after the slot time. */
export const SECOND_MEAL_MIN = 30;
/** Wall-clock time of the day-before and same-day due alerts. */
export const DUE_ALERT_TIME = '08:00';

export type DueKind = 'vaccination' | 'deworming' | 'vet_follow_up' | 'reminder';

/** Health screen per due kind (same as DUE_KIND_PATH in src/data/derived.js). */
export const DUE_KIND_PATH: Record<DueKind, string> = {
  vaccination: '/health/vaccines',
  deworming: '/health/deworming',
  vet_follow_up: '/health/visits',
  reminder: '/health/reminders',
};
const DUE_TABLE: Record<DueKind, string> = {
  vaccination: 'vaccinations',
  deworming: 'dewormings',
  vet_follow_up: 'vet_visits',
  reminder: 'reminders',
};

export type TextSpec =
  | { type: 'meal_first' | 'meal_second'; n: number; time: string }
  | { type: 'due_before' | 'due_today' | 'due_time'; kind: DueKind; title: string; time: string | null }
  | { type: 'test' };

export interface Candidate {
  /** Deterministic ledger id: meal:<date>:<slot>:first|second, due:<table>:<row id>:<due date>:before|day|time */
  id: string;
  /** Which subscription preference it needs. */
  pref: 'meals' | 'due';
  /** Scheduled instant (epoch ms). */
  at: number;
  /** App route opened by a tap. */
  path: string;
  /** Notifications with the same tag replace each other on the device (second meal reminder). */
  tag: string;
  /** Seconds the push service may keep it for an offline phone. */
  ttl: number;
  text: TextSpec;
}

export interface MealSlot {
  slot: number;
  time: string;
  grams?: number | null;
}
export interface FeedingRow {
  fed_at: string;
  meal_slot: number | null;
}

/** Meal reminders scheduled on `dates` (local 'YYYY-MM-DD'). */
export function mealCandidates(o: { slots: MealSlot[]; feedings: FeedingRow[]; dates: string[]; tz: string }): Candidate[] {
  const slots = [...(o.slots || [])].filter((s) => Number.isInteger(s?.slot) && clockMinutes(s.time) != null).sort((a, b) => a.slot - b.slot);
  const out: Candidate[] = [];
  for (const date of o.dates) {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      // A slot is done when a feeding on that local day has its meal_slot (as on the Today screen).
      const logged = (o.feedings || []).some((f) => f.meal_slot === s.slot && localDate(f.fed_at, o.tz) === date);
      if (logged) continue;
      const time = s.time.slice(0, 5);
      const at = zonedToUtcMs(date, time, o.tz);
      const base = { pref: 'meals' as const, path: '/today', tag: `meal-${date}-${s.slot}`, ttl: 30 * 60 };
      // "Comida n" is the slot's position, like the meal list in the app.
      out.push({ ...base, id: `meal:${date}:${s.slot}:first`, at, text: { type: 'meal_first', n: i + 1, time } });
      out.push({ ...base, id: `meal:${date}:${s.slot}:second`, at: at + SECOND_MEAL_MIN * 60_000, text: { type: 'meal_second', n: i + 1, time } });
    }
  }
  return out;
}

export interface DueItem {
  kind: DueKind;
  rowId: string;
  dueOn: string;
  dueTime: string | null;
  title: string;
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

function latestPerGroup<T extends Record<string, any>>(rows: T[], group: (r: T) => string, dateCol: string): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const g = group(r);
    const cur = best.get(g);
    if (!cur || r[dateCol] > cur[dateCol]) best.set(g, r);
  }
  return [...best.values()];
}

/**
 * Open due items, with the app's rules (src/data/derived.js getDueItems): only the latest vaccination
 * per vaccine name and the latest deworming per kind count, a vet follow-up is cleared by any later
 * visit on or after its date, and reminders with done_at are done.
 */
export function openDueItems(data: { vaccinations?: any[]; dewormings?: any[]; vetVisits?: any[]; reminders?: any[] }): DueItem[] {
  const items: DueItem[] = [];
  for (const v of latestPerGroup(data.vaccinations || [], (r) => norm(r.vaccine), 'given_on')) {
    if (v.next_due_on) items.push({ kind: 'vaccination', rowId: v.id, dueOn: v.next_due_on, dueTime: null, title: v.vaccine || '' });
  }
  for (const d of latestPerGroup(data.dewormings || [], (r) => r.kind || 'internal', 'given_on')) {
    if (d.next_due_on) items.push({ kind: 'deworming', rowId: d.id, dueOn: d.next_due_on, dueTime: null, title: d.product || '' });
  }
  const visits = data.vetVisits || [];
  for (const v of visits) {
    if (!v.follow_up_on) continue;
    if (visits.some((o) => o !== v && o.visited_on >= v.follow_up_on)) continue;
    items.push({ kind: 'vet_follow_up', rowId: v.id, dueOn: v.follow_up_on, dueTime: null, title: v.reason || '' });
  }
  for (const r of data.reminders || []) {
    if (r.done_at) continue;
    const t = r.due_time ? String(r.due_time).slice(0, 5) : null;
    items.push({ kind: 'reminder', rowId: r.id, dueOn: r.due_on, dueTime: clockMinutes(t) != null ? t : null, title: r.title || '' });
  }
  return items;
}

/**
 * Due-date alerts: 08:00 the day before, 08:00 on the day, and at due_time for timed reminders. A
 * timed reminder at or before 08:00 gets no same-day 08:00 alert (it would come after, or with, the
 * timed one).
 */
export function dueCandidates(items: DueItem[], tz: string): Candidate[] {
  const out: Candidate[] = [];
  for (const it of items) {
    const key = `due:${DUE_TABLE[it.kind]}:${it.rowId}:${it.dueOn}`;
    const base = { pref: 'due' as const, path: DUE_KIND_PATH[it.kind], tag: `due-${it.kind}-${it.rowId}` };
    const title = it.title;
    out.push({
      ...base,
      id: `${key}:before`,
      at: zonedToUtcMs(addDays(it.dueOn, -1), DUE_ALERT_TIME, tz),
      ttl: 8 * 3600,
      text: { type: 'due_before', kind: it.kind, title, time: it.dueTime },
    });
    const timedEarly = it.dueTime != null && (clockMinutes(it.dueTime) as number) <= (clockMinutes(DUE_ALERT_TIME) as number);
    if (!timedEarly) {
      out.push({ ...base, id: `${key}:day`, at: zonedToUtcMs(it.dueOn, DUE_ALERT_TIME, tz), ttl: 8 * 3600, text: { type: 'due_today', kind: it.kind, title, time: it.dueTime } });
    }
    if (it.dueTime) {
      out.push({ ...base, id: `${key}:time`, at: zonedToUtcMs(it.dueOn, it.dueTime, tz), ttl: 3600, text: { type: 'due_time', kind: it.kind, title, time: it.dueTime } });
    }
  }
  return out;
}

/** In the send window now: (now - TOLERANCE_MS, now + LEAD_MS]. */
export const inWindow = (at: number, now: number): boolean => at > now - TOLERANCE_MS && at <= now + LEAD_MS;

export interface TickData {
  timezone: string;
  mealSlots: MealSlot[];
  feedings: FeedingRow[];
  vaccinations: any[];
  dewormings: any[];
  vetVisits: any[];
  reminders: any[];
}

/** Local dates whose notifications can fall in the window at `now` (yesterday covers 23:50 + 30 min). */
export function windowDates(now: number, tz: string): string[] {
  const today = localDate(now, tz);
  return [addDays(today, -1), today];
}

/** Everything to send at `now`, oldest first. */
export function planTick(now: number, data: TickData): Candidate[] {
  const tz = data.timezone;
  const dates = windowDates(now, tz);
  const meals = mealCandidates({ slots: data.mealSlots, feedings: data.feedings, dates, tz });
  const today = dates[1];
  // Only items due yesterday..tomorrow can have an alert in the window.
  const items = openDueItems(data).filter((i) => Math.abs(diffDays(today, i.dueOn)) <= 2);
  return [...meals, ...dueCandidates(items, tz)].filter((c) => inWindow(c.at, now)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Start of the oldest local day whose feedings matter for `planTick` (UTC ISO). */
export function feedingsSince(now: number, tz: string): string {
  return new Date(zonedToUtcMs(windowDates(now, tz)[0], '00:00', tz)).toISOString();
}
