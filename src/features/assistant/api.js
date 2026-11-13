// Calls to the `chat` Edge Function (supabase/functions/chat). Uses fetch directly so the answer can be
// read as a stream; the editor's session JWT authenticates the call.
//
// Session safety: every call gets a token from getAccessToken() (waits for the session to be
// restored, refreshes an expired or nearly expired token). A 401 refreshes the session and retries
// once. Only when the refresh is rejected does a call fail with 'unauthorized' (the session ended);
// when the auth server cannot be reached it fails with 'network', never "signed out".
import { isOffline } from '../../lib/supabase.js';
import { getAccessToken, refreshAccessToken } from '../../lib/auth.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../../config.js';
import { createSseParser } from './sse.js';
import { normalizeError, tokenErrorCode } from './logic.js';

export const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat`;

/**
 * Stop waiting for a stream that has sent nothing (not even the function's keep-alive comments,
 * every 15 s) for this long. Also the longest wait for the response to start.
 */
let stallMs = 45_000;
/** Tests shorten the stall timeout. @param {{ stallMs?: number }} o */
export function configureChat(o) {
  if (o.stallMs) stallMs = o.stallMs;
}

/**
 * @typedef {{ used_usd: number, budget_usd: number, remaining_usd: number }} Budget
 * @typedef {{ budget?: Budget, daily?: { used: number, limit: number }, enabled?: boolean }} Usage
 * @typedef {{ ok: boolean, data?: any, code?: string, usage?: Usage | null, unsent?: boolean }} Result
 *   ok: data; else code + usage. `unsent`: failed before the request left the device (no token,
 *   offline), so the server cannot have saved anything.
 */

/** @param {string} token */
const headersFor = (token) => ({ Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' });

/** @param {any} payload @returns {Usage | null} */
const usageOf = (payload) => (payload && (payload.budget || payload.daily) ? { budget: payload.budget, daily: payload.daily, enabled: payload.enabled } : null);

/** @param {string} code @returns {{ res: null, error: Result }} */
const failure = (code, usage = null) => ({ res: null, error: { ok: false, code, usage } });
/** @param {string} code @returns {{ res: null, error: Result }} */
const unsent = (code) => ({ res: null, error: { ok: false, code, usage: null, unsent: true } });

/**
 * POST with a fresh token; on 401 refresh the session and retry once.
 * @param {Record<string, unknown>} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ res: Response | null, error: Result | null }>}
 */
async function post(body, signal) {
  if (isOffline()) return unsent('offline');
  let auth = await getAccessToken();
  if (!auth.token) return unsent(tokenErrorCode(auth.error));
  try {
    let res = await fetch(CHAT_URL, { method: 'POST', headers: headersFor(auth.token), body: JSON.stringify(body), signal });
    if (res.status === 401) {
      // The token was refused (expired while the app was suspended, clock skew...): refresh once.
      auth = await refreshAccessToken();
      if (!auth.token) return unsent(tokenErrorCode(auth.error));
      res = await fetch(CHAT_URL, { method: 'POST', headers: headersFor(auth.token), body: JSON.stringify(body), signal });
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      if (res.status === 401) return failure('unauthorized', usageOf(payload));
      return failure(normalizeError(payload?.error, payload?.reason), usageOf(payload));
    }
    return { res, error: null };
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    return failure(isOffline() ? 'offline' : 'network');
  }
}

/** Budget and daily usage (no Claude call). @returns {Promise<Result>} */
export async function fetchStatus() {
  const { res, error } = await post({ action: 'status' });
  if (error) return error;
  return { ok: true, data: await /** @type {Response} */ (res).json() };
}

/** Draft a bilingual FAQ entry from a thread. @param {string} threadId @returns {Promise<Result>} */
export async function draftFaq(threadId) {
  const { res, error } = await post({ action: 'draft_faq', thread_id: threadId });
  if (error) return error;
  const payload = await /** @type {Response} */ (res).json().catch(() => null);
  if (!payload?.draft) return { ok: false, code: 'upstream_error', usage: usageOf(payload) };
  return { ok: true, data: payload };
}

/**
 * Ask a question and stream the answer. Callbacks fire per server event; resolves when the stream
 * ends. Throws AbortError when `signal` aborts. When nothing arrives for `stallMs` (no response,
 * no event, no keep-alive) the request is cancelled and the result is `{ code: 'timeout' }`.
 * `requestId` is the client-generated id of this question: sending the same id again never asks
 * Claude twice (the function replays the saved answer, or answers 'in_progress').
 * @param {{ threadId: string | null, message: string, requestId: string, signal: AbortSignal,
 *   onEvent: (event: string, data: any) => void }} o
 * @returns {Promise<Result | null>} an error result if the request was refused or failed, else null
 */
export async function streamAnswer({ threadId, message, requestId, signal, onEvent }) {
  // Our own controller, so the watchdog can cancel without looking like the person pressed stop.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let stalled = false;
  /** @type {any} */
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };
  // iOS freezes timers while the app is in the background: give the stream a fresh window when the
  // app comes back instead of judging it by the time spent suspended.
  const onVisible = () => {
    if (document.visibilityState === 'visible') arm();
  };
  document.addEventListener('visibilitychange', onVisible);
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    document.removeEventListener('visibilitychange', onVisible);
  };

  try {
    arm();
    let posted;
    try {
      posted = await post({ action: 'send', thread_id: threadId, message, request_id: requestId }, ctrl.signal);
    } catch (e) {
      if (stalled && !signal.aborted) return { ok: false, code: 'timeout', usage: null };
      throw e;
    }
    if (posted.error) return posted.error;
    const body = /** @type {Response} */ (posted.res).body;
    if (!body) return { ok: false, code: 'upstream_error', usage: null };
    const parser = createSseParser((e) => {
      let data = null;
      try {
        data = e.data ? JSON.parse(e.data) : null;
      } catch {
        return;
      }
      onEvent(e.event, data);
    });
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.end();
    } catch (e) {
      if (signal.aborted) throw e;
      if (stalled) return { ok: false, code: 'timeout', usage: null };
      return { ok: false, code: isOffline() ? 'offline' : 'network', usage: null };
    }
    return null;
  } finally {
    cleanup();
  }
}
