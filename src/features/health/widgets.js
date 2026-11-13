// Small shared pieces of the Health feature: formatting, "Add to Calendar", badges.
import { html } from '../../../vendor/preact.js';
import { t, formatDate, formatNumber, formatClock, formatRelativeDay } from '../../lib/i18n.js';
import { Badge, IconButton, Button } from '../../lib/ui/index.js';
import { buildIcs, eventUid, icsFileName } from './ics.js';

/** "4,6 kg" @param {number | string | null | undefined} kg */
export function formatKg(kg) {
  if (kg == null || kg === '') return '';
  return `${formatNumber(Number(kg), { maximumFractionDigits: 2 })} kg`;
}

/** "+0,5 kg" / "−0,2 kg" / "0 kg" @param {number | null} delta */
export function formatDeltaKg(delta) {
  if (delta == null) return '';
  return `${formatNumber(delta, { maximumFractionDigits: 2, signDisplay: 'exceptZero' })} kg`;
}

/** "$ 80.000" in the row's currency. @param {number | string | null} amount @param {string} [currency] */
export function formatMoney(amount, currency = 'COP') {
  if (amount == null || amount === '') return '';
  try {
    return formatNumber(Number(amount), { style: 'currency', currency, maximumFractionDigits: currency === 'COP' ? 0 : 2 });
  } catch {
    return `${formatNumber(Number(amount))} ${currency}`;
  }
}

/** "7 semanas · 3 días" @param {{ weeks: number, days: number }} age */
export function formatAge(age) {
  return age.days ? `${t('age.weeks', { count: age.weeks })} · ${t('age.days', { count: age.days })}` : t('age.weeks', { count: age.weeks });
}

/** Due date with optional time: "29 nov, 8:00 a. m." @param {string} date @param {string | null} [time] @param {'short' | 'medium'} [style] */
export function formatDue(date, time, style = 'short') {
  return time ? `${formatDate(date, style)}, ${formatClock(time)}` : formatDate(date, style);
}

/** @param {import('../../data/derived.js').DueStatus} status */
export const statusTone = (status) => (status === 'overdue' ? 'red' : status === 'today' || status === 'soon' ? 'gold' : 'blue');

/**
 * Badge for a due item: "Atrasado · hace 2 días", "Pronto · en 3 días".
 * @param {{ item: { status: import('../../data/derived.js').DueStatus, dueOn: string }, today: string }} props
 */
export function DueBadge({ item, today }) {
  const rel = formatRelativeDay(item.dueOn, today);
  const text = item.status === 'upcoming' ? rel.charAt(0).toUpperCase() + rel.slice(1) : `${t(`due.status.${item.status}`)} · ${rel}`;
  return html`<${Badge} tone=${statusTone(item.status)} icon=${item.status === 'overdue' ? 'alert' : 'clock'}>${text}</${Badge}>`;
}

/**
 * @typedef {object} CalendarItem
 * @property {import('../../data/derived.js').DueKind} kind
 * @property {string} rowId
 * @property {string} dueOn
 * @property {string | null} [dueTime]
 * @property {string} title   free text (vaccine name, product, reason, reminder title)
 * @property {string | null} [notes]
 */

/**
 * Build and download the .ics file for a due item.
 * @param {CalendarItem} item @param {string} tz
 */
export function downloadIcs(item, tz) {
  const kindLabel = t(`due.kind.${item.kind}`);
  const title = item.kind === 'reminder' ? t('health.calendar.reminderTitle', { title: item.title }) : t('health.calendar.eventTitle', { kind: kindLabel, title: item.title || kindLabel });
  const description = [t('health.calendar.description'), item.notes || ''].filter(Boolean).join('\n\n');
  const text = buildIcs({
    uid: eventUid(item.kind, item.rowId, item.dueOn),
    title,
    description,
    date: item.dueOn,
    time: item.dueTime || null,
    tz,
    now: new Date(),
    alarmText: { dayBefore: t('health.calendar.alarmDayBefore', { title }), atTime: title },
  });
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFileName(`${kindLabel} ${item.title}`, item.dueOn);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * "Add to Calendar" button (full button, or icon-only with `compact`).
 * @param {{ item: CalendarItem, tz: string, compact?: boolean }} props
 */
export function CalendarButton({ item, tz, compact = false }) {
  const label = t('health.calendar.add');
  const onClick = (/** @type {Event} */ e) => {
    e.stopPropagation();
    downloadIcs(item, tz);
  };
  if (compact) {
    return html`<${IconButton} icon="calendar" label=${`${label}: ${item.title}`} onClick=${onClick} class="health-cal-btn" data-testid="add-to-calendar" />`;
  }
  return html`<${Button} variant="secondary" icon="calendar" onClick=${onClick} data-testid="add-to-calendar">${label}</${Button}>`;
}

