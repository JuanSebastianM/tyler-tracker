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
import { createStore, useStore } from '../lib/store.js';

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

  const cached = config.private ? null : deps.readCache(cacheKey);
  /** @type {import('../lib/store.js').Store<TableState>} */
  const state = createStore(
    /** @type {TableState} */ ({
      rows: cached?.rows || [],
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
    deps.writeCache(cacheKey, { rows: s.rows.slice(0, MAX_CACHED_ROWS), range: s.range, savedAt: Date.now() });
  };

  /** @param {(rows: any[]) => any[]} fn */
  const setRows = (fn) => {
    state.set((s) => ({ ...s, rows: sortRows(fn(s.rows)) }));
    persist();
  };

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
    const client = deps.getClient();
    let q = client.from(config.table).select('*');
    if (config.rangeColumn && range) q = q.gte(config.rangeColumn, range.start).lt(config.rangeColumn, range.end);
    if (order) q = q.order(order.column, { ascending: !!order.ascending });
    state.set((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading' }));
    let result;
    try {
      result = await q;
    } catch (e) {
      result = { data: null, error: e };
    }
    const { data, error } = result;
    if (error) {
      state.set((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: String(error.message || error) }));
      return { error: String(error.message || error) };
    }
    if (config.rangeColumn && range) {
      const col = config.rangeColumn;
      const inWindow = (/** @type {any} */ r) => r[col] >= range.start && r[col] < range.end;
      const incoming = new Map(data.map((/** @type {any} */ r) => [r[key], r]));
      state.set((s) => ({
        ...s,
        rows: sortRows([...s.rows.filter((r) => !inWindow(r) && !incoming.has(r[key])), ...data]),
        range,
      }));
    } else {
      state.set((s) => ({ ...s, rows: sortRows(data) }));
    }
    state.set((s) => ({ ...s, status: 'ready', fromCache: false, error: null, loadedAt: Date.now() }));
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
      state.set({ rows: [], status: 'idle', fromCache: false, error: null, loadedAt: 0, range: null });
    },

    /**
     * Optimistic insert. uuid tables get a client-generated id.
     * @param {Record<string, any>} values
     */
    async insert(values) {
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const payload = strip({ ...values });
      if (keyKind === 'uuid' && !payload[key]) payload[key] = deps.uuid();
      const id = payload[key];
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
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const prev = api.get(id);
      const payload = strip(patch);
      delete payload[key];
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
      if (deps.isOffline()) return fail(deps.t('errors.offline'));
      const payload = strip(values);
      const id = payload[key];
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
    try {
      const r = await fn();
      return r && r.error ? { data: null, error: r.error } : { data: r?.data ?? null, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
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
