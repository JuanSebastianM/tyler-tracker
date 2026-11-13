// '#/log/stats': house-training summary for the last 7 or 14 days. Calculations live in
// log-logic.js (pure, unit tested); this file only draws them with CSS bars.
import { html, useState } from '../../../vendor/preact.js';
import { t, formatDate, formatClock, formatNumber } from '../../lib/i18n.js';
import { Card, Segmented, EmptyState } from '../../lib/ui/index.js';
import { feedings, routineEvents, settings, petProfile, useTimezone } from '../../data/stores.js';
import { getToday } from '../../data/derived.js';
import { summarize } from './log-logic.js';
import { formatMinutes } from './entry-ui.js';
import { useNow } from './use-now.js';

const pad = (/** @type {number} */ h) => String(h).padStart(2, '0') + ':00';

/**
 * Vertical bars, one per day. Values are labelled on top of non-zero bars; a visually hidden table
 * carries the same numbers for screen readers.
 * @param {{ caption: string, dates: string[], series: Array<{ key: string, label: string, values: number[], format?: (v: number) => string }>,
 *   testid?: string }} props
 */
function DayBars({ caption, dates, series, testid }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const dense = dates.length > 7;
  const fmt = (/** @type {any} */ s, /** @type {number} */ v) => (s.format ? s.format(v) : formatNumber(v));
  return html`<figure class=${`bars${dense ? ' bars-dense' : ''}`} data-testid=${testid}>
    ${series.length > 1
      ? html`<div class="bars-legend" aria-hidden="true">
          ${series.map((s) => html`<span class="bars-key"><span class=${`bars-swatch bar-${s.key}`}></span>${s.label}</span>`)}
        </div>`
      : null}
    <div class="bars-plot" aria-hidden="true">
      ${dates.map(
        (d, i) => html`<div class="bars-col" title=${`${formatDate(d, 'short')}: ${series.map((s) => `${s.label} ${fmt(s, s.values[i])}`).join(', ')}`}>
          <div class="bars-stack">
            ${series.map((s) => {
              const v = s.values[i];
              return html`<div class="bars-cell">
                <span class=${`bars-bar bar-${s.key}${v ? '' : ' is-zero'}`} style=${{ height: `${(v / max) * 100}%` }}>
                  ${v > 0 && (!dense || (series.length === 1 && !s.format)) ? html`<span class="bars-val">${s.format ? s.format(v) : v}</span>` : null}
                </span>
              </div>`;
            })}
          </div>
          <span class="bars-day">${dense ? formatDate(d, 'short').split(' ')[0] : formatDate(d, 'weekday')}</span>
        </div>`,
      )}
    </div>
    <table class="sr-only">
      <caption>${caption}</caption>
      <thead><tr><th scope="col">${t('log.stats.day')}</th>${series.map((s) => html`<th scope="col">${s.label}</th>`)}</tr></thead>
      <tbody>
        ${dates.map((d, i) => html`<tr><th scope="row">${formatDate(d, 'medium')}</th>${series.map((s) => html`<td>${fmt(s, s.values[i])}</td>`)}</tr>`)}
      </tbody>
    </table>
  </figure>`;
}

export function StatsScreen() {
  const tz = useTimezone();
  const now = useNow(60_000);
  const conf = settings.useRow();
  const profile = petProfile.useRow();
  const fRows = feedings.useRows();
  const eRows = routineEvents.useRows();
  const [days, setDays] = useState('7');
  const today = getToday(tz, new Date(now)).date;
  const slotsPerDay = conf?.meal_slots?.length || 4;
  const s = summarize({ feedings: fRows, events: eRows, today, days: Number(days), tz, now, slotsPerDay, firstDay: profile?.home_date || null });
  const hours = (/** @type {number} */ m) => formatNumber(m / 60, { maximumFractionDigits: 1 });

  return html`<div class="log log-stats stack">
    <${Segmented}
      label=${t('log.stats.range')}
      hideLabel
      value=${days}
      onValue=${setDays}
      options=${[
        { value: '7', label: t('log.stats.days', { count: 7 }) },
        { value: '14', label: t('log.stats.days', { count: 14 }) },
      ]}
    />
    ${!s.hasData
      ? html`<${Card}><${EmptyState} icon="pulse" title=${t('log.stats.emptyTitle')} body=${t('log.stats.emptyBody')} /></${Card}>`
      : html`
          <div class="stat-tiles">
            <div class="stat-tile" data-testid="stat-accidents">
              <span class="stat-num">${s.totals.accidents}</span>
              <span class="stat-label">${t('log.stats.accidentsTotal', { count: s.totals.accidents })}</span>
            </div>
            <div class="stat-tile" data-testid="stat-meal-poop">
              <span class="stat-num">${s.mealToPoop.average != null ? formatMinutes(s.mealToPoop.average) : '—'}</span>
              <span class="stat-label">${t('log.stats.mealToPoop')}</span>
            </div>
            <div class="stat-tile" data-testid="stat-meals">
              <span class="stat-num">${s.meals.logged}<span class="stat-of">/${s.meals.expected}</span></span>
              <span class="stat-label">${t('log.stats.mealsLogged')}</span>
            </div>
            <div class="stat-tile" data-testid="stat-sleep">
              <span class="stat-num">${s.avgSleepMinutes != null ? t('log.stats.hoursShort', { h: hours(s.avgSleepMinutes) }) : '—'}</span>
              <span class="stat-label">${t('log.stats.sleepAvg')}</span>
            </div>
          </div>

          <${Card} title=${t('log.stats.accidentsTitle')}>
            <${DayBars} caption=${t('log.stats.accidentsTitle')} dates=${s.dates} testid="chart-accidents"
              series=${[{ key: 'accident', label: t('log.stats.accidents'), values: s.perDay.map((d) => d.accidents) }]} />
            ${s.totals.accidents === 0 ? html`<p class="muted stat-note">${t('log.stats.noAccidents')}</p>` : null}
          </${Card}>

          <${Card} title=${t('log.stats.pottyTitle')}>
            <${DayBars} caption=${t('log.stats.pottyTitle')} dates=${s.dates} testid="chart-potty"
              series=${[
                { key: 'pee', label: t('log.kindPlural.pee'), values: s.perDay.map((d) => d.pee) },
                { key: 'poop', label: t('log.kindPlural.poop'), values: s.perDay.map((d) => d.poop) },
              ]} />
            <p class="muted stat-note">${t('log.stats.pottyTotals', { pee: s.totals.pee, poop: s.totals.poop })}</p>
          </${Card}>

          <${Card} title=${t('log.stats.hoursTitle')}>
            ${s.topPottyHours.length
              ? html`<p class="stat-lead">${t('log.stats.usualTimes', { times: [...s.topPottyHours].sort((a, b) => a.hour - b.hour).map((h) => formatClock(pad(h.hour))).join(', ') })}</p>
                  <div class="hours" aria-hidden="true">
                    ${s.pottyHours.map((c, h) => {
                      const peak = Math.max(1, ...s.pottyHours);
                      return html`<span class="hours-cell" title=${`${pad(h)}: ${c}`}><span class="hours-bar" style=${{ height: `${(c / peak) * 100}%` }}></span></span>`;
                    })}
                  </div>
                  <div class="hours-axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>`
              : html`<p class="muted">${t('log.stats.noPotty')}</p>`}
          </${Card}>

          <${Card} title=${t('log.stats.mealToPoopTitle')}>
            <p class="stat-lead">${s.mealToPoop.average != null
              ? t('log.stats.mealToPoopBody', { duration: formatMinutes(s.mealToPoop.average), count: s.mealToPoop.samples })
              : t('log.stats.mealToPoopNone')}</p>
          </${Card}>

          <${Card} title=${t('log.stats.mealsTitle')}>
            <p class="stat-lead">${t('log.stats.mealsBody', { logged: s.meals.logged, expected: s.meals.expected })}</p>
            <div class="meter" role="meter" aria-valuemin="0" aria-valuemax=${s.meals.expected} aria-valuenow=${Math.min(s.meals.logged, s.meals.expected)} aria-label=${t('log.stats.mealsTitle')}>
              <span class="meter-fill" style=${{ width: `${Math.min(100, (s.meals.ratio || 0) * 100)}%` }}></span>
            </div>
            <${DayBars} caption=${t('log.stats.mealsTitle')} dates=${s.dates} testid="chart-meals"
              series=${[{ key: 'meal', label: t('log.kindPlural.meal'), values: s.perDay.map((d) => d.meals) }]} />
          </${Card}>

          <${Card} title=${t('log.stats.sleepTitle')}>
            <${DayBars} caption=${t('log.stats.sleepTitle')} dates=${s.dates} testid="chart-sleep"
              series=${[{ key: 'sleep', label: t('log.kind.sleep'), values: s.perDay.map((d) => d.sleepMinutes), format: (v) => t('log.stats.hoursShort', { h: hours(v) }) }]} />
            <p class="muted stat-note">${t('log.stats.sleepNote')}</p>
          </${Card}>
        `}
  </div>`;
}
