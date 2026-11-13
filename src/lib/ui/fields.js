// Form inputs. Every input renders its own <label>; pass `label` always (use `hideLabel` to keep
// it for screen readers only). Inputs report values with onValue(string) and pass other props
// through to the <input>.
import { html, useId, useRef } from '../../../vendor/preact.js';
import { Icon } from './icons.js';
import { formatDate, getLocale } from '../i18n.js';

/**
 * @typedef {object} FieldProps
 * @property {string} label
 * @property {string} [hint]
 * @property {string | null} [error]
 * @property {boolean} [hideLabel]
 * @property {boolean} [required]
 */

/**
 * Wrapper used by all inputs. Exported for custom controls.
 * @param {FieldProps & { id: string, children: any }} props
 */
export function Field({ id, label, hint, error, hideLabel, required, children }) {
  return html`<div class=${`field${error ? ' field-invalid' : ''}`}>
    <label class=${`field-label${hideLabel ? ' sr-only' : ''}`} for=${id}>${label}${required ? html`<span aria-hidden="true"> *</span>` : null}</label>
    ${children}
    ${hint && !error ? html`<p class="field-hint" id=${id + '-hint'}>${hint}</p>` : null}
    ${error ? html`<p class="field-error" id=${id + '-error'} role="alert"><${Icon} name="alert" size=${16} />${error}</p>` : null}
  </div>`;
}

/** @param {string} id @param {any} hint @param {any} error */
const describedBy = (id, hint, error) => (error ? id + '-error' : hint ? id + '-hint' : undefined);

/**
 * @param {FieldProps & { type?: string, value?: string | number | null, onValue?: (v: string) => void, [k: string]: any }} props
 */
export function TextInput({ label, hint, error, hideLabel, required, type = 'text', value, onValue, ...rest }) {
  const autoId = useId();
  const id = rest.id || 'f' + autoId;
  return html`<${Field} id=${id} label=${label} hint=${hint} error=${error} hideLabel=${hideLabel} required=${required}>
    <input
      id=${id}
      class="input"
      type=${type}
      value=${value ?? ''}
      required=${required}
      aria-invalid=${error ? 'true' : undefined}
      aria-describedby=${describedBy(id, hint, error)}
      onInput=${(/** @type {any} */ e) => onValue?.(e.currentTarget.value)}
      ...${rest}
    />
  </${Field}>`;
}

/** Decimal number input with a unit suffix (e.g. "kg"). */
export function NumberInput({ unit, ...props }) {
  return html`<div class="input-unit" data-unit=${unit || ''}>
    <${TextInput} type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" autocomplete="off" ...${props} />
  </div>`;
}

/**
 * Native date picker. Value is 'YYYY-MM-DD'. The picker's own format follows the device's region
 * (an iPhone set to Colombia shows dd/mm/aaaa; a browser in US English shows mm/dd/yyyy) and cannot
 * be forced by the page, so the chosen date is also spelled out in the app's language under the
 * field ("jueves, 13 de noviembre de 2026"). `lang` helps engines that honour it.
 */
export function DateInput({ hint, value, ...props }) {
  const valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const spelled = valid ? formatDate(value, 'full') : '';
  const fullHint = spelled ? (hint ? `${spelled} · ${hint}` : spelled) : hint;
  return html`<${TextInput} type="date" lang=${getLocale() === 'es' ? 'es-CO' : 'en'} value=${value} hint=${fullHint} ...${props} />`;
}

/** Native time picker. Value is 'HH:MM'. */
export function TimeInput(props) {
  return html`<${TextInput} type="time" ...${props} />`;
}

/**
 * @param {FieldProps & { value?: string | null, onValue?: (v: string) => void, rows?: number, [k: string]: any }} props
 */
export function TextArea({ label, hint, error, hideLabel, required, value, onValue, rows = 3, ...rest }) {
  const autoId = useId();
  const id = rest.id || 'f' + autoId;
  return html`<${Field} id=${id} label=${label} hint=${hint} error=${error} hideLabel=${hideLabel} required=${required}>
    <textarea
      id=${id}
      class="input textarea"
      rows=${rows}
      required=${required}
      aria-invalid=${error ? 'true' : undefined}
      aria-describedby=${describedBy(id, hint, error)}
      onInput=${(/** @type {any} */ e) => onValue?.(e.currentTarget.value)}
      value=${value ?? ''}
      ...${rest}
    ></textarea>
  </${Field}>`;
}

/**
 * Native select.
 * @param {FieldProps & { value?: string, options: Array<{ value: string, label: string }>, onValue?: (v: string) => void, placeholder?: string, [k: string]: any }} props
 */
export function Select({ label, hint, error, hideLabel, required, value, options, onValue, placeholder, ...rest }) {
  const autoId = useId();
  const id = rest.id || 'f' + autoId;
  return html`<${Field} id=${id} label=${label} hint=${hint} error=${error} hideLabel=${hideLabel} required=${required}>
    <div class="select-wrap">
      <select
        id=${id}
        class="input select"
        value=${value ?? ''}
        required=${required}
        aria-invalid=${error ? 'true' : undefined}
        aria-describedby=${describedBy(id, hint, error)}
        onChange=${(/** @type {any} */ e) => onValue?.(e.currentTarget.value)}
        ...${rest}
      >
        ${placeholder != null ? html`<option value="" disabled>${placeholder}</option>` : null}
        ${options.map((o) => html`<option value=${o.value} selected=${o.value === value}>${o.label}</option>`)}
      </select>
      <${Icon} name="chevron-down" size=${18} class="select-chevron" />
    </div>
  </${Field}>`;
}

/**
 * Segmented control (radio group). Arrow keys move the selection.
 * @param {{ label: string, hideLabel?: boolean, value: string, options: Array<{ value: string, label: string, icon?: string }>,
 *   onValue: (v: string) => void, size?: 'md' | 'sm' }} props
 */
export function Segmented({ label, hideLabel = false, value, options, onValue, size = 'md' }) {
  const id = 'seg' + useId();
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const idx = options.findIndex((o) => o.value === value);
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = options[(idx + delta + options.length) % options.length];
    onValue(next.value);
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (ref.current?.querySelector('[aria-checked="true"]'))?.focus());
  };
  return html`<div class="field">
    <span class=${`field-label${hideLabel ? ' sr-only' : ''}`} id=${id}>${label}</span>
    <div class=${`segmented segmented-${size}`} role="radiogroup" aria-labelledby=${id} ref=${ref} onKeyDown=${onKeyDown}>
      ${options.map(
        (o) => html`<button
          type="button"
          role="radio"
          aria-checked=${o.value === value ? 'true' : 'false'}
          tabindex=${o.value === value ? 0 : -1}
          class="segment"
          onClick=${() => onValue(o.value)}
        >${o.icon ? html`<${Icon} name=${o.icon} size=${18} />` : null}<span>${o.label}</span></button>`,
      )}
    </div>
  </div>`;
}

/**
 * On/off switch.
 * @param {{ label: string, checked: boolean, onValue: (v: boolean) => void, hint?: string }} props
 */
export function Switch({ label, checked, onValue, hint }) {
  const id = 'sw' + useId();
  return html`<div class="switch-row">
    <label for=${id} class="switch-label">${label}${hint ? html`<span class="field-hint">${hint}</span>` : null}</label>
    <button id=${id} type="button" role="switch" aria-checked=${checked ? 'true' : 'false'} class="switch" onClick=${() => onValue(!checked)}>
      <span class="switch-thumb"></span>
    </button>
  </div>`;
}
