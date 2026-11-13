// Pure helpers for session handling (no Supabase import): unit-tested in tests/unit/auth-logic.test.mjs.

/** An access token is refreshed before use when it expires within this many seconds. */
export const TOKEN_MIN_VALIDITY_S = 60;

/**
 * Why a token could not be obtained:
 *  - 'network': the auth server could not be reached (offline, iOS resume, timeout, 5xx). The session
 *    is still there: say "no connection", never "you are signed out".
 *  - 'expired': the auth server rejected the refresh token. The session really ended.
 *  - 'signedOut': there is no session on this device.
 * @typedef {'network' | 'expired' | 'signedOut'} TokenError
 */

/**
 * Classify an error from supabase-js auth (refreshSession / getSession) or a thrown exception.
 * @param {any} error
 * @returns {TokenError}
 */
export function classifyAuthError(error) {
  if (!error) return 'network';
  const name = String(error.name || '');
  if (name === 'AuthSessionMissingError') return 'signedOut';
  if (name === 'AuthRetryableFetchError' || name === 'TimeoutError' || name === 'TypeError' || name === 'AbortError') return 'network';
  const status = Number(error.status);
  // No HTTP status means the request never completed; 5xx, 408 and 429 are the server's problem.
  if (!status || status >= 500 || status === 408 || status === 429) return 'network';
  return 'expired';
}

/**
 * Does this stored session need a refresh before its token is sent?
 * @param {{ access_token?: string, expires_at?: number } | null | undefined} session
 * @param {number} nowMs
 * @param {number} [minValidityS]
 */
export function needsRefresh(session, nowMs, minValidityS = TOKEN_MIN_VALIDITY_S) {
  if (!session?.access_token) return true;
  if (!session.expires_at) return false;
  return session.expires_at * 1000 - nowMs < minValidityS * 1000;
}

/**
 * The session as supabase-js keeps it in localStorage, or null. Only sessions that can still be
 * refreshed count.
 * @param {string | null} raw
 * @returns {{ access_token: string, refresh_token: string, expires_at?: number, user?: { id: string, email?: string } } | null}
 */
export function parseStoredSession(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    const session = s?.currentSession || s;
    return session && typeof session.refresh_token === 'string' && session.refresh_token && typeof session.access_token === 'string' ? session : null;
  } catch {
    return null;
  }
}

/**
 * Reject with a TimeoutError if `promise` has not settled within `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  /** @type {any} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}
