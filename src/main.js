// Boot: strings -> auth -> data -> render -> service worker.
import { html, render } from '../vendor/preact.js';
import { loadStrings, syncDocumentLang } from './lib/i18n.js';
import { initAuth } from './lib/auth.js';
import { startDataSync } from './data/stores.js';
import { applyWaitingUpdate, registerServiceWorker } from './lib/pwa.js';
import { features } from './features/registry.js';
import { App } from './app.js';

async function boot() {
  syncDocumentLang();
  if (await applyWaitingUpdate()) return; // page reloads into the new version
  await loadStrings(features.map((f) => f.id));
  initAuth();
  startDataSync();
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  root.textContent = '';
  render(html`<${App} />`, root);
  registerServiceWorker().catch((e) => console.warn('Service worker registration failed', e));
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('boot-error')?.removeAttribute('hidden');
  document.getElementById('boot-splash')?.setAttribute('hidden', '');
});
