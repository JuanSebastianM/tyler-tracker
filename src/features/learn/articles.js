// Must-know, health tips and puppy parents: grouped lists and article views.
import { html } from '../../../vendor/preact.js';
import { t, pick } from '../../lib/i18n.js';
import { href } from '../../lib/router.js';
import { useContent, findById } from '../../lib/content.js';
import { Badge, Card, EmptyState, List, ListRow } from '../../lib/ui/index.js';
import { PRIORITIES, sortByPriority, sectionById } from './logic.js';
import { ArticleView, Loading, LoadError, NotFound, SampleBadge, categoryLabel } from './components.js';

/** @typedef {'must-know' | 'health' | 'parents'} ArticleSection */

/** Tone of a must-know priority badge. */
const PRIORITY_TONE = /** @type {Record<string, 'red' | 'gold' | 'neutral'>} */ ({ critical: 'red', important: 'gold', 'good-to-know': 'neutral' });
const PRIORITY_KEY = /** @type {Record<string, string>} */ ({ critical: 'critical', important: 'important', 'good-to-know': 'goodToKnow' });

/** @param {string} p */
export const priorityLabel = (p) => (PRIORITY_KEY[p] ? t(`learn.priority.${PRIORITY_KEY[p]}`) : p);

/**
 * Groups for a section list: must-know by priority, others by category (first-seen order).
 * @param {ArticleSection} section @param {any[]} items
 * @returns {Array<{ key: string, label: string, items: any[] }>}
 */
function groupsFor(section, items) {
  if (section === 'must-know') {
    const sorted = sortByPriority(items);
    const keys = [...PRIORITIES, ...new Set(sorted.map((i) => i.priority).filter((p) => !PRIORITIES.includes(p)))];
    return keys
      .map((k) => ({ key: k, label: priorityLabel(k), items: sorted.filter((i) => i.priority === k) }))
      .filter((g) => g.items.length);
  }
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const i of items) {
    const k = i.category || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map].map(([k, list]) => ({ key: k, label: categoryLabel(k || null), items: list }));
}

/** @param {{ section: ArticleSection }} props */
function ArticleList({ section }) {
  const { data, status } = useContent(section);
  const sec = sectionById(section);
  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} /></div>`;
  if (!data) return html`<div class="learn stack"><${LoadError} /></div>`;
  const items = data.items || [];
  const intro = t(`learn.sections.${section === 'must-know' ? 'mustKnow' : section}.longIntro`);
  return html`<div class="learn stack">
    <p class="section-intro">${intro}</p>
    ${items.length
      ? groupsFor(section, items).map(
          (g) => html`<${Card} title=${g.label} data-group=${g.key}>
            <${List}>${g.items.map(
              (i) => html`<${ListRow}
                icon=${sec.icon}
                iconTone=${section === 'must-know' ? PRIORITY_TONE[i.priority] || 'neutral' : sec.tone}
                title=${pick(i.title)}
                subtitle=${pick(i.summary)}
                trailing=${i.sample ? html`<${SampleBadge} sample=${true} />` : null}
                href=${href(`/learn/${section}/${encodeURIComponent(i.id)}`)}
              />`,
            )}</${List}>
          </${Card}>`,
        )
      : html`<${Card}><${EmptyState} icon=${sec.icon} title=${t('learn.emptySectionTitle')} body=${t('learn.emptySectionBody')} /></${Card}>`}
  </div>`;
}

/** @param {{ section: ArticleSection, id: string }} props */
function Article({ section, id }) {
  const { data, status } = useContent(section);
  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} lines=${8} /></div>`;
  /** @type {any} */
  const item = findById(data?.items, id);
  if (!item) return html`<${NotFound} section=${section} />`;
  const meta =
    section === 'must-know'
      ? html`<${Badge} tone=${PRIORITY_TONE[item.priority] || 'neutral'}>${priorityLabel(item.priority)}</${Badge}>`
      : item.category
        ? html`<${Badge} tone="blue">${categoryLabel(item.category)}</${Badge}>`
        : null;
  return html`<div class="learn stack">
    <${ArticleView} item=${item} health=${sectionById(section).health} meta=${meta} />
  </div>`;
}

export const MustKnowScreen = () => html`<${ArticleList} section="must-know" />`;
export const HealthTipsScreen = () => html`<${ArticleList} section="health" />`;
export const ParentsScreen = () => html`<${ArticleList} section="parents" />`;
/** @param {{ params: Record<string, string> }} p */
export const MustKnowArticle = (p) => html`<${Article} section="must-know" id=${p.params.id} />`;
/** @param {{ params: Record<string, string> }} p */
export const HealthTipArticle = (p) => html`<${Article} section="health" id=${p.params.id} />`;
/** @param {{ params: Record<string, string> }} p */
export const ParentsArticle = (p) => html`<${Article} section="parents" id=${p.params.id} />`;
