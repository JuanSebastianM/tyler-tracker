// Timezone helpers for the push function (a small copy of src/lib/dates.js and of chat/lib/dates.ts:
// each function is bundled on its own, so it cannot import them). Meal times and "today" are
// wall-clock in settings.timezone (America/Bogota), never the server's timezone (UTC).

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

interface WallClock {
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

function offsetMinutes(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** 'HH:MM' (or 'HH:MM:SS') → minutes after midnight, or null when invalid. */
export function clockMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** UTC epoch ms of the wall-clock time `hhmm` on `dateStr` in `tz`. */
export function zonedToUtcMs(dateStr: string, hhmm: string, tz: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const mins = clockMinutes(hhmm) ?? 0;
  const guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  let ms = guess - offsetMinutes(guess, tz) * 60000;
  ms = guess - offsetMinutes(ms, tz) * 60000;
  return ms;
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
