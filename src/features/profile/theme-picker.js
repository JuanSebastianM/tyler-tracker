// Ajustes → Tema: per-person colour theme and light/dark mode (src/lib/theme.js).
// Each swatch previews its theme with the real tokens: the preview carries data-theme and
// data-scheme, and tokens.css/themes.css declare colour tokens on any [data-theme] element.
import { html, useRef } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { useIsEditor } from '../../lib/auth.js';
import { Icon, Segmented } from '../../lib/ui/index.js';
import { THEMES, setThemeChoice, useThemeChoice } from '../../lib/theme.js';

export function ThemeSettings() {
  const { theme, mode, scheme } = useThemeChoice();
  const isEditor = useIsEditor();
  const groupRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  /** @param {string} id */
  const pick = (id) => setThemeChoice({ theme: /** @type {any} */ (id) });

  /** Arrow keys move the selection, like the UI kit's Segmented. @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const idx = THEMES.indexOf(theme);
    pick(THEMES[(idx + delta + THEMES.length) % THEMES.length]);
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (groupRef.current?.querySelector('[aria-checked="true"]'))?.focus());
  };

  return html`<section class="theme-settings" data-testid="theme-settings" aria-labelledby="theme-settings-title">
    <h3 class="profile-subhead" id="theme-settings-title">${t('profile.theme.title')}</h3>
    <p class="profile-note muted">${isEditor ? t('profile.theme.savedAccount') : t('profile.theme.savedDevice')}</p>
    <div class="field">
      <span class="field-label" id="theme-color-label">${t('profile.theme.color')}</span>
      <div class="theme-swatches" role="radiogroup" aria-labelledby="theme-color-label" ref=${groupRef} onKeyDown=${onKeyDown}>
        ${THEMES.map(
          (id) => html`<button
            type="button"
            role="radio"
            class="theme-swatch"
            aria-checked=${id === theme ? 'true' : 'false'}
            tabindex=${id === theme ? 0 : -1}
            data-testid=${`theme-${id}`}
            onClick=${() => pick(id)}
          >
            <span class="theme-preview" data-theme=${id} data-scheme=${scheme} aria-hidden="true">
              <span class="tp-card">
                <span class="tp-dot"></span>
                <span class="tp-lines"><span class="tp-line"></span><span class="tp-line tp-line-short"></span></span>
              </span>
              <span class="tp-pill"></span>
            </span>
            <span class="theme-name">${t(`profile.theme.names.${id}`)}</span>
            ${id === theme ? html`<span class="tp-check"><${Icon} name="check" size=${16} /></span>` : null}
          </button>`,
        )}
      </div>
    </div>
    <div class="theme-mode">
      <${Segmented}
        label=${t('profile.theme.mode')}
        value=${mode}
        onValue=${(/** @type {any} */ v) => setThemeChoice({ mode: v })}
        options=${[
          { value: 'auto', label: t('profile.theme.modes.auto') },
          { value: 'light', label: t('profile.theme.modes.light') },
          { value: 'dark', label: t('profile.theme.modes.dark') },
        ]}
      />
      <p class="field-hint theme-mode-hint">${t('profile.theme.autoHint')}</p>
    </div>
  </section>`;
}
