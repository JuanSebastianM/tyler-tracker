import { html } from '../../../vendor/preact.js';
import { useStore } from '../store.js';
import { toastStore, dismissToast } from '../toast.js';
import { Icon } from './icons.js';
import { t } from '../i18n.js';

const ICONS = { info: 'info', success: 'check', error: 'alert' };

/** Renders the global toasts. Mounted once by the shell. */
export function Toaster() {
  const toasts = useStore(toastStore);
  return html`<div class="toaster" aria-live="polite">
    ${toasts.map(
      (x) => html`<div class=${`toast toast-${x.tone}`} role=${x.tone === 'error' ? 'alert' : 'status'} key=${x.id}>
        <${Icon} name=${ICONS[x.tone]} size=${20} />
        <span class="toast-msg">${x.message}</span>
        ${x.action
          ? html`<button type="button" class="toast-action" onClick=${() => { dismissToast(x.id); x.action?.onClick(); }}>${x.action.label}</button>`
          : html`<button type="button" class="toast-close" aria-label=${t('common.dismiss')} onClick=${() => dismissToast(x.id)}><${Icon} name="close" size=${18} /></button>`}
      </div>`,
    )}
  </div>`;
}
