// Health overview (#/health): what is due next, latest weight and entries to each section.
import { html, useState } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { href, navigate } from '../../lib/router.js';
import { Card, List, ListRow, Fab, Sheet, Button, HealthDisclaimer } from '../../lib/ui/index.js';
import { vaccinations, dewormings, vetVisits, medications, reminders, weights } from '../../data/stores.js';
import { DUE_KIND_PATH } from '../../data/derived.js';
import { useHealthCtx } from './sections.js';
import { LatestWeight, useBirthDate } from './weight-screen.js';
import { splitMedications, splitReminders } from './logic.js';
import { DueBadge, CalendarButton, formatDue } from './widgets.js';

/** Section ids, routes, icons. */
export const SECTIONS = [
  { id: 'vaccines', icon: 'syringe', tone: 'blue' },
  { id: 'deworming', icon: 'pill', tone: 'green' },
  { id: 'weight', icon: 'scale', tone: 'gold' },
  { id: 'visits', icon: 'stethoscope', tone: 'blue' },
  { id: 'medications', icon: 'pill', tone: 'gold' },
  { id: 'reminders', icon: 'bell', tone: 'gold' },
];

/** Section route for a due item kind. */
const KIND_ICON = { vaccination: 'syringe', deworming: 'pill', vet_follow_up: 'stethoscope', reminder: 'bell' };
/** Due items shown on the overview. */
const MAX_DUE = 5;

export function HealthScreen() {
  const ctx = useHealthCtx();
  const birthDate = useBirthDate();
  const [chooser, setChooser] = useState(false);
  const w = weights.useRows();
  const meds = splitMedications(medications.useRows(), ctx.today);
  const rem = splitReminders(reminders.useRows());
  const counts = {
    vaccines: t('health.count.records', { count: vaccinations.useRows().length }),
    deworming: t('health.count.records', { count: dewormings.useRows().length }),
    weight: t('health.count.records', { count: w.length }),
    visits: t('health.count.records', { count: vetVisits.useRows().length }),
    medications: t('health.count.active', { count: meds.active.length }),
    reminders: t('health.count.pending', { count: rem.open.length }),
  };
  const due = ctx.due.slice(0, MAX_DUE);

  return html`<div class="health stack" data-testid="health-overview">
    <${Card} title=${t('health.overview.dueTitle')} data-testid="due-card">
      ${due.length
        ? html`<${List}>
            ${due.map(
              (d) => html`<div class="health-row" key=${d.id} data-testid="due-item">
                <${ListRow} icon=${KIND_ICON[d.kind]} iconTone=${d.status === 'overdue' ? 'red' : d.status === 'today' || d.status === 'soon' ? 'warn' : 'neutral'}
                  title=${d.title || t(`due.kind.${d.kind}`)}
                  subtitle=${html`<span class="health-sub">${d.title ? `${t(`due.kind.${d.kind}`)} · ` : ''}${formatDue(d.dueOn, d.dueTime)}</span>
                    <span class="health-due-line"><${DueBadge} item=${d} today=${ctx.today} /></span>`}
                  href=${href(DUE_KIND_PATH[d.kind])} />
                <${CalendarButton} compact tz=${ctx.tz}
                  item=${{ kind: d.kind, rowId: d.row.id, dueOn: d.dueOn, dueTime: d.dueTime, title: d.title, notes: d.row.notes }} />
              </div>`,
            )}
          </${List}>
          ${ctx.due.length > MAX_DUE ? html`<p class="muted health-more">${t('health.overview.moreDue', { count: ctx.due.length - MAX_DUE })}</p>` : null}`
        : html`<p class="muted">${t('health.overview.nothingDue')}</p>`}
    </${Card}>

    <${Card} title=${t('health.overview.weightTitle')}
      action=${html`<a class="health-link" href=${href('/health/weight')}>${t('health.overview.seeChart')}</a>`}>
      ${w.length ? html`<${LatestWeight} rows=${w} birthDate=${birthDate} />` : html`<p class="muted">${t('health.overview.noWeight')}</p>`}
    </${Card}>

    <${Card} title=${t('health.overview.sectionsTitle')}>
      <${List}>
        ${SECTIONS.map(
          (s) => html`<${ListRow} icon=${s.icon} iconTone=${s.tone} title=${t(`health.${s.id}.title`)} subtitle=${t(`health.${s.id}.summary`)}
            meta=${counts[s.id]} href=${href(`/health/${s.id}`)} data-testid=${`section-${s.id}`} />`,
        )}
      </${List}>
    </${Card}>

    <${HealthDisclaimer} />

    <${EditorOnly}>
      <${Fab} label=${t('health.add')} onClick=${() => setChooser(true)} data-testid="fab-add" />
      <${Sheet} open=${chooser} onClose=${() => setChooser(false)} title=${t('health.chooserTitle')}>
        <div class="health-chooser">
          ${SECTIONS.map(
            (s) => html`<${Button} variant="secondary" icon=${s.icon} block
              onClick=${() => { setChooser(false); navigate(`/health/${s.id}?add=1`); }}>${t(`health.${s.id}.add`)}</${Button}>`,
          )}
        </div>
      </${Sheet}>
    </${EditorOnly}>
  </div>`;
}
