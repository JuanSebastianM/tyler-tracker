// Session safety, update gating and idempotent sends (launch-day fixes): pure logic of the app and
// of the `chat` function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthError, needsRefresh, parseStoredSession, withTimeout } from '../../src/lib/auth-logic.js';
import { beginBusy, isBusy, whenIdle, busyStore } from '../../src/lib/busy.js';
import { answerFor, draftKey, normalizeError, RETRYABLE, tokenErrorCode, withUpdateHint, ERROR_CODES } from '../../src/features/assistant/logic.js';
import { createSseParser } from '../../src/features/assistant/sse.js';
import { parseRequest, ERROR_STATUS } from '../../supabase/functions/chat/lib/http.ts';
import { verifyUser } from '../../supabase/functions/chat/lib/rest.ts';
import { RestError } from '../../supabase/functions/chat/lib/rest.ts';
import { duplicateRequestState, InProgressError, reservationRow, reserve, STALE_RESERVATION_MS } from '../../supabase/functions/chat/lib/budget.ts';
import { pickAnswer, SSE_KEEPALIVE, KEEPALIVE_MS } from '../../supabase/functions/chat/lib/replay.ts';
import { readFileSync } from 'node:fs';

const REQ = '1b2c3d4e-0000-4000-8000-00000000abcd';

// ---------------------------------------------------------------------------
// Session tokens (src/lib/auth-logic.js)
// ---------------------------------------------------------------------------

test('auth errors: unreachable server is "network", a rejected refresh token is "expired"', () => {
  assert.equal(classifyAuthError({ name: 'AuthRetryableFetchError', status: 0, message: 'Load failed' }), 'network');
  assert.equal(classifyAuthError(new TypeError('Failed to fetch')), 'network');
  assert.equal(classifyAuthError({ name: 'TimeoutError' }), 'network');
  assert.equal(classifyAuthError({ name: 'AuthApiError', status: 503 }), 'network');
  assert.equal(classifyAuthError({ name: 'AuthApiError', status: 429 }), 'network');
  assert.equal(classifyAuthError({ name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' }), 'expired');
  assert.equal(classifyAuthError({ name: 'AuthApiError', status: 401 }), 'expired');
  assert.equal(classifyAuthError({ name: 'AuthSessionMissingError', status: 400 }), 'signedOut');
  assert.equal(classifyAuthError(null), 'network');
});

test('a token is refreshed when it expires within a minute', () => {
  const now = Date.parse('2026-11-13T21:03:00Z');
  const exp = (iso) => Date.parse(iso) / 1000;
  assert.equal(needsRefresh({ access_token: 'a', expires_at: exp('2026-11-13T21:04:22Z') }, now), false); // 82 s left
  assert.equal(needsRefresh({ access_token: 'a', expires_at: exp('2026-11-13T21:03:30Z') }, now), true);
  assert.equal(needsRefresh({ access_token: 'a', expires_at: exp('2026-11-13T20:59:00Z') }, now), true); // expired while suspended
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh({ access_token: 'a' }, now), false);
});

test('stored session: only a refreshable session counts', () => {
  assert.equal(parseStoredSession(null), null);
  assert.equal(parseStoredSession('not json'), null);
  assert.equal(parseStoredSession(JSON.stringify({ access_token: 'a' })), null);
  assert.equal(parseStoredSession(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1 })).refresh_token, 'r');
  assert.equal(parseStoredSession(JSON.stringify({ currentSession: { access_token: 'a', refresh_token: 'r' } })).access_token, 'a');
});

test('withTimeout rejects with a TimeoutError and passes results through', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), { name: 'TimeoutError' });
});

// ---------------------------------------------------------------------------
// Work in flight (src/lib/busy.js): the update waits for it
// ---------------------------------------------------------------------------

test('busy: nested work, idempotent end, whenIdle fires once when everything ended', () => {
  assert.equal(isBusy(), false);
  let fired = 0;
  whenIdle(() => fired++);
  assert.equal(fired, 1, 'runs at once when idle');
  const a = beginBusy('assistant');
  const b = beginBusy('upload');
  whenIdle(() => fired++);
  assert.equal(fired, 1);
  a();
  a(); // ending twice does not end someone else's work
  assert.equal(isBusy(), true);
  assert.deepEqual(busyStore.get(), { upload: 1 });
  b();
  assert.equal(isBusy(), false);
  assert.equal(fired, 2);
  beginBusy('x')();
  assert.equal(fired, 2, 'a later idle moment does not fire again');
});

test('busy: whenIdle can be cancelled', () => {
  const end = beginBusy('write');
  let fired = false;
  const cancel = whenIdle(() => (fired = true));
  cancel();
  end();
  assert.equal(fired, false);
});

// ---------------------------------------------------------------------------
// Assistant client logic
// ---------------------------------------------------------------------------

test('a token that could not be refreshed for lack of network is never "signed out"', () => {
  assert.equal(tokenErrorCode('network'), 'network');
  assert.equal(tokenErrorCode('expired'), 'unauthorized');
  assert.equal(tokenErrorCode('signedOut'), 'unauthorized');
});

test('new error codes are known, retryable where it helps, and get an update hint', () => {
  for (const c of ['offline', 'timeout', 'interrupted', 'in_progress', 'update_pending']) assert.equal(normalizeError(c), c);
  for (const c of ['offline', 'timeout', 'interrupted', 'in_progress', 'network']) assert.ok(RETRYABLE.has(c), c);
  for (const c of ['unauthorized', 'budget_exhausted', 'upstream_config', 'update_pending']) assert.ok(!RETRYABLE.has(c), c);
  assert.equal(normalizeError('forbidden_origin'), 'server_error');
  assert.equal(withUpdateHint('server_error', true), 'update_pending');
  assert.equal(withUpdateHint('bad_request', true), 'update_pending');
  assert.equal(withUpdateHint('server_error', false), 'server_error');
  assert.equal(withUpdateHint('budget_exhausted', true), 'budget_exhausted');
});

test('every assistant error code has a title and body in Spanish and English', () => {
  for (const lang of ['es', 'en']) {
    const strings = JSON.parse(readFileSync(new URL(`../../src/features/assistant/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const code of [...ERROR_CODES, 'upstream_config', 'upstream_busy']) {
      assert.ok(strings.errors[code]?.title && strings.errors[code]?.body, `${lang}: errors.${code}`);
    }
  }
});

test('draft keys and the saved answer to a request id', () => {
  assert.equal(draftKey(null), 'new');
  assert.equal(draftKey('t1'), 't1');
  const rows = [
    { id: 'q0', role: 'user', content: 'antes', created_at: '2026-11-13T21:00:00Z' },
    { id: 'a0', role: 'assistant', content: 'r0', created_at: '2026-11-13T21:00:10Z' },
    { id: REQ, role: 'user', content: '¿y el agua?', created_at: '2026-11-13T21:04:00Z' },
    { id: 'f1', role: 'assistant', content: '<!--faq-draft-->{}', created_at: '2026-11-13T21:04:05Z' },
    { id: 'a1', role: 'assistant', content: 'Siempre disponible.', created_at: '2026-11-13T21:04:09Z' },
  ];
  assert.equal(answerFor(rows, REQ).answer.id, 'a1');
  assert.equal(answerFor(rows.slice(0, 3), REQ), null, 'question saved, answer not yet');
  assert.equal(answerFor(rows, 'missing'), null);
});

test('the client SSE parser ignores the keep-alive comments', () => {
  const out = [];
  const p = createSseParser((e) => out.push(e.event));
  p.push(`event: meta\ndata: {}\n\n${SSE_KEEPALIVE}${SSE_KEEPALIVE}event: delta\ndata: {"text":"a"}\n\n`);
  p.end();
  assert.deepEqual(out, ['meta', 'delta']);
  assert.ok(KEEPALIVE_MS * 3 <= 45_000, 'three keep-alives fit in the app stall timeout');
});

// ---------------------------------------------------------------------------
// chat function: request ids, transient auth failures, duplicate requests
// ---------------------------------------------------------------------------

test('send accepts an optional request id (UUID only)', () => {
  assert.deepEqual(parseRequest({ action: 'send', message: 'hola', request_id: REQ }), { action: 'send', threadId: null, message: 'hola', requestId: REQ });
  assert.equal(parseRequest({ action: 'send', message: 'hola', request_id: 'abc' }), null);
  assert.equal(ERROR_STATUS.in_progress, 409);
});

test('verifyUser: a rejected token is null (401), an unreachable Auth throws (500, retryable)', async () => {
  const respond = (status, body = {}) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await verifyUser('https://x.test', 'pk', 'jwt', respond(200, { id: 'u1' })), 'u1');
  assert.equal(await verifyUser('https://x.test', 'pk', 'jwt', respond(401)), null);
  assert.equal(await verifyUser('https://x.test', 'pk', 'jwt', respond(403)), null);
  await assert.rejects(verifyUser('https://x.test', 'pk', 'jwt', respond(503)), RestError);
  await assert.rejects(verifyUser('https://x.test', 'pk', 'jwt', async () => {
    throw new TypeError('connection reset');
  }));
});

test('reservation carries the request id; a duplicate is in progress unless settled or stale', async () => {
  const owner = { editorId: 'u1', editorName: 'Ed', threadId: null, requestId: REQ };
  assert.equal(reservationRow('send', 0.1, owner).message_id, REQ);
  assert.equal(reservationRow('send', 0.1, { ...owner, requestId: null }).message_id, undefined);
  const now = new Date('2026-11-13T21:05:00Z');
  assert.equal(duplicateRequestState({ model: 'reservation:send', created_at: '2026-11-13T21:04:30Z' }, now), 'in_progress');
  assert.equal(duplicateRequestState({ model: 'reservation:send', created_at: new Date(now.getTime() - STALE_RESERVATION_MS - 1).toISOString() }, now), 'retry');
  assert.equal(duplicateRequestState({ model: 'claude-sonnet-5-5', created_at: '2026-11-13T21:04:30Z' }, now), 'retry'); // billed failure
  assert.equal(duplicateRequestState(null, now), 'retry');

  // A unique message_id, like the real ai_usage table.
  const rows = [];
  const svc = {
    async insert(_t, row) {
      if (row.message_id && rows.some((r) => r.message_id === row.message_id)) throw new RestError(409, '23505', 'duplicate');
      const r = { id: `r${rows.length + 1}`, created_at: now.toISOString(), ...row };
      rows.push(r);
      return r;
    },
    async select(_t, q) {
      const id = decodeURIComponent(/message_id=eq\.([^&]+)/.exec(q)[1]);
      return rows.filter((r) => r.message_id === id);
    },
  };
  const first = await reserve(svc, 'send', 0.1, owner, now);
  assert.equal(first, 'r1');
  await assert.rejects(reserve(svc, 'send', 0.1, owner, now), InProgressError);
  // The first attempt failed and was billed: a retry may reserve again (without the id).
  rows[0].model = 'claude-sonnet-5-5';
  const again = await reserve(svc, 'send', 0.1, owner, now);
  assert.equal(again, 'r2');
  assert.equal(rows[1].message_id, undefined);
});

test('replay finds the first saved answer after the question', () => {
  const q = { id: REQ, thread_id: 't1', role: 'user', content: 'q', created_at: '2026-11-13T21:04:00Z' };
  const rows = [
    { id: 'old', thread_id: 't1', role: 'assistant', content: 'antes', created_at: '2026-11-13T21:00:00Z' },
    { id: 'faq', thread_id: 't1', role: 'assistant', content: '<!--faq-draft-->{}', created_at: '2026-11-13T21:04:01Z' },
    { id: 'later', thread_id: 't1', role: 'assistant', content: 'después', created_at: '2026-11-13T21:09:00Z' },
    { id: 'ans', thread_id: 't1', role: 'assistant', content: 'respuesta', created_at: '2026-11-13T21:04:10Z' },
  ];
  assert.equal(pickAnswer(q, rows).id, 'ans');
  assert.equal(pickAnswer(q, rows.slice(0, 2)), null);
});
