// Reads every public table through the Supabase REST API with the publishable key and writes
// one JSON file per table. Used by the nightly workflow (keeps the free project awake + backup).
//   node scripts/backup.mjs [outDir]
// Exits non-zero if any request fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPABASE_KEY, SUPABASE_URL } from '../src/config.js';

const TABLES = [
  'pet_profile', 'settings', 'feedings', 'routine_events', 'weights', 'vaccinations', 'dewormings',
  'vet_visits', 'medications', 'reminders', 'training_skills', 'checklist_done', 'milestones', 'photos', 'faq_entries',
];
const PAGE = 1000;
const out = resolve(process.argv[2] || 'backup');
mkdirSync(out, { recursive: true });

let failed = false;
const summary = {};
for (const table of TABLES) {
  const rows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`;
      const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const page = await res.json();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    writeFileSync(join(out, `${table}.json`), JSON.stringify(rows, null, 2));
    summary[table] = rows.length;
    console.log(`${table}: ${rows.length} rows`);
  } catch (e) {
    failed = true;
    summary[table] = `ERROR ${e.message}`;
    console.error(`::error::${table}: ${e.message}`);
  }
}
writeFileSync(join(out, '_summary.json'), JSON.stringify({ at: new Date().toISOString(), tables: summary }, null, 2));
if (failed) {
  console.error('Backup failed: the Supabase API was unreachable or rejected a request.');
  process.exit(1);
}
