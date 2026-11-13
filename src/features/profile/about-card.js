// About: app version, how to install on iPhone, link to the public repo.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { Card, List, ListRow, Icon } from '../../lib/ui/index.js';
import { parseBuildVersion, versionFromCaches, versionFromSwSource } from './logic.js';

export const REPO_URL = 'https://github.com/JuanSebastianM/tyler-tracker';

/**
 * The deployed build version. The foundation stamps it only into sw.js ('tt-shell-<version>'
 * cache name + VERSION constant), so read the running shell cache first, then sw.js.
 * @returns {Promise<string | null>}
 */
async function readVersion() {
  try {
    if (typeof caches !== 'undefined') {
      const v = versionFromCaches(await caches.keys());
      if (v) return v;
    }
  } catch {
    /* caches unavailable (private mode) */
  }
  try {
    const res = await fetch('./sw.js', { cache: 'no-cache' });
    if (res.ok) return versionFromSwSource(await res.text());
  } catch {
    /* offline */
  }
  return null;
}

export function AboutCard() {
  const [version, setVersion] = useState(/** @type {ReturnType<typeof parseBuildVersion> | undefined} */ (undefined));
  useEffect(() => {
    let alive = true;
    readVersion().then((v) => alive && setVersion(parseBuildVersion(v)));
    return () => {
      alive = false;
    };
  }, []);

  const versionText =
    version === undefined
      ? t('common.loading')
      : version === null
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
