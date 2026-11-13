// Reference page for the UI kit at '#/dev/ui' (not in the tab bar). Feature agents: look here
// before building a new component.
import { html, useState } from '../../../vendor/preact.js';
import { t } from '../i18n.js';
import { toast } from '../toast.js';
import {
  Button, IconButton, Card, ListRow, List, TextInput, NumberInput, DateInput, TimeInput, TextArea,
  Segmented, Switch, Select, Sheet, ConfirmDialog, EmptyState, Badge, Spinner, Skeleton, Icon, ICON_NAMES,
} from './index.js';
import { InstallHint } from './install-hint.js';

export function KitchenSink() {
  const [name, setName] = useState('');
  const [weight, setWeight] = useState('4,8');
  const [date, setDate] = useState('2026-11-13');
  const [time, setTime] = useState('07:30');
  const [appetite, setAppetite] = useState('all');
  const [place, setPlace] = useState('outside');
  const [remind, setRemind] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return html`<div class="stack kitchen">
    <${Card} title=${t('kitchen.buttons')}>
      <div class="button-row wrap">
        <${Button} icon="bowl">${t('kitchen.primary')}</${Button}>
        <${Button} variant="secondary">${t('kitchen.secondary')}</${Button}>
        <${Button} variant="ghost">${t('kitchen.ghost')}</${Button}>
        <${Button} variant="danger" icon="trash" size="sm">${t('kitchen.danger')}</${Button}>
        <${Button} loading>${t('kitchen.loading')}</${Button}>
        <${IconButton} icon="edit" label=${t('common.edit')} />
        <${IconButton} icon="plus" label=${t('common.add')} variant="primary" />
      </div>
    </${Card}>

    <${Card} title=${t('kitchen.inputs')}>
      <div class="stack">
        <${TextInput} label=${t('kitchen.name')} hint=${t('kitchen.nameHint')} value=${name} onValue=${setName} />
        <div class="grid-2">
          <${NumberInput} label=${t('kitchen.weight')} unit="kg" value=${weight} onValue=${setWeight} />
          <${Select} label=${t('kitchen.place')} value=${place} onValue=${setPlace}
            options=${[{ value: 'inside', label: t('kitchen.inside') }, { value: 'outside', label: t('kitchen.outside') }]} />
        </div>
        <div class="grid-2">
          <${DateInput} label=${t('kitchen.date')} value=${date} onValue=${setDate} />
          <${TimeInput} label=${t('kitchen.time')} value=${time} onValue=${setTime} />
        </div>
        <${Segmented} label=${t('kitchen.appetite')} value=${appetite} onValue=${setAppetite}
          options=${[
            { value: 'all', label: t('kitchen.appetiteAll') },
            { value: 'some', label: t('kitchen.appetiteSome') },
            { value: 'none', label: t('kitchen.appetiteNone') },
          ]} />
        <${TextArea} label=${t('kitchen.notes')} error=${t('errors.required')} rows=${2} />
        <${Switch} label=${t('kitchen.reminder')} checked=${remind} onValue=${setRemind} />
      </div>
    </${Card}>

    <${Card} title=${t('kitchen.rows')}>
      <${List}>
        <${ListRow} icon="bowl" iconTone="gold" title=${t('kitchen.rowTitle')} subtitle=${t('kitchen.rowSubtitle')} meta="7:30" />
        <${ListRow} icon="drop" iconTone="blue" title=${t('due.kind.reminder')} subtitle=${t('common.loggedBy', { name: 'Alex' })} onClick=${() => {}} />
        <${ListRow} icon="syringe" iconTone="green" title=${t('due.kind.vaccination')} href="#/health" trailing=${html`<${Badge} tone="red">${t('due.status.overdue')}</${Badge}>`} />
      </${List}>
    </${Card}>

    <${Card} title=${t('kitchen.badges')}>
      <div class="button-row wrap">
        <${Badge}>${t('due.status.upcoming')}</${Badge}>
        <${Badge} tone="warn" icon="clock">${t('due.status.soon')}</${Badge}>
        <${Badge} tone="green" icon="check">${t('common.saved')}</${Badge}>
        <${Badge} tone="red" icon="alert">${t('due.status.overdue')}</${Badge}>
        <${Badge} tone="blue">${t('due.status.today')}</${Badge}>
        <${Spinner} label=${t('common.loading')} />
      </div>
      <${Skeleton} lines=${2} />
    </${Card}>

    <${Card} title=${t('kitchen.empty')} tone="quiet">
      <${EmptyState} icon="paw" title=${t('kitchen.emptyTitle')} body=${t('kitchen.emptyBody')} />
    </${Card}>

    <div class="button-row wrap">
      <${Button} variant="secondary" onClick=${() => setSheet(true)}>${t('kitchen.sheet')}</${Button}>
      <${Button} variant="secondary" onClick=${() => setConfirm(true)}>${t('kitchen.confirm')}</${Button}>
      <${Button} variant="secondary" onClick=${() => toast(t('common.saved'), { tone: 'success' })}>${t('kitchen.toast')}</${Button}>
      <${Button} variant="secondary" onClick=${() => toast(t('errors.saveFailed'), { tone: 'error' })}>${t('kitchen.toastError')}</${Button}>
    </div>

    <${InstallHint} force />

    <div class="icon-grid" aria-hidden="true">${ICON_NAMES.map((n) => html`<span title=${n}><${Icon} name=${n} /></span>`)}</div>

    <${Sheet} open=${sheet} onClose=${() => setSheet(false)} title=${t('kitchen.rowTitle')}
      footer=${html`<${Button} block onClick=${() => setSheet(false)}>${t('common.save')}</${Button}>`}>
      <div class="stack">
        <${TimeInput} label=${t('kitchen.time')} value=${time} onValue=${setTime} />
        <${Segmented} label=${t('kitchen.appetite')} value=${appetite} onValue=${setAppetite}
          options=${[{ value: 'all', label: t('kitchen.appetiteAll') }, { value: 'some', label: t('kitchen.appetiteSome') }, { value: 'none', label: t('kitchen.appetiteNone') }]} />
      </div>
    </${Sheet}>
    <${ConfirmDialog} open=${confirm} danger title=${t('kitchen.confirmTitle')} message=${t('kitchen.confirmBody')}
      confirmLabel=${t('common.delete')} onConfirm=${() => setConfirm(false)} onCancel=${() => setConfirm(false)} />
  </div>`;
}
