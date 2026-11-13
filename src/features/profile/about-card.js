// About: app version, how to install on iPhone, link to the public repo.
import { html } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { Card, List, ListRow, Icon } from '../../lib/ui/index.js';
import { parseBuildVersion } from './logic.js';
import { APP_VERSION } from '../../version.js';

export const REPO_URL = 'https://github.com/JuanSebastianM/tyler-tracker';

export function AboutCard() {
  const version = parseBuildVersion(APP_VERSION);

  const versionText =
    version === null
      ? t('profile.about.devVersion')
      : version.date
        ? t('profile.about.versionBuilt', { sha: version.sha, date: formatDate(version.date, 'medium') })
        : version.sha;

  return html`<${Card} title=${t('profile.about.title')} data-testid="about-card">
    <p class="muted profile-note">${t('profile.about.intro')}</p>
    <${List}>
      <${ListRow} icon="info" title=${t('profile.about.version')} meta=${html`<span class="mono" data-testid="app-version">${versionText}</span>`} />
      <${ListRow}
        icon="globe"
        title=${t('profile.about.repo')}
        subtitle=${t('profile.about.repoBody')}
        href=${REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
      />
    </${List}>
    <div class="install-help">
      <h3 class="profile-subhead">${t('profile.about.installTitle')}</h3>
      <ol class="install-steps">
        <li>${t('profile.about.install1')}</li>
        <li>${t('profile.about.install2Before')}<${Icon} name="share" size=${16} label=${t('pwa.shareIcon')} />${t('profile.about.install2After')}</li>
        <li>${t('profile.about.install3')}</li>
        <li>${t('profile.about.install4')}</li>
      </ol>
    </div>
  </${Card}>`;
}
