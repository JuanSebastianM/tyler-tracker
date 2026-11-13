// Conversation list: '#/assistant/threads'. Shared by both editors; rename and delete.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { href, navigate } from '../../lib/router.js';
import { toast } from '../../lib/toast.js';
import { localDateOf } from '../../lib/dates.js';
import { Button, ConfirmDialog, EmptyState, IconButton, ListRow, Sheet, Skeleton, TextInput } from '../../lib/ui/index.js';
import { chatThreads, useTimezone } from '../../data/stores.js';
import { forgetThread } from './session.js';
import { EditorGate } from './parts.js';

export function ThreadsScreen() {
  return html`<${EditorGate}><${Threads} /></${EditorGate}>`;
}

function Threads() {
  const rows = chatThreads.useRows();
  const state = chatThreads.useState();
  const tz = useTimezone();
  const [selected, setSelected] = useState(/** @type {any} */ (null));
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    chatThreads.load();
  }, []);

  const openOptions = (/** @type {any} */ row) => {
    setSelected(row);
    setName(row.title || '');
  };
  const close = () => {
    setSelected(null);
    setConfirming(false);
  };
  const rename = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const title = name.trim();
    if (!title || !selected) return;
    const { error } = await chatThreads.update(selected.id, { title: title.slice(0, 120) });
    if (!error) {
      toast(t('assistant.threads.renamed'), { tone: 'success' });
      close();
    }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    const id = selected.id;
    const { error } = await chatThreads.remove(id);
    setBusy(false);
    if (!error) {
      forgetThread(id);
      toast(t('assistant.threads.deleted'), { tone: 'success' });
    }
    close();
  };

  return html`<div class="assistant threads stack" data-testid="assistant-threads-screen">
    <${Button} icon="plus" block onClick=${() => navigate('/assistant')}>${t('assistant.actions.newThread')}</${Button}>
    ${state.status === 'loading' && !rows.length
      ? html`<${Skeleton} lines=${4} />`
      : !rows.length
        ? html`<${EmptyState} icon="sparkle" title=${t('assistant.threads.empty')} body=${t('assistant.threads.emptyBody')} />`
        : html`<ul class="thread-list">
            ${rows.map((r) => {
              const title = r.title || t('assistant.threads.untitled');
              return html`<li class="thread-item" key=${r.id}>
                <${ListRow}
                  icon="sparkle"
                  iconTone="gold"
                  title=${title}
                  subtitle=${t('assistant.threads.subtitle', { name: r.created_by_name || '—', date: formatDate(localDateOf(r.updated_at || r.created_at, tz), 'medium') })}
                  href=${href(`/assistant?t=${r.id}`)}
                  data-testid="thread-row"
                />
                <${IconButton} icon="more" label=${t('assistant.threads.options', { title })} onClick=${() => openOptions(r)} data-testid="thread-options" />
              </li>`;
            })}
          </ul>`}

    <${Sheet} open=${!!selected && !confirming} onClose=${close} title=${t('assistant.threads.optionsTitle')}>
      <form class="stack" onSubmit=${rename}>
        <${TextInput} label=${t('assistant.threads.rename')} value=${name} onValue=${setName} maxlength="120" required />
        <${Button} type="submit" block icon="check" disabled=${!name.trim()}>${t('assistant.threads.saveName')}</${Button}>
        <${Button} variant="danger" block icon="trash" onClick=${() => setConfirming(true)} data-testid="thread-delete">${t('assistant.threads.delete')}</${Button}>
      </form>
    </${Sheet}>
    <${ConfirmDialog}
      open=${confirming}
      danger
      busy=${busy}
      title=${t('assistant.threads.confirmTitle')}
      message=${t('assistant.threads.confirmBody')}
      confirmLabel=${t('assistant.threads.delete')}
      onConfirm=${remove}
      onCancel=${close}
    />
  </div>`;
}
