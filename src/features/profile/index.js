// Feature: profile. Owns every route under '#/profile'. See docs/FEATURE_GUIDE.md.
import { ProfileScreen } from './profile-screen.js';
import { MemoriesScreen } from './memories-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'profile',
  tab: { icon: 'paw', order: 5 },
  routes: [
    { path: '/profile', component: ProfileScreen },
    { path: '/profile/memories', component: MemoriesScreen, titleKey: 'profile.memories.title' },
  ],
};
