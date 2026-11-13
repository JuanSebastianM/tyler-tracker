// Shared UI for log entries (used by Log and Today): labels, the add/edit sheet and delete confirm.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t, formatClock } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import {
  Sheet, ConfirmDialog, Button, DateInput, TimeInput, NumberInput, TextInput, TextArea, Select, Segmented, Switch,
} from '../../lib/ui/index.js';
import { feedings, routineEvents, settings } from '../../data/stores.js';
import { DURATION_KINDS, ENTRY_KINDS, minutesBetween, splitMinutes } from './log-logic.js';
import { localDateOf, localTimeOf } from '../../lib/dates.js';
import { emptyForm, formFromRow, formToValues } from './entry-form.js';

/** @typedef {import('./log-logic.js').EntryKind} EntryKind */

/** "1 h 30 min", "45 min". @param {number} minutes */
export function formatMinutes(minutes) {
  const { h, m } = splitMinutes(minutes);
  if (!h) return t('log.duration.min', { m });
  if (!m) return t('log.duration.h', { h });
  return t('log.duration.hm', { h, m });
}

/** Store for a table. @param {'feedings' | 'routine_events'} table */
export const storeFor = (table) => (table === 'feedings' ? feedings : routineEvents);

/**
 * Title for an entry: "Comida 2", "Pipí afuera", "Popó adentro", "Sueño".
 * @param {EntryKind} kind @param {any} row
 */
export function entryTitle(kind, row) {
  if (kind === 'meal') return row.meal_slot ? t('log.mealN', { n: row.meal_slot }) : t('log.extraMeal');
  if (kind === 'pee' || kind === 'poop') {
    if (!row.location) return t(`log.kind.${kind}`);
    return t(`log.potty.${kind}.${row.location}`);
  }
  return t(`log.kind.${kind}`);
}

/**
 * Detail fragments for an entry (amount, appetite, duration, accident...). Free text as typed.
 * @param {EntryKind} kind @param {any} row @param {string} now
 * @returns {string[]}
 */
export function entryDetails(kind, row, now) {
  /** @type {string[]} */
  const out = [];
  if (kind === 'meal') {
    if (row.amount_g != null) out.push(t('log.grams', { g: row.amount_g }));
    if (row.amount_note) out.push(row.amount_note);
    if (row.appetite) out.push(t(`log.appetite.${row.appetite}`));
  } else if (DURATION_KINDS.includes(kind)) {
    if (row.ended_at) out.push(formatMinutes(minutesBetween(row.started_at, row.ended_at)));
    else out.push(t('log.ongoingFor', { duration: formatMinutes(minutesBetween(row.started_at, now)) }));
  }
  if (row.notes) out.push(row.notes);
  return out;
}

/**
 * @typedef {object} SheetTarget
 * @property {EntryKind} kind
 * @property {any} [row]        existing row to edit
 * @property {'feedings' | 'routine_events'} [table]
 * @property {Partial<{ date: string, time: string, slot: number | null }>} [defaults]
 * @property {boolean} [chooseKind]  let the user change the kind (new entries)
 */

/**
 * Add/edit sheet for any entry kind. Closes on save; delete asks for confirmation.
 * @param {{ target: SheetTarget | null, onClose: () => void, tz: string, today: string, now: () => string,
 *   onSaved?: (row: any, table: string, isNew: boolean) => void }} props
 */
export function EntrySheet({ target, onClose, tz, now, onSaved }) {
  const conf = settings.useRow();
  const [form, setForm] = useState(/** @type {import('./entry-form.js').EntryForm | null} */ (null));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const slots = conf?.meal_slots || [];

  useEffect(() => {
    setErrors({});
    setConfirm(false);
    if (!target) return setForm(null);
    if (target.row) return setForm(formFromRow(target.kind, target.row, tz));
    const d = target.defaults || {};
    const nowIso = now();
    const slot = d.slot != null ? slots.find((s) => s.slot === d.slot) : null;
    setForm(
      emptyForm(target.kind, {
        date: d.date || localDateOf(nowIso, tz),
        time: d.time || localTimeOf(nowIso, tz),
        slot: d.slot ?? null,
        grams: slot?.grams ?? null,
        amountNote: target.kind === 'meal' ? conf?.meal_amount_note || null : null,
      }),
    );
  }, [target]);

  if (!target || !form) return null;
  const isNew = !target.row;
  /** @param {Partial<import('./entry-form.js').EntryForm>} patch */
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const kind = form.kind;

  const save = async (/** @type {Event} */ e) => {
    e?.preventDefault?.();
    const { errors: errs, table, values } = formToValues(form, { tz, now: now() });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const store = storeFor(table);
    const res = isNew ? await store.insert(values) : await store.update(target.row.id, values);
    setBusy(false);
    if (res.error) return; // the store already toasted and rolled back
    toast(t(isNew ? 'log.added' : 'common.saved'), { tone: 'success' });
    onSaved?.(res.data, table, isNew);
    onClose();
  };

  const remove = async () => {
    const table = target.table || (kind === 'meal' ? 'feedings' : 'routine_events');
    const row = target.row;
    setBusy(true);
    const res = await storeFor(table).remove(row.id);
    setBusy(false);
    setConfirm(false);
    if (res.error) return;
    onClose();
    toast(t('common.deleted'), {
      tone: 'success',
      action: { label: t('log.undo'), onClick: () => storeFor(table).insert(stripAudit(row)) },
    });
  };

  const err = (/** @type {string} */ f) => (errors[f] ? t(`log.errors.${errors[f]}`) : null);
  const title = isNew ? (kind === 'meal' && !form.slot ? t('log.sheet.addExtraMeal') : t('log.sheet.add')) : t('log.sheet.edit');

  const footer = html`
    ${!isNew
      ? html`<${Button} variant="ghost" icon="trash" onClick=${() => setConfirm(true)} data-testid="entry-delete">${t('common.delete')}</${Button}>`
      : null}
    <${Button} type="submit" form="entry-form" loading=${busy} data-testid="entry-save">${t('log.sheet.save')}</${Button}>`;

  return html`<${Sheet} open=${true} onClose=${onClose} title=${title} footer=${footer} class="sheet entry-sheet" initialFocus=".sheet-body select, .sheet-body .segment">
    <form id="entry-form" class="stack log-form" onSubmit=${save} novalidate>
      ${isNew && target.chooseKind
        ? html`<${Select}
            label=${t('log.sheet.kind')}
            value=${kind}
            onValue=${(/** @type {any} */ v) => set({ kind: v, appetite: v === 'meal' ? 'all' : '', amountNote: v === 'meal' ? conf?.meal_amount_note || '' : '' })}
            options=${ENTRY_KINDS.map((k) => ({ value: k, label: t(`log.kind.${k}`) }))}
          />`
        : null}
      <div class="grid-2">
        <${DateInput} label=${t('log.sheet.date')} value=${form.date} onValue=${(v) => set({ date: v })} error=${err('date')} />
        <${TimeInput} label=${DURATION_KINDS.includes(kind) ? t('log.sheet.startTime') : t('log.sheet.time')} value=${form.time} onValue=${(v) => set({ time: v })} error=${err('time')} />
      </div>
      ${kind === 'meal'
        ? html`
            <${Select}
              label=${t('log.sheet.slot')}
              value=${form.slot}
              onValue=${(v) => set({ slot: v })}
              options=${[
                ...slots.map((s) => ({ value: String(s.slot), label: t('log.slotOption', { n: s.slot, time: formatClock(s.time) }) })),
                ...(form.slot && !slots.some((s) => String(s.slot) === form.slot) ? [{ value: form.slot, label: t('log.mealN', { n: form.slot }) }] : []),
                { value: '', label: t('log.extraMeal') },
              ]}
            />
            <${Segmented}
              label=${t('log.sheet.appetite')}
              size="sm"
              value=${form.appetite}
              onValue=${(v) => set({ appetite: v })}
              options=${['all', 'most', 'some', 'none'].map((a) => ({ value: a, label: t(`log.appetiteShort.${a}`) }))}
            />
            <div class="grid-2">
              <${NumberInput} label=${t('log.sheet.amountG')} unit="g" value=${form.amountG} onValue=${(v) => set({ amountG: v })} error=${err('amountG')} />
              <${TextInput} label=${t('log.sheet.amountNote')} value=${form.amountNote} onValue=${(v) => set({ amountNote: v })} placeholder=${t('log.sheet.amountNotePlaceholder')} />
            </div>`
        : null}
      ${kind === 'pee' || kind === 'poop'
        ? html`
            <${Segmented}
              label=${t('log.sheet.where')}
              value=${form.location}
              onValue=${(v) => set({ location: /** @type {any} */ (v), accident: v === 'inside' })}
              options=${[
                { value: 'outside', label: t('log.where.outside') },
                { value: 'inside', label: t('log.where.inside') },
              ]}
            />
            ${form.location === 'inside'
              ? html`<${Switch} label=${t('log.sheet.accident')} hint=${t('log.sheet.accidentHint')} checked=${form.accident} onValue=${(v) => set({ accident: v })} />`
              : null}`
        : null}
      ${DURATION_KINDS.includes(kind)
        ? html`
            <${Switch} label=${t('log.sheet.ongoing')} checked=${form.ongoing} onValue=${(v) => set({ ongoing: v })} />
            ${!form.ongoing
              ? html`<${NumberInput} label=${t('log.sheet.duration')} unit="min" inputmode="numeric" value=${form.duration} onValue=${(v) => set({ duration: v })} error=${err('duration')} />`
              : null}`
        : null}
      <${TextArea} label=${t('log.sheet.notes')} rows=${2} value=${form.notes} onValue=${(v) => set({ notes: v })} />
    </form>
  </${Sheet}>
  <${ConfirmDialog}
      open=${confirm}
      danger
      busy=${busy}
      title=${t('log.confirmDelete.title')}
      message=${t('log.confirmDelete.body', { what: entryTitle(kind, target.row || {}) })}
      confirmLabel=${t('log.confirmDelete.confirm')}
      onConfirm=${remove}
      onCancel=${() => setConfirm(false)}
    />`;
}

/** Copy of a row without audit columns and client flags (to re-insert on undo). @param {any} row */
export function stripAudit(row) {
  const { created_at, updated_at, created_by, created_by_name, _pending, ...rest } = row;
  return rest;
}
