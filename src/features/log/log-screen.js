// Log tab: one day at a time, every feeding and routine event in time order.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t, formatDate, formatTime, formatRelativeDay } from '../../lib/i18n.js';
import { useIsEditor, EditorOnly } from '../../lib/auth.js';
import { navigate, href } from '../../lib/router.js';
import { Card, EmptyState, Fab, IconButton, Button, Icon, DateInput, Spinner, Badge } from '../../lib/ui/index.js';
import { feedings, routineEvents, useTimezone } from '../../data/stores.js';
import { getToday } from '../../data/derived.js';
import { addDays, dayRange, daysRange } from '../../lib/dates.js';
import { DEFAULT_RANGE_DAYS } from '../../config.js';
import { ENTRY_KINDS, KIND_ICON, KIND_TONE, buildTimeline, countByKind } from './log-logic.js';
import { EntrySheet, entryDetails, entryTitle } from './entry-ui.js';
import { useNow, nowIso } from './use-now.js';

/** @typedef {import('./log-logic.js').EntryKind} EntryKind */

const isDate = (/** @type {string | undefined} */ s) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Days already fetched outside the default window (per session). */
const loadedDays = new Set();

/** @param {string} day */
const goToDay = (day, today) => navigate(day === today ? '/log' : `/log?day=${day}`, { replace: true });

export function LogScreen({ query }) {
  const tz = useTimezone();
  const now = useNow();
  const isEditor = useIsEditor();
  const today = getToday(tz, new Date(now)).date;
  const day = isDate(query?.day) && query.day <= today ? query.day : today;
  const { start, end } = dayRange(day, tz);
  // Subscribe to both stores so the day re-renders on every change.
  feedings.useRows();
  routineEvents.useRows();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState(/** @type {Set<EntryKind>} */ (new Set()));
  const [target, setTarget] = useState(/** @type {import('./entry-ui.js').SheetTarget | null} */ (null));

  useEffect(() => {
    const windowStart = daysRange(today, DEFAULT_RANGE_DAYS, tz).start;
    if (start >= windowStart || loadedDays.has(day)) return;
    let alive = true;
    setLoading(true);
    Promise.all([feedings.loadRange(start, end), routineEvents.loadRange(start, end)]).then((res) => {
      if (res.every((r) => !r.error)) loadedDays.add(day);
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [day, tz]);

  const all = buildTimeline(feedings.inRange(start, end), routineEvents.inRange(start, end));
  const entries = filter.size ? all.filter((e) => filter.has(e.kind)) : all;
  const counts = countByKind(all);

  const toggle = (/** @type {EntryKind} */ k) =>
    setFilter((f) => {
      const next = new Set(f);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const relative = day === today ? t('common.today') : day === addDays(today, -1) ? t('common.yesterday') : formatRelativeDay(day, today);

  return html`<div class="log stack">
    <div class="log-daybar">
      <${IconButton} icon="chevron-left" label=${t('log.prevDay')} variant="secondary" onClick=${() => goToDay(addDays(day, -1), today)} data-testid="log-prev" />
      <div class="log-day">
        <p class="log-day-name" data-testid="log-day-label">${formatDate(day, 'long')}</p>
        <p class="log-day-rel">${relative}</p>
      </div>
      <${IconButton} icon="chevron-right" label=${t('log.nextDay')} variant="secondary" disabled=${day >= today} onClick=${() => goToDay(addDays(day, 1), today)} data-testid="log-next" />
    </div>
    <div class="log-daytools">
      <div class="log-datepick">
        <${DateInput} label=${t('log.pickDay')} hideLabel value=${day} max=${today} onValue=${(v) => isDate(v) && goToDay(v > today ? today : v, today)} />
      </div>
      ${day !== today ? html`<${Button} variant="secondary" size="sm" icon="calendar" onClick=${() => goToDay(today, today)}>${t('log.goToday')}</${Button}>` : null}
      <${Button} variant="ghost" size="sm" icon="pulse" href=${href('/log/stats')} data-testid="open-stats">${t('log.stats.open')}</${Button}>
    </div>

    <p class="log-summary" aria-live="polite">
      ${all.length
        ? [
            t('log.summary.meals', { count: counts.meal }),
            t('log.summary.pee', { count: counts.pee }),
            t('log.summary.poop', { count: counts.poop }),
            counts.accidents ? t('log.summary.accidents', { count: counts.accidents }) : null,
          ].filter(Boolean).join(' · ')
        : null}
    </p>

    <div class="log-chips" role="group" aria-label=${t('log.filterLabel')}>
      ${ENTRY_KINDS.map(
        (k) => html`<button type="button" class="log-chip" aria-pressed=${filter.has(k) ? 'true' : 'false'} onClick=${() => toggle(k)}>
          <${Icon} name=${KIND_ICON[k]} size=${16} />${t(`log.kindPlural.${k}`)}
        </button>`,
      )}
    </div>

    <${Card} class="log-day-card">
      ${loading && !all.length
        ? html`<div class="log-loading"><${Spinner} label=${t('common.loading')} /></div>`
        : entries.length
          ? html`<ol class="timeline" data-testid="timeline">
              ${entries.map((e) => {
                const details = entryDetails(e.kind, e.row, now);
                const accident = !!e.row.accident;
                const body = html`
                  <span class="tl-time">${formatTime(e.at, tz)}</span>
                  <span class=${`tl-icon row-icon tone-${accident ? 'red' : KIND_TONE[e.kind]}`}><${Icon} name=${KIND_ICON[e.kind]} size=${20} /></span>
                  <span class="tl-text">
                    <span class="tl-title">${entryTitle(e.kind, e.row)}${accident ? html` <${Badge} tone="red" icon="alert">${t('log.accident')}</${Badge}>` : null}${e.kind !== 'meal' && !e.row.ended_at && ['sleep', 'walk', 'play'].includes(e.kind) ? html` <${Badge} tone="blue">${t('log.ongoing')}</${Badge}>` : null}</span>
                    ${details.length ? html`<span class="tl-details">${details.join(' · ')}</span>` : null}
                    ${e.row.created_by_name ? html`<span class="tl-by">${t('common.loggedBy', { name: e.row.created_by_name })}</span>` : null}
                  </span>`;
                return html`<li key=${e.id} class=${`tl-item${e.row._pending ? ' is-pending' : ''}`} data-kind=${e.kind}>
                  ${isEditor
                    ? html`<button type="button" class="tl-row tl-action" onClick=${() => setTarget({ kind: e.kind, row: e.row, table: e.table })} aria-label=${t('log.editEntry', { what: entryTitle(e.kind, e.row), time: formatTime(e.at, tz) })}>${body}<${Icon} name="chevron-right" size=${18} class="row-chevron" /></button>`
                    : html`<div class="tl-row">${body}</div>`}
                </li>`;
              })}
            </ol>`
          : html`<${EmptyState}
              icon="journal"
              title=${all.length ? t('log.emptyFiltered') : day === today ? t('log.emptyTodayTitle') : t('log.emptyDayTitle')}
              body=${all.length ? t('log.emptyFilteredBody') : isEditor ? t('log.emptyBodyEditor') : t('log.emptyBody')}
              action=${filter.size ? html`<${Button} variant="secondary" size="sm" onClick=${() => setFilter(new Set())}>${t('log.clearFilters')}</${Button}>` : null}
            />`}
    </${Card}>

    <${EditorOnly}>
      <${Fab}
        label=${t('log.add')}
        onClick=${() => setTarget({ kind: 'pee', chooseKind: true, defaults: { date: day, time: day === today ? undefined : '12:00' } })}
        data-testid="fab-add"
      />
    </${EditorOnly}>
    <${EntrySheet} target=${target} onClose=${() => setTarget(null)} tz=${tz} today=${today} now=${nowIso} />
  </div>`;
}
