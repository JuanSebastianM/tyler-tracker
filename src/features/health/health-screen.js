import { html } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { EmptyState, Fab } from '../../lib/ui/index.js';

// Placeholder: the Health feature replaces this screen.
export function HealthScreen() {
  return html`<div class="health stack">
    <${EmptyState} icon="heart" title=${t('health.emptyTitle')} body=${t('health.emptyBody')} />
    <${EditorOnly}>
      <${Fab} label=${t('health.add')} onClick=${() => toast(t('common.comingSoon'))} data-testid="fab-add" />
    </${EditorOnly}>
  </div>`;
}
