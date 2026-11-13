// Roadmap: age stages in order; the current one is highlighted and open; editors tick to-dos.
import { html, useEffect, useRef, useState } from '../../../vendor/preact.js';
import { t, pick } from '../../lib/i18n.js';
import { useContent, currentStage } from '../../lib/content.js';
import { useIsEditor } from '../../lib/auth.js';
import { Badge, HealthDisclaimer, Icon, Markdown, Sources } from '../../lib/ui/index.js';
import { checklistDone } from '../../data/stores.js';
import { sortStages, stageProgress, stageTiming } from './logic.js';
import { Loading, LoadError, NotFound, SampleBadge, useAge } from './components.js';

const TIMING_TONE = /** @type {const} */ ({ past: 'neutral', current: 'gold', future: 'blue' });

/** @param {{ params: Record<string, string> }} props */
export function RoadmapScreen({ params }) {
  const { data, status } = useContent('roadmap');
  const { weeks } = useAge();
  const done = checklistDone.useRows();
  /** @type {any[]} */
  const stages = sortStages(data?.items || []);
  const current = currentStage(stages, weeks);
  const target = params?.id ? stages.find((s) => s.id === params.id) || null : null;
  const [open, setOpen] = useState(/** @type {Set<string> | null} */ (null));
  const refs = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));

  // Open the deep-linked stage (or the current one) once stages are known.
  const initialId = target?.id || current?.id || null;
  useEffect(() => {
    if (!initialId) return;
    setOpen(new Set([initialId]));
    if (target) requestAnimationFrame(() => refs.current[initialId]?.scrollIntoView({ block: 'start' }));
  }, [initialId]);

  if (!data && (status === 'loading' || status === 'idle')) return html`<div class="learn stack"><${Loading} /></div>`;
  if (!data) return html`<div class="learn stack"><${LoadError} /></div>`;
  if (params?.id && !target) return html`<${NotFound} section="roadmap" />`;

  const doneKeys = new Set(done.map((r) => r.item_key));
  const openSet = open || new Set(initialId ? [initialId] : []);
  /** @param {string} id */
  const toggle = (id) =>
    setOpen(() => {
      const next = new Set(openSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return html`<div class="learn stack">
    <p class="section-intro">${t('learn.sections.roadmap.longIntro')}</p>
    <ol class="stages">
      ${stages.map((s) => {
        const timing = stageTiming(s, current);
        const p = stageProgress(s, doneKeys);
        const isOpen = openSet.has(s.id);
        return html`<li class=${`stage stage-${timing}${isOpen ? ' is-open' : ''}`} ref=${(/** @type {any} */ el) => (refs.current[s.id] = el)}
          data-stage=${s.id} data-timing=${timing}>
          <button type="button" class="stage-head" aria-expanded=${isOpen ? 'true' : 'false'} aria-controls=${`stage-${s.id}`} onClick=${() => toggle(s.id)}>
            <span class="stage-dot" aria-hidden="true">${p.complete ? html`<${Icon} name="check" size=${16} strokeWidth=${3} />` : null}</span>
            <span class="stage-text">
              <span class="stage-weeks">${t('learn.roadmap.weeks', { from: s.from_weeks, to: s.to_weeks })}</span>
              <span class="stage-title">${pick(s.title)}</span>
              <span class="stage-badges">
                <${Badge} tone=${TIMING_TONE[timing]}>${t(`learn.roadmap.timing.${timing}`)}</${Badge}>
                ${p.total ? html`<span class="stage-count">${t('learn.roadmap.progress', { done: p.done, total: p.total })}</span>` : null}
                <${SampleBadge} sample=${s.sample} />
              </span>
            </span>
            <${Icon} name="chevron-down" size=${20} class="stage-chevron" />
          </button>
          ${isOpen
            ? html`<div class="stage-body stack" id=${`stage-${s.id}`}>
                <p class="article-summary">${pick(s.summary)}</p>
                ${p.total
                  ? html`<div class="progress" role="progressbar" aria-label=${t('learn.roadmap.progressLabel')}
                      aria-valuemin="0" aria-valuemax=${p.total} aria-valuenow=${p.done}>
                      <span style=${{ width: `${(p.done / p.total) * 100}%` }}></span>
                    </div>`
                  : null}
                <${Todos} stage=${s} doneKeys=${doneKeys} />
                <div class="article-body"><${Markdown} source=${pick(s.body)} /></div>
                <${HealthDisclaimer} />
                <${Sources} sources=${s.sources || []} reviewedOn=${s.reviewed_on} />
              </div>`
            : null}
        </li>`;
      })}
    </ol>
  </div>`;
}

/** @param {{ stage: any, doneKeys: Set<string> }} props */
function Todos({ stage, doneKeys }) {
  const isEditor = useIsEditor();
  const todos = stage.todos || [];
  if (!todos.length) return null;
  /** @param {string} key */
  const toggle = (key) => (doneKeys.has(key) ? checklistDone.remove(key) : checklistDone.upsert({ item_key: key }));
  return html`<section class="todos" aria-label=${t('learn.roadmap.todos')}>
    <h3 class="todos-title">${t('learn.roadmap.todos')}</h3>
    <ul>
      ${todos.map((td) => {
        const checked = doneKeys.has(td.key);
        const text = pick(td.text);
        return html`<li class=${`todo${checked ? ' is-done' : ''}`} data-todo=${td.key}>
          ${isEditor
            ? html`<label class="todo-row">
                <input type="checkbox" class="todo-check" checked=${checked} onChange=${() => toggle(td.key)} />
                <span class="todo-text">${text}</span>
              </label>`
            : html`<div class="todo-row" role="checkbox" aria-checked=${checked ? 'true' : 'false'} aria-readonly="true" aria-label=${text}>
                <span class="todo-box" aria-hidden="true">${checked ? html`<${Icon} name="check" size=${16} strokeWidth=${3} />` : null}</span>
                <span class="todo-text" aria-hidden="true">${text}</span>
              </div>`}
        </li>`;
      })}
    </ul>
  </section>`;
}
