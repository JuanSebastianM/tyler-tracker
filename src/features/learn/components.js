// Shared building blocks for the Learn screens: age hook, article view, not-found and loading states.
import { html } from '../../../vendor/preact.js';
import { t, pick, hasKey, formatDate } from '../../lib/i18n.js';
import { href } from '../../lib/router.js';
import { Badge, Button, EmptyState, HealthDisclaimer, Markdown, Skeleton, Sources, Card } from '../../lib/ui/index.js';
import { petProfile, useTimezone } from '../../data/stores.js';
import { getAge, getToday } from '../../data/derived.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';

/** i18n key segment per section id. */
export const SECTION_KEY = /** @type {Record<string, string>} */ ({
  'must-know': 'mustKnow',
  roadmap: 'roadmap',
  training: 'training',
  health: 'health',
  parents: 'parents',
  faq: 'faq',
  facts: 'facts',
});

/** @param {string} sectionId */
export const sectionTitle = (sectionId) => t(`learn.sections.${SECTION_KEY[sectionId]}.title`);

/** Tyler's age (weeks) and today's date in the settings timezone. */
export function useAge() {
  const tz = useTimezone();
  const profile = petProfile.useRow();
  const today = getToday(tz).date;
  const age = getAge(profile?.birth_date || DEFAULT_BIRTH_DATE, today);
  return { tz, today, weeks: age.weeks, age };
}

/** Translated category label, or the raw value for unknown categories. @param {string | null} c */
export function categoryLabel(c) {
  if (!c) return t('learn.categories.uncategorized');
  const key = `learn.categories.${c}`;
  return hasKey(key) ? t(key) : c;
}

/** "Example" pill for placeholder content (sample: true). @param {{ sample?: boolean }} props */
export function SampleBadge({ sample }) {
  return sample ? html`<${Badge} tone="neutral">${t('learn.sample')}</${Badge}>` : null;
}

/** Loading placeholder for a list or article. @param {{ lines?: number }} props */
export function Loading({ lines = 4 }) {
  return html`<${Card}><${Skeleton} lines=${lines} /></${Card}>`;
}

/** Content could not load (offline with no cache). */
export function LoadError() {
  return html`<${EmptyState} icon="alert" title=${t('learn.loadErrorTitle')} body=${t('errors.loadFailed')} />`;
}

/**
 * Unknown article id: say so and link back to the section.
 * @param {{ section: string }} props
 */
export function NotFound({ section }) {
  return html`<div class="learn stack" data-testid="learn-not-found">
    <${EmptyState}
      icon="question"
      title=${t('learn.notFoundTitle')}
      body=${t('learn.notFoundBody')}
      action=${html`<${Button} variant="secondary" href=${href(`/learn/${section}`)}>${t('learn.backTo', { section: sectionTitle(section) })}</${Button}>`}
    />
  </div>`;
}

/**
 * Article layout used by every section: title, summary, meta badges, Markdown body, optional extra
 * blocks, health disclaimer and sources.
 * @param {{ item: any, health?: boolean, meta?: any, before?: any, after?: any, title?: string, body?: string, summary?: string }} props
 */
export function ArticleView({ item, health = false, meta, before, after, title, body, summary }) {
  const titleText = title ?? pick(item.title);
  const summaryText = summary ?? pick(item.summary);
  return html`<article class="learn-article stack" data-testid="learn-article">
    <header class="article-head">
      <h2 class="article-title">${titleText}</h2>
      ${summaryText ? html`<p class="article-summary">${summaryText}</p>` : null}
      ${meta || item.sample ? html`<div class="article-meta">${meta}<${SampleBadge} sample=${item.sample} /></div>` : null}
    </header>
    ${before || null}
    <div class="article-body">
      <${Markdown} source=${body ?? pick(item.body)} headingOffset=${1} />
    </div>
    ${after || null}
    ${health ? html`<${HealthDisclaimer} />` : null}
    <${Sources} sources=${item.sources || []} reviewedOn=${item.reviewed_on} />
  </article>`;
}

/** Number of weeks as text ("8 semanas"). @param {number} n */
export const weeksText = (n) => t('age.weeks', { count: n });

/** @param {string} d 'YYYY-MM-DD' */
export const dateText = (d) => formatDate(d, 'medium');
