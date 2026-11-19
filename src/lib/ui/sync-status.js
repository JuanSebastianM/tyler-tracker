// Offline and sync status: the header indicator, the sync sheet (queued changes and the "could not
// be saved" list), the small pending mark on entries not yet synced, and offline notes.
//
//   html`<${PendingMark} row=${row} />`        // renders only while row._pending
//   html`<${OfflineNote} text=${t('sync.photoNeedsConnection')} />`   // renders only offline
import { html, useState } from '../../../vendor/preact.js';
import { t, formatDate, formatDateTime, formatNumber } from '../i18n.js';
import { useStore } from '../store.js';
import { useOnline } from '../connectivity.js';
import { openSignIn } from '../auth.js';
import { toast } from '../toast.js';
import { outbox, useSyncSummary, useOutbox, syncSheetStore, openSyncSheet, closeSyncSheet } from '../../data/sync.js';
import { describeValues } from '../../data/outbox-logic.js';
import { getTimezone } from '../../data/stores.js';
import { Icon } from './icons.js';
import { Button } from './button.js';
import { Sheet, ConfirmDialog } from './sheet.js';

/** Changes listed by name in the sheet before "and N more". */
const MAX_LISTED = 12;

/** Small, calm mark on an entry that is not on the server yet. @param {{ row?: any, show?: boolean }} props */
export function PendingMark({ row, show }) {
  if (!(show ?? row?._pending)) return null;
  return html`<span class="pending-mark" title=${t('sync.pendingMarkLabel')} data-testid="pending-mark">
    <${Icon} name="cloud" size=${14} strokeWidth=${2.2} />
    <span aria-hidden="true">${t('sync.pendingMark')}</span>
    <span class="sr-only">${t('sync.pendingMarkLabel')}</span>
  </span>`;
}

/** A note shown only while offline (photo fields, sign-in, days that are not on the phone). @param {{ text: string, testid?: string }} props */
export function OfflineNote({ text, testid = 'offline-note' }) {
  const online = useOnline();
  if (online) return null;
  return html`<p class="offline-note" data-testid=${testid}><${Icon} name="cloud-off" size=${18} />${text}</p>`;
}

/** Header indicator: offline state and changes waiting, hidden when everything is synced. */
export function SyncIndicator() {
  const s = useSyncSummary();
  const pending = s.pending;
  if (s.online && !pending && !s.rejected) return null;
  const tone = s.rejected ? 'red' : s.needsSignIn ? 'warn' : s.online ? 'info' : 'muted';
  const label = s.rejected
    ? t('sync.indicator.rejected', { count: s.rejected })
    : s.needsSignIn
      ? t('sync.indicator.signIn', { count: pending })
      : !s.online
        ? pending
          ? t('sync.indicator.offlinePending', { count: pending })
          : t('sync.indicator.offline')
        : t('sync.indicator.pending', { count: pending });
  const count = s.rejected || pending;
  return html`<button type="button" class=${`sync-pill sync-pill-${tone}`} aria-label=${label} title=${label} onClick=${openSyncSheet}
      data-testid="sync-indicator" data-online=${String(s.online)} data-pending=${String(pending)} data-rejected=${String(s.rejected)} data-syncing=${String(s.syncing)}>
    <${Icon} name=${s.rejected ? 'alert' : s.online ? 'cloud' : 'cloud-off'} size=${20} />
    ${count ? html`<span class="sync-pill-count" aria-hidden="true">${count}</span>` : null}
  </button>`;
}

/** @param {string} table */
const tableLabel = (table) => {
  const k = `sync.tables.${table}`;
  const v = t(k);
  return v === k ? t('sync.tables.generic') : v;
};

/** @param {string} col @param {string} value @param {string} tz */
function formatField(col, value, tz) {
  const k = `sync.fields.${col}`;
  const label = t(k) === k ? col : t(k);
  let shown = value;
  if (/_at$/.test(col) && !Number.isNaN(Date.parse(value))) shown = formatDateTime(value, tz);
  else if (/_on$/.test(col) && /^\d{4}-\d{2}-\d{2}$/.test(value)) shown = formatDate(value, 'medium');
  else if (value === 'true' || value === 'false') shown = t(value === 'true' ? 'sync.yes' : 'sync.no');
  else if (/^-?\d+(\.\d+)?$/.test(value)) shown = formatNumber(Number(value));
  return [label, shown];
}

/** Why the server refused it, in plain words. @param {{ code: string, status: number }} e */
function reasonOf(e) {
  if (e.status === 403 || e.code === '42501') return t('sync.reasons.permission');
  if (e.status === 400 || e.status === 409 || e.status === 422 || /^2[23]/.test(e.code)) return t('sync.reasons.invalid');
  return t('sync.reasons.generic');
}

/** One change the server refused: what it was, why, retry or discard. @param {{ item: import('../../data/outbox-logic.js').Rejected, tz: string, onDiscard: () => void }} props */
function RejectedItem({ item, tz, onDiscard }) {
  const [busy, setBusy] = useState(false);
  const fields = describeValues(item.op).map(([k, v]) => formatField(k, v, tz));
  const retry = async () => {
    setBusy(true);
    await outbox.retryRejected(item.id);
    setBusy(false);
  };
  return html`<li class="sync-rejected-item" data-testid="rejected-item">
    <p class="sync-item-title"><strong>${tableLabel(item.op.table)}</strong> · ${t(`sync.kinds.${item.op.kind}`)}</p>
    <p class="muted sync-item-meta">${t('sync.madeAt', { time: formatDateTime(new Date(item.op.at).toISOString(), tz) })}</p>
    <p class="sync-item-reason">${t('sync.reason', { message: reasonOf(item.error) })}</p>
    ${fields.length
      ? html`<dl class="sync-fields">
          ${fields.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}
        </dl>`
      : null}
    <div class="button-row">
      <${Button} size="sm" variant="secondary" icon="refresh" loading=${busy} onClick=${retry} data-testid="rejected-retry">${t('sync.retry')}</${Button}>
      <${Button} size="sm" variant="ghost" icon="trash" onClick=${onDiscard} data-testid="rejected-discard">${t('sync.discard')}</${Button}>
    </div>
  </li>`;
}

/** The sync sheet, opened from the indicator or the "could not be saved" toast. */
export function SyncSheet() {
  const open = useStore(syncSheetStore);
  const s = useSyncSummary();
  const box = useOutbox();
  const [discarding, setDiscarding] = useState(/** @type {string | null} */ (null));
  if (!open) return null;
  const tz = getTimezone();
  const pending = box.ops;

  /** @type {[string, string, string]} icon, title, body */
  const status = s.needsSignIn
    ? ['lock', t('sync.status.signInTitle'), t('sync.status.signInBody')]
    : !s.online
      ? ['cloud-off', t('sync.status.offlineTitle'), t('sync.status.offlineBody')]
      : s.blocked === 'server' && pending.length
        ? ['alert', t('sync.status.serverTitle'), t('sync.status.serverBody')]
        : pending.length
          ? ['cloud', t('sync.status.pendingTitle', { count: pending.length }), s.syncing ? t('sync.status.syncing') : t('sync.status.pendingBody')]
          : box.rejected.length
            ? ['alert', t('sync.status.reviewTitle'), t('sync.status.reviewBody')]
            : ['check', t('sync.status.syncedTitle'), t('sync.status.syncedBody')];

  const doDiscard = async () => {
    const id = discarding;
    setDiscarding(null);
    if (!id) return;
    await outbox.discardRejected(id);
    toast(t('sync.discarded'));
  };

  return html`<${Sheet} open onClose=${closeSyncSheet} title=${t('sync.title')} data-testid="sync-sheet">
    <div class="stack sync-sheet">
      <div class="sync-status" data-testid="sync-status">
        <span class="sync-status-icon"><${Icon} name=${status[0]} size=${22} /></span>
        <div>
          <p class="sync-status-title">${status[1]}</p>
          <p class="muted">${status[2]}</p>
        </div>
      </div>
      ${s.needsSignIn
        ? html`<${Button} block icon="lock" onClick=${() => { closeSyncSheet(); openSignIn(); }} data-testid="sync-sign-in">${t('auth.signIn')}</${Button}>`
        : null}
      ${pending.length
        ? html`<section aria-labelledby="sync-pending-h">
            <h3 id="sync-pending-h" class="sync-h">${t('sync.pendingList')}</h3>
            <ul class="sync-list" data-testid="pending-list">
              ${pending.slice(0, MAX_LISTED).map(
                (o) => html`<li key=${o.id}><span>${tableLabel(o.table)} · ${t(`sync.kinds.${o.kind}`)}</span><span class="muted">${formatDateTime(new Date(o.at).toISOString(), tz)}</span></li>`,
              )}
              ${pending.length > MAX_LISTED ? html`<li class="muted">${t('sync.more', { count: pending.length - MAX_LISTED })}</li>` : null}
            </ul>
            ${s.online && !s.needsSignIn
              ? html`<${Button} variant="secondary" block icon="refresh" loading=${s.syncing} onClick=${() => outbox.kick()} data-testid="sync-now">${t('sync.syncNow')}</${Button}>`
              : null}
          </section>`
        : null}
      ${box.rejected.length
        ? html`<section aria-labelledby="sync-rejected-h" data-testid="rejected-list">
            <h3 id="sync-rejected-h" class="sync-h sync-h-danger">${t('sync.rejectedTitle')}</h3>
            <p class="muted">${t('sync.rejectedBody')}</p>
            <ul class="sync-rejected">
              ${box.rejected.map((r) => html`<${RejectedItem} key=${r.id} item=${r} tz=${tz} onDiscard=${() => setDiscarding(r.id)} />`)}
            </ul>
          </section>`
        : null}
      <p class="muted sync-limits">${t('sync.offlineLimits')}</p>
    </div>
  </${Sheet}>
  <${ConfirmDialog} open=${!!discarding} danger title=${t('sync.discardTitle')} message=${t('sync.discardBody')}
      confirmLabel=${t('sync.discard')} onConfirm=${doDiscard} onCancel=${() => setDiscarding(null)} />`;
}
