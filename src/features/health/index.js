// Feature: health. Owns every route under '#/health'. See docs/FEATURE_GUIDE.md.
import { HealthScreen } from './health-screen.js';
import { VaccinesScreen, DewormingScreen, VisitsScreen, MedicationsScreen, RemindersScreen } from './sections.js';
import { WeightScreen } from './weight-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'health',
  tab: { icon: 'heart', order: 3 },
  routes: [
    { path: '/health', component: HealthScreen },
    { path: '/health/vaccines', component: VaccinesScreen, titleKey: 'health.vaccines.title' },
    { path: '/health/deworming', component: DewormingScreen, titleKey: 'health.deworming.title' },
    { path: '/health/weight', component: WeightScreen, titleKey: 'health.weight.title' },
    { path: '/health/visits', component: VisitsScreen, titleKey: 'health.visits.title' },
    { path: '/health/medications', component: MedicationsScreen, titleKey: 'health.medications.title' },
    { path: '/health/reminders', component: RemindersScreen, titleKey: 'health.reminders.title' },
  ],
};
