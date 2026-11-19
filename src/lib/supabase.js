// Supabase client singleton. Import `getSupabase()` instead of creating clients.
import { createClient } from '../../vendor/supabase.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config.js';
import { reportRequest, monotonicNow } from './connectivity.js';

/** localStorage key of the persisted auth session (tests seed it to simulate an editor). */
export const AUTH_STORAGE_KEY = 'tt-auth';

/** @type {any} */
let client = null;

/** @type {(() => Promise<string | null>) | null} */
let renewToken = null;
/**
 * Called by auth.js: returns a fresh user token after a refresh, or null when it cannot.
 * @param {() => Promise<string | null>} fn
 */
export function setTokenRenewer(fn) {
  renewToken = fn;
}

/**
 * fetch for supabase-js: a REST or Storage request rejected with 401 (the user JWT expired, e.g.
 * while iOS kept the app suspended) refreshes the session and is sent once more with the new token.
 * Auth requests pass through untouched (they are the refresh).
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export async function sessionFetch(input, init) {
  const res = await reportedFetch(input, init);
  if (res.status !== 401 || !renewToken) return res;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/\/(rest|storage)\/v1\//.test(url)) return res;
  const headers = new Headers(init?.headers);
  const sent = (headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const token = await renewToken();
  if (!token || token === sent) return res;
  headers.set('Authorization', `Bearer ${token}`);
  return reportedFetch(input, { ...init, headers });
}

/**
 * fetch that tells connectivity.js whether the server was reached (any HTTP answer) or not
 * (network failure, or the write timeout in sync.js: the only abort of a Supabase request).
 * @param {RequestInfo | URL} input @param {RequestInit} [init]
 */
async function reportedFetch(input, init) {
  const startedAt = monotonicNow();
  try {
    const res = await fetch(input, init);
    reportRequest(true);
    return res;
  } catch (e) {
    reportRequest(false, startedAt);
    throw e;
  }
}

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
      global: { fetch: sessionFetch },
    });
  }
  return client;
}

/** True when the browser reports no connection. Writes fail fast in that case. */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
