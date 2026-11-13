// Feature: learn. Owns every route under '#/learn'. See docs/FEATURE_GUIDE.md.
import { LearnScreen } from './learn-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'learn',
  tab: { icon: 'book', order: 4 },
  routes: [{ path: '/learn', component: LearnScreen }],
};
