// Assistant state shared by the screens: the answer being streamed, the last error, usage, and the
// messages of the threads that were opened. Lives outside components so an answer keeps streaming
// while the editor moves around the app.
//
// Nothing the person typed is lost:
//  - the composer text is saved per conversation (`assistant.drafts`, this device only) as it is
//    typed, so a reload or relaunch restores it;
//  - the question being answered is saved with its request id (`assistant.inflight`) until the
//    answer arrives. If the app is closed, reloaded or the stream stalls, the thread is checked for a
//    saved answer before anything is resent; if there is none the question goes back to the composer
//    with a retry that reuses the same request id (the function never asks Claude twice for one id).
// Both are cleared when the editor signs out on purpose.
import { createStore, useStore } from '../../lib/store.js';
import { onEditorChange, onSignOut, editorName } from '../../lib/auth.js';
import { getSupabase } from '../../lib/supabase.js';
import { navigate, locationStore } from '../../lib/router.js';
import { readJSON, writeJSON, removeKey } from '../../lib/storage.js';
import { beginBusy } from '../../lib/busy.js';
import { withTimeout } from '../../lib/auth-logic.js';
import { updateStore } from '../../lib/pwa.js';
import { chatThreads } from '../../data/stores.js';
import { fetchStatus, streamAnswer } from './api.js';
import { answerFor, draftKey, normalizeError, withUpdateHint } from './logic.js';

const DRAFTS_KEY = 'assistant.drafts';
const INFLIGHT_KEY = 'assistant.inflight';
/** Codes after which the server may still have saved an answer: check before showing the error. */
const MAYBE_SAVED = new Set(['timeout', 'network', 'offline', 'upstream_error']);

/**
 * @typedef {object} Pending
 * @property {string | null} threadId
 * @property {string} question
 * @property {string} askedBy
 * @property {string} text
 * @property {'sending' | 'searching' | 'streaming' | 'checking'} status
 * @property {string} startedAt
 * @property {string} [requestId] the question's request id (= the saved question's id)
 * @property {string} [savedId] id of the saved assistant message (from the 'done' event); once the
 *   reloaded thread contains it, the chat shows the saved row instead of this bubble
 *
 * @typedef {{ code: string, question: string, threadId: string | null, requestId: string | null }} ChatError
 *
 * @typedef {object} SessionState
 * @property {Pending | null} pending
 * @property {ChatError | null} error
 * @property {import('./api.js').Usage | null} usage
 *
 * @typedef {{ key: string, threadId: string | null, question: string, requestId: string, startedAt: string,
 *   createdThreadId?: string }} Inflight  createdThreadId: id announced for a new conversation (it only
 *   exists on the server once the answer is saved)
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
onSignOut(() => {
  removeKey(DRAFTS_KEY);
  removeKey(INFLIGHT_KEY);
});

export const useSession = () => useStore(session);

/** @param {string} threadId */
export function useThreadMessages(threadId) {
  return useStore(threadMessages, (s) => (threadId ? s[threadId] : undefined));
}

// ---- Drafts ----

/** Unsent composer text of a conversation. @param {string} key */
export function getDraft(key) {
  const all = readJSON(DRAFTS_KEY, /** @type {Record<string, string>} */ ({}));
  return typeof all?.[key] === 'string' ? all[key] : '';
}

/** @param {string} key @param {string} text */
export function setDraft(key, text) {
  const all = { ...readJSON(DRAFTS_KEY, /** @type {Record<string, string>} */ ({})) };
  if (text.trim()) all[key] = text;
  else delete all[key];
  if (Object.keys(all).length) writeJSON(DRAFTS_KEY, all);
  else removeKey(DRAFTS_KEY);
}

/** Put a question back in its conversation's composer, unless something else was typed there. */
function restoreDraft(/** @type {string} */ key, /** @type {string} */ question) {
  if (!getDraft(key).trim()) setDraft(key, question);
}

// ---- Threads ----

/** Load (or reload) one thread's messages. @param {string} threadId */
export async function loadThreadMessages(threadId) {
  threadMessages.set((s) => ({ ...s, [threadId]: { rows: s[threadId]?.rows || [], status: s[threadId]?.rows?.length ? 'ready' : 'loading' } }));
  try {
    const { data, error } = await getSupabase().from('chat_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true });
    if (error) throw error;
    threadMessages.set((s) => ({ ...s, [threadId]: { rows: data || [], status: 'ready' } }));
    return true;
  } catch {
    threadMessages.set((s) => ({ ...s, [threadId]: { rows: s[threadId]?.rows || [], status: 'error' } }));
    return false;
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

/**
 * Was the question with this request id answered and saved? The function saves the question with
 * the request id as its id, so one query finds its thread. Returns the thread id, or null.
 * @param {string} requestId
 */
async function findSavedAnswer(requestId) {
  try {
    const { data, error } = await withTimeout(getSupabase().from('chat_messages').select('id,thread_id').eq('id', requestId).limit(1), 10000);
    if (error || !data?.length) return null;
    const threadId = data[0].thread_id;
    if (!(await loadThreadMessages(threadId))) return null;
    return answerFor(threadMessages.get()[threadId]?.rows || [], requestId) ? threadId : null;
  } catch {
    return null;
  }
}

/** Show a saved thread in place of a new conversation that had no id yet. @param {string} threadId */
function followNewThread(threadId) {
  const loc = locationStore.get();
  if (loc.path === '/assistant' && !loc.query.t) navigate(`/assistant?t=${threadId}`, { replace: true });
}

/**
 * A new conversation whose first answer was not saved does not exist on the server: leave its
 * announced id for the "new conversation" screen, where the question waits in the composer.
 * @param {string | undefined} createdThreadId
 */
function abandonNewThread(createdThreadId) {
  const loc = locationStore.get();
  if (createdThreadId && loc.path === '/assistant' && loc.query.t === createdThreadId) navigate('/assistant', { replace: true });
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

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask a question in a thread (null = new conversation). One question at a time.
 * Pass the `requestId` of a failed attempt to retry it without risking a second answer.
 * @param {string | null} threadId
 * @param {string} question
 * @param {{ requestId?: string | null }} [opts]
 */
export async function ask(threadId, question, opts = {}) {
  if (session.get().pending) return;
  const requestId = opts.requestId || crypto.randomUUID();
  const ctrl = new AbortController();
  controller = ctrl;
  const endBusy = beginBusy('assistant'); // no update reload while this runs
  /** @type {Inflight} */
  const inflight = { key: draftKey(threadId), threadId, question, requestId, startedAt: new Date().toISOString() };
  writeJSON(INFLIGHT_KEY, inflight);
  /** @type {string | null} */
  let currentThread = threadId;
  let finished = false;
  session.set((s) => ({
    ...s,
    error: null,
    pending: { threadId, question, askedBy: editorName(), text: '', status: 'sending', startedAt: inflight.startedAt, requestId },
  }));
  /** @param {(p: Pending) => Pending} fn */
  const patch = (fn) => session.set((s) => (s.pending ? { ...s, pending: fn(s.pending) } : s));
  /** Reload the thread, then drop the streaming bubble (no flicker). */
  const settle = async () => {
    removeKey(INFLIGHT_KEY);
    if (currentThread) {
      await Promise.all([loadThreadMessages(currentThread), chatThreads.load()]);
    }
    session.set((s) => ({ ...s, pending: null }));
  };
  /**
   * Show an error, after checking (when the answer may exist) that nothing was saved meanwhile.
   * @param {string} code @param {any} usage @param {boolean} [sent] false: the request never left
   */
  const fail = async (code, usage, sent = true) => {
    finished = true;
    code = normalizeError(code);
    if (sent && (MAYBE_SAVED.has(code) || code === 'in_progress')) {
      patch((p) => ({ ...p, status: 'checking' }));
      // The function saves what it had when the connection dropped; give it a moment. While it is
      // still answering ('in_progress') keep checking for up to a minute.
      const attempts = code === 'in_progress' ? 12 : 1;
      for (let i = 0; i < attempts; i++) {
        await sleep(code === 'in_progress' ? 5000 : 1500);
        if (ctrl.signal.aborted) break;
        const saved = await findSavedAnswer(requestId);
        if (saved) {
          currentThread = saved;
          if (!threadId) followNewThread(saved);
          await settle();
          refreshUsage();
          return;
        }
      }
    }
    removeKey(INFLIGHT_KEY);
    if (!threadId) {
      abandonNewThread(currentThread || undefined);
      currentThread = null;
    }
    restoreDraft(draftKey(currentThread), question);
    session.set((s) => ({
      ...s,
      pending: null,
      error: { code: withUpdateHint(code, updateStore.get().ready), question, threadId: currentThread, requestId },
      usage: usage ? { ...s.usage, ...usage } : s.usage,
    }));
  };

  try {
    /** @type {{ code: string, usage: any } | null} */
    let streamError = null;
    const refused = await streamAnswer({
      threadId,
      message: question,
      requestId,
      signal: ctrl.signal,
      onEvent(event, data) {
        if (event === 'meta' && data?.thread_id) {
          currentThread = data.thread_id;
          patch((p) => ({ ...p, threadId: data.thread_id }));
          // A new conversation gets its id now: keep the URL in sync without remounting the screen.
          if (!threadId) {
            followNewThread(data.thread_id);
            writeJSON(INFLIGHT_KEY, { ...inflight, createdThreadId: data.thread_id });
          }
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
          streamError = { code: normalizeError(data?.error, data?.reason), usage: data?.budget ? data : null };
        }
      },
    });
    if (refused && !refused.ok) return await fail(refused.code || 'server_error', refused.usage, !refused.unsent);
    if (streamError) return await fail(/** @type {any} */ (streamError).code, /** @type {any} */ (streamError).usage);
    if (!finished) return await fail('upstream_error', null); // the stream ended without an answer
    await settle();
  } catch (e) {
    if (ctrl.signal.aborted) {
      // Stopped: the function saves the partial answer; give it a moment, then reload the thread.
      await sleep(1200);
      await settle();
      refreshUsage();
    } else {
      await fail('network', null);
    }
  } finally {
    if (controller === ctrl) controller = null;
    endBusy();
  }
}

let resumed = false;
/**
 * After a reload or relaunch: a question that was being answered when the app went away is
 * either answered in its thread by now (show it) or comes back to the composer with a retry.
 * Runs once per app run, when the chat opens.
 */
export async function resumeInterrupted() {
  if (resumed || controller || session.get().pending) return;
  resumed = true;
  /** @type {Inflight | null} */
  const inf = readJSON(INFLIGHT_KEY, null);
  if (!inf?.requestId || !inf.question) return;
  session.set((s) => ({
    ...s,
    pending: { threadId: inf.threadId, question: inf.question, askedBy: editorName(), text: '', status: 'checking', startedAt: inf.startedAt, requestId: inf.requestId },
  }));
  const saved = await findSavedAnswer(inf.requestId);
  removeKey(INFLIGHT_KEY);
  if (saved) {
    if (!inf.threadId) followNewThread(saved);
    chatThreads.load();
    session.set((s) => ({ ...s, pending: null }));
    return;
  }
  if (!inf.threadId) abandonNewThread(inf.createdThreadId);
  restoreDraft(inf.key, inf.question);
  session.set((s) => ({
    ...s,
    pending: null,
    error: { code: 'interrupted', question: inf.question, threadId: inf.threadId, requestId: inf.requestId },
  }));
}
