// Ajustes → Notificaciones (editors only): opt this phone in to meal and due-date alerts, switch each
// kind on or off, send a test. Device logic lives in src/lib/push.js; the server in
// supabase/functions/push.
import { html, useEffect } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { useStore } from '../../lib/store.js';
import { toast } from '../../lib/toast.js';
import { Button, Switch, Badge, Icon, Spinner } from '../../lib/ui/index.js';
import { pushStore, preparePush, enablePush, setPushPref, sendTestPush, disablePush, checkPush } from '../../lib/push.js';

/** Toast for a failed action. @param {string} code */
function toastError(code) {
  const key = ['offline', 'network', 'unauthorized', 'not_found', 'gone', 'too_many', 'push_failed', 'denied', 'unsupported'].includes(code) ? code : 'server_error';
  toast(t(`profile.push.errors.${key}`), { tone: 'error' });
}

export function PushSettings() {
  const s = useStore(pushStore);
  useEffect(() => {
    if (s.status === 'idle') checkPush();
    preparePush();
  }, []);

  const enable = () => {
    // Straight from the tap: iOS only shows the permission prompt for a direct user action.
    enablePush().then((r) => {
      if (r.ok) toast(t('profile.push.enabled'), { tone: 'success' });
      else if (r.code !== 'denied') toastError(r.code);
    });
  };
  const test = async () => {
    const r = await sendTestPush();
    if (r.ok) toast(t('profile.push.testSent'), { tone: 'success' });
    else toastError(r.code);
  };
  const disable = async () => {
    const r = await disablePush();
    if (r.ok) toast(t('profile.push.disabled'), { tone: 'success' });
    else toastError(r.code);
  };
  /** @param {'meals' | 'due'} name @param {boolean} v */
  const toggle = async (name, v) => {
    const r = await setPushPref(name, v);
    if (!r.ok) toastError(r.code);
  };

  return html`<section class="push-settings" data-testid="push-settings" aria-labelledby="push-settings-title">
    <h3 class="profile-subhead push-head" id="push-settings-title">
      <span>${t('profile.push.title')}</span>
      ${s.status === 'on' ? html`<${Badge} tone="green" icon="check">${t('profile.push.onBadge')}</${Badge}>` : null}
    </h3>
    <p class="profile-note muted">${t('profile.push.intro')}</p>
    <${Body} s=${s} enable=${enable} test=${test} disable=${disable} toggle=${toggle} />
  </section>`;
}

/** @param {{ s: import('../../lib/push.js').PushState, enable: () => void, test: () => void, disable: () => void, toggle: (n: 'meals' | 'due', v: boolean) => void }} p */
function Body({ s, enable, test, disable, toggle }) {
  if (s.support === 'needs-install') {
    return html`<${Notice} icon="share" testid="push-install" title=${t('profile.push.install.title')}>
      <ol class="push-steps">
        <li>${t('profile.push.install.step1')}</li>
        <li>${t('profile.push.install.step2')}</li>
        <li>${t('profile.push.install.step3')}</li>
      </ol>
      <p class="field-hint">${t('profile.push.install.version')}</p>
    </${Notice}>`;
  }
  if (s.support === 'unsupported') {
    return html`<${Notice} icon="info" testid="push-unsupported" title=${t('profile.push.unsupported.title')}>
      <p>${t('profile.push.unsupported.body')}</p>
    </${Notice}>`;
  }
  if (s.status === 'idle' || s.status === 'checking' || s.support === 'unknown') {
    return html`<p class="push-checking muted" data-testid="push-checking"><${Spinner} size=${18} /> ${t('profile.push.checking')}</p>`;
  }
  if (s.status === 'denied') {
    return html`<${Notice} icon="alert" tone="warn" testid="push-denied" title=${t('profile.push.denied.title')}>
      <p>${t('profile.push.denied.body')}</p>
      <ol class="push-steps">
        <li>${t('profile.push.denied.step1')}</li>
        <li>${t('profile.push.denied.step2')}</li>
        <li>${t('profile.push.denied.step3')}</li>
      </ol>
    </${Notice}>`;
  }
  if (s.status === 'on') {
    return html`<div class="push-on">
      <${Switch} label=${t('profile.push.meals')} hint=${t('profile.push.mealsHint')} checked=${s.prefs.meals} onValue=${(/** @type {boolean} */ v) => toggle('meals', v)} />
      <${Switch} label=${t('profile.push.due')} hint=${t('profile.push.dueHint')} checked=${s.prefs.due} onValue=${(/** @type {boolean} */ v) => toggle('due', v)} />
      <div class="button-row push-actions">
        <${Button} variant="secondary" size="sm" icon="bell" loading=${s.busy === 'test'} onClick=${test} data-testid="push-test">${t('profile.push.test')}</${Button}>
        <${Button} variant="ghost" size="sm" loading=${s.busy === 'disable'} onClick=${disable} data-testid="push-disable">${t('profile.push.disable')}</${Button}>
      </div>
    </div>`;
  }
  const lost = s.status === 'lost';
  return html`<div class="push-off">
    ${lost
      ? html`<${Notice} icon="alert" tone="warn" testid="push-lost" title=${t('profile.push.lost.title')}><p>${t('profile.push.lost.body')}</p></${Notice}>`
      : null}
    ${s.status === 'error' ? html`<p class="field-hint" data-testid="push-check-error">${t('profile.push.checkFailed')}</p>` : null}
    <${Button} icon="bell" block loading=${s.busy === 'enable'} onClick=${enable} data-testid="push-enable">${lost ? t('profile.push.reenable') : t('profile.push.enable')}</${Button}>
  </div>`;
}

/** @param {{ icon: string, title: string, tone?: 'warn' | 'info', testid: string, children: any }} p */
function Notice({ icon, title, tone = 'info', testid, children }) {
  return html`<div class=${`push-notice push-notice-${tone}`} data-testid=${testid}>
    <span class="push-notice-icon"><${Icon} name=${icon} size=${20} /></span>
    <div class="push-notice-text">
      <p class="push-notice-title">${title}</p>
      ${children}
    </div>
  </div>`;
}
