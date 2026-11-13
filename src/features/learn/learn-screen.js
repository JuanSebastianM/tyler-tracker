import { html } from '../../../vendor/preact.js';
import { t, pick } from '../../lib/i18n.js';
import { useContent, factOfTheDay } from '../../lib/content.js';
import { Card, EmptyState, ListRow, List, Skeleton, Markdown, Sources } from '../../lib/ui/index.js';
import { useTimezone } from '../../data/stores.js';
import { getToday } from '../../data/derived.js';

// Placeholder: the Learn feature replaces this screen. It shows how to read /content files.
export function LearnScreen() {
  const tz = useTimezone();
  const facts = useContent('facts');
  const mustKnow = useContent('must-know');
  const fact = factOfTheDay(facts.data?.items || [], getToday(tz).date);

  return html`<div class="learn stack">
    ${fact
      ? html`<${Card} title=${t('learn.factTitle')} tone="quiet" data-testid="fact-of-the-day">
          <${Markdown} source=${pick(fact.text)} />
          <${Sources} sources=${fact.sources} />
        </${Card}>`
      : null}
    <${Card} title=${t('learn.mustKnowTitle')}>
      ${mustKnow.status === 'loading' && !mustKnow.data
        ? html`<${Skeleton} lines=${3} />`
        : html`<${List}>${(mustKnow.data?.items || []).map(
            (/** @type {any} */ item) => html`<${ListRow} icon="star" iconTone="gold" title=${pick(item.title)} subtitle=${pick(item.summary)} />`,
          )}</${List}>`}
    </${Card}>
    <${EmptyState} icon="book" title=${t('learn.emptyTitle')} body=${t('learn.emptyBody')} />
  </div>`;
}
