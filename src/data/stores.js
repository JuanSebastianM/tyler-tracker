// One store per table in supabase/migrations. Import the store you need:
//   import { feedings, settings } from '../../data/stores.js';
import { createTableStore } from './table-store.js';
import { getSupabase, isOffline } from '../lib/supabase.js';
import { readJSON, writeJSON, removeKey } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { t } from '../lib/i18n.js';
import { editorName, onEditorChange, isEditor } from '../lib/auth.js';
import { daysRange, todayIn } from '../lib/dates.js';
import { DEFAULT_RANGE_DAYS, DEFAULT_TIMEZONE } from '../config.js';

/** @type {import('./table-store.js').Deps} */
const deps = {
  getClient: getSupabase,
  notifyError: (message) => toast(message, { tone: 'error' }),
  readCache: (k) => readJSON(k, null),
  writeCache: writeJSON,
  clearCache: removeKey,
  isOffline,
  editorName,
  t: (k) => t(k),
  uuid: () => crypto.randomUUID(),
};

/** @param {import('./table-store.js').TableConfig} c */
const make = (c) => createTableStore(c, deps);

// Single-row tables (id = 1)
export const petProfile = make({ table: 'pet_profile', keyKind: 'single' });
export const settings = make({ table: 'settings', keyKind: 'single' });
export const petPrivate = make({ table: 'pet_private', keyKind: 'single', private: true });

// Daily logs: loaded by time window
export const feedings = make({ table: 'feedings', orderBy: { column: 'fed_at' }, rangeColumn: 'fed_at' });
export const routineEvents = make({ table: 'routine_events', orderBy: { column: 'started_at' }, rangeColumn: 'started_at' });

// Health
export const weights = make({ table: 'weights', orderBy: { column: 'measured_on' } });
export const vaccinations = make({ table: 'vaccinations', orderBy: { column: 'given_on' } });
export const dewormings = make({ table: 'dewormings', orderBy: { column: 'given_on' } });
export const vetVisits = make({ table: 'vet_visits', orderBy: { column: 'visited_on' } });
export const vetVisitPrivate = make({ table: 'vet_visit_private', key: 'visit_id', keyKind: 'text', private: true });
export const medications = make({ table: 'medications', orderBy: { column: 'start_on' } });
export const reminders = make({ table: 'reminders', orderBy: { column: 'due_on', ascending: true } });

// Learning progress (text keys from /content)
export const trainingSkills = make({ table: 'training_skills', key: 'skill_key', keyKind: 'text' });
export const checklistDone = make({ table: 'checklist_done', key: 'item_key', keyKind: 'text' });

// Memories
export const milestones = make({ table: 'milestones', orderBy: { column: 'happened_on' } });
export const photos = make({ table: 'photos', orderBy: { column: 'taken_on' } });

// FAQ entries saved from the in-app assistant (public read). Repo FAQ lives in /content/faq.json.
export const faqEntries = make({ table: 'faq_entries', orderBy: { column: 'created_at' } });

export const publicStores = [
  petProfile, settings, feedings, routineEvents, weights, vaccinations, dewormings, vetVisits,
  medications, reminders, trainingSkills, checklistDone, milestones, photos, faqEntries,
];
export const privateStores = [petPrivate, vetVisitPrivate];
export const allStores = [...publicStores, ...privateStores];

/** Timezone from settings, or the default until settings load. */
export function getTimezone() {
  return settings.single()?.timezone || DEFAULT_TIMEZONE;
}

/** Hook: timezone from settings. */
export function useTimezone() {
  const row = settings.useRow();
  return row?.timezone || DEFAULT_TIMEZONE;
}

/** Recompute the default window (last DEFAULT_RANGE_DAYS days in the settings timezone). */
function updateDefaultRanges() {
  const tz = getTimezone();
  const range = daysRange(todayIn(tz), DEFAULT_RANGE_DAYS, tz);
  feedings.setDefaultRange(range);
  routineEvents.setDefaultRange(range);
}

/** Refresh every table the current user can read. */
export async function refreshAll() {
  await settings.load();
  updateDefaultRanges();
  const stores = isEditor() ? allStores.filter((s) => s !== settings) : publicStores.filter((s) => s !== settings);
  await Promise.all(stores.map((s) => s.load()));
}

let lastRefresh = 0;
let started = false;

/** Load on launch, refresh on tab focus (throttled) and react to editor sign-in/out. */
export function startDataSync() {
  if (started) return;
  started = true;
  updateDefaultRanges();
  lastRefresh = Date.now();
  refreshAll();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 30_000) {
        lastRefresh = Date.now();
        refreshAll();
      }
    });
  }
  onEditorChange((editor) => {
    if (editor) privateStores.forEach((s) => s.load());
    else privateStores.forEach((s) => s.clear());
  });
}
