import { html } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { Card, EmptyState, Fab, Skeleton, Badge } from '../../lib/ui/index.js';
import { petProfile, vaccinations, dewormings, vetVisits, reminders, useTimezone } from '../../data/stores.js';
import { getAge, getDueItems, getToday } from '../../data/derived.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';

// Placeholder: the Today feature replaces this screen. It already shows how to read stores and
// derived data, and how to gate an editor-only control.
export function TodayScreen() {
  const tz = useTimezone();
  const profile = petProfile.useRow();
  const { status } = petProfile.useState();
  const today = getToday(tz).date;
  const age = getAge(profile?.birth_date || DEFAULT_BIRTH_DATE, today);
  const due = getDueItems(
    { vaccinations: vaccinations.useRows(), dewormings: dewormings.useRows(), vetVisits: vetVisits.useRows(), reminders: reminders.useRows() },
    today,
  );
  const pressing = due.filter((d) => d.status !== 'upcoming');

  return html`<div class="today stack">
    <${Card} tone="gold" class="today-hero" data-testid="age-card">
      ${!profile && status !== 'ready'
        ? html`<${Skeleton} lines=${2} height=${22} />`
        : html`<p class="today-hello">${t('today.hello', { name: profile?.name || 'Tyler' })}</p>
            <p class="today-age">${t('age.weeks', { count: age.weeks })}${age.days ? ' · ' + t('age.days', { count: age.days }) : ''}</p>
            <p class="today-months">${t('today.monthsOld', { count: age.months })}</p>`}
    </${Card}>
    <${Card} title=${t('today.dueTitle')}>
      ${pressing.length
        ? html`<p>${t('today.dueCount', { count: pressing.length })} <${Badge} tone=${pressing.some((d) => d.status === 'overdue') ? 'red' : 'gold'}>${t(`due.status.${pressing[0].status}`)}</${Badge}></p>`
        : html`<p class="muted">${t('today.nothingDue')}</p>`}
    </${Card}>
    <${EmptyState} icon="bowl" title=${t('today.emptyTitle')} body=${t('today.emptyBody')} />
    <${EditorOnly}>
      <${Fab} label=${t('today.quickAdd')} onClick=${() => toast(t('common.comingSoon'))} data-testid="fab-add" />
    </${EditorOnly}>
  </div>`;
}
