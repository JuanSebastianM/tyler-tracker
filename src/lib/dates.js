// Date helpers. Calendar dates are 'YYYY-MM-DD' strings; instants are ISO strings or Date.
// "Today" and day boundaries always use an explicit IANA timezone (settings.timezone), never the
// device's.

const DAY_MS = 86_400_000;

/** @param {string} dateStr 'YYYY-MM-DD' */
export function parseDateOnly(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw new RangeError(`Invalid date: ${dateStr}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** @param {string} dateStr @returns {number} UTC ms at 00:00 of that calendar date */
function utcMs(dateStr) {
  const { y, m, d } = parseDateOnly(dateStr);
  return Date.UTC(y, m - 1, d);
}

/** @param {number} ms */
function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @param {string} dateStr @param {number} n */
export function addDays(dateStr, n) {
  return fromUtcMs(utcMs(dateStr) + n * DAY_MS);
}

/** Whole days from `a` to `b` (b - a). @param {string} a @param {string} b */
export function diffDays(a, b) {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const partsFormatters = new Map();
/** @param {string} tz */
function partsFormatter(tz) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/**
 * Wall-clock parts of an instant in a timezone.
 * @param {Date | string | number} instant
 * @param {string} tz
 */
export function zonedParts(instant, tz) {
  const date = instant instanceof Date ? instant : new Date(instant);
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of partsFormatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mm: p.minute, ss: p.second };
}

/** Offset of `tz` from UTC at `instant`, in minutes (Bogota = -300). */
export function tzOffsetMinutes(instant, tz) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** Calendar date of an instant in `tz`. */
export function localDateOf(instant, tz) {
  const p = zonedParts(instant, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 'HH:MM' wall-clock time of an instant in `tz`. */
export function localTimeOf(instant, tz) {
  const p = zonedParts(instant, tz);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

/** Today's calendar date in `tz`. @param {string} tz @param {Date} [now] */
export function todayIn(tz, now = new Date()) {
  return localDateOf(now, tz);
}

/**
 * UTC instant for a wall-clock date + time in `tz`.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} time 'HH:MM' (or 'HH:MM:SS')
 * @param {string} tz
 * @returns {Date}
 */
export function zonedToUtc(dateStr, time, tz) {
  const { y, m, d } = parseDateOnly(dateStr);
  const [hh, mm, ss] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  // Two passes handle DST transitions; Bogota has none but other zones might.
  let ms = guess - tzOffsetMinutes(guess, tz) * 60000;
  ms = guess - tzOffsetMinutes(ms, tz) * 60000;
  return new Date(ms);
}

/**
 * Start (inclusive) and end (exclusive) of a calendar day in `tz`, as ISO strings for queries.
 * @param {string} dateStr
 * @param {string} tz
 */
export function dayRange(dateStr, tz) {
  return {
    start: zonedToUtc(dateStr, '00:00', tz).toISOString(),
    end: zonedToUtc(addDays(dateStr, 1), '00:00', tz).toISOString(),
  };
}

/**
 * Range covering `days` calendar days ending with `endDate` (inclusive) in `tz`.
 * @param {string} endDate
 * @param {number} days
 * @param {string} tz
 */
export function daysRange(endDate, days, tz) {
  return {
    start: dayRange(addDays(endDate, -(days - 1)), tz).start,
    end: dayRange(endDate, tz).end,
  };
}

/**
 * Age on `today` for a birth date. months = completed calendar months.
 * @param {string} birthDate
 * @param {string} today
 */
export function getAge(birthDate, today) {
  const totalDays = Math.max(0, diffDays(birthDate, today));
  const b = parseDateOnly(birthDate);
  const t = parseDateOnly(today);
  let months = (t.y - b.y) * 12 + (t.m - b.m);
  if (t.d < b.d) months -= 1;
  return {
    totalDays,
    weeks: Math.floor(totalDays / 7),
    days: totalDays % 7,
    months: Math.max(0, months),
  };
}
