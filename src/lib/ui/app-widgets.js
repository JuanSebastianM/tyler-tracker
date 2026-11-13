// App-level widgets shared by features: language switch, account panel, sign-in sheet,
// health disclaimer and article sources.
import { html, useState } from '../../../vendor/preact.js';
import { useStore } from '../store.js';
import { t, setLocale, useLocale, formatDate } from '../i18n.js';
import { useAuth, signIn, signOut, changePassword, signInSheetStore, closeSignIn, openSignIn } from '../auth.js';
import { toast } from '../toast.js';
import { Button } from './button.js';
import { Card, ListRow } from './layout.js';
import { Segmented, TextInput } from './fields.js';
import { Sheet } from './sheet.js';
import { Icon } from './icons.js';
import { Badge } from './feedback.js';
import { safeHref } from '../markdown.js';

/** Spanish / English switch. */
export function LanguageSwitch() {
  const locale = useLocale();
  return html`<${Segmented}
    label=${t('settings.language')}
    value=${locale}
    onValue=${(/** @type {any} */ v) => setLocale(v)}
    options=${[
      { value: 'es', label: 'Español' },
      { value: 'en', label: 'English' },
    ]}
  />`;
}

/** Email + password sign-in. Mounted once by the shell; open with openSignIn(). */
export function SignInSheet() {
  const open = useStore(signInSheetStore);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  const close = () => {
    setError(null);
    setPassword('');
    closeSignIn();
  };
  /** @param {Event} e */
  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError(t('auth.errors.missingFields'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await signIn(email, password);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setPassword('');
    closeSignIn();
    toast(t('auth.signedIn'), { tone: 'success' });
  };

  return html`<${Sheet} open=${open} onClose=${close} title=${t('auth.signInTitle')}>
    <form class="stack" onSubmit=${submit} novalidate>
      <p class="muted">${t('auth.signInIntro')}</p>
      <${TextInput} label=${t('auth.email')} type="email" autocomplete="username" inputmode="email" autocapitalize="none" value=${email} onValue=${setEmail} />
      <${TextInput} label=${t('auth.password')} type="password" autocomplete="current-password" value=${password} onValue=${setPassword} />
      ${error ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${18} />${error}</p>` : null}
      <${Button} type="submit" block loading=${busy}>${t('auth.signIn')}</${Button}>
    </form>
  </${Sheet}>`;
}

function ChangePasswordSheet({ open, onClose }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPw('');
    setPw2('');
    setError(null);
    onClose();
  };
  /** @param {Event} e */
  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) return setError(t('auth.errors.weakPassword'));
    if (pw !== pw2) return setError(t('auth.errors.passwordMismatch'));
    setBusy(true);
    const res = await changePassword(pw);
    setBusy(false);
    if (res.error) return setError(res.error);
    toast(t('auth.passwordChanged'), { tone: 'success' });
    close();
  };
  return html`<${Sheet} open=${open} onClose=${close} title=${t('auth.changePassword')}>
    <form class="stack" onSubmit=${submit} novalidate>
      <${TextInput} label=${t('auth.newPassword')} hint=${t('auth.passwordHint')} type="password" autocomplete="new-password" value=${pw} onValue=${setPw} />
      <${TextInput} label=${t('auth.repeatPassword')} type="password" autocomplete="new-password" value=${pw2} onValue=${setPw2} />
      ${error ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${18} />${error}</p>` : null}
      <${Button} type="submit" block loading=${busy}>${t('auth.savePassword')}</${Button}>
    </form>
  </${Sheet}>`;
}

/** Account card for the Profile tab: sign in, or who is signed in + change password + sign out. */
export function AccountPanel() {
  const auth = useAuth();
  const [pwOpen, setPwOpen] = useState(false);
  if (auth.status === 'loading') return null;
  if (auth.status === 'signedOut') {
    return html`<${Card} title=${t('auth.accountTitle')}>
      <p class="muted">${t('auth.signedOutBody')}</p>
      <${Button} variant="secondary" icon="lock" onClick=${openSignIn} data-testid="open-sign-in">${t('auth.signIn')}</${Button}>
    </${Card}>`;
  }
  return html`<${Card} title=${t('auth.accountTitle')}>
    <${ListRow}
      icon="user"
      iconTone=${auth.editor ? 'gold' : 'neutral'}
      title=${auth.editor ? t('auth.signedInAs', { name: auth.editor.displayName }) : auth.user?.email || ''}
      subtitle=${auth.editor ? t('auth.editorRole') : auth.editorCheck === 'no' ? t('auth.notEditor') : t('common.loading')}
      trailing=${auth.editor ? html`<${Badge} tone="gold" icon="edit">${t('auth.editorBadge')}</${Badge}>` : null}
    />
    <div class="button-row">
      <${Button} variant="secondary" size="sm" icon="key" onClick=${() => setPwOpen(true)}>${t('auth.changePassword')}</${Button}>
      <${Button} variant="ghost" size="sm" icon="logout" onClick=${async () => { await signOut(); toast(t('auth.signedOut')); }}>${t('auth.signOut')}</${Button}>
    </div>
    <${ChangePasswordSheet} open=${pwOpen} onClose=${() => setPwOpen(false)} />
  </${Card}>`;
}

/** "Tyler's vet has the final word" line for health content. */
export function HealthDisclaimer() {
  return html`<p class="disclaimer"><${Icon} name="stethoscope" size=${18} /><span>${t('content.vetDisclaimer')}</span></p>`;
}

/**
 * Sources list + "reviewed on" line for an article.
 * @param {{ sources?: Array<{ title: string, url: string }>, reviewedOn?: string }} props
 */
export function Sources({ sources = [], reviewedOn }) {
  if (!sources.length && !reviewedOn) return null;
  return html`<aside class="sources" aria-label=${t('content.sources')}>
    ${sources.length
      ? html`<p class="sources-title">${t('content.sources')}</p>
          <ul>${sources.map((s) => {
            const safe = safeHref(s.url);
            return html`<li>${safe ? html`<a href=${safe.href} target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</li>`;
          })}</ul>`
      : null}
    ${reviewedOn ? html`<p class="sources-reviewed">${t('content.reviewedOn', { date: formatDate(reviewedOn, 'medium') })}</p>` : null}
  </aside>`;
}
