import { html } from '../../../vendor/preact.js';
import { Icon } from './icons.js';
import { Spinner } from './feedback.js';

/**
 * @param {{ variant?: 'primary' | 'secondary' | 'ghost' | 'danger', size?: 'md' | 'sm', icon?: string,
 *   loading?: boolean, block?: boolean, href?: string, type?: string, class?: string, children?: any,
 *   [k: string]: any }} props
 */
export function Button({ variant = 'primary', size = 'md', icon, loading = false, block = false, href, type = 'button', class: cls = '', children, ...rest }) {
  const className = `btn btn-${variant} btn-${size}${block ? ' btn-block' : ''}${cls ? ' ' + cls : ''}`;
  const inner = html`${loading ? html`<${Spinner} size=${18} />` : icon ? html`<${Icon} name=${icon} size=${20} />` : null}<span>${children}</span>`;
  if (href) return html`<a class=${className} href=${href} ...${rest}>${inner}</a>`;
  return html`<button class=${className} type=${type} disabled=${rest.disabled || loading} aria-busy=${loading ? 'true' : undefined} ...${rest}>${inner}</button>`;
}

/**
 * Icon-only button. `label` is required: it is the accessible name.
 * @param {{ icon: string, label: string, variant?: 'ghost' | 'secondary' | 'primary', class?: string, [k: string]: any }} props
 */
export function IconButton({ icon, label, variant = 'ghost', class: cls = '', ...rest }) {
  return html`<button type="button" class=${`icon-btn icon-btn-${variant}${cls ? ' ' + cls : ''}`} aria-label=${label} title=${label} ...${rest}>
    <${Icon} name=${icon} size=${22} />
  </button>`;
}

/**
 * Floating add button, fixed above the tab bar. Wrap in <EditorOnly>.
 * @param {{ icon?: string, label: string, onClick: () => void, [k: string]: any }} props
 */
export function Fab({ icon = 'plus', label, onClick, ...rest }) {
  return html`<button type="button" class="fab" aria-label=${label} title=${label} onClick=${onClick} ...${rest}>
    <${Icon} name=${icon} size=${28} strokeWidth=${2.4} />
  </button>`;
}
