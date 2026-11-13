// Pure conversion between log rows (feedings, routine_events) and the entry sheet's form state.
// Unit tested in tests/unit/log.test.mjs.
import { localDateOf, localTimeOf, zonedToUtc } from '../../lib/dates.js';
import { DURATION_KINDS, minutesBetween } from './log-logic.js';

/** @typedef {import('./log-logic.js').EntryKind} EntryKind */

/**
 * @typedef {object} EntryForm
 * @property {EntryKind} kind
 * @property {string} date      'YYYY-MM-DD'
 * @property {string} time      'HH:MM'
 * @property {string} slot      meal slot number as text, '' = extra meal
 * @property {string} appetite  '' | all | most | some | none
 * @property {string} amountG
 * @property {string} amountNote
 * @property {'outside' | 'inside'} location
 * @property {boolean} accident
 * @property {boolean} ongoing   duration kinds: still going (ended_at null)
 * @property {string} duration   duration kinds: minutes
 * @property {string} notes
 */

/**
 * Form state for a new entry.
 * @param {EntryKind} kind
 * @param {{ date: string, time: string, slot?: number | null, amountNote?: string | null, grams?: number | null }} defaults
 * @returns {EntryForm}
 */
export function emptyForm(kind, defaults) {
  return {
    kind,
    date: defaults.date,
    time: defaults.time,
    slot: defaults.slot != null ? String(defaults.slot) : '',
    appetite: kind === 'meal' ? 'all' : '',
    amountG: defaults.grams != null ? String(defaults.grams) : '',
    amountNote: defaults.amountNote || '',
    location: 'outside',
    accident: false,
    ongoing: false,
    duration: '',
    notes: '',
  };
}

/**
 * Form state for an existing row.
 * @param {EntryKind} kind @param {any} row @param {string} tz
 * @returns {EntryForm}
 */
export function formFromRow(kind, row, tz) {
  const at = kind === 'meal' ? row.fed_at : row.started_at;
  const base = emptyForm(kind, { date: localDateOf(at, tz), time: localTimeOf(at, tz) });
  if (kind === 'meal') {
    return {
      ...base,
      slot: row.meal_slot != null ? String(row.meal_slot) : '',
      appetite: row.appetite || '',
      amountG: row.amount_g != null ? String(row.amount_g).replace('.', ',') : '',
      amountNote: row.amount_note || '',
      notes: row.notes || '',
    };
  }
  return {
    ...base,
    location: row.location === 'inside' ? 'inside' : 'outside',
    accident: !!row.accident,
    ongoing: DURATION_KINDS.includes(kind) && !row.ended_at,
    duration: row.ended_at ? String(minutesBetween(row.started_at, row.ended_at)) : '',
    notes: row.notes || '',
  };
}

/** Parse '80', '80,5' or '80.5'. Empty -> null. NaN for junk. @param {string} s */
export function parseAmount(s) {
  const v = String(s ?? '').trim().replace(',', '.');
  if (!v) return null;
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
}

/**
 * Validate a form and build the row values to write.
 * @param {EntryForm} form
 * @param {{ tz: string, now: string }} ctx
 * @returns {{ errors: Record<string, string>, table: 'feedings' | 'routine_events', values: Record<string, any> }}
 *   errors map field -> i18n key under 'log.errors'
 */
export function formToValues(form, ctx) {
  /** @type {Record<string, string>} */
  const errors = {};
  const table = form.kind === 'meal' ? 'feedings' : 'routine_events';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || '')) errors.date = 'required';
  if (!/^\d{2}:\d{2}/.test(form.time || '')) errors.time = 'required';
  if (Object.keys(errors).length) return { errors, table, values: {} };

  const at = zonedToUtc(form.date, form.time.slice(0, 5), ctx.tz);
  // A couple of minutes of clock drift between phones is fine; the future is not.
  if (at.getTime() > Date.parse(ctx.now) + 5 * 60000) errors.time = 'future';
  const notes = form.notes.trim() || null;

  if (form.kind === 'meal') {
    const amount = parseAmount(form.amountG);
    if (Number.isNaN(amount) || (amount != null && amount > 5000)) errors.amountG = 'amount';
    return {
      errors,
      table,
      values: {
        fed_at: at.toISOString(),
        meal_slot: form.slot ? Number(form.slot) : null,
        appetite: form.appetite || null,
        amount_g: Number.isNaN(amount) ? null : amount,
        amount_note: form.amountNote.trim() || null,
        notes,
      },
    };
  }

  /** @type {Record<string, any>} */
  const values = { type: form.kind, started_at: at.toISOString(), notes };
  if (form.kind === 'pee' || form.kind === 'poop') {
    values.location = form.location;
    values.accident = form.location === 'inside' ? !!form.accident : false;
    values.ended_at = null;
  } else {
    values.location = null;
    values.accident = false;
    if (form.ongoing) {
      values.ended_at = null;
    } else {
      const minutes = parseAmount(form.duration);
      if (minutes == null || Number.isNaN(minutes) || minutes <= 0 || minutes > 24 * 60 || !Number.isInteger(minutes)) {
        errors.duration = 'duration';
      } else {
        values.ended_at = new Date(at.getTime() + minutes * 60000).toISOString();
      }
    }
  }
  return { errors, table, values };
}
