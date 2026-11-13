import { html } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { Card, ListRow, List, Button, LanguageSwitch, AccountPanel, Skeleton } from '../../lib/ui/index.js';
import { petProfile } from '../../data/stores.js';

// Placeholder: the Profile feature replaces the profile card and adds photos, milestones,
// meal settings and export. Keep LanguageSwitch and AccountPanel on this screen.
export function ProfileScreen() {
  const profile = petProfile.useRow();
  return html`<div class="profile stack">
    <${Card}
      title=${profile?.full_name || profile?.name || t('nav.profile')}
      action=${html`<${EditorOnly}><${Button} variant="ghost" size="sm" icon="edit" onClick=${() => toast(t('common.comingSoon'))} data-testid="edit-profile">${t('common.edit')}</${Button}></${EditorOnly}>`}
    >
      ${profile
        ? html`<${List}>
            <${ListRow} icon="paw" title=${t('profile.breed')} meta=${profile.breed || t('profile.breedDefault')} />
            <${ListRow} icon="star" title=${t('profile.born')} meta=${formatDate(profile.birth_date, 'medium')} />
            ${profile.home_date ? html`<${ListRow} icon="home" title=${t('profile.cameHome')} meta=${formatDate(profile.home_date, 'medium')} />` : null}
          </${List}>`
        : html`<${Skeleton} lines=${3} />`}
    </${Card}>
    <${Card} title=${t('settings.title')}>
      <${LanguageSwitch} />
    </${Card}>
    <${AccountPanel} />
  </div>`;
}
