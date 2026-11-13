// Locale-aware labels for the profile feature (thin wrappers over t() and Intl).
import { t, getLocale } from '../../lib/i18n.js';
import { INTL_LOCALE } from '../../config.js';
import { ageParts } from './logic.js';

/**
 * "7 semanas y 3 días", "5 meses", "3 días". Empty before birth.
 * @param {string} birthDate @param {string} date
 */
export function ageLabel(birthDate, date) {
  const a = ageParts(birthDate, date);
  if (!a) return '';
  if (a.unit === 'days') return a.days === 0 ? t('profile.age.newborn') : t('age.days', { count: a.days });
  if (a.unit === 'months') return t('age.months', { count: a.months });
  const weeks = t('age.weeks', { count: a.weeks });
  return a.days ? t('profile.age.weeksAndDays', { weeks, days: t('age.days', { count: a.days }) }) : weeks;
}

/** "noviembre de 2026" / "November 2026" for 'YYYY-MM'. @param {string} month */
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return '';
  const locale = getLocale();
  const s = new Intl.DateTimeFormat(INTL_LOCALE[locale] || locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Suggested first milestones (quick picks), in the current locale. */
export const SUGGESTION_KEYS = ['home', 'night', 'bath', 'vet', 'vaccine', 'walk', 'car', 'sit', 'friend', 'toy'];
export function suggestions() {
  return SUGGESTION_KEYS.map((key) => ({ key, title: t(`profile.memories.suggest.${key}`) }));
}
