// Health sub-screens: vaccines, deworming, vet visits, medications and reminders (weight has its
// own screen with the growth chart). Each is a RecordSection config.
import { html } from '../../../vendor/preact.js';
import { t, formatDate, formatClock, formatDateTime, getLocale } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { EditorOnly } from '../../lib/auth.js';
import { Button, IconButton, Badge } from '../../lib/ui/index.js';
import {
  vaccinations, dewormings, vetVisits, vetVisitPrivate, medications, reminders, useTimezone,
} from '../../data/stores.js';
import { getDueItems, getToday } from '../../data/derived.js';
import { uploadPhoto, deletePhoto } from '../../data/photos.js';
import { RecordSection } from './records.js';
import { orNull, parseDecimal, decimalToInput, isValidWeight, splitMedications, splitReminders, hhmm } from './logic.js';
import { formatKg, formatMoney, formatDue } from './widgets.js';

/**
 * Shared context for Health screens: today, timezone and due items keyed by row id.
 * @returns {import('./records.js').Ctx & { due: import('../../data/derived.js').DueItem[] }}
 */
export function useHealthCtx() {
  const tz = useTimezone();
  const today = getToday(tz).date;
  const due = getDueItems(
    { vaccinations: vaccinations.useRows(), dewormings: dewormings.useRows(), vetVisits: vetVisits.useRows(), reminders: reminders.useRows() },
    today,
  );
  const dueByRow = new Map(due.map((d) => [d.row.id, d]));
  return { tz, today, due, dueByRow, isEditor: false };
}

const dateOf = (/** @type {string | null} */ d) => (d ? formatDate(d, 'medium') : '');

// ---------------------------------------------------------------------------
// Vaccines
// ---------------------------------------------------------------------------

/** @type {import('./records.js').SectionConfig} */
export const vaccinesConfig = {
  id: 'vaccines',
  store: vaccinations,
  icon: 'syringe',
  iconTone: 'blue',
  fields: [
    { name: 'vaccine', kind: 'text', label: 'health.vaccines.fields.vaccine', hint: 'health.vaccines.fields.vaccineHint', required: true },
    [
      { name: 'given_on', kind: 'date', label: 'health.vaccines.fields.givenOn', required: true },
      { name: 'next_due_on', kind: 'date', label: 'health.vaccines.fields.nextDueOn' },
    ],
    [
      { name: 'vet', kind: 'text', label: 'health.fields.vet' },
      { name: 'batch', kind: 'text', label: 'health.vaccines.fields.batch' },
    ],
    { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
    { name: 'photo', kind: 'photo', label: 'health.vaccines.fields.photo', hint: 'health.vaccines.fields.photoHint' },
  ],
  rules: { required: ['vaccine', 'given_on'], after: [['next_due_on', 'given_on']] },
  toForm: (row, ctx) => ({
    vaccine: row?.vaccine || '',
    given_on: row?.given_on || ctx.today,
    next_due_on: row?.next_due_on || '',
    vet: row?.vet || '',
    batch: row?.batch || '',
    notes: row?.notes || '',
    photo: { path: row?.photo_path || null, file: null, remove: false },
  }),
  toPayload: (v) => ({
    vaccine: v.vaccine.trim(),
    given_on: v.given_on,
    next_due_on: orNull(v.next_due_on),
    vet: orNull(v.vet),
    batch: orNull(v.batch),
    notes: orNull(v.notes),
  }),
  async beforeSave(values, row) {
    const old = row?.photo_path || null;
    const p = values.photo || {};
    if (p.file) {
      try {
        const up = await uploadPhoto('vaccines', p.file);
        // Keep the new file only if the row saves; drop the replaced one after success.
        return {
          extra: { photo_path: up.path },
          onDone: (ok) => {
            if (!ok) deletePhoto(up.path);
            else if (old) deletePhoto(old);
          },
        };
      } catch (e) {
        toast(t(/** @type {any} */ (e)?.code === 'offline' ? 'errors.offline' : 'errors.photoFailed'), { tone: 'error' });
        return null;
      }
    }
    if (p.remove && old) return { extra: { photo_path: null }, onDone: (ok) => ok && deletePhoto(old) };
    return { extra: {} };
  },
  afterDelete: (row) => row.photo_path && deletePhoto(row.photo_path),
  photo: (row) => row.photo_path || null,
  view: (row) => ({
    title: row.vaccine,
    subtitle: t('health.vaccines.givenOn', { date: dateOf(row.given_on) }),
    meta: row.photo_path ? html`<${Badge} icon="camera">${t('health.photo.badge')}</${Badge}>` : null,
  }),
  details: (row) => [
    ['health.vaccines.fields.givenOn', dateOf(row.given_on)],
    ['health.vaccines.fields.nextDueOn', dateOf(row.next_due_on)],
    ['health.fields.vet', row.vet],
    ['health.vaccines.fields.batch', row.batch],
    ['health.fields.notes', row.notes],
  ],
  calendar: (row, ctx) =>
    ctx.dueByRow.has(row.id) ? { kind: 'vaccination', rowId: row.id, dueOn: row.next_due_on, title: row.vaccine, notes: row.notes } : null,
};

// ---------------------------------------------------------------------------
// Deworming
// ---------------------------------------------------------------------------

const kindOptions = () => [
  { value: 'internal', label: t('health.deworming.kinds.internal') },
  { value: 'external', label: t('health.deworming.kinds.external') },
  { value: 'both', label: t('health.deworming.kinds.both') },
];

/** @type {import('./records.js').SectionConfig} */
export const dewormingConfig = {
  id: 'deworming',
  store: dewormings,
  icon: 'pill',
  iconTone: 'green',
  fields: [
    { name: 'product', kind: 'text', label: 'health.deworming.fields.product', hint: 'health.deworming.fields.productHint' },
    { name: 'kind', kind: 'segmented', label: 'health.deworming.fields.kind', options: kindOptions },
    [
      { name: 'given_on', kind: 'date', label: 'health.deworming.fields.givenOn', required: true },
      { name: 'weight', kind: 'decimal', label: 'health.deworming.fields.weight', unit: 'kg' },
    ],
    { name: 'next_due_on', kind: 'date', label: 'health.deworming.fields.nextDueOn' },
    { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
  ],
  rules: { required: ['given_on'], after: [['next_due_on', 'given_on']] },
  check: (v) => (v.weight && !isValidWeight(parseDecimal(v.weight)) ? { weight: 'health.form.invalidWeight' } : {}),
  toForm: (row, ctx) => ({
    product: row?.product || '',
    kind: row?.kind || 'internal',
    given_on: row?.given_on || ctx.today,
    weight: decimalToInput(row?.weight_kg, getLocale()),
    next_due_on: row?.next_due_on || '',
    notes: row?.notes || '',
  }),
  toPayload: (v) => ({
    product: orNull(v.product),
    kind: v.kind,
    given_on: v.given_on,
    weight_kg: parseDecimal(v.weight),
    next_due_on: orNull(v.next_due_on),
    notes: orNull(v.notes),
  }),
  view: (row) => ({
    title: row.product || t('health.deworming.unnamed'),
    subtitle: `${t(`health.deworming.kinds.${row.kind}`)} · ${dateOf(row.given_on)}`,
    meta: row.weight_kg != null ? formatKg(row.weight_kg) : null,
  }),
  details: (row) => [
    ['health.deworming.fields.kind', t(`health.deworming.kinds.${row.kind}`)],
    ['health.deworming.fields.givenOn', dateOf(row.given_on)],
    ['health.deworming.fields.weight', row.weight_kg != null ? formatKg(row.weight_kg) : ''],
    ['health.deworming.fields.nextDueOn', dateOf(row.next_due_on)],
    ['health.fields.notes', row.notes],
  ],
  calendar: (row, ctx) =>
    ctx.dueByRow.has(row.id) ? { kind: 'deworming', rowId: row.id, dueOn: row.next_due_on, title: row.product || '', notes: row.notes } : null,
};

// ---------------------------------------------------------------------------
// Vet visits (cost and private notes for editors only, in vet_visit_private)
// ---------------------------------------------------------------------------

/** Cost + private notes of a visit. Only rendered inside EditorOnly. @param {{ id: string }} props */
function VisitPrivate({ id }) {
  const p = vetVisitPrivate.useRow(id);
  return html`<div class="health-private" data-testid="visit-private">
    <p class="health-private-title"><span>${t('health.visits.privateTitle')}</span></p>
    ${p && (p.cost != null || p.private_notes)
      ? html`<dl class="health-dl">
          ${p.cost != null ? html`<div><dt>${t('health.visits.fields.cost')}</dt><dd>${formatMoney(p.cost, p.currency)}</dd></div>` : null}
          ${p.private_notes ? html`<div><dt>${t('health.visits.fields.privateNotes')}</dt><dd>${p.private_notes}</dd></div>` : null}
        </dl>`
      : html`<p class="muted">${t('health.visits.privateEmpty')}</p>`}
  </div>`;
}

/** @type {import('./records.js').SectionConfig} */
export const visitsConfig = {
  id: 'visits',
  store: vetVisits,
  icon: 'stethoscope',
  iconTone: 'blue',
  fields: [
    { name: 'reason', kind: 'text', label: 'health.visits.fields.reason', required: true },
    [
      { name: 'visited_on', kind: 'date', label: 'health.visits.fields.visitedOn', required: true },
      { name: 'vet', kind: 'text', label: 'health.fields.vet' },
    ],
    { name: 'findings', kind: 'textarea', label: 'health.visits.fields.findings' },
    { name: 'treatment', kind: 'textarea', label: 'health.visits.fields.treatment' },
    { name: 'follow_up_on', kind: 'date', label: 'health.visits.fields.followUpOn' },
    { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
    { name: 'cost', kind: 'decimal', label: 'health.visits.fields.cost', unit: 'COP', hint: 'health.visits.fields.privateHint' },
    { name: 'private_notes', kind: 'textarea', label: 'health.visits.fields.privateNotes', hint: 'health.visits.fields.privateHint' },
  ],
  rules: { required: ['reason', 'visited_on'], after: [['follow_up_on', 'visited_on']] },
  check: (v) => (v.cost && parseDecimal(v.cost) == null ? { cost: 'health.form.invalidNumber' } : {}),
  toForm: (row, ctx) => {
    const p = row ? vetVisitPrivate.get(row.id) : null;
    return {
      reason: row?.reason || '',
      visited_on: row?.visited_on || ctx.today,
      vet: row?.vet || '',
      findings: row?.findings || '',
      treatment: row?.treatment || '',
      follow_up_on: row?.follow_up_on || '',
      notes: row?.notes || '',
      cost: decimalToInput(p?.cost, getLocale()),
      private_notes: p?.private_notes || '',
    };
  },
  toPayload: (v) => ({
    reason: v.reason.trim(),
    visited_on: v.visited_on,
    vet: orNull(v.vet),
    findings: orNull(v.findings),
    treatment: orNull(v.treatment),
    follow_up_on: orNull(v.follow_up_on),
    notes: orNull(v.notes),
  }),
  afterSave(saved, v, row) {
    const cost = parseDecimal(v.cost);
    const notes = orNull(v.private_notes);
    const existing = row ? vetVisitPrivate.get(row.id) : null;
    if (cost == null && !notes && !existing) return;
    vetVisitPrivate.upsert({ visit_id: saved.id, cost, currency: existing?.currency || 'COP', private_notes: notes });
  },
  view: (row) => ({
    title: row.reason,
    subtitle: [dateOf(row.visited_on), row.vet].filter(Boolean).join(' · '),
  }),
  details: (row) => [
    ['health.visits.fields.visitedOn', dateOf(row.visited_on)],
    ['health.fields.vet', row.vet],
    ['health.visits.fields.findings', row.findings],
    ['health.visits.fields.treatment', row.treatment],
    ['health.visits.fields.followUpOn', dateOf(row.follow_up_on)],
    ['health.fields.notes', row.notes],
  ],
  extraDetails: (row) => html`<${EditorOnly}><${VisitPrivate} id=${row.id} /></${EditorOnly}>`,
  calendar: (row, ctx) =>
    ctx.dueByRow.has(row.id) ? { kind: 'vet_follow_up', rowId: row.id, dueOn: row.follow_up_on, title: row.reason, notes: row.treatment } : null,
};

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

/** @type {import('./records.js').SectionConfig} */
export const medicationsConfig = {
  id: 'medications',
  store: medications,
  icon: 'pill',
  iconTone: 'gold',
  fields: [
    { name: 'name', kind: 'text', label: 'health.medications.fields.name', required: true },
    [
      { name: 'dose', kind: 'text', label: 'health.medications.fields.dose', hint: 'health.medications.fields.doseHint' },
      { name: 'frequency', kind: 'text', label: 'health.medications.fields.frequency', hint: 'health.medications.fields.frequencyHint' },
    ],
    [
      { name: 'start_on', kind: 'date', label: 'health.medications.fields.startOn', required: true },
      { name: 'end_on', kind: 'date', label: 'health.medications.fields.endOn' },
    ],
    { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
  ],
  rules: { required: ['name', 'start_on'], after: [['end_on', 'start_on']] },
  toForm: (row, ctx) => ({
    name: row?.name || '',
    dose: row?.dose || '',
    frequency: row?.frequency || '',
    start_on: row?.start_on || ctx.today,
    end_on: row?.end_on || '',
    notes: row?.notes || '',
  }),
  toPayload: (v) => ({
    name: v.name.trim(),
    dose: orNull(v.dose),
    frequency: orNull(v.frequency),
    start_on: v.start_on,
    end_on: orNull(v.end_on),
    notes: orNull(v.notes),
  }),
  groups: (rows, ctx) => {
    const { active, finished } = splitMedications(rows, ctx.today);
    return [
      { key: 'active', title: t('health.medications.active'), rows: active },
      ...(finished.length ? [{ key: 'finished', title: t('health.medications.finished'), rows: finished }] : []),
    ];
  },
  view: (row, ctx) => {
    const finished = row.end_on && row.end_on < ctx.today;
    const period = row.end_on
      ? t('health.medications.period', { start: formatDate(row.start_on, 'medium'), end: formatDate(row.end_on, 'medium') })
      : t('health.medications.since', { start: formatDate(row.start_on, 'medium') });
    return {
      title: row.name,
      subtitle: [row.dose, row.frequency, period].filter(Boolean).join(' · '),
      iconTone: finished ? 'neutral' : 'gold',
      dim: !!finished,
    };
  },
  details: (row) => [
    ['health.medications.fields.dose', row.dose],
    ['health.medications.fields.frequency', row.frequency],
    ['health.medications.fields.startOn', dateOf(row.start_on)],
    ['health.medications.fields.endOn', row.end_on ? dateOf(row.end_on) : t('health.medications.noEnd')],
    ['health.fields.notes', row.notes],
  ],
};

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** @param {any} row @param {boolean} done */
async function setDone(row, done) {
  const { error } = await reminders.update(row.id, { done_at: done ? new Date().toISOString() : null });
  if (!error) toast(t(done ? 'health.reminders.doneToast' : 'health.reminders.reopenedToast'), { tone: 'success' });
}

/** @type {import('./records.js').SectionConfig} */
export const remindersConfig = {
  id: 'reminders',
  store: reminders,
  icon: 'bell',
  iconTone: 'gold',
  fields: [
    { name: 'title', kind: 'text', label: 'health.reminders.fields.title', hint: 'health.reminders.fields.titleHint', required: true },
    [
      { name: 'due_on', kind: 'date', label: 'health.reminders.fields.dueOn', required: true },
      { name: 'due_time', kind: 'time', label: 'health.reminders.fields.dueTime' },
    ],
    { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
  ],
  rules: { required: ['title', 'due_on'] },
  toForm: (row, ctx) => ({ title: row?.title || '', due_on: row?.due_on || ctx.today, due_time: hhmm(row?.due_time) || '', notes: row?.notes || '' }),
  toPayload: (v) => ({ title: v.title.trim(), due_on: v.due_on, due_time: orNull(v.due_time), notes: orNull(v.notes) }),
  groups: (rows) => {
    const { open, done } = splitReminders(rows);
    return [
      { key: 'open', title: t('health.reminders.open'), rows: open },
      ...(done.length ? [{ key: 'done', title: t('health.reminders.done'), rows: done }] : []),
    ];
  },
  view: (row, ctx) => ({
    title: row.title,
    subtitle: row.done_at
      ? t('health.reminders.doneOn', { date: formatDateTime(row.done_at, ctx.tz) })
      : formatDue(row.due_on, hhmm(row.due_time)),
    icon: row.done_at ? 'check' : 'bell',
    iconTone: row.done_at ? 'green' : 'gold',
    dim: !!row.done_at,
  }),
  details: (row, ctx) => [
    ['health.reminders.fields.dueOn', dateOf(row.due_on)],
    ['health.reminders.fields.dueTime', row.due_time ? formatClock(hhmm(row.due_time)) : ''],
    ['health.reminders.doneLabel', row.done_at ? formatDateTime(row.done_at, ctx.tz) : ''],
    ['health.fields.notes', row.notes],
  ],
  calendar: (row) =>
    row.done_at ? null : { kind: 'reminder', rowId: row.id, dueOn: row.due_on, dueTime: hhmm(row.due_time), title: row.title, notes: row.notes },
  actions: (row, _ctx, close) =>
    row.done_at
      ? html`<${Button} variant="secondary" icon="refresh" onClick=${() => { close(); setDone(row, false); }}>${t('health.reminders.reopen')}</${Button}>`
      : html`<${Button} icon="check" onClick=${() => { close(); setDone(row, true); }}>${t('health.reminders.markDone')}</${Button}>`,
  sideAction: (row) =>
    html`<${IconButton} icon=${row.done_at ? 'refresh' : 'check'} variant="secondary" class="health-side-btn"
      label=${t(row.done_at ? 'health.reminders.reopenNamed' : 'health.reminders.markDoneNamed', { title: row.title })}
      onClick=${() => setDone(row, !row.done_at)} data-testid="reminder-toggle" />`,
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** @param {import('./records.js').SectionConfig} config */
const screen = (config) =>
  function SectionScreen(/** @type {{ query: Record<string, string> }} */ { query }) {
    const ctx = useHealthCtx();
    return html`<${RecordSection} config=${config} ctx=${ctx} query=${query} />`;
  };

export const VaccinesScreen = screen(vaccinesConfig);
export const DewormingScreen = screen(dewormingConfig);
export const VisitsScreen = screen(visitsConfig);
export const MedicationsScreen = screen(medicationsConfig);
export const RemindersScreen = screen(remindersConfig);

