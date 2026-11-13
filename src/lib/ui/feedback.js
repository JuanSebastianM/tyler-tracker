import { html } from '../../../vendor/preact.js';
import { Icon } from './icons.js';
import { t } from '../i18n.js';

/** @param {{ size?: number, label?: string }} props */
export function Spinner({ size = 24, label }) {
  return html`<span class="spinner" style=${{ width: size + 'px', height: size + 'px' }} role=${label ? 'status' : undefined} aria-label=${label}></span>`;
}

/** Placeholder lines while data loads. @param {{ lines?: number, height?: number }} props */
export function Skeleton({ lines = 3, height = 16 }) {
  return html`<div class="skeleton" aria-busy="true" aria-label=${t('common.loading')}>
    ${Array.from({ length: lines }, (_, i) => html`<span class="skeleton-line" style=${{ height: height + 'px', width: i === lines - 1 && lines > 1 ? '60%' : '100%' }}></span>`)}
  </div>`;
}

/**
 * Friendly empty state: an icon, a short title, one line of direction and an optional action.
 * @param {{ icon?: string, title: string, body?: string, action?: any }} props
 */
export function EmptyState({ icon = 'paw', title, body, action }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${30} /></div>
    <p class="empty-title">${title}</p>
    ${body ? html`<p class="empty-body">${body}</p>` : null}
    ${action ? html`<div class="empty-action">${action}</div>` : null}
  </div>`;
}

/**
 * Small status pill.
 * @param {{ tone?: 'neutral' | 'gold' | 'warn' | 'green' | 'red' | 'blue', icon?: string, children?: any }} props
 */
export function Badge({ tone = 'neutral', icon, children }) {
  return html`<span class=${`badge badge-${tone}`}>${icon ? html`<${Icon} name=${icon} size=${14} strokeWidth=${2.4} />` : null}${children}</span>`;
}
