// #/learn home: current roadmap stage, search across all content, section index, fact of the day.
import { html, useMemo, useState } from '../../../vendor/preact.js';
import { t, pick, useLocale } from '../../lib/i18n.js';
import { href } from '../../lib/router.js';
import { useContent, currentStage, factOfTheDay } from '../../lib/content.js';
import { Card, List, ListRow, Markdown, Button, EmptyState, TextInput, Badge } from '../../lib/ui/index.js';
import { checklistDone, trainingSkills } from '../../data/stores.js';
import { SECTIONS, sortByPriority, stageProgress, trainingOverview, buildSearchDocs, searchDocs, sectionById } from './logic.js';
import { SECTION_KEY, sectionTitle, useAge, weeksText } from './components.js';
import { useFaqItems } from './faq.js';

/** @param {{ query: Record<string, string> }} props */
export function LearnScreen({ query }) {
  const locale = useLocale();
  const { today, weeks } = useAge();
  const [q, setQ] = useState(query?.q || '');

  const mustKnow = useContent('must-know');
  const roadmap = useContent('roadmap');
  const training = useContent('training');
  const health = useContent('health');
  const parents = useContent('parents');
  const facts = useContent('facts');
  const faq = useFaqItems();
  const done = checklistDone.useRows();
  const skills = trainingSkills.useRows();

  /** @type {Record<string, any[]>} */
  const content = {
    'must-know': mustKnow.data?.items || [],
    roadmap: roadmap.data?.items || [],
    training: training.data?.items || [],
    health: health.data?.items || [],
    parents: parents.data?.items || [],
    facts: facts.data?.items || [],
  };
  const docs = useMemo(
    () => buildSearchDocs(content, faq.items, locale),
    [mustKnow.data, roadmap.data, training.data, health.data, parents.data, facts.data, faq.items, locale],
  );
  const results = q.trim() ? searchDocs(docs, q) : null;

  const stage = currentStage(content.roadmap, weeks);
  const doneKeys = new Set(done.map((r) => r.item_key));
  const progress = stage ? stageProgress(stage, doneKeys) : null;
  const fact = factOfTheDay(content.facts, today);
  const overview = trainingOverview(content.training, skills);
  const topMustKnow = sortByPriority(content['must-know']).slice(0, 3);

  /** @param {string} id */
  const countFor = (id) => {
    if (id === 'faq') return t('learn.count.questions', { count: faq.items.length });
    if (id === 'roadmap') return t('learn.count.stages', { count: content.roadmap.length });
    if (id === 'training') return t('learn.count.guides', { count: content.training.length });
    if (id === 'facts') return t('learn.count.facts', { count: content.facts.length });
    return t('learn.count.articles', { count: content[id].length });
  };

  return html`<div class="learn stack">
    <div class="learn-search" role="search">
      <${TextInput}
        type="search"
        label=${t('learn.search.label')}
        hideLabel
        placeholder=${t('learn.search.placeholder')}
        value=${q}
        onValue=${setQ}
        enterkeyhint="search"
        data-testid="learn-search"
      />
    </div>

    ${results
      ? html`<${Card} title=${t('learn.search.results', { count: results.length })} data-testid="search-results">
          ${results.length
            ? html`<${List}>${results.map((r) => {
                const sec = sectionById(r.section);
                return html`<${ListRow}
                  icon=${sec.icon}
                  iconTone=${sec.tone}
                  title=${r.title}
                  subtitle=${html`<span class="result-section">${sectionTitle(r.section)}</span>${r.snippet && r.snippet !== r.title ? html` · ${r.snippet}` : null}`}
                  href=${href(r.path)}
                />`;
              })}</${List}>`
            : html`<${EmptyState} icon="question" title=${t('learn.search.emptyTitle')} body=${t('learn.search.emptyBody')} />`}
        </${Card}>`
      : html`
          ${stage
            ? html`<${Card} tone="gold" class="learn-now" data-testid="current-stage-card"
                title=${t('learn.now.title', { weeks: weeksText(weeks) })}>
                <p class="now-stage">${pick(stage.title)}</p>
                <p class="now-summary">${pick(stage.summary)}</p>
                ${progress.total
                  ? html`<div class="progress-line">
                      <div class="progress" role="progressbar" aria-label=${t('learn.roadmap.progressLabel')}
                        aria-valuemin="0" aria-valuemax=${progress.total} aria-valuenow=${progress.done}>
                        <span style=${{ width: `${(progress.done / progress.total) * 100}%` }}></span>
                      </div>
                      <span class="progress-text">${t('learn.roadmap.progress', { done: progress.done, total: progress.total })}</span>
                    </div>`
                  : null}
                <${Button} variant="primary" size="sm" icon="calendar" href=${href(`/learn/roadmap/${encodeURIComponent(stage.id)}`)}>
                  ${t('learn.now.open')}
                </${Button}>
              </${Card}>`
            : null}

          ${topMustKnow.length
            ? html`<${Card} title=${t('learn.startHere')} data-testid="must-know-preview"
                action=${html`<a class="card-link" href=${href('/learn/must-know')}>${t('learn.facts.more')}</a>`}>
                <${List}>${topMustKnow.map(
                  (i) => html`<${ListRow} icon="star" iconTone=${i.priority === 'critical' ? 'red' : 'gold'} title=${pick(i.title)}
                    subtitle=${pick(i.summary)} href=${href(`/learn/must-know/${encodeURIComponent(i.id)}`)} />`,
                )}</${List}>
              </${Card}>`
            : null}

          <${Card} title=${t('learn.sectionsTitle')} data-testid="learn-sections">
            <${List}>${SECTIONS.map(
              (s) => html`<${ListRow}
                icon=${s.icon}
                iconTone=${s.tone}
                title=${sectionTitle(s.id)}
                subtitle=${t(`learn.sections.${SECTION_KEY[s.id]}.intro`)}
                meta=${countFor(s.id)}
                href=${href(`/learn/${s.id}`)}
                data-section=${s.id}
              />`,
            )}</${List}>
            ${overview.total
              ? html`<p class="sections-foot">
                  <${Badge} tone="green" icon="grad-cap">${t('learn.training.overviewShort', { percent: overview.percent })}</${Badge}>
                </p>`
              : null}
          </${Card}>

          ${fact
            ? html`<${Card} title=${t('learn.facts.today')} tone="quiet" data-testid="fact-of-the-day"
                action=${html`<a class="card-link" href=${href('/learn/facts')}>${t('learn.facts.more')}</a>`}>
                <${Markdown} source=${pick(fact.text)} />
              </${Card}>`
            : null}
        `}
  </div>`;
}
