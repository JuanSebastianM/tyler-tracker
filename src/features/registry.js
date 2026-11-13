// Every feature is imported here once. Features own their routes under '/<id>'.
import { feature as today } from './today/index.js';
import { feature as log } from './log/index.js';
import { feature as health } from './health/index.js';
import { feature as learn } from './learn/index.js';
import { feature as profile } from './profile/index.js';
import { feature as assistant } from './assistant/index.js';

/**
 * @typedef {object} Route
 * @property {string} path            '/health' or '/learn/guide/:id'
 * @property {(props: { params: Record<string, string>, query: Record<string, string> }) => any} component
 * @property {string} [titleKey]      i18n key for the header title (default: nav.<feature id>)
 * @property {string} [back]          path for the header back button (default: '/<feature id>' on sub-routes)
 *
 * @typedef {object} Feature
 * @property {string} id              'today' | 'log' | 'health' | 'learn' | 'profile'
 * @property {{ icon: string, order: number }} [tab]
 * @property {Route[]} routes
 */

/** @type {Feature[]} */
export const features = [today, log, health, learn, profile, assistant];

/** All routes, tagged with their feature id. */
export const routes = features.flatMap((f) => f.routes.map((r) => ({ ...r, featureId: f.id })));

/** Bottom tab bar entries in order. */
export const tabs = features
  .filter((f) => f.tab)
  .map((f) => ({ id: f.id, icon: /** @type {{icon: string}} */ (f.tab).icon, order: /** @type {{order: number}} */ (f.tab).order, path: `/${f.id}` }))
  .sort((a, b) => a.order - b.order);
