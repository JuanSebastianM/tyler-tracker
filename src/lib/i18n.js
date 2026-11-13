// Translations and locale-aware formatting.
//
//   t('common.save')                         -> "Guardar"
//   t('today.mealsLeft', { count: 2 })       -> plural form picked with Intl.PluralRules
//   t('auth.signedInAs', { name: 'Alex' })   -> "{name}" interpolation
//
// Strings are nested JSON objects. A plural entry is an object with CLDR keys
// ({ "one": "...", "other": "..." }, optionally "zero"), selected by vars.count.
// Feature strings are registered under the feature id: src/features/log/i18n/es.json key
// "title" is t('log.title').
import { createStore, useStore } from './store.js';
import { readJSON, writeJSON } from './storage.js';
import { DEFAULT_LOCALE, INTL_LOCALE, LOCALES } from '../config.js';

/** @typedef {'es' | 'en'} Locale */

/** @type {Record<string, Record<string, any>>} */
const dictionaries = { es: {}, en: {} };

/** @param {unknown} v */
const isLocale = (v) => typeof v === 'string' && /** @type {readonly string[]} */ (LOCALES).includes(v);

const stored = readJSON('locale', null);
/** Current locale. Subscribe with useLocale(). */
export const localeStore = createStore(/** @type {Locale} */ (isLocale(stored) ? stored : DEFAULT_LOCALE));

/** @returns {Locale} */
export function getLocale() {
  return localeStore.get();
}

/** @param {Locale} locale */
export function setLocale(locale) {
  if (!isLocale(locale)) return;
  writeJSON('locale', locale);
  localeStore.set(locale);
  syncDocumentLang();
}

/** Keep <html lang> in sync with the current locale. */
export function syncDocumentLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
}

/** Re-render on locale change and get the current locale. */
export function useLocale() {
  return useStore(localeStore);
}

/** @param {Record<string, any>} target @param {Record<string, any>} source */
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Add strings for a locale. With a namespace, they live under that key (feature id).
 * @param {Locale} locale
 * @param {string | null} namespace
 * @param {Record<string, any>} strings
 */
export function registerStrings(locale, namespace, strings) {
  const target = dictionaries[locale] || (dictionaries[locale] = {});
  if (namespace) {
    target[namespace] = deepMerge(target[namespace] || {}, strings);
  } else {
    deepMerge(target, strings);
  }
}

/** Remove all strings (tests only). */
export function resetStrings() {
  dictionaries.es = {};
  dictionaries.en = {};
}

/** @param {Record<string, any>} dict @param {string} key */
function lookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/** @type {Map<string, Intl.PluralRules>} */
const pluralRules = new Map();
/** @param {Locale} locale @param {number} n */
function pluralCategory(locale, n) {
  let pr = pluralRules.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(INTL_LOCALE[locale] || locale);
    pluralRules.set(locale, pr);
  }
  return pr.select(n);
}

/**
 * Translate a key.
 * @param {string} key dot path, e.g. 'common.save' or 'health.vaccines.title'
 * @param {Record<string, string | number> & { count?: number }} [vars]
 * @param {Locale} [locale]
 * @returns {string}
 */
export function t(key, vars, locale = getLocale()) {
  /** @type {any} */
  let value = lookup(dictionaries[locale] || {}, key);
  if (value === undefined && locale !== DEFAULT_LOCALE) value = lookup(dictionaries[DEFAULT_LOCALE], key);
  if (value && typeof value === 'object') {
    const n = Number(vars?.count ?? 0);
    value = (n === 0 && value.zero) || value[pluralCategory(locale, n)] || value.other;
  }
  if (typeof value !== 'string') return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
}

/** True when a key exists in the current (or default) locale. @param {string} key */
export function hasKey(key) {
  return lookup(dictionaries[getLocale()] || {}, key) !== undefined || lookup(dictionaries[DEFAULT_LOCALE], key) !== undefined;
}

/**
 * Pick the current locale's value from a bilingual content field { es, en }.
 * Falls back to Spanish, then to any value. Plain strings pass through.
 * @param {{ es?: string, en?: string } | string | null | undefined} field
 * @param {Locale} [locale]
 */
export function pick(field, locale = getLocale()) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  return field[locale] ?? field[DEFAULT_LOCALE] ?? Object.values(field)[0] ?? '';
}

/**
 * Load shared strings and every feature's strings for both locales (called once at boot).
 * @param {string[]} featureIds
 * @param {string} [base] URL prefix of the app root
 */
export async function loadStrings(featureIds, base = './') {
  /** @type {Array<[Locale, string | null, string]>} */
  const jobs = [];
  for (const locale of LOCALES) {
    jobs.push([locale, null, `${base}src/i18n/${locale}.json`]);
    for (const id of featureIds) jobs.push([locale, id, `${base}src/features/${id}/i18n/${locale}.json`]);
  }
  await Promise.all(
    jobs.map(async ([locale, ns, url]) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
      registerStrings(locale, ns, await res.json());
    }),
  );
}

// ---------------------------------------------------------------------------
// Formatting. Date-only strings ('YYYY-MM-DD') are formatted as calendar dates without any
// timezone shift; instants are formatted in the given timezone (settings.timezone).
// ---------------------------------------------------------------------------

/** @type {Map<string, Intl.DateTimeFormat>} */
const dtfCache = new Map();
/** @param {Locale} locale @param {Intl.DateTimeFormatOptions} opts */
function dtf(locale, opts) {
  const k = locale + JSON.stringify(opts);
  let f = dtfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale] || locale, opts);
    dtfCache.set(k, f);
  }
  return f;
}

/** @type {Record<string, Intl.DateTimeFormatOptions>} */
const DATE_STYLES = {
  short: { day: 'numeric', month: 'short' }, // 13 nov
  medium: { day: 'numeric', month: 'short', year: 'numeric' }, // 13 nov 2026
  long: { weekday: 'long', day: 'numeric', month: 'long' }, // jueves, 13 de noviembre
  full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  weekday: { weekday: 'short' },
};

/**
 * Format a calendar date ('YYYY-MM-DD').
 * @param {string} dateStr
 * @param {keyof typeof DATE_STYLES} [style]
 * @param {Locale} [locale]
 */
export function formatDate(dateStr, style = 'medium', locale = getLocale()) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return dtf(locale, { ...DATE_STYLES[style], timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Format the time of an instant in a timezone ("7:30 a. m." / "7:30 AM").
 * @param {string | Date} instant
 * @param {string} tz
 * @param {Locale} [locale]
 */
export function formatTime(instant, tz, locale = getLocale()) {
  if (!instant) return '';
  return dtf(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(instant));
}

/**
 * Format a wall-clock 'HH:MM' (e.g. a meal slot) without any timezone math.
 * @param {string} hhmm
 * @param {Locale} [locale]
 */
export function formatClock(hhmm, locale = getLocale()) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return dtf(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
}

/**
 * Format date and time of an instant in a timezone.
 * @param {string | Date} instant @param {string} tz @param {Locale} [locale]
 */
export function formatDateTime(instant, tz, locale = getLocale()) {
  if (!instant) return '';
  return dtf(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(
    new Date(instant),
  );
}

/**
 * @param {number} n
 * @param {Intl.NumberFormatOptions} [opts]
 * @param {Locale} [locale]
 */
export function formatNumber(n, opts = {}, locale = getLocale()) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return new Intl.NumberFormat(INTL_LOCALE[locale] || locale, opts).format(Number(n));
}

/**
 * "hoy", "mañana", "en 3 días", "hace 2 días" for a calendar date relative to `today`.
 * @param {string} dateStr @param {string} today @param {Locale} [locale]
 */
export function formatRelativeDay(dateStr, today, locale = getLocale()) {
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = dateStr.split('-').map(Number);
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
  return new Intl.RelativeTimeFormat(INTL_LOCALE[locale] || locale, { numeric: 'auto' }).format(days, 'day');
}
