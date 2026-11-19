// Wires the outbox (outbox.js) to Supabase, the session, connectivity, toasts and the device's
// storage, and decides when to send: at launch, on reconnect, on resume, after sign-in and on a
// timer while the app is open. iOS has no Background Sync for web apps, so nothing is sent while
// the app is closed; it all goes out the next time it is opened with a connection.
import { createStore, useStore } from '../lib/store.js';
import { getSupabase } from '../lib/supabase.js';
import { authStore, getAccessToken, editorName, openSignIn } from '../lib/auth.js';
import { beginBusy } from '../lib/busy.js';
import { toast, dismissToast } from '../lib/toast.js';
import { t } from '../lib/i18n.js';
import { connectivity, onReconnect, reportRequest, startConnectivity } from '../lib/connectivity.js';
import { openOutboxStorage, requestPersistentStorage } from '../lib/idb.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { createOutbox } from './outbox.js';
import { classifyResult } from './outbox-logic.js';

/** A write that gets no answer within this time counts as "no connection" (bad signal). */
const SEND_TIMEOUT_MS = 20_000;
/** While the app is open: retry queued changes / probe the connection this often. */
const TICK_MS = 30_000;

/**
 * One request for a queued change. Idempotent: ids are generated on the device, so a retry after
 * an answer that never arrived cannot create a second row, and deleting twice is harmless.
 * @param {import('./outbox-logic.js').Op} op
 * @returns {Promise<import('./outbox.js').SendResult>}
 */
export async function sendOp(op, client = getSupabase(), timeoutMs = SEND_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const done = beginBusy('write');
  const from = () => client.from(op.table);
  /** @param {any} res */
  const failure = (res) => {
    const c = classifyResult(res);
    return { status: /** @type {any} */ (c === 'duplicate' ? 'rejected' : c), error: { ...(res.error || {}), message: res.error?.message, code: res.error?.code, status: res.status || 0 } };
  };
  try {
    /** @type {any} */
    let res;
    switch (op.kind) {
      case 'insert': {
        res = await from().insert(op.values).select().abortSignal(ctrl.signal).single();
        if (classifyResult(res) === 'duplicate') {
          // An earlier attempt reached the server (its answer was lost). Apply the values, which
          // may have grown with edits made since, instead of creating anything.
          const patch = { ...op.values };
          delete patch[op.key];
          const again = Object.keys(patch).length
            ? await from().update(patch).eq(op.key, op.rowKey).select().abortSignal(ctrl.signal)
            : await from().select('*').eq(op.key, op.rowKey).abortSignal(ctrl.signal);
          if (again.error) return failure(again);
          if (!again.data?.length) return failure(res); // a different unique column clashed
          return { status: 'ok', row: again.data[0] };
        }
        break;
      }
      case 'update': {
        res = await from().update(op.values).eq(op.key, op.rowKey).select().abortSignal(ctrl.signal);
        if (!res.error) return res.data?.length ? { status: 'ok', row: res.data[0] } : { status: 'gone' };
        break;
      }
      case 'upsert':
        res = await from().upsert(op.values, { onConflict: op.key }).select().abortSignal(ctrl.signal).single();
        break;
      case 'delete':
        res = await from().delete().eq(op.key, op.rowKey).abortSignal(ctrl.signal);
        if (!res.error) return { status: 'ok', row: null };
        break;
    }
    if (!res.error) return { status: 'ok', row: res.data ?? null };
    return failure(res);
  } catch (e) {
    return { status: 'network', error: { message: String(e), code: '', status: 0 } };
  } finally {
    clearTimeout(timer);
    done();
  }
}

/** @type {number} the current "could not be saved" toast */
let rejectedToast = 0;

/** The sync sheet (pending changes, "could not be saved" list) is open. */
export const syncSheetStore = createStore(false);
export const openSyncSheet = () => {
  // The sheet shows the refused changes: the toast that pointed to them has done its job.
  if (rejectedToast) dismissToast(rejectedToast);
  rejectedToast = 0;
  syncSheetStore.set(true);
};
export const closeSyncSheet = () => syncSheetStore.set(false);

/** Tells other tabs of this app that the stored outbox changed (opened by startSync). */
/** @type {BroadcastChannel | null} */
let channel = null;

export const outbox = createOutbox({
  storage: typeof indexedDB === 'undefined' && typeof localStorage === 'undefined' ? memoryStorage() : openOutboxStorage(),
  send: (op) => sendOp(op),
  session: async () => {
    const r = await getAccessToken();
    return !r.error ? 'ok' : r.error === 'network' ? 'network' : 'ended';
  },
  canTry: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  userId: () => (authStore.get().status === 'signedIn' ? authStore.get().user?.id || null : null),
  userName: () => editorName() || null,
  uuid: () => crypto.randomUUID(),
  beginBusy,
  // A visit's private cost row has the visit id as its key: it goes when the visit goes.
  dependents: { vet_visits: ['vet_visit_private'] },
  onPersisted: () => channel?.postMessage('changed'),
  onNotice: (n) => {
    if (n.type === 'rejected') {
      // One toast for a batch of refusals, counting them.
      if (rejectedToast) dismissToast(rejectedToast);
      const count = outbox.state.get().rejected.length;
      rejectedToast = toast(t('sync.rejectedToast', { count }), { tone: 'error', duration: 10000, action: { label: t('sync.review'), onClick: openSyncSheet } });
    } else if (n.type === 'gone') {
      toast(t('sync.goneToast'));
    }
  },
});

/** In-memory storage (Node without IndexedDB/localStorage: unit tests importing the stores). */
function memoryStorage() {
  /** @type {Record<string, Map<string, any>>} */
  const m = { ops: new Map(), rejected: new Map() };
  return {
    load: async () => ({ ops: [...m.ops.values()], rejected: [...m.rejected.values()] }),
    put: async (/** @type {'ops' | 'rejected'} */ s, /** @type {any} */ r) => void m[s].set(r.id, r),
    del: async (/** @type {'ops' | 'rejected'} */ s, /** @type {string} */ id) => void m[s].delete(id),
  };
}

/**
 * Summary for the indicator.
 * @typedef {object} SyncSummary
 * @property {boolean} online
 * @property {number} pending       queued changes on this device
 * @property {number} rejected      changes the server refused
 * @property {boolean} needsSignIn  queued changes wait for their author to sign in
 * @property {boolean} syncing
 * @property {null | 'offline' | 'session' | 'server'} blocked
 */

/** @returns {SyncSummary} */
export function syncSummary() {
  const s = outbox.state.get();
  const online = connectivity.get().online;
  return {
    online,
    pending: s.ops.length,
    rejected: s.rejected.length,
    needsSignIn: s.blocked === 'session' && s.ops.length > 0,
    syncing: s.syncing,
    blocked: s.blocked,
  };
}

/** Hook: the sync summary (re-renders on outbox or connectivity changes). */
export function useSyncSummary() {
  const s = useStore(outbox.state);
  const online = useStore(connectivity, (c) => c.online);
  return {
    online,
    pending: s.ops.length,
    rejected: s.rejected.length,
    needsSignIn: s.blocked === 'session' && s.ops.length > 0,
    syncing: s.syncing,
    blocked: s.blocked,
  };
}

/** Hook: the outbox state (ops and refused changes). */
export function useOutbox() {
  return useStore(outbox.state);
}

/** Probe the backend when the app thinks it is offline but the phone has a network. */
async function probe() {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD', headers: { apikey: SUPABASE_KEY }, cache: 'no-store' });
    reportRequest(true);
  } catch {
    reportRequest(false);
  }
}

/** Ask to sign in when queued changes are waiting for an ended session (once per block). */
let askedSignIn = false;

let started = false;
/** Start sending queued changes. Called once at boot (after initAuth). */
export function startSync() {
  if (started) return;
  started = true;
  startConnectivity();
  requestPersistentStorage();
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('tt-outbox');
  } catch {
    channel = null;
  }
  outbox.load().then(() => outbox.kick());
  channel?.addEventListener('message', () => outbox.load().then(() => outbox.kick()));
  onReconnect(() => outbox.kick());
  // Signed in again (or the session was restored at launch): send what waited.
  let lastUser = authStore.get().user?.id || null;
  authStore.subscribe((s) => {
    const id = s.status === 'signedIn' ? s.user?.id || null : null;
    if (id && id !== lastUser) {
      askedSignIn = false;
      outbox.kick();
    }
    lastUser = id;
  });
  outbox.state.subscribe((s) => {
    if (s.blocked === 'session' && s.ops.length && !askedSignIn && authStore.get().status !== 'loading') {
      askedSignIn = true;
      // The session ended toast (auth.js) may already be on screen; this one says nothing is lost.
      toast(t('sync.signInToSync', { count: s.ops.length }), { tone: 'info', duration: 10000, action: { label: t('auth.signIn'), onClick: openSignIn } });
    }
    if (s.blocked !== 'session') askedSignIn = false;
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') outbox.kick();
    });
    window.addEventListener('online', () => outbox.kick());
    setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (outbox.state.get().ops.length) outbox.kick();
      else if (!connectivity.get().online && connectivity.get().browser) probe();
    }, TICK_MS);
  }
}
