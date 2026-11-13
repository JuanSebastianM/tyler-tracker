// Dismissible "Add to Home Screen" hint for iOS Safari when the app is not installed.
import { html, useState } from '../../../vendor/preact.js';
import { t } from '../i18n.js';
import { readJSON, writeJSON } from '../storage.js';
import { isIosSafari, isStandalone } from '../pwa.js';
import { Icon } from './icons.js';
import { IconButton } from './button.js';

/** @param {{ force?: boolean }} props force: show regardless of platform (kitchen sink, tests) */
export function InstallHint({ force = false }) {
  const [hidden, setHidden] = useState(() => !force && (readJSON('installHintDismissed', false) || !isIosSafari() || isStandalone()));
  if (hidden) return null;
  const dismiss = () => {
    if (!force) writeJSON('installHintDismissed', true);
    setHidden(true);
  };
  return html`<aside class=${`install-hint${force ? ' install-hint-inline' : ''}`} aria-label=${t('pwa.installTitle')}>
    <img src="assets/icons/icon-192.png" alt="" width="44" height="44" />
    <div class="install-text">
      <p class="install-title">${t('pwa.installTitle')}</p>
      <p class="install-body">${t('pwa.installBefore')}<${Icon} name="share" size=${16} label=${t('pwa.shareIcon')} />${t('pwa.installAfter')}</p>
    </div>
    <${IconButton} icon="close" label=${t('common.dismiss')} onClick=${dismiss} />
  </aside>`;
}
