// App shell: header, route outlet, bottom tab bar, toasts, sign-in sheet, install hint.
import { html, useEffect, useRef } from '../vendor/preact.js';
import { t, useLocale } from './lib/i18n.js';
import { useLocation, resolveRoute, navigate, goBack, href } from './lib/router.js';
import { useAuth, openSignIn } from './lib/auth.js';
import { routes as featureRoutes, tabs } from './features/registry.js';
import { Icon, IconButton, Toaster, SignInSheet } from './lib/ui/index.js';
import { InstallHint } from './lib/ui/install-hint.js';
import { KitchenSink } from './lib/ui/kitchen-sink.js';

const DEFAULT_PATH = '/today';

/** Shell-owned routes that are not part of a feature (not in the tab bar). */
const shellRoutes = [{ path: '/dev/ui', component: KitchenSink, featureId: 'dev', titleKey: 'kitchen.title', back: '/profile' }];
const allRoutes = [...featureRoutes, ...shellRoutes];

function Header({ title, backTo, path }) {
  const auth = useAuth();
  const h1 = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const first = useRef(true);
  // Move focus to the new page title on navigation (not on first load) for screen readers.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    h1.current?.focus({ preventScroll: true });
  }, [path]);

  return html`<header class="app-header">
    <div class="app-header-inner">
      ${backTo
        ? html`<${IconButton} icon="chevron-left" label=${t('nav.back')} onClick=${() => goBack(backTo)} class="header-back" />`
        : html`<img class="header-avatar" src="assets/icons/icon-192.png" alt="" width="36" height="36" />`}
      <h1 class="app-title" tabindex="-1" ref=${h1}>${title}</h1>
      <div class="header-end">
        ${auth.status === 'signedOut'
          ? html`<${IconButton} icon="lock" label=${t('auth.signIn')} onClick=${openSignIn} data-testid="header-sign-in" />`
          : auth.editor
            ? html`<a class="header-editor" href=${href('/profile')} aria-label=${t('nav.account')} title=${auth.editor.displayName} data-testid="header-editor">
                ${auth.editor.displayName.slice(0, 1).toUpperCase()}
              </a>`
            : null}
      </div>
    </div>
  </header>`;
}

function TabBar({ activeId }) {
  return html`<nav class="tabbar" aria-label=${t('nav.main')}>
    <ul>
      ${tabs.map(
        (tab) => html`<li>
          <a
            class=${`tab${tab.id === activeId ? ' tab-active' : ''}`}
            href=${href(tab.path)}
            aria-current=${tab.id === activeId ? 'page' : undefined}
            data-tab=${tab.id}
          >
            <span class="tab-icon"><${Icon} name=${tab.icon} size=${24} /></span>
            <span class="tab-label">${t(`nav.${tab.id}`)}</span>
          </a>
        </li>`,
      )}
    </ul>
  </nav>`;
}

export function App() {
  const locale = useLocale();
  const loc = useLocation();
  const match = resolveRoute(allRoutes, loc.path);

  useEffect(() => {
    if (!match) navigate(DEFAULT_PATH, { replace: true });
  }, [match]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.path]);

  if (!match) return null;
  const { route, params } = match;
  const isSubRoute = route.path.split('/').filter(Boolean).length > 1;
  const backTo = route.back || (isSubRoute ? `/${route.featureId}` : null);
  const title = t(route.titleKey || `nav.${route.featureId}`);
  const Screen = route.component;

  return html`<div class="app" data-locale=${locale}>
    <a class="skip-link" href="#main" onClick=${(/** @type {Event} */ e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>${t('app.skipToContent')}</a>
    <${Header} title=${title} backTo=${backTo} path=${loc.path} />
    <main id="main" class="app-main" tabindex="-1" data-route=${route.path}>
      <${Screen} key=${loc.path + locale} params=${params} query=${loc.query} />
    </main>
    <${InstallHint} />
    <${TabBar} activeId=${route.featureId} />
    <${Toaster} />
    <${SignInSheet} />
  </div>`;
}
