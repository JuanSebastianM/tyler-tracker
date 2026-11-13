import { html } from '../../../vendor/preact.js';
import { Icon } from './icons.js';

/**
 * Content card. `title` renders an h2 row with an optional trailing `action`.
 * @param {{ title?: any, action?: any, tone?: 'default' | 'gold' | 'quiet', class?: string, children?: any, [k: string]: any }} props
 */
export function Card({ title, action, tone = 'default', class: cls = '', children, ...rest }) {
  return html`<section class=${`card card-${tone}${cls ? ' ' + cls : ''}`} ...${rest}>
    ${title || action ? html`<header class="card-head">${title ? html`<h2 class="card-title">${title}</h2>` : html`<span></span>`}${action || null}</header>` : null}
    ${children}
  </section>`;
}

/**
 * A row in a list: leading icon, title + subtitle, trailing meta. Becomes a link with `href` or a
 * button with `onClick` (with a chevron), otherwise static.
 * @param {{ icon?: string, iconTone?: 'gold' | 'green' | 'red' | 'blue' | 'neutral', title: any, subtitle?: any,
 *   meta?: any, trailing?: any, href?: string, onClick?: () => void, [k: string]: any }} props
 */
export function ListRow({ icon, iconTone = 'neutral', title, subtitle, meta, trailing, href, onClick, ...rest }) {
  const body = html`
    ${icon ? html`<span class=${`row-icon tone-${iconTone}`}><${Icon} name=${icon} size=${20} /></span>` : null}
    <span class="row-text">
      <span class="row-title">${title}</span>
      ${subtitle ? html`<span class="row-subtitle">${subtitle}</span>` : null}
    </span>
    ${meta ? html`<span class="row-meta">${meta}</span>` : null}
    ${trailing || null}
    ${href || onClick ? html`<${Icon} name="chevron-right" size=${18} class="row-chevron" />` : null}`;
  if (href) return html`<a class="row row-action" href=${href} ...${rest}>${body}</a>`;
  if (onClick) return html`<button type="button" class="row row-action" onClick=${onClick} ...${rest}>${body}</button>`;
  return html`<div class="row" ...${rest}>${body}</div>`;
}

/** Vertical list wrapper for ListRows (renders a <ul>-like group with dividers). */
export function List({ children, ...rest }) {
  return html`<div class="list" role="list" ...${rest}>${[].concat(children).filter(Boolean).map((c) => html`<div role="listitem">${c}</div>`)}</div>`;
}

/**
 * Large heading + intro line at the top of a screen. The shell header already renders the page
 * <h1> (route title), so this is an <h2>.
 * @param {{ title: any, subtitle?: any, action?: any }} props
 */
export function PageIntro({ title, subtitle, action }) {
  return html`<div class="page-intro">
    <div><h2 class="page-title">${title}</h2>${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : null}</div>
    ${action || null}
  </div>`;
}
