// Meal schedule (settings.meal_slots + meal_amount_note): summary for everyone, editor sheet to
// add, remove, reorder and time the slots.
import { html, useState } from '../../../vendor/preact.js';
import { t, formatClock, formatNumber } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { List, ListRow, Button, IconButton, Sheet, TimeInput, NumberInput, TextArea, Icon } from '../../lib/ui/index.js';
import { settings } from '../../data/stores.js';
import { slotsToDraft, addSlot, removeSlot, moveSlot, sortSlotsByTime, isChronological, validateSlots, MAX_MEAL_SLOTS } from './logic.js';

/** @typedef {import('../../data/types').Settings} Settings */

export function MealSchedule() {
  /** @type {Settings | null} */
  const row = settings.useRow();
  const [editing, setEditing] = useState(false);
  const slots = [...(row?.meal_slots || [])].sort((a, b) => a.slot - b.slot);
  return html`<div class="meal-schedule" data-testid="meal-schedule">
    <h3 class="profile-subhead">${t('profile.meals.title')}</h3>
    ${slots.length
      ? html`<${List}>
          ${slots.map(
            (s, i) => html`<${ListRow}
              icon="bowl"
              iconTone="gold"
              title=${t('profile.meals.slot', { n: i + 1 })}
              meta=${html`<span class="meal-meta"><strong>${formatClock(s.time)}</strong>${s.grams != null ? html`<span>${t('profile.meals.grams', { grams: formatNumber(s.grams) })}</span>` : null}</span>`}
            />`,
          )}
        </${List}>`
      : html`<p class="muted">${t('profile.meals.empty')}</p>`}
    ${row?.meal_amount_note ? html`<p class="meal-note pre-line"><${Icon} name="info" size=${16} /><span>${row.meal_amount_note}</span></p>` : null}
    <${EditorOnly}>
      <div class="button-row">
        <${Button} variant="secondary" size="sm" icon="clock" onClick=${() => setEditing(true)} data-testid="edit-meals">${t('profile.meals.edit')}</${Button}>
      </div>
    </${EditorOnly}>
    ${editing && row ? html`<${MealSheet} row=${row} onClose=${() => setEditing(false)} />` : null}
  </div>`;
}

/** @param {{ row: Settings, onClose: () => void }} props */
function MealSheet({ row, onClose }) {
  const [draft, setDraft] = useState(() => slotsToDraft(row.meal_slots || []));
  const [note, setNote] = useState(row.meal_amount_note || '');
  const [result, setResult] = useState(/** @type {ReturnType<typeof validateSlots> | null} */ (null));
  const [busy, setBusy] = useState(false);
  const rowErrors = result && 'rows' in result ? result.rows : [];
  const formError = result && 'form' in result ? result.form : null;

  /** @param {number} i @param {'time' | 'grams'} k @param {string} v */
  const setField = (i, k, v) => setDraft((d) => d.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  /** @param {(d: any[]) => any[]} fn */
  const change = (fn) => {
    setResult(null);
    setDraft(fn);
  };

  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    const r = validateSlots(draft);
    setResult(r);
    if (!r.ok) return;
    setBusy(true);
    const res = await settings.update(1, { meal_slots: r.slots, meal_amount_note: note.trim() || null });
    setBusy(false);
    if (res.error) return;
    toast(t('profile.meals.saved'), { tone: 'success' });
    onClose();
  };

  return html`<${Sheet}
    open=${true}
    onClose=${onClose}
    title=${t('profile.meals.editTitle')}
    initialFocus=".meal-edit-row input"
    footer=${html`<${Button} variant="secondary" onClick=${onClose}>${t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-meals">${t('profile.meals.save')}</${Button}>`}
  >
    <form class="stack meal-form" onSubmit=${save} novalidate>
      <p class="muted">${t('profile.meals.intro')}</p>
      <ol class="meal-edit-list">
        ${draft.map(
          (s, i) => html`<li class="meal-edit-row" key=${i} data-testid="meal-row">
            <div class="meal-edit-head">
              <span class="meal-edit-num">${t('profile.meals.slot', { n: i + 1 })}</span>
              <span class="meal-edit-actions">
                <${IconButton} icon="chevron-down" class="meal-up" label=${t('profile.meals.moveUp', { n: i + 1 })} disabled=${i === 0} onClick=${() => change((d) => moveSlot(d, i, -1))} />
                <${IconButton} icon="chevron-down" label=${t('profile.meals.moveDown', { n: i + 1 })} disabled=${i === draft.length - 1} onClick=${() => change((d) => moveSlot(d, i, 1))} />
                <${IconButton} icon="trash" label=${t('profile.meals.remove', { n: i + 1 })} onClick=${() => change((d) => removeSlot(d, i))} />
              </span>
            </div>
            <div class="grid-2">
              <${TimeInput}
                label=${t('profile.meals.time')}
                value=${s.time}
                onValue=${(/** @type {string} */ v) => setField(i, 'time', v)}
                error=${rowErrors[i]?.time ? t(`profile.meals.errors.${rowErrors[i].time}`) : null}
              />
              <${NumberInput}
                unit="g"
                label=${t('profile.meals.gramsLabel')}
                value=${s.grams}
                onValue=${(/** @type {string} */ v) => setField(i, 'grams', v)}
                placeholder=${t('common.optional')}
                error=${rowErrors[i]?.grams ? t(`profile.meals.errors.${rowErrors[i].grams}`) : null}
              />
            </div>
          </li>`,
        )}
      </ol>
      ${formError ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${18} />${t(`profile.meals.errors.${formError}`)}</p>` : null}
      <div class="button-row wrap">
        <${Button} variant="secondary" size="sm" icon="plus" disabled=${draft.length >= MAX_MEAL_SLOTS} onClick=${() => change(addSlot)} data-testid="add-meal">${t('profile.meals.add')}</${Button}>
        ${!isChronological(draft)
          ? html`<${Button} variant="ghost" size="sm" icon="clock" onClick=${() => change(sortSlotsByTime)}>${t('profile.meals.sort')}</${Button}>`
          : null}
      </div>
      ${draft.length >= MAX_MEAL_SLOTS ? html`<p class="field-hint">${t('profile.meals.max', { count: MAX_MEAL_SLOTS })}</p>` : null}
      <${TextArea} label=${t('profile.meals.note')} hint=${t('profile.meals.noteHint')} value=${note} onValue=${setNote} rows=${2} />
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}
