// Small presentational pieces shared by the assistant screens.
import { html } from '../../../vendor/preact.js';
import { t, formatNumber } from '../../lib/i18n.js';
import { useAuth, openSignIn } from '../../lib/auth.js';
import { Button, EmptyState, Skeleton, Icon } from '../../lib/ui/index.js';
import { budgetLevel, RETRYABLE } from './logic.js';

/** Send (arrow up) and stop (square) glyphs; the shared icon set has neither. */
export function GlyphSend() {
  return html`<svg class="icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>`;
}
export function GlyphStop() {
  return html`<svg class="icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></svg>`;
}

/** @param {number} usd */
const money = (usd) => formatNumber(usd, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1.20 of $25 used this month" with a thin meter. @param {{ usage: import('./api.js').Usage | null }} props */
export function BudgetIndicator({ usage }) {
  const b = usage?.budget;
  if (!b) return html`<p class="chat-budget" aria-hidden="true"> </p>`;
  const { ratio, level } = budgetLevel(b);
  const total = formatNumber(b.budget_usd, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return html`<p class=${`chat-budget budget-${level}`} data-testid="assistant-budget">
    <span class="budget-meter" role="meter" aria-label=${t('assistant.budgetLabel')} aria-valuemin="0" aria-valuemax=${b.budget_usd} aria-valuenow=${b.used_usd}>
      <span class="budget-fill" style=${{ width: `${Math.round(ratio * 100)}%` }}></span>
    </span>
    <span>${t('assistant.budget', { used: money(b.used_usd), total })}</span>
  </p>`;
}

/**
 * Error state for a function error code.
 * @param {{ code: string, usage?: import('./api.js').Usage | null, onRetry?: () => void, onDismiss?: () => void }} props
 */
export function ErrorNotice({ code, usage, onRetry, onDismiss }) {
  const vars = { limit: usage?.daily?.limit ?? 40 };
  return html`<div class="chat-error" role="alert" data-testid="assistant-error" data-code=${code}>
    <span class="chat-error-icon"><${Icon} name=${code === 'network' ? 'globe' : 'alert'} size=${20} /></span>
    <div class="chat-error-text">
      <p class="chat-error-title">${t(`assistant.errors.${code}.title`)}</p>
      <p class="chat-error-body">${t(`assistant.errors.${code}.body`, vars)}</p>
      <div class="button-row">
        ${code === 'unauthorized' ? html`<${Button} size="sm" variant="secondary" icon="lock" onClick=${openSignIn}>${t('auth.signIn')}</${Button}>` : null}
        ${onRetry && RETRYABLE.has(code) ? html`<${Button} size="sm" variant="secondary" icon="refresh" onClick=${onRetry}>${t('common.retry')}</${Button}>` : null}
        ${onDismiss ? html`<${Button} size="sm" variant="ghost" onClick=${onDismiss}>${t('common.dismiss')}</${Button}>` : null}
      </div>
    </div>
  </div>`;
}

/** Only editors may use the assistant; everyone else sees why. @param {{ children: any }} props */
export function EditorGate({ children }) {
  const auth = useAuth();
  if (auth.status === 'loading' || (auth.status === 'signedIn' && !auth.editor && auth.editorCheck === 'unknown')) {
    return html`<div class="assistant stack"><${Skeleton} lines=${3} /></div>`;
  }
  if (auth.editor) return children;
  const notEditor = auth.status === 'signedIn';
  return html`<div class="assistant stack" data-testid="assistant-signed-out">
    <${EmptyState}
      icon="lock"
      title=${t('assistant.signedOut.title')}
      body=${notEditor ? t('assistant.signedOut.notEditor') : t('assistant.signedOut.body')}
      action=${notEditor ? null : html`<${Button} icon="lock" onClick=${openSignIn}>${t('auth.signIn')}</${Button}>`}
    />
  </div>`;
}
