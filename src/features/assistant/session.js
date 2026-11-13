// Assistant state shared by the screens: the answer being streamed, the last error, usage, and the
// messages of the threads that were opened. Lives outside components so an answer keeps streaming
// while the editor moves around the app.
import { createStore, useStore } from '../../lib/store.js';
import { onEditorChange } from '../../lib/auth.js';
import { getSupabase } from '../../lib/supabase.js';
import { navigate, locationStore } from '../../lib/router.js';
import { chatThreads } from '../../data/stores.js';
import { editorName } from '../../lib/auth.js';
import { fetchStatus, streamAnswer } from './api.js';
import { normalizeError } from './logic.js';

/**
 * @typedef {object} Pending
 * @property {string | null} threadId
 * @property {string} question
 * @property {string} askedBy
 * @property {string} text
 * @property {'sending' | 'searching' | 'streaming'} status
 * @property {string} startedAt
 * @property {string} [savedId] id of the saved assistant message (from the 'done' event); once the
 *   reloaded thread contains it, the chat shows the saved row instead of this bubble
 *
 * @typedef {object} SessionState
 * @property {Pending | null} pending
 * @property {{ code: string, question: string, threadId: string | null } | null} error
 * @property {import('./api.js').Usage | null} usage
 */

/** @type {import('../../lib/store.js').Store<SessionState>} */
export const session = createStore(/** @type {SessionState} */ ({ pending: null, error: null, usage: null }));

/**
 * Messages per thread (editors only; not cached on the device).
 * @type {import('../../lib/store.js').Store<Record<string, { rows: any[], status: 'loading' | 'ready' | 'error' }>>}
 */
export const threadMessages = createStore({});

/** @type {AbortController | null} */
let controller = null;

onEditorChange((isEditor) => {
  if (!isEditor) {
    controller?.abort();
    session.set({ pending: null, error: null, usage: null });
    threadMessages.set({});
  }
});

export const useSession = () => useStore(session);

/** @param {string} threadId */
export function useThreadMessages(threadId) {
  return useStore(threadMessages, (s) => (threadId ? s[threadId] : undefined));
}

/** Load (or reload) one thread's messages. @param {string} threadId */
export async function loadThreadMessages(threadId) {
  threadMessages.set((s) => ({ ...s, [threadId]: { rows: s[threadId]?.rows || [], status: s[threadId]?.rows?.length ? 'ready' : 'loading' } }));
  try {
    const { data, error } = await getSupabase().from('chat_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true });
    if (error) throw error;
    threadMessages.set((s) => ({ ...s, [threadId]: { rows: data || [], status: 'ready' } }));
  } catch {
    threadMessages.set((s) => ({ ...s, [threadId]: { rows: s[threadId]?.rows || [], status: 'error' } }));
  }
}

/** Forget a deleted thread's messages. @param {string} threadId */
export function forgetThread(threadId) {
  threadMessages.set((s) => {
    const next = { ...s };
    delete next[threadId];
    return next;
  });
}

/** Refresh the budget indicator. */
export async function refreshUsage() {
  const r = await fetchStatus();
  if (r.ok) session.set((s) => ({ ...s, usage: r.data }));
  else if (r.usage) session.set((s) => ({ ...s, usage: { ...s.usage, ...r.usage } }));
}

export function clearError() {
  session.set((s) => ({ ...s, error: null }));
}

/** Stop the answer being streamed. The function saves what was generated so far. */
export function stopAnswer() {
  controller?.abort();
}

/**
 * Ask a question in a thread (null = new conversation). One question at a time.
 * @param {string | null} threadId
 * @param {string} question
 */
export async function ask(threadId, question) {
  if (session.get().pending) return;
  const ctrl = new AbortController();
  controller = ctrl;
  /** @type {string | null} */
  let currentThread = threadId;
  let finished = false;
  session.set((s) => ({
    ...s,
    error: null,
    pending: { threadId, question, askedBy: editorName(), text: '', status: 'sending', startedAt: new Date().toISOString() },
  }));
  /** @param {(p: Pending) => Pending} fn */
  const patch = (fn) => session.set((s) => (s.pending ? { ...s, pending: fn(s.pending) } : s));
  /** @param {string} code @param {any} usage */
  const fail = (code, usage) => {
    finished = true;
    session.set((s) => ({
      ...s,
      pending: null,
      error: { code: normalizeError(code), question, threadId: currentThread },
      usage: usage ? { ...s.usage, ...usage } : s.usage,
    }));
  };
  /** Reload the thread, then drop the streaming bubble (no flicker). */
  const settle = async () => {
    if (currentThread) {
      await Promise.all([loadThreadMessages(currentThread), chatThreads.load()]);
    }
    session.set((s) => ({ ...s, pending: null }));
  };

  try {
    const refused = await streamAnswer({
      threadId,
      message: question,
      signal: ctrl.signal,
      onEvent(event, data) {
        if (event === 'meta' && data?.thread_id) {
          currentThread = data.thread_id;
          patch((p) => ({ ...p, threadId: data.thread_id }));
          // A new conversation gets its id now: keep the URL in sync without remounting the screen.
          const loc = locationStore.get();
          if (!threadId && loc.path === '/assistant' && !loc.query.t) navigate(`/assistant?t=${data.thread_id}`, { replace: true });
        } else if (event === 'delta' && typeof data?.text === 'string') {
          patch((p) => ({ ...p, text: p.text + data.text, status: 'streaming' }));
        } else if (event === 'status' && data?.state === 'searching') {
          patch((p) => ({ ...p, status: p.text ? p.status : 'searching' }));
        } else if (event === 'done') {
          finished = true;
          session.set((s) => ({
            ...s,
            pending: s.pending ? { ...s.pending, savedId: data?.message?.id } : s.pending,
            usage: { budget: data.budget, daily: data.daily, enabled: data.enabled },
          }));
        } else if (event === 'error') {
          fail(data?.error, data?.budget ? data : null);
        }
      },
    });
    if (refused && !refused.ok) return fail(refused.code, refused.usage);
    if (!finished) return fail('upstream_error', null);
    if (session.get().error) return; // an error event arrived
    await settle();
  } catch (e) {
    if (ctrl.signal.aborted) {
      // Stopped: the function saves the partial answer; give it a moment, then reload the thread.
      await new Promise((r) => setTimeout(r, 1200));
      await settle();
      refreshUsage();
    } else {
      fail('network', null);
    }
  } finally {
    if (controller === ctrl) controller = null;
  }
}
