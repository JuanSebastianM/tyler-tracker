// Weight: growth chart (inline SVG over the reference band in content/growth.json) + list.
import { html } from '../../../vendor/preact.js';
import { t, pick, formatDate, formatNumber, getLocale } from '../../lib/i18n.js';
import { useContent } from '../../lib/content.js';
import { Card, HealthDisclaimer, Sources, Badge } from '../../lib/ui/index.js';
import { weights, petProfile } from '../../data/stores.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';
import { RecordSection } from './records.js';
import { useHealthCtx } from './sections.js';
import { ageAt, weightSeries, latestWeight, growthChartModel, parseDecimal, decimalToInput, isValidWeight, orNull } from './logic.js';
import { formatKg, formatDeltaKg, formatAge } from './widgets.js';

/** Birth date from the profile (or the default until it loads). */
export function useBirthDate() {
  return petProfile.useRow()?.birth_date || DEFAULT_BIRTH_DATE;
}

/**
 * Growth chart: Tyler's weights by age over the reference band.
 * @param {{ rows: any[], birthDate: string, today: string }} props
 */
export function GrowthChart({ rows, birthDate, today }) {
  const { data: growth, status } = useContent('growth');
  const series = weightSeries(rows, birthDate);
  const band = Array.isArray(growth?.points) && growth.points.length ? growth.points : null;
  const nowWeeks = ageAt(birthDate, today).weeksExact;
  const m = growthChartModel({
    weights: series.map((p) => ({ ageWeeks: p.age.weeksExact, kg: p.kg, date: p.date })),
    band,
    nowWeeks,
    width: 340,
    height: 230,
    pad: { top: 24, right: 12, bottom: 30, left: 36 },
  });
  const latest = series[series.length - 1];
  const summary = latest
    ? t('health.weight.chartSummary', { count: series.length, kg: formatKg(latest.kg), age: formatAge(latest.age) })
    : t('health.weight.chartEmpty');
  const plotBottom = m.height - m.pad.bottom;

  return html`<${Card} title=${t('health.weight.chartTitle')} class="health-chart-card" data-testid="growth-chart">
    <figure class="health-chart">
      <svg viewBox=${`0 0 ${m.width} ${m.height}`} role="img" aria-label=${summary} data-points=${series.length}>
        <g class="hc-grid" aria-hidden="true">
          ${m.yTicks.map((tk) => html`<line x1=${m.pad.left} x2=${m.width - m.pad.right} y1=${tk.y} y2=${tk.y} />`)}
        </g>
        ${m.bandPath ? html`<path class="hc-band" d=${m.bandPath} data-testid="growth-band" />` : null}
        <g class="hc-axis" aria-hidden="true">
          ${m.yTicks.map((tk) => html`<text x=${m.pad.left - 6} y=${tk.y} text-anchor="end" dominant-baseline="middle">${formatNumber(tk.value)}</text>`)}
          ${m.xTicks.map((tk) => html`<text x=${tk.x} y=${plotBottom + 16} text-anchor="middle">${formatNumber(tk.value)}</text>`)}
          <text x=${m.pad.left - 6} y=${m.pad.top - 12} text-anchor="end" class="hc-unit">kg</text>
          <text x=${m.width - m.pad.right} y=${m.height - 1} text-anchor="end" class="hc-unit">${t('health.weight.axisWeeks')}</text>
        </g>
        ${m.nowX != null ? html`<line class="hc-now" x1=${m.nowX} x2=${m.nowX} y1=${m.pad.top} y2=${plotBottom} aria-hidden="true" />` : null}
        ${m.linePath ? html`<path class="hc-line" d=${m.linePath} />` : null}
        ${m.points.map(
          (p) => html`<circle class="hc-dot" cx=${p.x} cy=${p.y} r="4.5"><title>${formatKg(p.kg)} · ${formatDate(/** @type {any} */ (p).date, 'medium')}</title></circle>`,
        )}
      </svg>
      <figcaption class="health-legend">
        <span><i class="lg-dot"></i>${t('health.weight.legendTyler')}</span>
        ${m.bandStatus === 'visible' ? html`<span><i class="lg-band"></i>${t('health.weight.legendBand')}</span>` : null}
        <span><i class="lg-now"></i>${t('health.weight.legendToday')}</span>
      </figcaption>
    </figure>
    ${!series.length ? html`<p class="muted">${t('health.weight.chartEmpty')}</p>` : null}
    ${!band && status !== 'loading' ? html`<p class="muted" data-testid="growth-no-reference">${t('health.weight.noReference')}</p>` : null}
    ${m.bandStatus === 'later' && m.bandRange
      ? html`<p class="muted" data-testid="growth-band-later">${t('health.weight.bandStartsLater', { weeks: formatNumber(m.bandRange[0]) })}</p>`
      : null}
    ${band && growth?.note ? html`<p class="health-note muted" data-testid="growth-note">${pick(growth.note)}</p>` : null}
    ${band && growth?.sample
      ? html`<p class="health-note" data-testid="growth-placeholder"><${Badge} tone="gold" icon="info">${t('health.weight.placeholderBadge')}</${Badge}> ${pick(growth.placeholder_note) || t('content.placeholder')}</p>`
      : null}
    ${band ? html`<${Sources} sources=${growth.sources || []} reviewedOn=${growth.reviewed_on} />` : null}
    <${HealthDisclaimer} />
  </${Card}>`;
}

/** Latest weight and change, shown above the chart. @param {{ rows: any[], birthDate: string }} props */
export function LatestWeight({ rows, birthDate }) {
  const l = latestWeight(rows, birthDate);
  if (!l) return null;
  return html`<div class="health-latest" data-testid="latest-weight">
    <p class="health-latest-kg">${formatKg(l.kg)}</p>
    <p class="health-latest-meta">
      ${formatDate(l.date, 'medium')} · ${formatAge(l.age)}
      ${l.delta != null ? html`<br /><span class="health-delta">${t('health.weight.change', { delta: formatDeltaKg(l.delta), days: l.daysSincePrev })}</span>` : null}
    </p>
  </div>`;
}

/** @param {string} birthDate @returns {import('./records.js').SectionConfig} */
function weightConfig(birthDate) {
  return {
    id: 'weight',
    store: weights,
    icon: 'scale',
    iconTone: 'gold',
    fields: [
      [
        { name: 'kg', kind: 'decimal', label: 'health.weight.fields.kg', unit: 'kg', required: true, hint: 'health.weight.fields.kgHint' },
        { name: 'measured_on', kind: 'date', label: 'health.weight.fields.measuredOn', required: true },
      ],
      { name: 'notes', kind: 'textarea', label: 'health.fields.notes' },
    ],
    rules: { required: ['kg', 'measured_on'] },
    check: (v) => (v.kg && !isValidWeight(parseDecimal(v.kg)) ? { kg: 'health.form.invalidWeight' } : {}),
    toForm: (row, ctx) => ({ kg: decimalToInput(row?.weight_kg, getLocale()), measured_on: row?.measured_on || ctx.today, notes: row?.notes || '' }),
    toPayload: (v) => ({ weight_kg: parseDecimal(v.kg), measured_on: v.measured_on, notes: orNull(v.notes) }),
    view: (row) => {
      const series = weightSeries(weights.rows(), birthDate);
      const point = series.find((p) => p.row.id === row.id);
      const age = ageAt(birthDate, row.measured_on);
      return {
        title: formatKg(row.weight_kg),
        subtitle: `${formatDate(row.measured_on, 'medium')} · ${formatAge(age)}`,
        meta: point?.delta != null ? formatDeltaKg(point.delta) : null,
      };
    },
    details: (row) => {
      const age = ageAt(birthDate, row.measured_on);
      const point = weightSeries(weights.rows(), birthDate).find((p) => p.row.id === row.id);
      return [
        ['health.weight.fields.measuredOn', formatDate(row.measured_on, 'medium')],
        ['health.weight.age', formatAge(age)],
        ['health.weight.changeLabel', point?.delta != null ? formatDeltaKg(point.delta) : ''],
        ['health.fields.notes', row.notes],
      ];
    },
  };
}

/** @param {{ query: Record<string, string> }} props */
export function WeightScreen({ query }) {
  const ctx = useHealthCtx();
  const rows = weights.useRows();
  const birthDate = useBirthDate();
  const header = html`${rows.length ? html`<${Card} tone="gold"><${LatestWeight} rows=${rows} birthDate=${birthDate} /></${Card}>` : null}
    <${GrowthChart} rows=${rows} birthDate=${birthDate} today=${ctx.today} />`;
  return html`<${RecordSection} config=${{ ...weightConfig(birthDate), header }} ctx=${ctx} query=${query} />`;
}
