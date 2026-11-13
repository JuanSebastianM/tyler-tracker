// Private details (editors only): microchip, vet contact, insurance, notes. Rendered only inside
// <EditorOnly>; the petPrivate store never loads for visitors.
import { html, useState } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { Card, List, ListRow, Button, Sheet, TextInput, TextArea, Badge, EmptyState } from '../../lib/ui/index.js';
import { petPrivate } from '../../data/stores.js';
import { telHref } from './logic.js';

/** @typedef {import('../../data/types').PetPrivate} PetPrivate */

const FIELDS = /** @type {const} */ (['microchip', 'vet_name', 'vet_phone', 'vet_address', 'insurance', 'notes']);

export function PrivateCard() {
  /** @type {PetPrivate | null} */
  const row = petPrivate.useRow();
  const { status } = petPrivate.useState();
  const [editing, setEditing] = useState(false);
  const hasAny = row && FIELDS.some((f) => row[f]);
  const phone = telHref(row?.vet_phone);

  return html`<${Card}
    title=${t('profile.private.title')}
    action=${html`<${Badge} tone="blue" icon="lock">${t('profile.private.badge')}</${Badge}>`}
    data-testid="private-card"
  >
    <p class="muted profile-note">${t('profile.private.intro')}</p>
    ${hasAny && row
      ? html`<${List}>
          ${row.microchip ? html`<${ListRow} icon="key" title=${t('profile.private.microchip')} subtitle=${html`<span class="mono">${row.microchip}</span>`} />` : null}
          ${row.vet_name ? html`<${ListRow} icon="stethoscope" title=${t('profile.private.vetName')} subtitle=${row.vet_name} />` : null}
          ${row.vet_phone
            ? phone
              ? html`<${ListRow} icon="bell" iconTone="green" title=${t('profile.private.vetPhone')} subtitle=${row.vet_phone} href=${phone} aria-label=${t('profile.private.call', { phone: row.vet_phone })} data-testid="vet-phone" />`
              : html`<${ListRow} icon="bell" title=${t('profile.private.vetPhone')} subtitle=${row.vet_phone} />`
            : null}
          ${row.vet_address ? html`<${ListRow} icon="home" title=${t('profile.private.vetAddress')} subtitle=${row.vet_address} />` : null}
          ${row.insurance ? html`<${ListRow} icon="heart" title=${t('profile.private.insurance')} subtitle=${row.insurance} />` : null}
          ${row.notes ? html`<${ListRow} icon="journal" title=${t('profile.private.notes')} subtitle=${html`<span class="pre-line">${row.notes}</span>`} />` : null}
        </${List}>`
      : status === 'loading' || status === 'idle'
        ? html`<p class="muted">${t('common.loading')}</p>`
        : html`<${EmptyState} icon="lock" title=${t('profile.private.emptyTitle')} body=${t('profile.private.emptyBody')} />`}
    <div class="button-row">
      <${Button} variant="secondary" size="sm" icon="edit" onClick=${() => setEditing(true)} data-testid="edit-private">${t('profile.private.edit')}</${Button}>
    </div>
    ${editing ? html`<${PrivateForm} row=${row} onClose=${() => setEditing(false)} />` : null}
  </${Card}>`;
}

/** @param {{ row: PetPrivate | null, onClose: () => void }} props */
function PrivateForm({ row, onClose }) {
  const [form, setForm] = useState(() => Object.fromEntries(FIELDS.map((f) => [f, row?.[f] || ''])));
  const [busy, setBusy] = useState(false);
  /** @param {string} k */
  const set = (k) => (/** @type {string} */ v) => setForm((f) => ({ ...f, [k]: v }));
  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    /** @type {Record<string, any>} */
    const values = { id: 1 };
    for (const f of FIELDS) values[f] = String(form[f] || '').trim() || null;
    const res = await petPrivate.upsert(values);
    setBusy(false);
    if (res.error) return;
    toast(t('profile.private.saved'), { tone: 'success' });
    onClose();
  };
  return html`<${Sheet}
    open=${true}
    onClose=${onClose}
    title=${t('profile.private.title')}
    footer=${html`<${Button} variant="secondary" onClick=${onClose}>${t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-private">${t('profile.private.save')}</${Button}>`}
  >
    <form class="stack" onSubmit=${save} novalidate>
      <${TextInput} label=${t('profile.private.microchip')} value=${form.microchip} onValue=${set('microchip')} inputmode="numeric" autocomplete="off" />
      <${TextInput} label=${t('profile.private.vetName')} value=${form.vet_name} onValue=${set('vet_name')} autocomplete="off" />
      <${TextInput} label=${t('profile.private.vetPhone')} type="tel" value=${form.vet_phone} onValue=${set('vet_phone')} autocomplete="off" />
      <${TextInput} label=${t('profile.private.vetAddress')} value=${form.vet_address} onValue=${set('vet_address')} autocomplete="off" />
      <${TextInput} label=${t('profile.private.insurance')} value=${form.insurance} onValue=${set('insurance')} autocomplete="off" />
      <${TextArea} label=${t('profile.private.notes')} value=${form.notes} onValue=${set('notes')} rows=${3} />
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}
