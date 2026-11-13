// Feature: today. Owns every route under '#/today'. See docs/FEATURE_GUIDE.md.
import { TodayScreen } from './today-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'today',
  tab: { icon: 'sun', order: 1 },
  routes: [{ path: '/today', component: TodayScreen }],
};
