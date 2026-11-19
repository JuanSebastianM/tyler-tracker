// Offline outbox: coalescing, overlay, classification, the sending engine (ordering, idempotency,
// sessions, refusals, backoff) and persistence across "restarts" with a fake storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesce, applyOps, classifyResult, backoffMs, sortOps, describeValues, OP_VERSION, MAX_TRANSIENT_ATTEMPTS } from '../../src/data/outbox-logic.js';
import { createOutbox } from '../../src/data/outbox.js';
import { sendOp } from '../../src/data/sync.js';
import { createTableStore } from '../../src/data/table-store.js';

let opN = 0;
/** @returns {import('../../src/data/outbox-logic.js').Op} */
const op = (kind, rowKey, values = {}, extra = {}) => ({
  v: OP_VERSION, id: `op${++opN}`, seq: opN, table: 'feedings', key: 'id', rowKey, kind, values, userId: 'u1', userName: 'Alex', at: 1000 + opN, attempts: 0, ...extra,
});

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test('coalesce: insert then edits then delete of an unsynced row sends nothing', () => {
  let ops = [];
  let r = coalesce(ops, op('insert', 'a', { id: 'a', fed_at: 'T1', notes: null }));
  ops = r.ops;
  r = coalesce(ops, op('update', 'a', { notes: 'hungry' }));
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0].values, { id: 'a', fed_at: 'T1', notes: 'hungry' }, 'edit merged into the insert');
  assert.equal(r.ops[0].kind, 'insert');
  ops = r.ops;
  r = coalesce(ops, op('delete', 'a'));
  assert.deepEqual(r.ops, []);
  assert.equal(r.target, null);
  assert.equal(r.del.length, 1);
});

test('coalesce: updates merge, update + delete keeps only the delete (at the end)', () => {
  let ops = [op('update', 'a', { notes: 'x' }), op('insert', 'b', { id: 'b' })];
  let r = coalesce(ops, op('update', 'a', { appetite: 'all' }));
  assert.deepEqual(r.ops[0].values, { notes: 'x', appetite: 'all' });
  r = coalesce(r.ops, op('delete', 'a'));
  assert.deepEqual(r.ops.map((o) => [o.kind, o.rowKey]), [['insert', 'b'], ['delete', 'a']]);
});

test('coalesce: never merges into an op being sent, nor across users or tables', () => {
  const first = op('insert', 'a', { id: 'a' });
  let r = coalesce([first], op('update', 'a', { notes: 'x' }), { inflight: new Set([first.id]) });
  assert.equal(r.ops.length, 2, 'appended behind the in-flight insert');
  r = coalesce([first], op('update', 'a', { notes: 'x' }, { userId: 'u2' }));
  assert.equal(r.ops.length, 2);
  r = coalesce([first], op('update', 'a', { notes: 'x' }, { table: 'weights' }));
  assert.equal(r.ops.length, 2);
  r = coalesce([first], op('insert', 'a', { id: 'a' }, { v: 99 }));
  assert.equal(r.ops.length, 2);
});

test('coalesce: delete after delete or insert after delete is kept in order (undo)', () => {
  const del = op('delete', 'a');
  const r = coalesce([del], op('insert', 'a', { id: 'a', fed_at: 'T' }));
  assert.deepEqual(r.ops.map((o) => o.kind), ['delete', 'insert']);
});

test('coalesce: cancelling a new visit drops its queued private cost too', () => {
  const visit = op('insert', 'v1', { id: 'v1' }, { table: 'vet_visits' });
  const cost = op('upsert', 'v1', { visit_id: 'v1', cost: 90000 }, { table: 'vet_visit_private', key: 'visit_id' });
  const other = op('insert', 'b', { id: 'b' });
  const r = coalesce([visit, cost, other], op('delete', 'v1', {}, { table: 'vet_visits' }), { dependents: { vet_visits: ['vet_visit_private'] } });
  assert.deepEqual(r.ops, [other]);
  assert.deepEqual(r.del.sort(), [visit.id, cost.id].sort());
});

test('coalesce: upserts merge (checklist, training, private details)', () => {
  const a = op('upsert', 'sit', { skill_key: 'sit', status: 'learning' }, { table: 'training_skills', key: 'skill_key' });
  const r = coalesce([a], op('upsert', 'sit', { skill_key: 'sit', notes: 'ok' }, { table: 'training_skills', key: 'skill_key' }));
  assert.deepEqual(r.ops[0].values, { skill_key: 'sit', status: 'learning', notes: 'ok' });
  const r2 = coalesce(r.ops, op('delete', 'sit', {}, { table: 'training_skills', key: 'skill_key' }));
  assert.deepEqual(r2.ops.map((o) => o.kind), ['delete'], 'the row may exist on the server, so the delete is sent');
});

test('applyOps: queued changes on top of server rows, marked pending, with the logged time', () => {
  const rows = [{ id: 'a', fed_at: 'T1', notes: null }, { id: 'b', fed_at: 'T2' }];
  const out = applyOps(rows, [op('update', 'a', { notes: 'x' }), op('delete', 'b'), op('insert', 'c', { id: 'c', fed_at: 'T0' }), op('update', 'zz', { notes: 'not loaded' })], 'id');
  const byId = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'c']);
  assert.equal(byId.a.notes, 'x');
  assert.equal(byId.a._pending, true);
  assert.equal(byId.c.fed_at, 'T0', 'the time the person logged, not the sync time');
  assert.equal(byId.c.created_by_name, 'Alex');
  assert.equal(byId.c._pending, true);
  assert.equal(rows[0].notes, null, 'server rows are not mutated');
});

test('classifyResult', () => {
  assert.equal(classifyResult({ error: null, status: 201 }), 'ok');
  assert.equal(classifyResult({ error: { message: 'TypeError: Failed to fetch' }, status: 0 }), 'network');
  assert.equal(classifyResult({ error: { message: 'AbortError: aborted' }, status: 0 }), 'network');
  assert.equal(classifyResult({ error: { code: 'PGRST303', message: 'JWT expired' }, status: 401 }), 'auth');
  assert.equal(classifyResult({ error: { message: 'x' }, status: 503 }), 'transient');
  assert.equal(classifyResult({ error: { message: 'x' }, status: 429 }), 'transient');
  assert.equal(classifyResult({ error: { code: '23505' }, status: 409 }), 'duplicate');
  assert.equal(classifyResult({ error: { code: 'PGRST116' }, status: 406 }), 'gone');
  assert.equal(classifyResult({ error: { code: '23514', message: 'check' }, status: 400 }), 'rejected');
  assert.equal(classifyResult({ error: { code: '42501', message: 'rls' }, status: 403 }), 'rejected');
});

test('backoff grows and is capped; sortOps orders by seq and drops junk', () => {
  assert.equal(backoffMs(1), 5000);
  assert.equal(backoffMs(2), 15000);
  assert.equal(backoffMs(20), 300000);
  assert.deepEqual(sortOps([{ id: 'b', table: 't', seq: 2 }, null, { id: 'a', table: 't', seq: 1 }, { nope: 1 }]).map((o) => o.id), ['a', 'b']);
  assert.deepEqual(describeValues(op('insert', 'a', { id: 'a', fed_at: 'T', notes: '', amount_g: 50, _pending: true })), [['fed_at', 'T'], ['amount_g', '50']]);
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Storage that outlives an outbox instance (a "restart" makes a new outbox on the same storage). */
function fakeStorage() {
  const m = { ops: new Map(), rejected: new Map() };
  return {
    m,
    load: async () => ({ ops: [...m.ops.values()].map((x) => structuredClone(x)), rejected: [...m.rejected.values()].map((x) => structuredClone(x)) }),
    put: async (s, r) => void m[s].set(r.id, structuredClone(r)),
    del: async (s, id) => void m[s].delete(id),
  };
}

/** Manual timers. */
function fakeTimers() {
  let t = 0;
  const list = [];
  return {
    now: () => t,
    schedule: (fn, ms) => {
      const item = { at: t + ms, fn, done: false };
      list.push(item);
      return () => (item.done = true);
    },
    async advance(ms) {
      t += ms;
      for (const it of list.filter((i) => !i.done && i.at <= t)) {
        it.done = true;
        it.fn();
      }
      await settle();
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fake server: a table of rows by id, and a programmable answer per request. */
function setupOutbox({ storage = fakeStorage(), session = 'ok', user = 'u1', answers = [] } = {}) {
  const timers = fakeTimers();
  const sent = [];
  const notices = [];
  const server = new Map();
  const ctl = { session, user, answers, online: true };
  let n = 0;
  const outbox = createOutbox({
    storage,
    send: async (o) => {
      sent.push({ kind: o.kind, rowKey: o.rowKey, values: { ...o.values } });
      const forced = ctl.answers.shift();
      if (forced) return typeof forced === 'function' ? forced(o) : forced;
      if (!ctl.online) return { status: 'network' };
      if (o.kind === 'delete') server.delete(o.rowKey);
      else if (o.kind === 'update') {
        if (!server.has(o.rowKey)) return { status: 'gone' };
        server.set(o.rowKey, { ...server.get(o.rowKey), ...o.values });
      } else server.set(o.rowKey, { ...(server.get(o.rowKey) || {}), ...o.values });
      return { status: 'ok', row: server.get(o.rowKey) || null };
    },
    session: async () => ctl.session,
    userId: () => ctl.user,
    userName: () => 'Alex',
    uuid: () => `id${++n}-${Math.random().toString(36).slice(2, 6)}`,
    now: timers.now,
    schedule: timers.schedule,
    onNotice: (x) => notices.push(x.type),
    waitMs: 8000,
  });
  return { outbox, storage, timers, sent, notices, server, ctl };
}

const w = (outbox, kind, rowKey, values = {}) => outbox.write({ table: 'feedings', key: 'id', rowKey, kind, values });

test('engine: online write is sent at once and confirmed', async () => {
  const { outbox, sent, storage } = setupOutbox();
  await outbox.load();
  const r = await w(outbox, 'insert', 'a', { id: 'a', fed_at: 'T1' });
  assert.equal(r.status, 'synced');
  assert.deepEqual(r.row, { id: 'a', fed_at: 'T1' });
  assert.equal(sent.length, 1);
  await outbox.flushed();
  assert.equal(storage.m.ops.size, 0);
  assert.equal(outbox.state.get().ops.length, 0);
});

test('engine: offline writes are stored, kept in order and sent exactly once when back', async () => {
  const { outbox, sent, ctl, storage, server, timers } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  const r1 = await w(outbox, 'insert', 'a', { id: 'a', fed_at: 'T1' });
  assert.equal(r1.status, 'queued');
  // The second write finds the queue blocked: it is queued at once (no wait for a dead network).
  const r2 = await w(outbox, 'insert', 'b', { id: 'b', fed_at: 'T2' });
  assert.equal(r2.status, 'queued');
  await w(outbox, 'update', 'a', { notes: 'ate fast' });
  await outbox.flushed();
  assert.equal(storage.m.ops.size, 2, 'the edit merged into the stored insert');
  assert.equal(outbox.state.get().blocked, 'offline');
  ctl.online = true;
  sent.length = 0;
  await outbox.kick();
  assert.deepEqual(sent.map((s) => [s.kind, s.rowKey]), [['insert', 'a'], ['insert', 'b']]);
  assert.deepEqual(server.get('a'), { id: 'a', fed_at: 'T1', notes: 'ate fast' });
  assert.equal(outbox.state.get().ops.length, 0);
  await timers.advance(60_000);
  assert.equal(sent.length, 2, 'nothing is sent twice');
});

test('engine: retries automatically after the offline retry delay', async () => {
  const { outbox, ctl, server, timers } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'a', { id: 'a' });
  ctl.online = true;
  await timers.advance(15_000);
  assert.ok(server.has('a'));
});

test('engine: persistence across restarts (app closed, phone restarted, app updated)', async () => {
  const storage = fakeStorage();
  const one = setupOutbox({ storage });
  await one.outbox.load();
  one.ctl.online = false;
  await w(one.outbox, 'insert', 'a', { id: 'a', fed_at: 'T1' });
  await w(one.outbox, 'insert', 'b', { id: 'b', fed_at: 'T2' });
  await w(one.outbox, 'delete', 'x');
  await one.outbox.flushed();
  // New "process": same storage, nothing in memory.
  const two = setupOutbox({ storage });
  await two.outbox.load();
  assert.deepEqual(two.outbox.state.get().ops.map((o) => [o.kind, o.rowKey]), [['insert', 'a'], ['insert', 'b'], ['delete', 'x']]);
  await two.outbox.kick();
  assert.deepEqual(two.sent.map((s) => [s.kind, s.rowKey]), [['insert', 'a'], ['insert', 'b'], ['delete', 'x']]);
  await two.outbox.flushed();
  assert.equal(storage.m.ops.size, 0);
  // And after a restart following the sync, nothing comes back.
  const three = setupOutbox({ storage });
  await three.outbox.load();
  assert.equal(three.outbox.state.get().ops.length, 0);
});

test('engine: ops of an unknown (future) format survive and are never sent', async () => {
  const storage = fakeStorage();
  storage.m.ops.set('future', { v: 99, id: 'future', seq: 1, table: 'feedings', key: 'id', rowKey: 'z', kind: 'insert', values: {}, userId: 'u1' });
  const { outbox, sent } = setupOutbox({ storage });
  await outbox.load();
  await outbox.kick();
  assert.equal(sent.length, 0);
  assert.ok(storage.m.ops.has('future'));
});

test('engine: a refusal while the person waits rolls back; after "queued" it goes to the list', async () => {
  const { outbox, ctl, notices, storage } = setupOutbox();
  await outbox.load();
  ctl.answers.push({ status: 'rejected', error: { code: '23514', message: 'check', status: 400 } });
  const r = await w(outbox, 'insert', 'a', { id: 'a', amount_g: -5 });
  assert.equal(r.status, 'failed', 'online write: the store rolls back and toasts');
  assert.equal(outbox.state.get().rejected.length, 0);
  assert.deepEqual(notices, []);

  ctl.online = false;
  await w(outbox, 'insert', 'b', { id: 'b', amount_g: -5 });
  ctl.online = true;
  ctl.answers.push({ status: 'rejected', error: { code: '23514', message: 'check', status: 400 } });
  await outbox.kick();
  const rej = outbox.state.get().rejected;
  assert.equal(rej.length, 1);
  assert.equal(rej[0].op.values.amount_g, -5, 'the data is kept');
  assert.equal(rej[0].error.code, '23514');
  assert.deepEqual(notices, ['rejected']);
  await outbox.flushed();
  assert.equal(storage.m.rejected.size, 1, 'the list survives a restart');
  assert.equal(storage.m.ops.size, 0);
});

test('engine: retry and discard from the "could not be saved" list', async () => {
  const { outbox, ctl, server, storage } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'b', { id: 'b', amount_g: 50 });
  ctl.online = true;
  ctl.answers.push({ status: 'rejected', error: { code: '42501', status: 403 } });
  await outbox.kick();
  const id = outbox.state.get().rejected[0].id;
  const r = await outbox.retryRejected(id);
  assert.equal(r.status, 'synced');
  assert.ok(server.has('b'));
  assert.equal(outbox.state.get().rejected.length, 0);

  ctl.online = false;
  await w(outbox, 'insert', 'c', { id: 'c' });
  ctl.online = true;
  ctl.answers.push({ status: 'rejected', error: { code: '42501', status: 403 } });
  await outbox.kick();
  // Refused again on retry: back in the list (never rolled back silently).
  ctl.answers.push({ status: 'rejected', error: { code: '42501', status: 403 } });
  const again = await outbox.retryRejected(outbox.state.get().rejected[0].id);
  assert.equal(again.status, 'queued');
  assert.equal(outbox.state.get().rejected.length, 1);
  await outbox.discardRejected(outbox.state.get().rejected[0].id);
  await outbox.flushed();
  assert.equal(outbox.state.get().rejected.length, 0);
  assert.equal(storage.m.rejected.size, 0);
});

test('engine: transient errors are retried with backoff, then listed after too many', async () => {
  const { outbox, ctl, timers, sent, server } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'a', { id: 'a' });
  ctl.online = true;
  ctl.answers.push({ status: 'transient', error: { status: 503 } });
  sent.length = 0;
  await outbox.kick();
  assert.equal(outbox.state.get().blocked, 'server');
  assert.equal(outbox.state.get().ops[0].attempts, 1);
  await outbox.kick();
  assert.equal(sent.length, 1, 'no retry before the backoff');
  await timers.advance(5000);
  assert.ok(server.has('a'));

  ctl.online = false;
  await w(outbox, 'insert', 'z', { id: 'z' });
  ctl.online = true;
  for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS; i++) ctl.answers.push({ status: 'transient', error: { status: 500 } });
  await outbox.kick();
  for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS; i++) await timers.advance(300_000);
  assert.equal(outbox.state.get().rejected.length, 1);
  assert.equal(outbox.state.get().ops.length, 0);
});

test('engine: waits for a valid session; an ended session keeps everything queued', async () => {
  const { outbox, ctl, sent, server } = setupOutbox({ session: 'ended' });
  await outbox.load();
  const r = await w(outbox, 'insert', 'a', { id: 'a' });
  assert.equal(r.status, 'queued');
  assert.equal(sent.length, 0);
  assert.equal(outbox.state.get().blocked, 'session');
  ctl.session = 'network';
  await outbox.kick();
  assert.equal(outbox.state.get().blocked, 'offline');
  ctl.session = 'ok';
  await outbox.kick();
  assert.ok(server.has('a'));
  assert.equal(outbox.state.get().blocked, null);
});

test('engine: a 401 after the refresh re-checks the session instead of dropping', async () => {
  const { outbox, ctl, server } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'a', { id: 'a' });
  ctl.online = true;
  // The token is refused, and the refresh then finds the session ended.
  ctl.answers.push(() => ((ctl.session = 'ended'), { status: 'auth' }));
  await outbox.kick();
  assert.equal(outbox.state.get().blocked, 'session');
  assert.equal(outbox.state.get().ops.length, 1);
  ctl.session = 'ok';
  await outbox.kick();
  assert.ok(server.has('a'));
});

test('engine: with no network at all nothing is tried; the next kick sends', async () => {
  const storage = fakeStorage();
  let net = false;
  const sent = [];
  const outbox = createOutbox({
    storage, send: async (o) => (sent.push(o), { status: 'ok', row: o.values }), session: async () => 'ok', canTry: () => net,
    userId: () => 'u1', userName: () => 'A', uuid: () => Math.random().toString(36), schedule: () => () => {},
  });
  await outbox.load();
  const r = await w(outbox, 'insert', 'a', { id: 'a' });
  assert.equal(r.status, 'queued');
  assert.equal(sent.length, 0);
  assert.equal(outbox.state.get().blocked, 'offline');
  net = true;
  await outbox.kick();
  assert.equal(sent.length, 1);
});

test('engine: a write with nobody signed in is refused at once, not queued', async () => {
  const { outbox, ctl, sent } = setupOutbox();
  await outbox.load();
  ctl.user = null;
  const r = await w(outbox, 'insert', 'a', { id: 'a' });
  assert.equal(r.status, 'failed');
  assert.equal(outbox.state.get().ops.length, 0);
  assert.equal(sent.length, 0);
});

test('engine: changes wait for their own author; signed out, nothing is sent or lost', async () => {
  const { outbox, ctl, sent, server } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'a', { id: 'a' });
  ctl.online = true;
  ctl.user = null;
  sent.length = 0;
  await outbox.kick();
  assert.equal(sent.length, 0);
  assert.equal(outbox.state.get().blocked, 'session');
  ctl.user = 'u2';
  await outbox.kick();
  assert.equal(sent.length, 0, "another editor's session does not send u1's change");
  ctl.user = 'u1';
  await outbox.kick();
  assert.ok(server.has('a'));
});

test('engine: an edit of a row deleted on the other phone stays deleted (quiet notice)', async () => {
  const { outbox, ctl, notices, server } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  const r = w(outbox, 'update', 'gone-row', { notes: 'x' });
  ctl.online = true;
  await r;
  await outbox.kick();
  assert.equal(server.has('gone-row'), false);
  assert.deepEqual(notices, ['gone']);
  assert.equal(outbox.state.get().ops.length, 0);
  assert.equal(outbox.state.get().rejected.length, 0);
});

test('engine: a change made while its row is being sent waits behind it', async () => {
  const { outbox, ctl, sent, server } = setupOutbox();
  await outbox.load();
  let release;
  ctl.answers.push((o) => new Promise((res) => (release = () => (server.set(o.rowKey, { ...o.values }), res({ status: 'ok', row: { ...o.values } })))));
  const p1 = w(outbox, 'insert', 'a', { id: 'a', notes: null });
  await settle();
  assert.deepEqual(outbox.inflightIds().length, 1);
  const p2 = w(outbox, 'update', 'a', { notes: 'later' });
  await settle();
  assert.equal(outbox.state.get().ops.length, 2, 'not merged into the in-flight insert');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(sent.map((s) => s.kind), ['insert', 'update']);
  assert.equal(server.get('a').notes, 'later');
});

test('engine: a caller gives up waiting on a slow request; the change stays and syncs once', async () => {
  const { outbox, ctl, timers, server, sent } = setupOutbox();
  await outbox.load();
  let release;
  ctl.answers.push((o) => new Promise((res) => (release = () => (server.set(o.rowKey, { ...o.values }), res({ status: 'ok', row: { ...o.values } })))));
  const p = w(outbox, 'insert', 'a', { id: 'a' });
  await settle();
  await timers.advance(8000);
  assert.equal((await p).status, 'queued');
  release();
  await outbox.kick();
  assert.ok(server.has('a'));
  assert.equal(sent.length, 1);
});

test('engine: insert then delete while offline sends nothing', async () => {
  const { outbox, ctl, sent } = setupOutbox();
  await outbox.load();
  ctl.online = false;
  await w(outbox, 'insert', 'a', { id: 'a' });
  sent.length = 0;
  const r = await w(outbox, 'delete', 'a');
  assert.equal(r.status, 'cancelled');
  ctl.online = true;
  await outbox.kick();
  assert.equal(sent.length, 0);
});

test('engine: a reload from storage (another tab) keeps changes made meanwhile', async () => {
  const storage = fakeStorage();
  const a = setupOutbox({ storage });
  const b = setupOutbox({ storage });
  await a.outbox.load();
  await b.outbox.load();
  a.ctl.online = false;
  b.ctl.online = false;
  await w(a.outbox, 'insert', 'from-a', { id: 'from-a' });
  await w(b.outbox, 'insert', 'from-b', { id: 'from-b' });
  await a.outbox.flushed();
  await b.outbox.flushed();
  await a.outbox.load();
  assert.deepEqual(a.outbox.state.get().ops.map((o) => o.rowKey).sort(), ['from-a', 'from-b']);
  assert.equal(storage.m.ops.size, 2, 'neither tab overwrote the other');
});

// ---------------------------------------------------------------------------
// sendOp: idempotent requests
// ---------------------------------------------------------------------------

/** Fake supabase client answering per method. */
function client(answer) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, method: 'select', body: null, filters: [] };
      calls.push(call);
      const b = {
        insert: (v) => ((call.method = 'insert'), (call.body = v), b),
        update: (v) => ((call.method = 'update'), (call.body = v), b),
        upsert: (v, o) => ((call.method = 'upsert'), (call.body = v), (call.opts = o), b),
        delete: () => ((call.method = 'delete'), b),
        select: () => b,
        eq: (c, v) => (call.filters.push([c, v]), b),
        abortSignal: () => b,
        single: () => b,
        then: (res, rej) => Promise.resolve(answer(call, calls)).then(res, rej),
      };
      return b;
    },
  };
}

test('sendOp: a retried insert whose first attempt reached the server applies its values, no duplicate', async () => {
  const c = client((call) =>
    call.method === 'insert'
      ? { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
      : { data: [{ id: 'a', ...call.body }], error: null, status: 200 },
  );
  const r = await sendOp(op('insert', 'a', { id: 'a', fed_at: 'T1', notes: 'later edit' }), c);
  assert.equal(r.status, 'ok');
  assert.deepEqual(c.calls.map((x) => x.method), ['insert', 'update']);
  assert.deepEqual(c.calls[1].body, { fed_at: 'T1', notes: 'later edit' });
  assert.deepEqual(c.calls[1].filters, [['id', 'a']]);
});

test('sendOp: a duplicate on another unique column is a refusal', async () => {
  const c = client((call) => (call.method === 'insert' ? { data: null, error: { code: '23505' }, status: 409 } : { data: [], error: null, status: 200 }));
  const r = await sendOp(op('insert', 'p', { id: 'p', storage_path: 'x' }), c);
  assert.equal(r.status, 'rejected');
});

test('sendOp: update of a missing row is "gone"; delete is idempotent; network is network', async () => {
  let r = await sendOp(op('update', 'a', { notes: 'x' }), client(() => ({ data: [], error: null, status: 200 })));
  assert.equal(r.status, 'gone');
  r = await sendOp(op('delete', 'a'), client(() => ({ data: null, error: null, status: 204 })));
  assert.equal(r.status, 'ok');
  r = await sendOp(op('insert', 'a', { id: 'a' }), client(() => ({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 })));
  assert.equal(r.status, 'network');
  r = await sendOp(op('insert', 'a', { id: 'a' }), client(() => ({ data: null, error: { code: '23514', message: 'check' }, status: 400 })));
  assert.equal(r.status, 'rejected');
  assert.equal(r.error.code, '23514');
  r = await sendOp(op('upsert', 'sit', { skill_key: 'sit' }, { key: 'skill_key' }), client((call) => ({ data: call.body, error: null, status: 201 })));
  assert.deepEqual(r, { status: 'ok', row: { skill_key: 'sit' } });
});

// ---------------------------------------------------------------------------
// Table store + outbox
// ---------------------------------------------------------------------------

function storeWithOutbox(config = { table: 'feedings', orderBy: { column: 'fed_at' } }) {
  const o = setupOutbox();
  const cache = {};
  const errors = [];
  let selectRows = [];
  const fake = {
    from() {
      const b = { select: () => b, order: () => b, gte: () => b, lt: () => b, then: (res) => Promise.resolve({ data: selectRows.map((r) => ({ ...r })), error: null }).then(res) };
      return b;
    },
  };
  let n = 0;
  const store = createTableStore(config, {
    getClient: () => fake,
    notifyError: (m) => errors.push(m),
    readCache: (k) => cache[k] ?? null,
    writeCache: (k, v) => (cache[k] = v),
    clearCache: (k) => delete cache[k],
    isOffline: () => false,
    editorName: () => 'Alex',
    t: (k) => k,
    uuid: () => `row-${++n}`,
    outbox: o.outbox,
  });
  return { ...o, store, cache, errors, setServerRows: (rows) => (selectRows = rows) };
}

test('store: offline insert is shown at once, pending, and survives a refresh from the server', async () => {
  const { outbox, ctl, store, setServerRows } = storeWithOutbox();
  await outbox.load();
  ctl.online = false;
  const res = await store.insert({ fed_at: '2026-11-18T12:00:00.000Z', meal_slot: 2 });
  assert.equal(res.error, null);
  assert.equal(res.queued, true);
  assert.equal(res.data.id, 'row-1');
  assert.equal(store.get('row-1')._pending, true);
  setServerRows([{ id: 'old', fed_at: '2026-11-17T12:00:00.000Z' }]);
  await store.load();
  assert.deepEqual(store.rows().map((r) => r.id), ['row-1', 'old'], 'the queued row is still shown');
});

test('store: when the sync succeeds the server row replaces the pending one', async () => {
  const { outbox, ctl, store } = storeWithOutbox();
  await outbox.load();
  ctl.online = false;
  await store.insert({ fed_at: 'T1' });
  ctl.online = true;
  await outbox.kick();
  assert.equal(store.get('row-1')._pending, undefined);
  assert.equal(store.get('row-1').fed_at, 'T1');
});

test('store: a refused online write rolls back and toasts like before', async () => {
  const { outbox, ctl, store, errors } = storeWithOutbox();
  await outbox.load();
  ctl.answers.push({ status: 'rejected', error: { code: '23514', status: 400 } });
  const res = await store.insert({ fed_at: 'T1' });
  assert.ok(res.error);
  assert.equal(store.rows().length, 0);
  assert.deepEqual(errors, ['errors.saveFailed']);
});

test('store: offline delete hides the row; a delete refused later brings it back with the list', async () => {
  const { outbox, ctl, store, setServerRows } = storeWithOutbox();
  await outbox.load();
  setServerRows([{ id: 'a', fed_at: 'T1' }]);
  await store.load();
  ctl.online = false;
  const r = await store.remove('a');
  assert.equal(r.error, null);
  assert.equal(store.rows().length, 0);
  ctl.online = true;
  ctl.answers.push({ status: 'rejected', error: { code: '42501', status: 403 } });
  await outbox.kick();
  assert.equal(store.rows().length, 1, 'the row is shown again; the refused delete is listed');
  assert.equal(outbox.state.get().rejected.length, 1);
});

test('store: the cache keeps server rows; queued changes come from the outbox', async () => {
  const { outbox, ctl, store, cache } = storeWithOutbox();
  await outbox.load();
  ctl.online = false;
  await store.insert({ fed_at: 'T1' });
  assert.deepEqual(cache['cache.feedings']?.rows || [], []);
});

test('store: tables marked offline:false still fail fast offline', async () => {
  const o = setupOutbox();
  const errors = [];
  const store = createTableStore(
    { table: 'chat_threads', offline: false },
    { getClient: () => ({}), notifyError: (m) => errors.push(m), readCache: () => null, writeCache: () => {}, clearCache: () => {}, isOffline: () => true, editorName: () => 'A', t: (k) => k, uuid: () => 'x', outbox: o.outbox },
  );
  const r = await store.update('t1', { title: 'x' });
  assert.ok(r.error);
  assert.deepEqual(errors, ['errors.offline']);
  assert.equal(o.outbox.state.get().ops.length, 0);
});
