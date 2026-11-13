import { html } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { EmptyState, Fab } from '../../lib/ui/index.js';

// Placeholder: the Log feature replaces this screen.
export function LogScreen() {
  return html`<div class="log stack">
    <${EmptyState} icon="journal" title=${t('log.emptyTitle')} body=${t('log.emptyBody')} />
    <${EditorOnly}>
      <${Fab} label=${t('log.add')} onClick=${() => toast(t('common.comingSoon'))} data-testid="fab-add" />
    </${EditorOnly}>
  </div>`;
}
