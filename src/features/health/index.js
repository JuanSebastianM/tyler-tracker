// Feature: health. Owns every route under '#/health'. See docs/FEATURE_GUIDE.md.
import { HealthScreen } from './health-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'health',
  tab: { icon: 'heart', order: 3 },
  routes: [{ path: '/health', component: HealthScreen }],
};
