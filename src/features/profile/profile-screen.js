// #/profile (tab "Tyler"): profile, private details, memories, settings, export, account, about.
import { html } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { EditorOnly } from '../../lib/auth.js';
import { Card, List, ListRow, LanguageSwitch, AccountPanel } from '../../lib/ui/index.js';
import { useTimezone } from '../../data/stores.js';
import { ProfileCard } from './profile-card.js';
import { PrivateCard } from './private-card.js';
import { MemoriesCard } from './memories-screen.js';
import { MealSchedule } from './meals.js';
import { ExportCard } from './export-card.js';
import { AboutCard } from './about-card.js';

export function ProfileScreen() {
  const tz = useTimezone();
  return html`<div class="profile stack">
    <${ProfileCard} />
    <${EditorOnly}><${PrivateCard} /></${EditorOnly}>
    <${MemoriesCard} />
    <${Card} title=${t('settings.title')} data-testid="settings-card">
      <${LanguageSwitch} />
      <${MealSchedule} />
      <h3 class="profile-subhead">${t('profile.settings.timezone')}</h3>
      <${List}>
        <${ListRow} icon="globe" title=${tz} subtitle=${t('profile.settings.timezoneBody')} data-testid="timezone" />
      </${List}>
    </${Card}>
    <${EditorOnly}><${ExportCard} /></${EditorOnly}>
    <${AccountPanel} />
    <${AboutCard} />
  </div>`;
}
