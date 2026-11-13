// Global toasts. Rendered by <Toaster/> in the shell.
//   toast(t('common.saved'))
//   toast(t('errors.saveFailed'), { tone: 'error' })
//   toast(t('pwa.updateReady'), { action: { label: t('pwa.reload'), onClick: () => location.reload() }, duration: 0 })
import { createStore } from './store.js';

/**
 * @typedef {object} Toast
 * @property {number} id
 * @property {string} message
 * @property {'info' | 'success' | 'error'} tone
 * @property {{ label: string, onClick: () => void } | undefined} action
 */

/** @type {import('./store.js').Store<Toast[]>} */
export const toastStore = createStore(/** @type {Toast[]} */ ([]));
let nextId = 1;

/**
 * @param {string} message
 * @param {{ tone?: Toast['tone'], action?: Toast['action'], duration?: number }} [opts]
 *   duration in ms; 0 keeps the toast until dismissed. Errors default to 6 s, others 3.5 s.
 * @returns {number} toast id
 */
export function toast(message, opts = {}) {
  const id = nextId++;
  const tone = opts.tone || 'info';
  toastStore.set((list) => [...list.slice(-2), { id, message, tone, action: opts.action }]);
  const duration = opts.duration ?? (tone === 'error' ? 6000 : 3500);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

/** @param {number} id */
export function dismissToast(id) {
  toastStore.set((list) => list.filter((x) => x.id !== id));
}
