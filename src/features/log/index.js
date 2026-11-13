// Feature: log. Owns every route under '#/log'. See docs/FEATURE_GUIDE.md.
import { LogScreen } from './log-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'log',
  tab: { icon: 'journal', order: 2 },
  routes: [{ path: '/log', component: LogScreen }],
};
