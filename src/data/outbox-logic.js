// Pure logic of the offline outbox (no DOM, no network): coalescing queued changes, showing them
// on top of the rows the server returned, and classifying the server's answer. Unit-tested in
// tests/unit/outbox.test.mjs; the engine that uses it is outbox.js.

/** Version of the stored op format. Ops of an unknown version are kept and never sent. */
export const OP_VERSION = 1;

/**
 * One queued change.
 * @typedef {object} Op
 * @property {number} v              OP_VERSION
 * @property {string} id             op id (client uuid)
 * @property {number} seq            order of the change on this device
 * @property {string} table
 * @property {string} key            primary key column ('id', 'skill_key'...)
 * @property {string | number} rowKey  primary key value (client-generated for new rows)
 * @property {'insert' | 'update' | 'upsert' | 'delete'} kind
 * @property {Record<string, any>} values  the columns to write (insert/upsert: the whole row; update: the patch)
 * @property {string | null} userId   who made the change (only sent while that person is signed in)
 * @property {string | null} userName shown as "who logged it" until the server row arrives
 * @property {number} at             epoch ms when the person made the change
 * @property {number} attempts       transient failures so far
 */

/**
 * A change the server refused for good (validation, permission), kept so nothing is silently lost.
 * @typedef {object} Rejected
 * @property {string} id      same as the op id
 * @property {Op} op
 * @property {{ code: string, message: string, status: number }} error
 * @property {number} at      epoch ms when it was refused
 */

/** @param {Op} a @param {{ table: string, rowKey: any, userId: any }} b */
const sameRow = (a, b) => a.table === b.table && String(a.rowKey) === String(b.rowKey) && a.userId === b.userId;

/**
 * Add `op` to the queue, merging it with the latest queued change of the same row when that is
 * safe (that change is not being sent right now):
 *  - insert/upsert/update + update/upsert(after insert/upsert) → one write with the merged values
 *  - insert + delete → nothing is sent at all (also drops queued changes of dependent rows, e.g.
 *    the private cost of a visit that never reached the server)
 *  - update/upsert + delete → only the delete
 * Anything else is appended (order is kept).
 * @param {Op[]} ops
 * @param {Op} op
 * @param {{ inflight?: Set<string>, dependents?: Record<string, string[]> }} [opts]
 *   dependents: table -> tables whose primary key is this table's id (cascade on delete)
 * @returns {{ ops: Op[], target: Op | null, put: Op[], del: string[], absorbed: string[] }}
 *   target: the op that will carry this change (null: nothing to send); put/del: what to store;
 *   absorbed: ids of ops that no longer exist (their waiters settle with the target)
 */
export function coalesce(ops, op, { inflight = new Set(), dependents = {} } = {}) {
  let idx = -1;
  for (let i = ops.length - 1; i >= 0; i--) {
    if (sameRow(ops[i], op)) {
      idx = i;
      break;
    }
  }
  const last = idx >= 0 ? ops[idx] : null;
  const append = () => ({ ops: [...ops, op], target: op, put: [op], del: [], absorbed: [] });
  if (!last || inflight.has(last.id) || last.v !== OP_VERSION) return append();

  const creates = last.kind === 'insert' || last.kind === 'upsert';
  if (op.kind === 'update' || (op.kind === 'upsert' && creates)) {
    if (last.kind === 'delete') return append();
    const merged = { ...last, values: { ...last.values, ...op.values } };
    const next = ops.slice();
    next[idx] = merged;
    return { ops: next, target: merged, put: [merged], del: [], absorbed: [] };
  }
  if (op.kind === 'delete') {
    if (last.kind === 'insert') {
      const deps = dependents[op.table] || [];
      const gone = ops.filter(
        (o) => o === last || (deps.includes(o.table) && String(o.rowKey) === String(op.rowKey) && o.userId === op.userId && !inflight.has(o.id)),
      );
      const ids = gone.map((o) => o.id);
      return { ops: ops.filter((o) => !gone.includes(o)), target: null, put: [], del: ids, absorbed: ids };
    }
    if (last.kind === 'update' || last.kind === 'upsert') {
      const next = ops.filter((o) => o !== last);
      return { ops: [...next, op], target: op, put: [op], del: [last.id], absorbed: [last.id] };
    }
  }
  return append();
}

/**
 * The rows to show: the server's rows with the queued changes applied on top, in order.
 * Rows touched by a queued change carry `_pending: true`.
 * @param {any[]} rows
 * @param {Op[]} ops   only this table's ops
 * @param {string} key
 * @returns {any[]}
 */
export function applyOps(rows, ops, key) {
  if (!ops.length) return rows;
  /** @type {Map<string, any>} */
  const byKey = new Map(rows.map((r) => [String(r[key]), r]));
  for (const op of ops) {
    const k = String(op.rowKey);
    const existing = byKey.get(k);
    if (op.kind === 'delete') {
      byKey.delete(k);
    } else if (op.kind === 'update') {
      if (existing) byKey.set(k, { ...existing, ...op.values, _pending: true });
    } else {
      const base = existing || { created_at: new Date(op.at).toISOString(), created_by_name: op.userName || null };
      byKey.set(k, { ...base, ...op.values, [key]: op.rowKey, _pending: true });
    }
  }
  return [...byKey.values()];
}

/**
 * What a write's response means for the queue.
 *  ok: done · network: no answer (offline, timeout): keep and retry · auth: the token was refused ·
 *  transient: server busy/down: retry later · duplicate: the row already exists (an earlier attempt
 *  of this insert reached the server) · gone: the row no longer exists · rejected: refused for good
 * @param {{ error?: any, status?: number } | null | undefined} res a supabase-js result
 * @returns {'ok' | 'network' | 'auth' | 'transient' | 'duplicate' | 'gone' | 'rejected'}
 */
export function classifyResult(res) {
  if (!res || !res.error) return 'ok';
  const status = Number(res.status || 0);
  const code = String(res.error.code || '');
  const message = String(res.error.message || res.error);
  if (!status) return 'network'; // fetch failed or was aborted: nothing came back
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return 'auth';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
  if (code === '23505') return 'duplicate';
  if (code === 'PGRST116') return 'gone';
  if (/failed to fetch|networkerror|load failed/i.test(message) && status === 0) return 'network';
  return 'rejected';
}

/** Delay before retry `attempt` (1-based) after a transient server error: 5 s, 15 s, 45 s... max 5 min. */
export function backoffMs(attempt) {
  return Math.min(5000 * 3 ** Math.max(0, attempt - 1), 300_000);
}

/** Transient failures of a queued change before it is moved to the "could not be saved" list. */
export const MAX_TRANSIENT_ATTEMPTS = 6;

/**
 * Order ops as they were made (seq), keeping only well-formed ones.
 * @param {any[]} list
 * @returns {Op[]}
 */
export function sortOps(list) {
  return list.filter((o) => o && typeof o.id === 'string' && typeof o.table === 'string').sort((a, b) => a.seq - b.seq);
}

/**
 * Fields of a queued or refused change worth showing to a person (no internal columns), in order.
 * @param {Op} op
 * @returns {Array<[string, string]>}
 */
export function describeValues(op) {
  const hidden = new Set([op.key, 'id', 'user_id', 'storage_path', 'width', 'height', 'milestone_id', 'visit_id']);
  return Object.entries(op.values || {})
    .filter(([k, v]) => !hidden.has(k) && !k.startsWith('_') && v != null && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}
