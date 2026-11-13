// Timezone helpers for the chat function (a small copy of src/lib/dates.js, which the function
// cannot import because only supabase/functions/ is bundled). "Today" and "this month" always use
// settings.timezone (America/Bogota), never the server's timezone (UTC).

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

/** Wall-clock parts of an instant in `tz`. */
export function zonedParts(instant: Date | string | number, tz: string): WallClock {
  const date = instant instanceof Date ? instant : new Date(instant);
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mm: p.minute, ss: p.second };
}

/** 'YYYY-MM-DD' of an instant in `tz`. */
export function localDate(instant: Date | string | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 'HH:MM' of an instant in `tz`. */
export function localTime(instant: Date | string | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

function offsetMinutes(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** UTC instant of local midnight at the start of `dateStr` in `tz`. */
export function startOfLocalDay(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - offsetMinutes(guess, tz) * 60000;
  ms = guess - offsetMinutes(ms, tz) * 60000;
  return new Date(ms);
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b ('YYYY-MM-DD'). */
export function diffDays(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/** Start of today and of the current calendar month in `tz`, as UTC ISO strings. */
export function periodStarts(now: Date, tz: string): { today: string; dayStart: string; monthStart: string } {
  const today = localDate(now, tz);
  return {
    today,
    dayStart: startOfLocalDay(today, tz).toISOString(),
    monthStart: startOfLocalDay(`${today.slice(0, 7)}-01`, tz).toISOString(),
  };
}

/** Age on `today`: completed weeks/days and calendar months. */
export function ageOn(birthDate: string, today: string): { totalDays: number; weeks: number; days: number; months: number } {
  const totalDays = Math.max(0, diffDays(birthDate, today));
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  return { totalDays, weeks: Math.floor(totalDays / 7), days: totalDays % 7, months: Math.max(0, months) };
}
