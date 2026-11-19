// The offline outbox: every store write becomes a queued change, stored on the device first and
// then sent in order. It is how the app keeps working with no connection.
//
//   const outbox = createOutbox(deps);     // src/data/sync.js wires the real dependencies
//   await outbox.load();                    // queued changes from the last session
//   const r = await outbox.write({ table, key, rowKey, kind, values });
//     // r.status: 'synced' (row) | 'queued' (kept on the device) | 'failed' (refused while the
//     //           person waited: the store rolls back) | 'gone' (the row was deleted elsewhere) |
//     //           'cancelled' (coalesced away, nothing to send)
//   outbox.kick();                          // try to send now (reconnect, launch, resume, timer)
//
// Rules (docs/ARCHITECTURE.md, "Offline writes"):
//  - A change is stored before it is sent and removed only after the server confirmed it.
//  - Changes are sent one at a time in the order they were made, only while their author is
//    signed in with a valid session (refreshed first; a session that really ended blocks the
//    queue and asks to sign in, nothing is dropped).
//  - A caller waits for its own write up to `waitMs`. While it waits, a refusal rolls it back (as
//    online writes always did); once it was told "queued", a refusal moves it to the visible
//    "could not be saved" list and transient errors are retried with backoff.
import { createStore } from '../lib/store.js';
import { coalesce, sortOps, backoffMs, MAX_TRANSIENT_ATTEMPTS, OP_VERSION } from './outbox-logic.js';

/** @typedef {import('./outbox-logic.js').Op} Op */
/** @typedef {import('./outbox-logic.js').Rejected} Rejected */

/**
 * @typedef {'synced' | 'queued' | 'failed' | 'gone' | 'cancelled'} WriteStatus
 * @typedef {{ status: WriteStatus, row?: any, error?: any }} WriteResult
 * @typedef {{ status: 'ok' | 'network' | 'auth' | 'transient' | 'gone' | 'rejected', row?: any, error?: any }} SendResult
 *
 * @typedef {object} OutboxStorage   durable storage (IndexedDB in the app, a fake in tests)
 * @property {() => Promise<{ ops: any[], rejected: any[] }>} load
 * @property {(store: 'ops' | 'rejected', record: any) => Promise<void>} put
 * @property {(store: 'ops' | 'rejected', id: string) => Promise<void>} del
 *
 * @typedef {object} OutboxDeps
 * @property {OutboxStorage} storage
 * @property {(op: Op) => Promise<SendResult>} send     one request; never throws for HTTP errors
 * @property {() => Promise<'ok' | 'network' | 'ended'>} session  a valid token (refreshed if needed)?
 * @property {() => boolean} [canTry]  false when the device has no network at all (nothing is sent)
 * @property {() => string | null} userId               signed-in user, if any
 * @property {() => string | null} userName
 * @property {() => string} uuid
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => () => void} [schedule]
 * @property {(notice: { type: 'rejected' | 'gone', op: Op }) => void} [onNotice]
 * @property {() => void} [onPersisted]                 after every storage change (other tabs reload)
 * @property {(reason: string) => () => void} [beginBusy]
 * @property {Record<string, string[]>} [dependents]
 * @property {number} [waitMs]       how long a caller waits before its write counts as queued
 * @property {number} [offlineRetryMs]
 *
 * @typedef {object} OutboxState
 * @property {boolean} loaded
 * @property {Op[]} ops
 * @property {Rejected[]} rejected
 * @property {boolean} syncing
 * @property {null | 'offline' | 'session' | 'server'} blocked  why queued changes are not being sent
 * @property {number} retryAt          epoch ms of the next retry after a server error (0 = none)
 * @property {number} lastSyncedAt
 */

/** @param {OutboxDeps} deps */
export function createOutbox(deps) {
  const now = deps.now || (() => Date.now());
  const schedule =
    deps.schedule ||
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      /** @type {any} */ (id)?.unref?.();
      return () => clearTimeout(id);
    });
  const waitMs = deps.waitMs ?? 8000;
  const offlineRetryMs = deps.offlineRetryMs ?? 15_000;

  /** @type {import('../lib/store.js').Store<OutboxState>} */
  const state = createStore(
    /** @type {OutboxState} */ ({ loaded: false, ops: [], rejected: [], syncing: false, blocked: null, retryAt: 0, lastSyncedAt: 0 }),
  );

  /** Ops being sent right now (never coalesced into). */
  const inflight = new Set();
  /** Ops whose author was told "queued" (or that come from storage): never rolled back silently. */
  const queuedOnce = new Set();
  /** @type {Map<string, Array<(r: WriteResult) => void>>} callers waiting for an op */
  const waiters = new Map();
  /** @type {Record<string, { synced?: (op: Op, row: any) => void, gone?: (op: Op) => void }>} */
  const handlers = {};
  let seq = 0;

  /** @type {(v?: unknown) => void} */
  let markLoaded = () => {};
  const loadedPromise = new Promise((r) => (markLoaded = r));

  // ---- storage (serialized so puts and deletes land in order) ----
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @param {() => Promise<void>} fn */
  function persist(fn) {
    const done = deps.beginBusy?.('outbox') || (() => {});
    const p = chain.then(fn).catch((e) => console.warn('outbox storage failed', e));
    chain = p.finally(() => {
      done();
      deps.onPersisted?.();
    });
    return chain;
  }

  /** @param {Partial<OutboxState>} patch */
  const set = (patch) => state.set((s) => ({ ...s, ...patch }));

  /** Settle every caller waiting for `id`. @param {string} id @param {WriteResult} result */
  function settle(id, result) {
    const list = waiters.get(id);
    if (!list) return;
    waiters.delete(id);
    for (const fn of list) fn(result);
  }

  /** Callers stop waiting: their changes stay queued on the device. */
  function settleAllQueued() {
    for (const id of [...waiters.keys()]) {
      queuedOnce.add(id);
      settle(id, { status: 'queued' });
    }
  }

  /** @param {string} id */
  function waitFor(id) {
    return new Promise((resolve) => {
      /** @type {(r: WriteResult) => void} */
      const fn = (r) => {
        cancel();
        resolve(r);
      };
      const cancel = schedule(() => {
        const list = waiters.get(id);
        if (!list) return;
        const rest = list.filter((f) => f !== fn);
        if (rest.length) waiters.set(id, rest);
        else waiters.delete(id);
        queuedOnce.add(id);
        resolve({ status: 'queued' });
      }, waitMs);
      waiters.set(id, [...(waiters.get(id) || []), fn]);
    });
  }

  /** @param {string} id */
  function removeOp(id) {
    set({ ops: state.get().ops.filter((o) => o.id !== id) });
    queuedOnce.delete(id);
    return persist(() => deps.storage.del('ops', id));
  }

  /** @param {Op} op @param {any} error */
  function reject(op, error) {
    /** @type {Rejected} */
    const rec = {
      id: op.id,
      op,
      error: { code: String(error?.code || ''), message: String(error?.message || error || ''), status: Number(error?.status || 0) },
      at: now(),
    };
    set({ ops: state.get().ops.filter((o) => o.id !== op.id), rejected: [...state.get().rejected.filter((r) => r.id !== op.id), rec] });
    queuedOnce.delete(op.id);
    persist(async () => {
      await deps.storage.put('rejected', rec);
      await deps.storage.del('ops', op.id);
    });
    deps.onNotice?.({ type: 'rejected', op });
  }

  // ---- sending ----
  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  /** @type {(() => void) | null} */
  let retryTimer = null;

  /** @param {number} ms */
  function retryIn(ms) {
    retryTimer?.();
    retryTimer = schedule(() => {
      retryTimer = null;
      api.kick();
    }, ms);
  }

  async function loop() {
    await loadedPromise;
    for (;;) {
      const uid = deps.userId();
      const ops = state.get().ops;
      const next = uid ? ops.find((o) => o.v === OP_VERSION && o.userId === uid) : null;
      if (!next) {
        // Nothing this person can send. Changes made by someone not signed in now wait for them.
        set({ syncing: false, blocked: ops.some((o) => o.v === OP_VERSION) ? 'session' : null, retryAt: 0 });
        settleAllQueued();
        return;
      }
      if (deps.canTry && !deps.canTry()) {
        // No network at all: queue without trying; reconnecting kicks the queue again.
        set({ syncing: false, blocked: 'offline' });
        settleAllQueued();
        return;
      }
      const retryAt = state.get().retryAt;
      if (retryAt > now()) {
        set({ syncing: false, blocked: 'server' });
        settleAllQueued();
        return;
      }
      const session = await deps.session();
      if (session !== 'ok') {
        set({ syncing: false, blocked: session === 'network' ? 'offline' : 'session' });
        settleAllQueued();
        if (session === 'network') retryIn(offlineRetryMs);
        return;
      }
      if (!state.get().ops.some((o) => o.id === next.id)) continue; // changed meanwhile
      set({ syncing: true });
      inflight.add(next.id);
      /** @type {SendResult} */
      let res;
      try {
        res = await deps.send(next);
      } catch (e) {
        res = { status: 'network', error: e };
      }
      inflight.delete(next.id);
      // The op may have been merged into or replaced while it was in flight: use the stored one.
      const current = state.get().ops.find((o) => o.id === next.id);
      const listed = queuedOnce.has(next.id) || !waiters.has(next.id);

      if (res.status === 'ok') {
        handlers[next.table]?.synced?.(next, res.row);
        await removeOp(next.id);
        set({ lastSyncedAt: now(), retryAt: 0, blocked: null });
        settle(next.id, { status: 'synced', row: res.row });
        continue;
      }
      if (res.status === 'gone') {
        handlers[next.table]?.gone?.(next);
        await removeOp(next.id);
        settle(next.id, { status: 'gone' });
        deps.onNotice?.({ type: 'gone', op: next });
        continue;
      }
      if (res.status === 'network') {
        set({ syncing: false, blocked: 'offline' });
        settleAllQueued();
        retryIn(offlineRetryMs);
        return;
      }
      if (res.status === 'auth') {
        // The token was refused even after a refresh: ask the session again.
        const again2 = await deps.session();
        set({ syncing: false, blocked: again2 === 'network' ? 'offline' : 'session' });
        settleAllQueued();
        if (again2 !== 'ended') retryIn(offlineRetryMs);
        return;
      }
      if (!listed) {
        // The person is still waiting for this write: roll it back, exactly like an online write.
        await removeOp(next.id);
        settle(next.id, { status: 'failed', error: res.error });
        continue;
      }
      if (res.status === 'transient') {
        const attempts = (current?.attempts || 0) + 1;
        if (attempts >= MAX_TRANSIENT_ATTEMPTS) {
          reject(current || next, res.error);
          continue;
        }
        const updated = { ...(current || next), attempts };
        set({ ops: state.get().ops.map((o) => (o.id === next.id ? updated : o)), syncing: false, blocked: 'server', retryAt: now() + backoffMs(attempts) });
        persist(() => deps.storage.put('ops', updated));
        settleAllQueued();
        retryIn(backoffMs(attempts));
        return;
      }
      // rejected for good
      reject(current || next, res.error);
      settle(next.id, { status: 'queued' });
    }
  }

  const api = {
    state,

    /** Read what is stored from earlier sessions. Safe to call more than once (reloads). */
    async load() {
      await chain; // what this tab stored so far is in storage
      const seqAtStart = seq;
      const startedAt = now();
      /** @type {{ ops: any[], rejected: any[] }} */
      let data = { ops: [], rejected: [] };
      try {
        data = await deps.storage.load();
      } catch (e) {
        console.warn('outbox load failed', e);
      }
      const stored = sortOps(data.ops || []);
      for (const o of stored) queuedOnce.add(o.id);
      // Storage is the truth (another tab may have sent or added changes); keep only what this
      // tab made while the load was running.
      const fresh = state.get().ops.filter((o) => o.seq > seqAtStart && !stored.some((x) => x.id === o.id));
      const merged = sortOps([...stored, ...fresh]);
      seq = Math.max(seq, ...merged.map((o) => o.seq || 0));
      const storedRejected = (data.rejected || []).filter((r) => r && r.op);
      const freshRejected = state.get().rejected.filter((r) => r.at >= startedAt && !storedRejected.some((x) => x.id === r.id));
      const rejected = [...storedRejected, ...freshRejected].sort((a, b) => a.at - b.at);
      set({ loaded: true, ops: merged, rejected });
      markLoaded();
    },

    /** Register what a table store does when its changes are confirmed or found deleted. */
    register(/** @type {string} */ table, /** @type {{ synced?: (op: Op, row: any) => void, gone?: (op: Op) => void }} */ h) {
      handlers[table] = h;
    },

    /** Ops of one table, in order. @param {string} table */
    opsFor(table) {
      return state.get().ops.filter((o) => o.table === table);
    },

    /**
     * Queue a change and try to send it. Resolves when it is confirmed, refused, or kept for later.
     * @param {{ table: string, key: string, rowKey: string | number, kind: Op['kind'], values: Record<string, any> }} input
     * @param {{ listed?: boolean }} [opts] listed: never roll back silently (a retried refused change)
     * @returns {Promise<WriteResult>}
     */
    async write(input, opts = {}) {
      await loadedPromise;
      // Nobody signed in (a visitor, or after signing out): nothing to queue, refuse like the
      // database would. Changes of an editor whose session ended were queued before and stay.
      if (!deps.userId()) return { status: 'failed', error: Object.assign(new Error('signed out'), { code: 'signedOut' }) };
      seq = Math.max(seq + 1, now());
      /** @type {Op} */
      const op = {
        v: OP_VERSION,
        id: deps.uuid(),
        seq,
        table: input.table,
        key: input.key,
        rowKey: input.rowKey,
        kind: input.kind,
        values: input.values,
        userId: deps.userId(),
        userName: deps.userName(),
        at: now(),
        attempts: 0,
      };
      const r = coalesce(state.get().ops, op, { inflight, dependents: deps.dependents || {} });
      set({ ops: r.ops });
      const stored = persist(async () => {
        for (const id of r.del) await deps.storage.del('ops', id);
        for (const o of r.put) await deps.storage.put('ops', o);
      });
      for (const id of r.absorbed) {
        if (r.target) {
          // Their waiters now wait for the op that carries the change.
          const list = waiters.get(id);
          if (list) {
            waiters.delete(id);
            waiters.set(r.target.id, [...(waiters.get(r.target.id) || []), ...list]);
          }
          if (queuedOnce.has(id)) queuedOnce.add(r.target.id);
        } else {
          queuedOnce.delete(id);
          settle(id, { status: 'cancelled' });
        }
      }
      if (!r.target) {
        await stored;
        return { status: 'cancelled' };
      }
      if (opts.listed) queuedOnce.add(r.target.id);
      const result = waitFor(r.target.id);
      await stored; // on the device before anything is sent
      api.kick();
      return result;
    },

    /** Try to send what is queued now. */
    kick() {
      again = true;
      if (running) return running;
      running = (async () => {
        try {
          // The check and the reset below run in one synchronous step: a kick is never missed.
          while (again) {
            again = false;
            await loop();
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },

    /** Send again a change the server refused (back at the end of the queue). @param {string} id */
    async retryRejected(id) {
      const rec = state.get().rejected.find((r) => r.id === id);
      if (!rec) return;
      set({ rejected: state.get().rejected.filter((r) => r.id !== id) });
      await persist(() => deps.storage.del('rejected', id));
      const { table, key, rowKey, kind, values } = rec.op;
      // From here it is a queued change like any other: refused again, it comes back to the list.
      return api.write({ table, key, rowKey, kind, values }, { listed: true });
    },

    /** Forget a refused change for good. @param {string} id */
    async discardRejected(id) {
      set({ rejected: state.get().rejected.filter((r) => r.id !== id) });
      await persist(() => deps.storage.del('rejected', id));
    },

    /** Resolves once everything queued so far is stored. */
    flushed() {
      return chain;
    },

    /** For tests: ids currently being sent. */
    inflightIds: () => [...inflight],
  };
  return api;
}
