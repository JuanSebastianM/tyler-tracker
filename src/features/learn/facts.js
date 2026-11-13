// Fun facts: fact of the day plus every fact. '/learn/facts/:id' highlights one fact.
import { html, useEffect } from '../../../vendor/preact.js';
import { t, pick } from '../../lib/i18n.js';
import { useContent, factOfTheDay } from '../../lib/content.js';
import { Card, EmptyState, Icon, Markdown, Sources } from '../../lib/ui/index.js';
import { Loading, LoadError, NotFound, SampleBadge, useAge } from './components.js';

/** @param {{ params: Record<string, string> }} props */
export function FactsScreen({ params }) {
  const { data, status } = useContent('facts');
  const { today } = useAge();
  const items = data?.items || [];
  const focusId = params?.id || null;
  useEffect(() => {
    if (focusId && data) document.querySelector(`[data-fact="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusId, !!data]);

  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} /></div>`;
  if (!data) return html`<div class="learn stack"><${LoadError} /></div>`;
  if (focusId && !items.some((/** @type {any} */ f) => f.id === focusId)) return html`<${NotFound} section="facts" />`;
  const fact = factOfTheDay(items, today);

  return html`<div class="learn stack">
    ${fact
      ? html`<${Card} tone="gold" title=${t('learn.facts.today')} data-testid="fact-of-the-day">
          <${Markdown} source=${pick(fact.text)} />
          <${Sources} sources=${fact.sources || []} />
        </${Card}>`
      : null}
    ${items.length
      ? html`<${Card} title=${t('learn.facts.all', { count: items.length })}>
          <ul class="facts">
            ${items.map(
              (/** @type {any} */ f) => html`<li class=${`fact${f.id === focusId ? ' is-focus' : ''}`} data-fact=${f.id}>
                <span class="fact-icon" aria-hidden="true"><${Icon} name="sparkle" size=${18} /></span>
                <div class="fact-text">
                  <${Markdown} source=${pick(f.text)} />
                  <${SampleBadge} sample=${f.sample} />
                  <${Sources} sources=${f.sources || []} reviewedOn=${f.reviewed_on} />
                </div>
              </li>`,
            )}
          </ul>
        </${Card}>`
      : html`<${Card}><${EmptyState} icon="sparkle" title=${t('learn.emptySectionTitle')} body=${t('learn.emptySectionBody')} /></${Card}>`}
  </div>`;
}
