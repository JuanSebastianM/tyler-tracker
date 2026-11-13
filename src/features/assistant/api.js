// Calls to the `chat` Edge Function (supabase/functions/chat). Uses fetch directly so the answer can be
// read as a stream; the editor's session JWT authenticates the call.
import { getSupabase, isOffline } from '../../lib/supabase.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../../config.js';
import { createSseParser } from './sse.js';
import { normalizeError } from './logic.js';

export const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat`;

/**
 * @typedef {{ used_usd: number, budget_usd: number, remaining_usd: number }} Budget
 * @typedef {{ budget?: Budget, daily?: { used: number, limit: number }, enabled?: boolean }} Usage
 * @typedef {{ ok: boolean, data?: any, code?: string, usage?: Usage | null }} Result  ok: data; else code + usage
 */

async function headers() {
  const { data } = await getSupabase().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
}

/** @param {any} payload @returns {Usage | null} */
const usageOf = (payload) => (payload && (payload.budget || payload.daily) ? { budget: payload.budget, daily: payload.daily, enabled: payload.enabled } : null);

/**
 * @param {Record<string, unknown>} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ res: Response | null, error: Result | null }>}
 */
async function post(body, signal) {
  if (isOffline()) return { res: null, error: { ok: false, code: 'network', usage: null } };
  const h = await headers();
  if (!h) return { res: null, error: { ok: false, code: 'unauthorized', usage: null } };
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      return { res: null, error: { ok: false, code: normalizeError(payload?.error, payload?.reason), usage: usageOf(payload) } };
    }
    return { res, error: null };
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
    return { res: null, error: { ok: false, code: 'network', usage: null } };
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
 * ends. Throws AbortError when `signal` aborts.
 * @param {{ threadId: string | null, message: string, signal: AbortSignal,
 *   onEvent: (event: string, data: any) => void }} o
 * @returns {Promise<Result | null>} an error result if the request was refused, else null
 */
export async function streamAnswer({ threadId, message, signal, onEvent }) {
  const { res, error } = await post({ action: 'send', thread_id: threadId, message }, signal);
  if (error) return error;
  const body = /** @type {Response} */ (res).body;
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
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'AbortError' || signal.aborted) throw e;
    return { ok: false, code: 'network', usage: null };
  }
  return null;
}
