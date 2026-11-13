// Export (editors only): all data as one JSON file, or one CSV per table, built in the browser
// from the stores after loading every table in full.
import { html, useState } from '../../../vendor/preact.js';
import { t, formatNumber } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { Card, Button, List, ListRow, Icon } from '../../lib/ui/index.js';
import * as stores from '../../data/stores.js';
import { getToday } from '../../data/derived.js';
import { buildExportJson, toCsv, exportFileName, EXPORT_TABLES, PRIVATE_EXPORT_TABLES } from './logic.js';

/** Store for each exported table. */
const STORE_BY_TABLE = Object.fromEntries(stores.allStores.map((s) => [s.config.table, s]));

/** Everything ever logged: wide enough for any real date. */
const ALL_TIME = { start: '2000-01-01T00:00:00.000Z', end: '2100-01-01T00:00:00.000Z' };

/**
 * Load every table in full (ranged tables over all time). Returns rows per table, or an error.
 * @returns {Promise<{ tables: Record<string, any[]> } | { error: string }>}
 */
async function loadEverything() {
  const results = await Promise.all(
    EXPORT_TABLES.map((name) => {
      const s = STORE_BY_TABLE[name];
      if (!s) return Promise.resolve({ error: null });
      return s.config.rangeColumn ? s.loadRange(ALL_TIME.start, ALL_TIME.end) : s.load();
    }),
  );
  const failed = results.find((r) => r && r.error);
  if (failed) return { error: String(failed.error) };
  /** @type {Record<string, any[]>} */
  const tables = {};
  for (const name of EXPORT_TABLES) {
    const s = STORE_BY_TABLE[name];
    if (s) tables[name] = s.rows();
  }
  return { tables };
}

/** Save a Blob as a file. @param {Blob} blob @param {string} name */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportCard() {
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [counts, setCounts] = useState(/** @type {Record<string, number> | null} */ (null));

  /** @param {string} what 'json' or a table name */
  const run = async (what) => {
    setBusy(what);
    const res = await loadEverything();
    setBusy(null);
    if ('error' in res) {
      toast(t('profile.export.failed'), { tone: 'error' });
      return;
    }
    setCounts(Object.fromEntries(Object.entries(res.tables).map(([k, v]) => [k, v.length])));
    const tz = stores.getTimezone();
    const date = getToday(tz).date;
    if (what === 'json') {
      const doc = buildExportJson(res.tables, { exportedAt: new Date().toISOString(), timezone: tz });
      download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), exportFileName(date));
    } else {
      download(new Blob([toCsv(res.tables[what] || [])], { type: 'text/csv;charset=utf-8' }), exportFileName(date, `-${what}.csv`));
    }
    toast(t('profile.export.done'), { tone: 'success' });
  };

  return html`<${Card} title=${t('profile.export.title')} data-testid="export-card">
    <p class="muted profile-note">${t('profile.export.intro')}</p>
    <${Button} block icon="download" loading=${busy === 'json'} disabled=${!!busy} onClick=${() => run('json')} data-testid="export-json">${t('profile.export.json')}</${Button}>
    <details class="export-csv">
      <summary><${Icon} name="list" size=${18} /><span>${t('profile.export.csvTitle')}</span><${Icon} name="chevron-down" size=${18} class="export-chevron" /></summary>
      <p class="muted profile-note">${t('profile.export.csvIntro')}</p>
      <${List}>
        ${EXPORT_TABLES.map(
          (name) => html`<${ListRow}
            icon=${PRIVATE_EXPORT_TABLES.includes(name) ? 'lock' : 'download'}
            iconTone=${PRIVATE_EXPORT_TABLES.includes(name) ? 'blue' : 'neutral'}
            title=${t(`profile.export.tables.${name}`)}
            subtitle=${counts && counts[name] != null ? t('profile.export.rows', { count: counts[name], n: formatNumber(counts[name]) }) : `${name}.csv`}
            onClick=${busy ? undefined : () => run(name)}
            trailing=${busy === name ? html`<span class="spinner" style="width:18px;height:18px"></span>` : null}
            data-testid=${`export-csv-${name}`}
          />`,
        )}
      </${List}>
    </details>
  </${Card}>`;
}
