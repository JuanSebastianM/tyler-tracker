// Generic record section: list + detail sheet + add/edit form + delete, driven by a config.
// Every Health sub-screen (vaccines, deworming, weight, visits, medications, reminders) uses it.
import { html, useState, useEffect, useId } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { useIsEditor, EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { navigate } from '../../lib/router.js';
import {
  Card, List, ListRow, Button, Fab, Sheet, ConfirmDialog, EmptyState, Skeleton, TextInput, NumberInput, DateInput,
  TimeInput, TextArea, Segmented,
} from '../../lib/ui/index.js';
import { photoUrl } from '../../data/photos.js';
import { validate } from './logic.js';
import { CalendarButton, PhotoViewer, DueBadge } from './widgets.js';

/**
 * @typedef {object} FieldDef
 * @property {string} name
 * @property {'text' | 'textarea' | 'date' | 'time' | 'decimal' | 'segmented' | 'photo'} kind
 * @property {string} label            i18n key
 * @property {string} [hint]           i18n key
 * @property {boolean} [required]
 * @property {string} [unit]
 * @property {() => Array<{ value: string, label: string }>} [options]
 * @property {boolean} [wide]          own row even inside a pair
 *
 * @typedef {object} Ctx
 * @property {string} today   'YYYY-MM-DD' in the settings timezone
 * @property {string} tz
 * @property {boolean} isEditor
 * @property {Map<string, any>} dueByRow   row id -> due item (from getDueItems)
 *
 * @typedef {object} SectionConfig
 * @property {string} id               i18n namespace under 'health.' and test id prefix
 * @property {any} store
 * @property {string} icon
 * @property {'gold' | 'green' | 'red' | 'blue' | 'neutral'} [iconTone]
 * @property {Array<FieldDef | FieldDef[]>} fields   arrays render side by side
 * @property {(row: any | null, ctx: Ctx) => Record<string, any>} toForm
 * @property {(values: Record<string, any>) => Record<string, string>} [check]  extra validation (field -> i18n key)
 * @property {{ required?: string[], after?: Array<[string, string]> }} [rules]
 * @property {(values: Record<string, any>, row: any | null) => Record<string, any>} toPayload
 * @property {(values: Record<string, any>, row: any | null) => Promise<{ extra: Record<string, any>, onDone?: (ok: boolean) => void } | null>} [beforeSave]
 *           runs before the write (e.g. photo upload); null aborts and keeps the form open
 * @property {(saved: any, values: Record<string, any>, row: any | null) => void} [afterSave]
 * @property {(row: any) => void} [afterDelete]
 * @property {(row: any, ctx: Ctx) => { title: any, subtitle?: any, meta?: any, icon?: string, iconTone?: any, dim?: boolean }} view
 * @property {(row: any, ctx: Ctx) => Array<[string, any]>} details   [i18n label key, value]
 * @property {(row: any, ctx: Ctx) => any} [extraDetails]  extra content in the detail sheet
 * @property {(row: any, ctx: Ctx) => import('./widgets.js').CalendarItem | null} [calendar]
 * @property {(row: any, ctx: Ctx, close: () => void) => any} [actions]  editor actions in the detail sheet
 * @property {(row: any, ctx: Ctx) => any} [sideAction]  editor control beside a list row
 * @property {(rows: any[], ctx: Ctx) => Array<{ key: string, title: string | null, rows: any[] }>} [groups]
 * @property {(row: any) => string | null} [photo]
 * @property {any} [header]            content above the list (e.g. the growth chart)
 */

/** Map of field name -> FieldDef for a config. @param {SectionConfig} config */
const flatFields = (config) => config.fields.flatMap((f) => (Array.isArray(f) ? f : [f]));

/** "Registrado por Alex" line. @param {{ row: any }} props */
export function LoggedBy({ row }) {
  if (!row?.created_by_name) return null;
  return html`<span class="health-by">${t('common.loggedBy', { name: row.created_by_name })}</span>`;
}

/**
 * @param {{ config: SectionConfig, ctx: Ctx, query?: Record<string, string> }} props
 */
export function RecordSection({ config, ctx, query = {} }) {
  const rows = config.store.useRows();
  const { status, fromCache } = config.store.useState();
  const isEditor = useIsEditor();
  const [detailId, setDetailId] = useState(/** @type {string | null} */ (null));
  const [form, setForm] = useState(/** @type {{ row: any | null, values: Record<string, any> } | null} */ (null));
  const [confirm, setConfirm] = useState(/** @type {any} */ (null));
  const fullCtx = { ...ctx, isEditor };

  const openAdd = () => setForm({ row: null, values: config.toForm(null, fullCtx) });
  const openEdit = (/** @type {any} */ row) => {
    setDetailId(null);
    setForm({ row, values: config.toForm(row, fullCtx) });
  };

  // '#/health/vaccines?add=1' opens the add form (used by the overview's add button).
  useEffect(() => {
    if (query.add === '1' && isEditor) {
      openAdd();
      navigate(`/health/${config.id}`, { replace: true });
    }
  }, [query.add, isEditor]);

  const detail = detailId ? rows.find((/** @type {any} */ r) => r.id === detailId) : null;
  const groups = config.groups ? config.groups(rows, fullCtx) : [{ key: 'all', title: null, rows }];
  const loading = !rows.length && (status === 'idle' || status === 'loading') && !fromCache;

  const onDelete = async () => {
    const row = confirm;
    setConfirm(null);
    setDetailId(null);
    const { error } = await config.store.remove(row.id);
    if (!error) {
      toast(t('common.deleted'), { tone: 'success' });
      config.afterDelete?.(row);
    }
  };

  return html`<div class="health stack" data-testid=${`health-${config.id}`}>
    ${config.header || null}
    ${loading
      ? html`<${Card}><${Skeleton} lines=${3} /></${Card}>`
      : !rows.length
        ? html`<${EmptyState} icon=${config.icon} title=${t(`health.${config.id}.emptyTitle`)}
            body=${t(isEditor ? `health.${config.id}.emptyBody` : 'health.emptyVisitor')}
            action=${isEditor ? html`<${Button} icon="plus" onClick=${openAdd}>${t(`health.${config.id}.add`)}</${Button}>` : null} />`
        : groups.map(
            (g) => html`<${Card} key=${g.key} title=${g.title} class="health-list-card">
              ${g.rows.length
                ? html`<${List}>${g.rows.map((row) => html`<${RecordRow} key=${row.id} config=${config} row=${row} ctx=${fullCtx} onOpen=${() => setDetailId(row.id)} />`)}</${List}>`
                : html`<p class="muted health-group-empty">${t(`health.${config.id}.groupEmpty.${g.key}`)}</p>`}
            </${Card}>`,
          )}

    ${detail
      ? html`<${DetailSheet} config=${config} row=${detail} ctx=${fullCtx} onClose=${() => setDetailId(null)}
          onEdit=${() => openEdit(detail)} onDelete=${() => setConfirm(detail)} />`
      : null}
    ${form
      ? html`<${FormSheet} config=${config} ctx=${fullCtx} row=${form.row} initial=${form.values}
          onClose=${() => setForm(null)} onReopen=${(/** @type {any} */ values) => setForm({ row: form.row, values })} />`
      : null}
    <${ConfirmDialog} open=${!!confirm} danger title=${t(`health.${config.id}.deleteTitle`)} message=${t('health.form.deleteBody')}
      confirmLabel=${t('common.delete')} onConfirm=${onDelete} onCancel=${() => setConfirm(null)} />
    <${EditorOnly}>
      <${Fab} label=${t(`health.${config.id}.add`)} onClick=${openAdd} data-testid="fab-add" />
    </${EditorOnly}>
  </div>`;
}

/** @param {{ config: SectionConfig, row: any, ctx: Ctx, onOpen: () => void }} props */
function RecordRow({ config, row, ctx, onOpen }) {
  const v = config.view(row, ctx);
  const due = ctx.dueByRow.get(row.id);
  const subtitle = html`${v.subtitle ? html`<span class="health-sub">${v.subtitle}</span>` : null}
    ${due ? html`<span class="health-due-line"><${DueBadge} item=${due} today=${ctx.today} /></span>` : null}
    <${LoggedBy} row=${row} />`;
  const side = ctx.isEditor && config.sideAction ? config.sideAction(row, ctx) : null;
  return html`<div class=${`health-row${row._pending ? ' is-pending' : ''}${v.dim ? ' is-dim' : ''}`}>
    <${ListRow} icon=${v.icon || config.icon} iconTone=${v.iconTone || config.iconTone || 'gold'} title=${v.title}
      subtitle=${subtitle} meta=${v.meta} onClick=${onOpen} data-testid=${`${config.id}-row`} />
    ${side}
  </div>`;
}

/**
 * @param {{ config: SectionConfig, row: any, ctx: Ctx, onClose: () => void, onEdit: () => void, onDelete: () => void }} props
 */
function DetailSheet({ config, row, ctx, onClose, onEdit, onDelete }) {
  const [viewer, setViewer] = useState(false);
  const v = config.view(row, ctx);
  const cal = config.calendar ? config.calendar(row, ctx) : null;
  const due = ctx.dueByRow.get(row.id);
  const path = config.photo ? config.photo(row) : null;
  const details = config.details(row, ctx).filter(([, value]) => value != null && value !== '');
  const footer = ctx.isEditor
    ? html`<${Button} variant="ghost" icon="trash" onClick=${onDelete}>${t('common.delete')}</${Button}>
        <${Button} variant="secondary" icon="edit" onClick=${onEdit}>${t('common.edit')}</${Button}>`
    : null;
  return html`<${Sheet} open onClose=${onClose} title=${v.title} footer=${footer} data-testid=${`${config.id}-detail`}>
    <div class="stack health-detail">
      ${due ? html`<div><${DueBadge} item=${due} today=${ctx.today} /></div>` : null}
      <dl class="health-dl">
        ${details.map(([label, value]) => html`<div><dt>${t(label)}</dt><dd>${value}</dd></div>`)}
      </dl>
      ${config.extraDetails ? config.extraDetails(row, ctx) : null}
      ${path
        ? html`<button type="button" class="health-thumb" onClick=${() => setViewer(true)} aria-label=${t('health.photo.open')}>
            <img src=${photoUrl(path)} alt=${t('health.photo.alt', { title: v.title })} loading="lazy" />
          </button>`
        : null}
      ${cal ? html`<div class="button-row"><${CalendarButton} item=${cal} tz=${ctx.tz} /></div>` : null}
      ${ctx.isEditor && config.actions ? html`<div class="button-row">${config.actions(row, ctx, onClose)}</div>` : null}
      <p class="muted health-by-detail"><${LoggedBy} row=${row} /></p>
    </div>
  </${Sheet}>
  ${viewer && path ? html`<${PhotoViewer} src=${photoUrl(path)} alt=${t('health.photo.alt', { title: v.title })} onClose=${() => setViewer(false)} />` : null}`;
}

/**
 * Add/edit form in a sheet. Writes are optimistic: the sheet closes right away; if the write
 * fails (the store rolls back and toasts), the form reopens with what was typed.
 * @param {{ config: SectionConfig, ctx: Ctx, row: any | null, initial: Record<string, any>, onClose: () => void,
 *   onReopen: (values: Record<string, any>) => void }} props
 */
function FormSheet({ config, ctx, row, initial, onClose, onReopen }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [busy, setBusy] = useState(false);
  const formId = 'hf' + useId();
  const set = (/** @type {string} */ name) => (/** @type {any} */ v) => setValues((s) => ({ ...s, [name]: v }));

  const submit = async (/** @type {Event} */ e) => {
    e.preventDefault();
    if (busy) return;
    const errs = { ...validate(values, config.rules || {}), ...(config.check ? config.check(values) : {}) };
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = flatFields(config).find((f) => errs[f.name]);
      if (first) /** @type {HTMLElement | null} */ (document.querySelector(`[data-field="${first.name}"] input, [data-field="${first.name}"] textarea`))?.focus();
      return;
    }
    let extra = {};
    /** @type {((ok: boolean) => void) | undefined} */
    let onDone;
    if (config.beforeSave) {
      setBusy(true);
      const pre = await config.beforeSave(values, row);
      setBusy(false);
      if (!pre) return;
      extra = pre.extra;
      onDone = pre.onDone;
    }
    const payload = { ...config.toPayload(values, row), ...extra };
    onClose();
    const res = row ? await config.store.update(row.id, payload) : await config.store.insert(payload);
    onDone?.(!res.error);
    if (res.error) {
      onReopen(values);
      return;
    }
    toast(t(`health.${config.id}.saved`), { tone: 'success' });
    config.afterSave?.(res.data, values, row);
  };

  const title = t(row ? `health.${config.id}.editTitle` : `health.${config.id}.add`);
  const footer = html`<${Button} block type="submit" form=${formId} loading=${busy} data-testid="form-save">${t(`health.${config.id}.save`)}</${Button}>`;
  /** @param {FieldDef} f */
  const field = (f) => html`<div data-field=${f.name} class=${f.wide ? 'health-wide' : ''}>
    <${FieldInput} f=${f} value=${values[f.name]} error=${errors[f.name] ? t(errors[f.name]) : null} onValue=${set(f.name)} />
  </div>`;
  return html`<${Sheet} open onClose=${onClose} title=${title} footer=${footer} data-testid=${`${config.id}-form`}>
    <form id=${formId} class="stack health-form" onSubmit=${submit} novalidate>
      ${config.fields.map((f) => (Array.isArray(f) ? html`<div class="grid-2">${f.map(field)}</div>` : field(f)))}
      <button type="submit" hidden tabindex="-1"></button>
    </form>
  </${Sheet}>`;
}

/** @param {{ f: FieldDef, value: any, error: string | null, onValue: (v: any) => void }} props */
function FieldInput({ f, value, error, onValue }) {
  const common = { label: t(f.label), hint: f.hint ? t(f.hint) : undefined, error, required: f.required, onValue, value: value ?? '', name: f.name };
  switch (f.kind) {
    case 'textarea':
      return html`<${TextArea} ...${common} rows=${3} />`;
    case 'date':
      return html`<${DateInput} ...${common} />`;
    case 'time':
      return html`<${TimeInput} ...${common} />`;
    case 'decimal':
      return html`<${NumberInput} ...${common} unit=${f.unit} />`;
    case 'segmented':
      return html`<${Segmented} label=${t(f.label)} value=${value} options=${f.options ? f.options() : []} onValue=${onValue} />`;
    case 'photo':
      return html`<${PhotoField} label=${t(f.label)} hint=${f.hint ? t(f.hint) : ''} value=${value} onValue=${onValue} />`;
    default:
      return html`<${TextInput} ...${common} autocomplete="off" />`;
  }
}

/**
 * Optional photo: keep, replace or remove.
 * @param {{ label: string, hint: string, value: { path: string | null, file: File | null, remove: boolean }, onValue: (v: any) => void }} props
 */
function PhotoField({ label, hint, value, onValue }) {
  const id = 'ph' + useId();
  const v = value || { path: null, file: null, remove: false };
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!v.file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(v.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [v.file]);
  const src = preview || (!v.remove && v.path ? photoUrl(v.path) : '');
  return html`<div class="field health-photo-field">
    <span class="field-label">${label}</span>
    ${src ? html`<img class="health-photo-preview" src=${src} alt="" />` : null}
    <div class="button-row">
      <label class="btn btn-secondary btn-sm health-file-btn" for=${id}>${t(src ? 'health.photo.change' : 'health.photo.choose')}</label>
      <input id=${id} class="sr-only" type="file" accept="image/*" data-testid="photo-input"
        onChange=${(/** @type {any} */ e) => {
          const file = e.currentTarget.files?.[0] || null;
          if (file) onValue({ ...v, file, remove: false });
        }} />
      ${src
        ? html`<${Button} variant="ghost" size="sm" onClick=${() => onValue({ ...v, file: null, remove: true })}>${t('health.photo.remove')}</${Button}>`
        : null}
    </div>
    ${hint ? html`<p class="field-hint">${hint}</p>` : null}
  </div>`;
}
