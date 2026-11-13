// iCalendar (.ics, RFC 5545) generator for "Add to Calendar". Pure: no DOM, no I/O.
//
//   const text = buildIcs({ uid: 'vaccination-<id>-2026-11-29@tyler-tracker', title: 'Vacuna: Puppy DP',
//     date: '2026-11-29', time: null, tz: 'America/Bogota', now: new Date() });
//
// All-day events alert at 09:00 the day before and at 09:00 on the day. Timed events alert one day
// before and at the time of the event.
import { addDays, tzOffsetMinutes, zonedToUtc } from '../../lib/dates.js';

export const ICS_PRODID = '-//Tyler Tracker//Health//ES';
/** Wall-clock hour (local) at which all-day alerts fire. */
export const ALL_DAY_ALERT_HOUR = 9;
/** Length of a timed event, in minutes. */
export const TIMED_DURATION_MIN = 30;

/**
 * Escape a TEXT value: backslash, semicolon, comma and newlines.
 * @param {string | null | undefined} value
 */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to at most 75 octets per line (UTF-8), continuation lines start with a
 * space. Never splits a multi-byte character.
 * @param {string} line
 * @returns {string} folded line joined with CRLF
 */
export function foldLine(line) {
  const enc = new TextEncoder();
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' -> 'YYYYMMDD'. @param {string} date */
export function icsDate(date) {
  return date.replace(/-/g, '');
}

/** UTC instant -> 'YYYYMMDDTHHMMSSZ'. @param {Date} d */
export function icsUtc(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Local wall-clock date + 'HH:MM' -> 'YYYYMMDDTHHMM00'. @param {string} date @param {string} time */
export function icsLocal(date, time) {
  const [h, m] = time.split(':').map(Number);
  return `${icsDate(date)}T${pad(h || 0)}${pad(m || 0)}00`;
}

/** Minutes offset -> '-0500'. @param {number} minutes */
export function icsOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/**
 * Add minutes to a wall-clock date + time (no timezone math).
 * @param {string} date @param {string} time @param {number} minutes
 */
function addMinutesLocal(date, time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + minutes;
  const dayShift = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return { date: addDays(date, dayShift), time: `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` };
}

/**
 * A stable UID for a due item, so downloading it again updates the same calendar event.
 * @param {string} kind @param {string} rowId @param {string} dueOn
 */
export function eventUid(kind, rowId, dueOn) {
  const safe = (/** @type {string} */ s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${safe(kind)}-${safe(rowId)}-${icsDate(dueOn)}@tyler-tracker`;
}

/**
 * @typedef {object} IcsEvent
 * @property {string} uid
 * @property {string} title
 * @property {string} date          'YYYY-MM-DD' (local calendar date)
 * @property {string | null} [time] 'HH:MM' local time; omitted/null = all-day event
 * @property {string} [description]
 * @property {string} [tz]          IANA timezone of the wall-clock time (default America/Bogota)
 * @property {Date} [now]           DTSTAMP (default: current time)
 * @property {{ dayBefore: string, atTime: string }} [alarmText]  alert descriptions
 */

/**
 * Build a complete VCALENDAR with one VEVENT and two alerts.
 * @param {IcsEvent} ev
 * @returns {string} CRLF-terminated iCalendar text
 */
export function buildIcs(ev) {
  const tz = ev.tz || 'America/Bogota';
  const now = ev.now || new Date();
  const alarm = ev.alarmText || { dayBefore: ev.title, atTime: ev.title };
  /** @type {string[]} */
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${ICS_PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];

  /** @type {string[]} */
  let when;
  /** @type {[string, string]} */
  let triggers;
  if (ev.time) {
    const offset = tzOffsetMinutes(zonedToUtc(ev.date, ev.time, tz), tz);
    lines.push(
      'BEGIN:VTIMEZONE',
      `TZID:${tz}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${icsOffset(offset)}`,
      `TZOFFSETTO:${icsOffset(offset)}`,
      `TZNAME:${icsOffset(offset).slice(0, 3)}`,
      'END:STANDARD',
      'END:VTIMEZONE',
    );
    const end = addMinutesLocal(ev.date, ev.time, TIMED_DURATION_MIN);
    when = [`DTSTART;TZID=${tz}:${icsLocal(ev.date, ev.time)}`, `DTEND;TZID=${tz}:${icsLocal(end.date, end.time)}`];
    triggers = ['-P1D', 'PT0M'];
  } else {
    when = [`DTSTART;VALUE=DATE:${icsDate(ev.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(ev.date, 1))}`];
    // Relative to the start of the day (00:00 local): -15 h = 09:00 the day before, +9 h = 09:00.
    triggers = [`-PT${24 - ALL_DAY_ALERT_HOUR}H`, `PT${ALL_DAY_ALERT_HOUR}H`];
  }

  lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${icsUtc(now)}`, ...when, `SUMMARY:${escapeText(ev.title)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  lines.push('TRANSP:TRANSPARENT');
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(alarm.dayBefore)}`, `TRIGGER:${triggers[0]}`, 'END:VALARM');
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(alarm.atTime)}`, `TRIGGER:${triggers[1]}`, 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * A safe file name for the download: 'tyler-vacuna-2026-11-29.ics'.
 * @param {string} label @param {string} date
 */
export function icsFileName(label, date) {
  const slug = String(label)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `tyler-${slug || 'evento'}-${date}.ics`;
}
