// Generic store for one Supabase table: cached reads (stale-while-revalidate) and optimistic writes.
//
//   const s = createTableStore({ table: 'weights', orderBy: { column: 'measured_on', ascending: false } });
//   await s.load();                       // fetch (renders cached rows first)
//   s.useRows()                           // hook: rows array
//   await s.insert({ measured_on, weight_kg })   // -> { data, error }
//   await s.update(id, { notes })
//   await s.remove(id)
//
// Ranged tables (feedings, routine_events) keep every row they have seen, merged by key, and load
// a date window at a time: s.loadRange(startIso, endIso). Use s.inRange(startIso, endIso) to read.
//
// Offline (deps.outbox): every write is a queued change in the outbox (src/data/outbox.js). The
// store keeps the rows the server returned (`base`, cached in localStorage) and shows them with the
// queued changes applied on top (rows with `_pending: true`), so what was typed offline is shown,
// survives a reload and never disappears on a refresh. Writes resolve with `queued: true` when the
// change is kept for later. Tables with `offline: false` (chat threads) keep the old behaviour:
// online only, fail fast offline.
import { createStore, useStore } from '../lib/store.js';
import { applyOps } from './outbox-logic.js';

/** Columns the database fills; never sent by the client. */
export const AUDIT_COLUMNS = ['created_at', 'updated_at', 'created_by', 'created_by_name'];

/** Max rows kept in the localStorage cache for ranged tables. */
const MAX_CACHED_ROWS = 600;

/**
 * @typedef {object} TableConfig
 * @property {string} table
 * @property {string} [key]            primary key column (default 'id')
 * @property {'uuid' | 'text' | 'single'} [keyKind]  uuid: generated client-side; text: supplied
 *                                     by the caller (skill_key...); single: id = 1 single-row table
 * @property {{ column: string, ascending?: boolean }} [orderBy]
 * @property {string} [rangeColumn]    load by time window on this timestamptz column
 * @property {boolean} [private]       editors only: never loaded or cached for others
 * @property {boolean} [offline]       false: writes need a connection (default: queued offline)
 */

/**
 * @typedef {object} TableState
 * @property {any[]} rows
 * @property {'idle' | 'loading' | 'ready' | 'error'} status  'ready' once a fetch succeeded
 * @property {boolean} fromCache   rows came from localStorage and have not been refreshed yet
 * @property {string | null} error
 * @property {number} loadedAt     epoch ms of the last successful fetch
 * @property {{ start: string, end: string } | null} range  last loaded window (ranged tables)
 */

/**
 * @typedef {object} Deps
 * @property {() => any} getClient          Supabase client
 * @property {(message: string) => void} notifyError   shows a translated error toast
 * @property {(key: string) => any} readCache
 * @property {(key: string, value: any) => void} writeCache
 * @property {(key: string) => void} clearCache
 * @property {() => boolean} isOffline
 * @property {() => string} editorName
 * @property {(key: string) => string} t
 * @property {() => string} uuid
 * @property {(reason: string) => () => void} [beginBusy]  marks a write in flight (no update reload)
 * @property {ReturnType<typeof import('./outbox.js').createOutbox>} [outbox]  queue for offline writes
 * @property {() => Promise<boolean>} [ensureSession]  true when the editor's token is valid (refreshed
 *   if needed). Private tables are not fetched without it: an anonymous read would return no rows
 *   and wipe what is shown (e.g. after iOS resumes the app with an expired token and no network yet).
 */

/**
 * @param {TableConfig} config
 * @param {Deps} deps
 */
export function createTableStore(config, deps) {
  const key = config.key || 'id';
  const keyKind = config.keyKind || 'uuid';
  const cacheKey = `cache.${config.table}`;
  const order = config.orderBy;

  /** @param {any[]} rows */
  const sortRows = (rows) => {
    if (!order) return rows;
    const dir = order.ascending ? 1 : -1;
    const col = order.column;
    return [...rows].sort((a, b) => (a[col] === b[col] ? 0 : a[col] > b[col] ? dir : -dir));
  };

  const outbox = config.offline === false ? null : deps.outbox || null;
  const cached = config.private ? null : deps.readCache(cacheKey);
  /** Rows as the server last returned them (plus legacy optimistic rows). */
  /** @type {any[]} */
  let base = cached?.rows || [];
  /** @type {any[]} the outbox ops last applied (to skip recomputing when they did not change) */
  let shownOps = [];

  /** Rows to show: base with this table's queued changes on top. Visitors never see private ones. */
  const visible = () => {
    shownOps = outbox && !(config.private && !deps.editorName()) ? outbox.opsFor(config.table) : [];
    return sortRows(applyOps(base, shownOps, key));
  };

  /** @type {import('../lib/store.js').Store<TableState>} */
  const state = createStore(
    /** @type {TableState} */ ({
      rows: [],
      status: 'idle',
      fromCache: !!cached,
      error: null,
      loadedAt: 0,
      range: cached?.range || null,
    }),
  );

  const persist = () => {
    const s = state.get();
    if (config.private && !deps.editorName()) return;
    deps.writeCache(cacheKey, { rows: sortRows(base).slice(0, MAX_CACHED_ROWS), range: s.range, savedAt: Date.now() });
  };

  const recompute = () => state.set((s) => ({ ...s, rows: visible() }));
  recompute();

  /** Change the server rows. @param {(rows: any[]) => any[]} fn */
  const setRows = (fn) => {
    base = fn(base);
    recompute();
    persist();
  };

  /**
   * Changes confirmed while a fetch was running: the fetch may have read the database before
   * them, so they are applied again on top of its result (no row flickers away after a sync).
   * @type {Array<{ at: number, op: import('./outbox-logic.js').Op, row: any }>}
   */
  let recent = [];
  /** @param {any[]} rows @param {number} since */
  const reapplyRecent = (rows, since) => {
    let out = rows;
    for (const r of recent) {
      if (r.at < since) continue;
      const k = String(r.op.rowKey);
      out = out.filter((x) => String(x[key]) !== k);
      if (r.op.kind !== 'delete' && r.row) out = [...out, r.row];
    }
    return out;
  };

  if (outbox) {
    outbox.state.subscribe(() => {
      const next = config.private && !deps.editorName() ? [] : outbox.opsFor(config.table);
      if (next.length === shownOps.length && next.every((o, i) => o === shownOps[i])) return;
      recompute();
    });
    outbox.register(config.table, {
      synced(op, row) {
        const at = Date.now();
        recent = [...recent.filter((r) => at - r.at < 30_000), { at, op, row }];
        const k = String(op.rowKey);
        if (op.kind === 'delete') setRows((rows) => rows.filter((r) => String(r[key]) !== k));
        else if (row) setRows((rows) => [...rows.filter((r) => String(r[key]) !== k), row]);
        scheduleRefresh();
      },
      gone(op) {
        const at = Date.now();
        recent = [...recent.filter((r) => at - r.at < 30_000), { at, op: { ...op, kind: 'delete' }, row: null }];
        const k = String(op.rowKey);
        setRows((rows) => rows.filter((r) => String(r[key]) !== k));
      },
    });
  }

  /** @param {any} row */
  const strip = (row) => {
    const out = { ...row };
    for (const c of AUDIT_COLUMNS) delete out[c];
    return out;
  };

  /** @type {Promise<any> | null} */
  let inflight = null;

  /**
   * Fetch rows (whole table, or a time window for ranged tables).
   * @param {{ start: string, end: string }} [range]
   * @returns {Promise<{ error: string | null }>}
   */
  async function fetchRows(range) {
    if (config.private && deps.ensureSession && !(await deps.ensureSession())) {
      return { error: 'session' }; // keep the rows already shown
    }
    if (deps.isOffline()) {
      // Known offline: keep what is shown (cache + queued changes) and do not wait for supabase-js
      // to retry a GET for several seconds. Reconnecting refreshes everything (stores.js).
      state.set((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: 'offline' }));
      return { error: 'offline' };
    }
    const client = deps.getClient();
    let q = client.from(config.table).select('*');
    if (config.rangeColumn && range) q = q.gte(config.rangeColumn, range.start).lt(config.rangeColumn, range.end);
    if (order) q = q.order(order.column, { ascending: !!order.ascending });
    state.set((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading' }));
    const startedAt = Date.now();
    let result;
    try {
      result = await q;
    } catch (e) {
      result = { data: null, error: e };
    }
    const { error } = result;
    if (error) {
      state.set((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: String(error.message || error) }));
      return { error: String(error.message || error) };
    }
    const data = reapplyRecent(result.data || [], startedAt);
    if (config.rangeColumn && range) {
      const col = config.rangeColumn;
      const inWindow = (/** @type {any} */ r) => r[col] >= range.start && r[col] < range.end;
      const incoming = new Map(data.map((/** @type {any} */ r) => [r[key], r]));
      base = [...base.filter((r) => !inWindow(r) && !incoming.has(r[key])), ...data];
      state.set((s) => ({ ...s, range }));
    } else {
      base = data;
    }
    state.set((s) => ({ ...s, rows: visible(), status: 'ready', fromCache: false, error: null, loadedAt: Date.now() }));
    persist();
    return { error: null };
  }

  /** @type {{ start: string, end: string } | null} */
  let defaultRange = null;

  const api = {
    config,
    state,

    /** Set the window used by load()/refresh() for ranged tables. */
    setDefaultRange(/** @type {{ start: string, end: string }} */ range) {
      defaultRange = range;
    },

    /** Load (or reload) the table. Concurrent calls share one request. */
    load() {
      if (config.private && !deps.editorName()) return Promise.resolve({ error: null });
      if (inflight) return inflight;
      inflight = fetchRows(config.rangeColumn ? defaultRange || undefined : undefined).finally(() => {
        inflight = null;
      });
      return inflight;
    },

    refresh() {
      return api.load();
    },

    /** Load a specific window and merge it in (ranged tables). */
    loadRange(/** @type {string} */ start, /** @type {string} */ end) {
      return fetchRows({ start, end });
    },

    /** Rows whose range column is within [start, end). */
    inRange(/** @type {string} */ start, /** @type {string} */ end) {
      const col = config.rangeColumn || order?.column || key;
      return state.get().rows.filter((r) => r[col] >= start && r[col] < end);
    },

    /** @returns {any[]} */
    rows: () => state.get().rows,
    get: (/** @type {any} */ id) => state.get().rows.find((r) => r[key] === id) || null,
    /** First row (single-row tables). */
    single: () => state.get().rows[0] || null,

    /** Forget rows and cache (private tables on sign-out). */
    clear() {
      deps.clearCache(cacheKey);
      base = [];
      state.set({ rows: [], status: 'idle', fromCache: false, error: null, loadedAt: 0, range: null });
      recompute();
    },

    /**
     * Private tables: show the rows cached on this device (and queued changes) once the person is
     * known to be an editor, before the first fetch, so they stay readable offline.
     */
    hydrate() {
      if (!config.private || !deps.editorName()) return;
      if (!base.length && state.get().status === 'idle') {
        const c = deps.readCache(cacheKey);
        if (c?.rows?.length) {
          base = c.rows;
          state.set((s) => ({ ...s, fromCache: true }));
        }
      }
      recompute();
    },

    /**
     * Optimistic insert. uuid tables get a client-generated id.
     * @param {Record<string, any>} values
     */
    async insert(values) {
      const payload = strip({ ...values });
      if (keyKind === 'uuid' && !payload[key]) payload[key] = deps.uuid();
      const id = payload[key];
      if (outbox) return settle(await outbox.write({ table: config.table, key, rowKey: id, kind: 'insert', values: payload }), id, 'errors.saveFailed');
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const optimistic = { ...payload, created_at: new Date().toISOString(), created_by_name: deps.editorName() || null, _pending: true };
      setRows((rows) => [...rows.filter((r) => r[key] !== id), optimistic]);
      const res = await run(() => deps.getClient().from(config.table).insert(payload).select().single());
      if (res.error) {
        setRows((rows) => rows.filter((r) => r[key] !== id));
        return fail(deps.t('errors.saveFailed'), res.error);
      }
      setRows((rows) => rows.map((r) => (r[key] === id ? res.data : r)));
      scheduleRefresh();
      return { data: res.data, error: null };
    },

    /**
     * Optimistic update of one row.
     * @param {any} id
     * @param {Record<string, any>} patch
     */
    async update(id, patch) {
      const payload = strip(patch);
      delete payload[key];
      if (outbox) return settle(await outbox.write({ table: config.table, key, rowKey: id, kind: 'update', values: payload }), id, 'errors.saveFailed');
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const prev = api.get(id);
      if (prev) setRows((rows) => rows.map((r) => (r[key] === id ? { ...r, ...payload, _pending: true } : r)));
      const res = await run(() => deps.getClient().from(config.table).update(payload).eq(key, id).select().single());
      if (res.error) {
        if (prev) setRows((rows) => rows.map((r) => (r[key] === id ? prev : r)));
        return fail(deps.t('errors.saveFailed'), res.error);
      }
      setRows((rows) => (rows.some((r) => r[key] === id) ? rows.map((r) => (r[key] === id ? res.data : r)) : [...rows, res.data]));
      scheduleRefresh();
      return { data: res.data, error: null };
    },

    /**
     * Insert or update by primary key (text-key tables like training_skills, checklist_done,
     * and pet_private). Not for pet_profile/settings: use update(1, patch) there.
     * @param {Record<string, any>} values must include the key
     */
    async upsert(values) {
      const payload = strip(values);
      const id = payload[key];
      if (outbox) return settle(await outbox.write({ table: config.table, key, rowKey: id, kind: 'upsert', values: payload }), id, 'errors.saveFailed');
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const prev = api.get(id);
      setRows((rows) => [...rows.filter((r) => r[key] !== id), { ...(prev || {}), ...payload, _pending: true }]);
      const res = await run(() =>
        deps.getClient().from(config.table).upsert(payload, { onConflict: key }).select().single(),
      );
      if (res.error) {
        setRows((rows) => (prev ? rows.map((r) => (r[key] === id ? prev : r)) : rows.filter((r) => r[key] !== id)));
        return fail(deps.t('errors.saveFailed'), res.error);
      }
      setRows((rows) => rows.map((r) => (r[key] === id ? res.data : r)));
      scheduleRefresh();
      return { data: res.data, error: null };
    },

    /** Optimistic delete. @param {any} id */
    async remove(id) {
      if (outbox) return settle(await outbox.write({ table: config.table, key, rowKey: id, kind: 'delete', values: {} }), id, 'errors.deleteFailed');
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const prev = api.get(id);
      setRows((rows) => rows.filter((r) => r[key] !== id));
      const res = await run(() => deps.getClient().from(config.table).delete().eq(key, id));
      if (res.error) {
        if (prev) setRows((rows) => [...rows, prev]);
        return fail(deps.t('errors.deleteFailed'), res.error);
      }
      scheduleRefresh();
      return { data: null, error: null };
    },

    /** Hook: the rows array. */
    useRows() {
      return useStore(state, (s) => s.rows);
    },
    /** Hook: the whole state ({ rows, status, fromCache, error }). */
    useState() {
      return useStore(state);
    },
    /** Hook: one row by key (or the single row when id is omitted). */
    useRow(/** @type {any} */ id) {
      return useStore(state, (s) => (id === undefined ? s.rows[0] : s.rows.find((r) => r[key] === id)) || null);
    },
  };

  /** @param {() => any} fn */
  async function run(fn) {
    const done = deps.beginBusy?.('write') || (() => {});
    try {
      const r = await fn();
      return r && r.error ? { data: null, error: r.error } : { data: r?.data ?? null, error: null };
    } catch (e) {
      return { data: null, error: e };
    } finally {
      done();
    }
  }

  /**
   * What a queued write means for the caller. 'queued' is success for the person (the change is
   * on the device and shown); 'failed' was refused while they waited and is already rolled back.
   * @param {import('./outbox.js').WriteResult} r @param {any} id @param {string} errorKey
   * @returns {{ data: any, error: any, queued?: boolean }}
   */
  function settle(r, id, errorKey) {
    if (r.status === 'synced') return { data: r.row ?? api.get(id), error: null };
    if (r.status === 'queued' || r.status === 'cancelled') return { data: api.get(id) || { [key]: id }, error: null, queued: true };
    if (r.status === 'gone') return { data: null, error: Object.assign(new Error('gone'), { code: 'gone' }) };
    return fail(deps.t(errorKey), r.error);
  }

  /** @param {string} message @param {any} [error] */
  function fail(message, error) {
    deps.notifyError(message);
    return { data: null, error: error || new Error(message) };
  }

  /** @type {any} */
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => api.load(), 1500);
    refreshTimer?.unref?.();
  }

  return api;
}
