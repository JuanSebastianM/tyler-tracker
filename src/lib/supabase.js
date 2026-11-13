// Supabase client singleton. Import `getSupabase()` instead of creating clients.
import { createClient } from '../../vendor/supabase.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config.js';

/** localStorage key of the persisted auth session (tests seed it to simulate an editor). */
export const AUTH_STORAGE_KEY = 'tt-auth';

/** @type {any} */
let client = null;

/** @returns {any} SupabaseClient */
export function getSupabase() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: AUTH_STORAGE_KEY,
      },
    });
  }
  return client;
}

/** True when the browser reports no connection. Writes fail fast in that case. */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
