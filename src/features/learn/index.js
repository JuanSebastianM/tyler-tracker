// Feature: learn. Owns every route under '#/learn'. See docs/FEATURE_GUIDE.md.
import { LearnScreen } from './learn-screen.js';
import { MustKnowScreen, MustKnowArticle, HealthTipsScreen, HealthTipArticle, ParentsScreen, ParentsArticle } from './articles.js';
import { RoadmapScreen } from './roadmap.js';
import { TrainingScreen, TrainingGuide } from './training.js';
import { FaqScreen, FaqArticle } from './faq.js';
import { FactsScreen } from './facts.js';

const title = (/** @type {string} */ k) => `learn.sections.${k}.title`;

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'learn',
  tab: { icon: 'book', order: 4 },
  routes: [
    { path: '/learn', component: LearnScreen },
    { path: '/learn/must-know', component: MustKnowScreen, titleKey: title('mustKnow') },
    { path: '/learn/must-know/:id', component: MustKnowArticle, titleKey: title('mustKnow'), back: '/learn/must-know' },
    { path: '/learn/roadmap', component: RoadmapScreen, titleKey: title('roadmap') },
    { path: '/learn/roadmap/:id', component: RoadmapScreen, titleKey: title('roadmap'), back: '/learn/roadmap' },
    { path: '/learn/training', component: TrainingScreen, titleKey: title('training') },
    { path: '/learn/training/:id', component: TrainingGuide, titleKey: title('training'), back: '/learn/training' },
    { path: '/learn/health', component: HealthTipsScreen, titleKey: title('health') },
    { path: '/learn/health/:id', component: HealthTipArticle, titleKey: title('health'), back: '/learn/health' },
    { path: '/learn/parents', component: ParentsScreen, titleKey: title('parents') },
    { path: '/learn/parents/:id', component: ParentsArticle, titleKey: title('parents'), back: '/learn/parents' },
    { path: '/learn/faq', component: FaqScreen, titleKey: title('faq') },
    { path: '/learn/faq/:id', component: FaqArticle, titleKey: title('faq'), back: '/learn/faq' },
    { path: '/learn/facts', component: FactsScreen, titleKey: title('facts') },
    { path: '/learn/facts/:id', component: FactsScreen, titleKey: title('facts'), back: '/learn/facts' },
  ],
};
