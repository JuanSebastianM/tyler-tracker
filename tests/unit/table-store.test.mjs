import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTableStore } from '../../src/data/table-store.js';

/**
 * Fake Supabase client: records calls and resolves with the queued result per operation.
 * Every builder method returns the builder; awaiting it (or .single()) resolves the result.
 */
function fakeClient() {
  const calls = [];
  const results = { select: { data: [], error: null }, insert: null, update: null, upsert: null, delete: { data: null, error: null } };
  const client = {
    calls,
    results,
    from(table) {
      const call = { table, op: 'select', args: [], filters: [] };
      calls.push(call);
      const builder = {
        select: (...a) => ((call.selectArgs = a), builder),
        insert: (v) => ((call.op = 'insert'), (call.args = [v]), builder),
        update: (v) => ((call.op = 'update'), (call.args = [v]), builder),
        upsert: (v, o) => ((call.op = 'upsert'), (call.args = [v, o]), builder),
        delete: () => ((call.op = 'delete'), builder),
        eq: (c, v) => (call.filters.push(['eq', c, v]), builder),
        gte: (c, v) => (call.filters.push(['gte', c, v]), builder),
        lt: (c, v) => (call.filters.push(['lt', c, v]), builder),
        order: (c, o) => ((call.order = [c, o]), builder),
        single: () => builder,
        then: (resolve, reject) => {
          const r = results[call.op];
          const value = typeof r === 'function' ? r(call) : r;
          return Promise.resolve(value).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}

function setup(config = { table: 'weights', orderBy: { column: 'measured_on' } }, { cache = {}, offline = false, editor = 'Alex' } = {}) {
  const client = fakeClient();
  const errors = [];
  let n = 0;
  const store = createTableStore(config, {
    getClient: () => client,
    notifyError: (m) => errors.push(m),
    readCache: (k) => cache[k] ?? null,
    writeCache: (k, v) => (cache[k] = v),
    clearCache: (k) => delete cache[k],
    isOffline: () => offline,
    editorName: () => editor,
    t: (k) => k,
    uuid: () => `uuid-${++n}`,
  });
  return { client, store, errors, cache };
}

test('renders cached rows first, then replaces them after load', async () => {
  const { client, store, cache } = setup(undefined, { cache: { 'cache.weights': { rows: [{ id: 'old', measured_on: '2026-11-01' }] } } });
  assert.equal(store.state.get().fromCache, true);
  assert.equal(store.rows()[0].id, 'old');
  client.results.select = { data: [{ id: 'a', measured_on: '2026-11-08' }, { id: 'b', measured_on: '2026-11-12' }], error: null };
  await store.load();
  const s = store.state.get();
  assert.equal(s.status, 'ready');
  assert.equal(s.fromCache, false);
  assert.deepEqual(store.rows().map((r) => r.id), ['b', 'a'], 'sorted desc by orderBy column');
  assert.deepEqual(cache['cache.weights'].rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(client.calls[0].order, ['measured_on', { ascending: false }]);
});

test('load error keeps cached rows and reports status', async () => {
  const { client, store } = setup(undefined, { cache: { 'cache.weights': { rows: [{ id: 'old' }] } } });
  client.results.select = { data: null, error: { message: 'boom' } };
  const res = await store.load();
  assert.equal(res.error, 'boom');
  assert.equal(store.state.get().status, 'error');
  assert.equal(store.rows().length, 1);
});

test('concurrent loads share one request', async () => {
  const { client, store } = setup();
  await Promise.all([store.load(), store.load(), store.refresh()]);
  assert.equal(client.calls.length, 1);
});

test('optimistic insert: row appears immediately with a client uuid, then server row replaces it', async () => {
  const { client, store } = setup();
  let seenDuringRequest;
  client.results.insert = (call) => {
    seenDuringRequest = store.rows().map((r) => ({ ...r }));
    return { data: { ...call.args[0], created_by_name: 'Alex', created_at: 'server' }, error: null };
  };
  const res = await store.insert({ measured_on: '2026-11-13', weight_kg: 5, created_by_name: 'hacker', created_at: 'x' });
  assert.equal(res.error, null);
  assert.equal(seenDuringRequest.length, 1);
  assert.equal(seenDuringRequest[0]._pending, true);
  assert.equal(seenDuringRequest[0].id, 'uuid-1');
  const sent = client.calls[0].args[0];
  assert.deepEqual(sent, { measured_on: '2026-11-13', weight_kg: 5, id: 'uuid-1' }, 'audit columns are never sent');
  assert.equal(store.rows()[0].created_at, 'server');
  assert.equal(store.rows()[0]._pending, undefined);
});

test('failed insert rolls back and notifies', async () => {
  const { client, store, errors } = setup();
  client.results.insert = { data: null, error: { message: 'rls' } };
  const res = await store.insert({ measured_on: '2026-11-13', weight_kg: 5 });
  assert.ok(res.error);
  assert.equal(store.rows().length, 0);
  assert.deepEqual(errors, ['errors.saveFailed']);
});

test('failed update restores the previous row', async () => {
  const { client, store, errors } = setup();
  client.results.select = { data: [{ id: 'a', measured_on: '2026-11-08', weight_kg: 4 }], error: null };
  await store.load();
  client.results.update = { data: null, error: { message: 'x' } };
  await store.update('a', { weight_kg: 9 });
  assert.equal(store.get('a').weight_kg, 4);
  assert.deepEqual(errors, ['errors.saveFailed']);
  assert.deepEqual(client.calls.at(-1).filters, [['eq', 'id', 'a']]);
});

test('successful update merges the server row', async () => {
  const { client, store } = setup();
  client.results.select = { data: [{ id: 'a', measured_on: '2026-11-08', weight_kg: 4 }], error: null };
  await store.load();
  client.results.update = (call) => ({ data: { id: 'a', measured_on: '2026-11-08', ...call.args[0] }, error: null });
  await store.update('a', { weight_kg: 4.4, id: 'ignored' });
  assert.deepEqual(client.calls.at(-1).args[0], { weight_kg: 4.4 });
  assert.equal(store.get('a').weight_kg, 4.4);
});

test('failed delete restores the row', async () => {
  const { client, store, errors } = setup();
  client.results.select = { data: [{ id: 'a', measured_on: '2026-11-08' }], error: null };
  await store.load();
  client.results.delete = { data: null, error: { message: 'x' } };
  await store.remove('a');
  assert.ok(store.get('a'));
  assert.deepEqual(errors, ['errors.deleteFailed']);
});

test('offline writes fail fast without touching state', async () => {
  const { client, store, errors } = setup(undefined, { offline: true });
  const res = await store.insert({ measured_on: '2026-11-13' });
  assert.ok(res.error);
  assert.equal(client.calls.length, 0);
  assert.equal(store.rows().length, 0);
  assert.deepEqual(errors, ['errors.offline']);
});

test('upsert for text-key tables', async () => {
  const { client, store } = setup({ table: 'training_skills', key: 'skill_key', keyKind: 'text' });
  client.results.upsert = (call) => ({ data: { ...call.args[0] }, error: null });
  await store.upsert({ skill_key: 'sit', status: 'learning' });
  assert.deepEqual(client.calls[0].args, [{ skill_key: 'sit', status: 'learning' }, { onConflict: 'skill_key' }]);
  assert.equal(store.get('sit').status, 'learning');
  client.results.upsert = { data: null, error: { message: 'x' } };
  await store.upsert({ skill_key: 'sit', status: 'mastered' });
  assert.equal(store.get('sit').status, 'learning', 'rolled back to previous value');
});

test('ranged tables query a window and merge rows, dropping ones deleted remotely', async () => {
  const { client, store } = setup({ table: 'feedings', orderBy: { column: 'fed_at' }, rangeColumn: 'fed_at' });
  const day1 = { start: '2026-11-12T05:00:00.000Z', end: '2026-11-13T05:00:00.000Z' };
  const day2 = { start: '2026-11-13T05:00:00.000Z', end: '2026-11-14T05:00:00.000Z' };
  client.results.select = { data: [{ id: 'x', fed_at: '2026-11-12T12:00:00.000Z' }, { id: 'y', fed_at: '2026-11-12T20:00:00.000Z' }], error: null };
  await store.loadRange(day1.start, day1.end);
  assert.deepEqual(client.calls[0].filters, [['gte', 'fed_at', day1.start], ['lt', 'fed_at', day1.end]]);
  client.results.select = { data: [{ id: 'z', fed_at: '2026-11-13T12:00:00.000Z' }], error: null };
  await store.loadRange(day2.start, day2.end);
  assert.deepEqual(store.rows().map((r) => r.id), ['z', 'y', 'x']);
  assert.deepEqual(store.inRange(day1.start, day1.end).map((r) => r.id), ['y', 'x']);
  // 'y' was deleted on another device
  client.results.select = { data: [{ id: 'x', fed_at: '2026-11-12T12:00:00.000Z' }], error: null };
  await store.loadRange(day1.start, day1.end);
  assert.deepEqual(store.rows().map((r) => r.id), ['z', 'x']);
});

test('default range is used by load() for ranged tables', async () => {
  const { client, store } = setup({ table: 'feedings', orderBy: { column: 'fed_at' }, rangeColumn: 'fed_at' });
  store.setDefaultRange({ start: 'A', end: 'B' });
  await store.load();
  assert.deepEqual(client.calls[0].filters, [['gte', 'fed_at', 'A'], ['lt', 'fed_at', 'B']]);
});

test('private tables load nothing and cache nothing for non-editors', async () => {
  const { client, store, cache } = setup({ table: 'pet_private', keyKind: 'single', private: true }, { editor: '' });
  await store.load();
  assert.equal(client.calls.length, 0);
  assert.deepEqual(cache, {});
});

test('clear() forgets rows and cache', async () => {
  const { client, store, cache } = setup();
  client.results.select = { data: [{ id: 'a', measured_on: '1' }], error: null };
  await store.load();
  store.clear();
  assert.equal(store.rows().length, 0);
  assert.equal(cache['cache.weights'], undefined);
});

test('private tables are not fetched without a valid session, so shown rows are kept', async () => {
  const client = fakeClient();
  let sessionOk = true;
  const busy = [];
  const store = createTableStore(
    { table: 'chat_threads', private: true },
    {
      getClient: () => client,
      notifyError: () => {},
      readCache: () => null,
      writeCache: () => {},
      clearCache: () => {},
      isOffline: () => false,
      editorName: () => 'Alex',
      t: (k) => k,
      uuid: () => 'u',
      ensureSession: async () => sessionOk,
      beginBusy: (reason) => (busy.push(reason), () => busy.push(`end:${reason}`)),
    },
  );
  client.results.select = { data: [{ id: 't1' }], error: null };
  await store.load();
  assert.deepEqual(store.rows().map((r) => r.id), ['t1']);
  // iOS resumed the app with an expired token and no network: the anonymous read would be empty.
  sessionOk = false;
  client.results.select = { data: [], error: null };
  const r = await store.load();
  assert.equal(r.error, 'session');
  assert.deepEqual(store.rows().map((x) => x.id), ['t1']);
  assert.equal(client.calls.length, 1);
  // Writes are marked busy (an update reload waits for them).
  client.results.insert = { data: { id: 't2' }, error: null };
  await store.insert({ title: 'x' });
  assert.deepEqual(busy, ['write', 'end:write']);
});
