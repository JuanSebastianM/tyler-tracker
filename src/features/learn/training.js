// Training guides: list with status, difficulty and age; guide article with a progress control.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t, pick } from '../../lib/i18n.js';
import { href } from '../../lib/router.js';
import { useContent, findById } from '../../lib/content.js';
import { useIsEditor } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { Badge, Button, Card, DateInput, EmptyState, List, ListRow, Select, TextArea } from '../../lib/ui/index.js';
import { trainingSkills } from '../../data/stores.js';
import {
  TRAINING_STATUSES, STATUS_TONE, normalizeStatus, applyStatus, trainingFormError, trainingOverview, isOldEnough, sortGuides,
} from './logic.js';
import { ArticleView, Loading, LoadError, NotFound, SampleBadge, useAge, weeksText, dateText } from './components.js';

const STATUS_KEY = /** @type {Record<string, string>} */ ({ not_started: 'notStarted', learning: 'learning', reliable: 'reliable', mastered: 'mastered' });
/** @param {string} s */
export const statusLabel = (s) => t(`learn.training.status.${STATUS_KEY[normalizeStatus(s)]}`);
/** @param {string} d */
const difficultyLabel = (d) => (['easy', 'medium', 'hard'].includes(d) ? t(`learn.training.difficulty.${d}`) : d || '');

/** @param {{ status: string }} props */
function StatusBadge({ status }) {
  const s = normalizeStatus(status);
  return html`<${Badge} tone=${STATUS_TONE[s]} icon=${s === 'mastered' ? 'check' : undefined}>${statusLabel(s)}</${Badge}>`;
}

/** Age line for a guide: "Desde 8 semanas" or "Desde 12 semanas · en 5 semanas". @param {any} g @param {number} weeks */
function ageLine(g, weeks) {
  const min = g.min_age_weeks ?? 0;
  return isOldEnough(g, weeks)
    ? t('learn.training.fromAge', { age: weeksText(min) })
    : t('learn.training.fromAgeWait', { age: weeksText(min), wait: weeksText(min - weeks) });
}

export function TrainingScreen() {
  const { data, status } = useContent('training');
  const rows = trainingSkills.useRows();
  const { weeks } = useAge();
  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} /></div>`;
  if (!data) return html`<div class="learn stack"><${LoadError} /></div>`;
  /** @type {any[]} */
  const guides = sortGuides(data.items || []);
  const byKey = new Map(rows.map((r) => [r.skill_key, r]));
  const ov = trainingOverview(guides, rows);

  return html`<div class="learn stack">
    <p class="section-intro">${t('learn.sections.training.longIntro')}</p>
    ${guides.length
      ? html`
          <${Card} title=${t('learn.training.overview')} data-testid="training-overview">
            <div class="progress-line">
              <div class="progress" role="progressbar" aria-label=${t('learn.training.overview')} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${ov.percent}>
                <span style=${{ width: `${ov.percent}%` }}></span>
              </div>
              <span class="progress-text">${ov.percent}%</span>
            </div>
            <ul class="status-counts">
              ${TRAINING_STATUSES.map(
                (s) => html`<li><span class=${`dot dot-${STATUS_TONE[s]}`} aria-hidden="true"></span>${statusLabel(s)}<strong>${ov.counts[s]}</strong></li>`,
              )}
            </ul>
          </${Card}>
          <${Card} title=${t('learn.training.guides')}>
            <${List} data-testid="training-list">${guides.map((g) => {
              const st = normalizeStatus(byKey.get(g.id)?.status);
              const ok = isOldEnough(g, weeks);
              return html`<${ListRow}
                icon=${ok ? 'grad-cap' : 'clock'}
                iconTone=${st === 'mastered' ? 'green' : ok ? 'blue' : 'neutral'}
                title=${pick(g.title)}
                subtitle=${html`${difficultyLabel(g.difficulty)} · ${ageLine(g, weeks)}`}
                trailing=${html`<span class="row-badges"><${StatusBadge} status=${st} /><${SampleBadge} sample=${g.sample} /></span>`}
                href=${href(`/learn/training/${encodeURIComponent(g.id)}`)}
                data-guide=${g.id}
              />`;
            })}</${List}>
          </${Card}>`
      : html`<${Card}><${EmptyState} icon="grad-cap" title=${t('learn.emptySectionTitle')} body=${t('learn.emptySectionBody')} /></${Card}>`}
  </div>`;
}

/** @param {{ params: Record<string, string> }} props */
export function TrainingGuide({ params }) {
  const { data, status } = useContent('training');
  const { weeks } = useAge();
  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} lines=${8} /></div>`;
  /** @type {any} */
  const guide = findById(data?.items, params.id);
  if (!guide) return html`<${NotFound} section="training" />`;
  const ok = isOldEnough(guide, weeks);
  const meta = html`
    <${Badge} tone="blue">${difficultyLabel(guide.difficulty)}</${Badge}>
    ${guide.duration_min ? html`<${Badge} tone="neutral" icon="clock">${t('learn.training.minutes', { count: guide.duration_min })}</${Badge}>` : null}
    <${Badge} tone=${ok ? 'green' : 'warn'} icon=${ok ? 'check' : 'calendar'}>${ok ? t('learn.training.readyNow') : ageLine(guide, weeks)}</${Badge}>`;
  return html`<div class="learn stack">
    <${ArticleView} item=${guide} health meta=${meta} before=${html`<${Progress} guide=${guide} />`} />
  </div>`;
}

/** Progress card: read-only for visitors, a small form for editors. @param {{ guide: any }} props */
function Progress({ guide }) {
  const isEditor = useIsEditor();
  const row = trainingSkills.useRow(guide.id);
  const { today } = useAge();
  const status = normalizeStatus(row?.status);

  if (!isEditor) {
    return html`<${Card} title=${t('learn.training.progressTitle')} data-testid="training-progress">
      <div class="progress-readonly">
        <${StatusBadge} status=${status} />
        ${row?.started_on ? html`<span>${t('learn.training.startedOn', { date: dateText(row.started_on) })}</span>` : null}
        ${row?.mastered_on ? html`<span>${t('learn.training.masteredOn', { date: dateText(row.mastered_on) })}</span>` : null}
      </div>
      ${row?.notes ? html`<p class="training-notes">${row.notes}</p>` : null}
      ${row?.created_by_name ? html`<p class="article-note">${t('common.loggedBy', { name: row.created_by_name })}</p>` : null}
    </${Card}>`;
  }
  return html`<${ProgressForm} guide=${guide} row=${row} today=${today} />`;
}

/** @param {{ guide: any, row: any, today: string }} props */
function ProgressForm({ guide, row, today }) {
  const fromRow = () => ({
    status: normalizeStatus(row?.status),
    started_on: row?.started_on || null,
    mastered_on: row?.mastered_on || null,
    notes: row?.notes || '',
  });
  const [form, setForm] = useState(fromRow);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  // Follow the saved row (refresh, other editor) while there are no local edits.
  useEffect(() => {
    if (!dirty) setForm(fromRow());
  }, [row?.status, row?.started_on, row?.mastered_on, row?.notes]);

  /** @param {Partial<typeof form>} patch */
  const change = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setError(null);
  };

  const save = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const err = trainingFormError(form, today);
    if (err) return setError(t(`learn.training.errors.${err}`));
    setBusy(true);
    const { error: saveError } = await trainingSkills.upsert({
      skill_key: guide.id,
      status: form.status,
      started_on: form.status === 'not_started' ? null : form.started_on,
      mastered_on: form.status === 'mastered' ? form.mastered_on : null,
      notes: form.notes.trim() || null,
    });
    setBusy(false);
    if (saveError) {
      setForm(fromRow());
      setDirty(false);
      return;
    }
    setDirty(false);
    toast(t('learn.training.saved'), { tone: 'success' });
  };

  return html`<${Card} title=${t('learn.training.progressTitle')} data-testid="training-progress">
    <form class="stack" onSubmit=${save} novalidate>
      <${Select}
        label=${t('learn.training.statusLabel')}
        value=${form.status}
        options=${TRAINING_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        onValue=${(/** @type {any} */ v) => change(applyStatus(form, normalizeStatus(v), today))}
        data-testid="training-status"
      />
      ${form.status !== 'not_started'
        ? html`<div class=${form.status === 'mastered' ? 'grid-2' : ''}>
            <${DateInput} label=${t('learn.training.startedLabel')} value=${form.started_on || ''} max=${today}
              onValue=${(/** @type {string} */ v) => change({ started_on: v || null })} />
            ${form.status === 'mastered'
              ? html`<${DateInput} label=${t('learn.training.masteredLabel')} value=${form.mastered_on || ''} max=${today}
                  onValue=${(/** @type {string} */ v) => change({ mastered_on: v || today })} />`
              : null}
          </div>`
        : null}
      <${TextArea} label=${t('learn.training.notesLabel')} hint=${t('learn.training.notesHint')} value=${form.notes}
        onValue=${(/** @type {string} */ v) => change({ notes: v })} rows=${2} />
      ${error ? html`<p class="form-error" role="alert">${error}</p>` : null}
      <${Button} type="submit" block loading=${busy} disabled=${!dirty}>${t('learn.training.save')}</${Button}>
      ${row?.created_by_name && !dirty ? html`<p class="article-note">${t('common.loggedBy', { name: row.created_by_name })}</p>` : null}
    </form>
  </${Card}>`;
}
