// Bottom sheet (modal dialog) and confirm dialog.
//   html`<${Sheet} open=${open} onClose=${close} title=${t('health.addVaccine')} footer=${buttons}>...form...</${Sheet}>`
import { html, useLayoutEffect, useRef, useId } from '../../../vendor/preact.js';
import { IconButton, Button } from './button.js';
import { t } from '../i18n.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openCount = 0;

/**
 * @param {{ open: boolean, onClose: () => void, title: any, children?: any, footer?: any,
 *   initialFocus?: string, dismissible?: boolean, [k: string]: any }} props
 *   initialFocus: CSS selector inside the sheet to focus first (default: first input, else the panel)
 */
export function Sheet({ open, onClose, title, children, footer, initialFocus, dismissible = true, ...rest }) {
  const panel = useRef(/** @type {HTMLDivElement | null} */ (null));
  const titleId = 'sheet' + useId();

  // Layout effect: Escape and the focus trap work as soon as the sheet is on screen.
  useLayoutEffect(() => {
    if (!open) return;
    const previous = /** @type {HTMLElement | null} */ (document.activeElement);
    openCount++;
    document.body.classList.add('sheet-open');
    const el = panel.current;
    const target = /** @type {HTMLElement | null} */ (
      (initialFocus && el?.querySelector(initialFocus)) || el?.querySelector('input, select, textarea') || el
    );
    // Do not pop the iOS keyboard for sheets without inputs.
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const items = /** @type {HTMLElement[]} */ ([...el.querySelectorAll(FOCUSABLE)]);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openCount--;
      if (openCount <= 0) document.body.classList.remove('sheet-open');
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return html`<div class="sheet-layer">
    <div class="sheet-backdrop" onClick=${() => dismissible && onClose()}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby=${titleId} tabindex="-1" ref=${panel} ...${rest}>
      <div class="sheet-grabber" aria-hidden="true"></div>
      <header class="sheet-head">
        <h2 class="sheet-title" id=${titleId}>${title}</h2>
        ${dismissible ? html`<${IconButton} icon="close" label=${t('common.close')} onClick=${onClose} />` : null}
      </header>
      <div class="sheet-body">${children}</div>
      ${footer ? html`<footer class="sheet-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

/**
 * Confirm a destructive or important action.
 * @param {{ open: boolean, title: string, message?: string, confirmLabel?: string, cancelLabel?: string,
 *   danger?: boolean, busy?: boolean, onConfirm: () => void, onCancel: () => void }} props
 */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onCancel }) {
  return html`<${Sheet}
    open=${open}
    onClose=${onCancel}
    title=${title}
    class="sheet confirm"
    initialFocus=".btn-secondary"
    footer=${html`
      <${Button} variant="secondary" onClick=${onCancel}>${cancelLabel || t('common.cancel')}</${Button}>
      <${Button} variant=${danger ? 'danger' : 'primary'} loading=${busy} onClick=${onConfirm}>${confirmLabel || t('common.confirm')}</${Button}>`}
  >
    ${message ? html`<p class="confirm-message">${message}</p>` : null}
  </${Sheet}>`;
}
