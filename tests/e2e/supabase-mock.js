// Mocks the Supabase REST, Auth and Storage APIs with Playwright routes, backed by an in-memory
// copy of the fixtures. Nothing reaches the network.
//
//   const sb = await mockSupabase(page, { mode: 'asEditor' });
//   await page.goto('./#/today');
//   ...
//   expect(sb.db.feedings).toHaveLength(3);          // writes land in sb.db
//   expect(sb.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
//
// Options:
//   mode: 'signedOut' (default) | 'asEditor' (session pre-seeded, editors row readable)
//   fixtures: { table: rows } overrides
//   now: ISO string for the page clock (default FIXED_NOW); pass null to use the real clock
//   failWrites: true -> every insert/update/delete returns HTTP 500 (test rollback + toast)
//   password: the password that signs in successfully via the sign-in sheet (default 'correct-password')
//   content: { name: json | null } overrides of the fake reading content (content-fixtures.js) that
//     is served for every content/*.json request (null = HTTP 404); 'real' serves the repo files
//   chat: behaviour of the `chat` Edge Function mock (see mockChatFunction below):
//     { reply, sources, refuse: '<error code>', streamError: true, draft, draftError: '<code>', budget,
//       unauthorizedOnce: true (the first call gets the gateway's 401, like an expired JWT),
//       stall: 'before-save' | 'after-save' (the response never arrives; 'after-save' saves the answer
//       first, like a function that finished while the connection to the phone was dead),
//       inProgress: true (answers 409 in_progress), delayMs: the answer arrives after this long,
//       waitFor: a promise; the answer arrives once it resolves }
//     sb.setChat(patch) changes it during a test.
//   refresh: 'ok' (default) | 'network' (the refresh request fails) | 'invalid' (refresh token rejected)
//   jwtExpiredOnce: true -> the first REST/Storage write answers 401 "JWT expired" (the app refreshes
//     the session and retries)
// Every call records its Authorization token (`calls[i].token`).
import { defaultFixtures, EDITOR_USER, FIXED_NOW, PRIVATE_TABLES } from './fixtures.js';
import { CONTENT_FIXTURES } from './content-fixtures.js';

export const SUPABASE_URL = 'https://kegtfxoiijbytprfwqrl.supabase.co';
export const AUTH_STORAGE_KEY = 'tt-auth';

const KEYS = { training_skills: 'skill_key', checklist_done: 'item_key', vet_visit_private: 'visit_id', editors: 'user_id' };
const keyOf = (table) => KEYS[table] || 'id';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

let sessionCounter = 0;
/** A session object as supabase-js stores it. @param {number} nowMs @param {number} [lifetimeS] */
export function makeSession(nowMs, lifetimeS = 3600) {
  const exp = Math.floor(nowMs / 1000) + lifetimeS;
  const user = {
    id: EDITOR_USER.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: EDITOR_USER.email,
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-11-10T00:00:00Z',
  };
  const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, role: 'authenticated', aud: 'authenticated', exp, email: user.email, n: ++sessionCounter })}.c2ln`;
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'mock-refresh-token', user };
}

/** Parse PostgREST filters from search params into predicate functions. */
function filtersFrom(params) {
  const preds = [];
  for (const [col, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(col)) continue;
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like|ilike)\.(.*)$/.exec(raw);
    if (!m) continue;
    const [, not, op, v] = m;
    const cmp = (x) => {
      switch (op) {
        case 'eq': return String(x) === v;
        case 'neq': return String(x) !== v;
        case 'gt': return x != null && String(x) > v;
        case 'gte': return x != null && String(x) >= v;
        case 'lt': return x != null && String(x) < v;
        case 'lte': return x != null && String(x) <= v;
        case 'is': return v === 'null' ? x == null : String(x) === v;
        case 'in': return v.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(x));
        case 'like':
        case 'ilike': return new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', op === 'ilike' ? 'i' : '').test(String(x ?? ''));
      }
      return true;
    };
    preds.push((row) => (not ? !cmp(row[col]) : cmp(row[col])));
  }
  return (row) => preds.every((p) => p(row));
}

function applyOrder(rows, order) {
  if (!order) return rows;
  const specs = order.split(',').map((s) => {
    const [col, dir = 'asc'] = s.split('.');
    return { col, dir: dir === 'desc' ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, dir } of specs) {
      if (a[col] === b[col]) continue;
      if (a[col] == null) return 1;
      if (b[col] == null) return -1;
      return a[col] > b[col] ? dir : -dir;
    }
    return 0;
  });
}

/**
 * @param {import('playwright/test').Page} page
 * @param {{ mode?: 'signedOut' | 'asEditor', fixtures?: Record<string, any[]>, now?: string | null,
 *   failWrites?: boolean, password?: string, chat?: any,
 *   content?: 'real' | Record<string, any> }} [opts]
 */
export async function mockSupabase(page, opts = {}) {
  const mode = opts.mode || 'signedOut';
  const now = opts.now === undefined ? FIXED_NOW : opts.now;
  const nowMs = now ? Date.parse(now) : Date.now();
  const db = structuredClone({ ...defaultFixtures(), ...(opts.fixtures || {}) });
  const state = { signedIn: mode === 'asEditor', failWrites: !!opts.failWrites, jwtExpiredOnce: !!opts.jwtExpiredOnce, refresh: opts.refresh || 'ok', chat: { ...(opts.chat || {}) } };
  /** @type {Array<{ method: string, path: string, search: string, body: any }>} */
  const calls = [];

  if (now) await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(
    ([key, session]) => {
      if (session) localStorage.setItem(key, JSON.stringify(session));
    },
    [AUTH_STORAGE_KEY, mode === 'asEditor' ? makeSession(nowMs) : null],
  );

  const json = (route, status, body, headers = {}) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', ...headers },
      body: body === undefined ? '' : JSON.stringify(body),
    });

  // Reading content: tests never depend on the real /content files.
  if (opts.content !== 'real') {
    const content = { ...CONTENT_FIXTURES, ...(opts.content || {}) };
    await page.route(/\/content\/[a-z-]+\.json(\?.*)?$/, (route) => {
      const name = /\/content\/([a-z-]+)\.json/.exec(route.request().url())?.[1] || '';
      const data = content[name];
      if (data == null) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
  }

  /**
   * Never answer this request (a stalled stream), but release it when the page gives up on it, so
   * the browser does not keep it open (an open request would also hold back a service worker update).
   */
  const hold = (route) =>
    new Promise((resolve) => {
      const onFailed = (req) => {
        if (req !== route.request()) return;
        page.off('requestfailed', onFailed);
        route.abort().catch(() => {});
        resolve();
      };
      page.on('requestfailed', onFailed);
    });

  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      });
    }
    const url = new URL(req.url());
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = req.postData();
    }
    const token = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
    calls.push({ method, path: url.pathname, search: url.search, body, token });

    // ---- Auth ----
    if (url.pathname.startsWith('/auth/v1/')) {
      const ep = url.pathname.slice('/auth/v1/'.length);
      if (ep === 'token' && url.searchParams.get('grant_type') === 'password') {
        if (body?.password === (opts.password || 'correct-password')) {
          state.signedIn = true;
          return json(route, 200, makeSession(Date.now()));
        }
        return json(route, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (ep === 'token') {
        // refresh
        if (state.refresh === 'network') return route.abort('internetdisconnected');
        if (state.refresh === 'invalid') {
          state.signedIn = false;
          return json(route, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        }
        return json(route, 200, makeSession(Math.max(Date.now(), nowMs)));
      }
      if (ep === 'logout') {
        state.signedIn = false;
        return json(route, 204);
      }
      if (ep === 'user') {
        if (!state.signedIn) return json(route, 401, { code: 401, error_code: 'no_authorization', msg: 'No session' });
        if (method === 'PUT' && body?.password && body.password.length < 8) {
          return json(route, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
        }
        return json(route, 200, makeSession(nowMs).user);
      }
      return json(route, 404, { msg: 'not mocked' });
    }

    // ---- Storage ----
    if (url.pathname.startsWith('/storage/v1/')) {
      if (state.jwtExpiredOnce && method !== 'GET') {
        state.jwtExpiredOnce = false;
        return json(route, 401, { statusCode: '401', error: 'Unauthorized', message: 'jwt expired' });
      }
      if (!state.signedIn) return json(route, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (state.failWrites) return json(route, 500, { message: 'mock failure' });
      return json(route, 200, method === 'DELETE' ? [] : { Key: url.pathname.split('/object/')[1] || '', Id: 'mock' });
    }

    // ---- Edge Function: chat ----
    if (url.pathname === '/functions/v1/chat') return mockChatFunction(route, { body, db, state, nowMs, chat: state.chat, hold: () => hold(route) });

    // ---- REST ----
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (!m) return json(route, 404, { message: 'not mocked' });
    const table = m[1];
    if (!(table in db)) return json(route, 404, { code: '42P01', message: `relation "public.${table}" does not exist` });
    const key = keyOf(table);
    const match = filtersFrom(url.searchParams);
    const wantsObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    const prefer = req.headers()['prefer'] || '';
    const respond = (rows, status = 200) => {
      if (wantsObject) {
        if (rows.length !== 1) return json(route, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
        return json(route, status, rows[0]);
      }
      return json(route, status, rows);
    };

    if (method === 'GET' || method === 'HEAD') {
      let rows = db[table];
      if (PRIVATE_TABLES.includes(table) && !state.signedIn) rows = [];
      if (table === 'editors') rows = state.signedIn ? rows.filter((r) => r.user_id === EDITOR_USER.id) : [];
      rows = applyOrder(rows.filter(match), url.searchParams.get('order'));
      const limit = Number(url.searchParams.get('limit') || 0);
      if (limit) rows = rows.slice(0, limit);
      return respond(rows);
    }

    // Writes
    if (state.jwtExpiredOnce) {
      state.jwtExpiredOnce = false;
      return json(route, 401, { code: 'PGRST303', message: 'JWT expired' });
    }
    if (!state.signedIn) return json(route, 401, { code: '42501', message: `new row violates row-level security policy for table "${table}"` });
    if (state.failWrites) return json(route, 500, { code: 'XX000', message: 'mock failure' });
    const stamp = () => ({ updated_at: new Date(nowMs).toISOString() });

    if (method === 'POST') {
      const items = Array.isArray(body) ? body : [body];
      const upsert = prefer.includes('resolution=merge-duplicates');
      const out = [];
      for (const it of items) {
        const existing = db[table].find((r) => r[key] === it[key]);
        if (existing && !upsert) return json(route, 409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        if (existing) {
          Object.assign(existing, it, stamp());
          out.push(existing);
        } else {
          const row = { ...it, created_at: new Date(nowMs).toISOString(), ...stamp(), created_by: EDITOR_USER.id, created_by_name: db.editors[0]?.display_name || null };
          if (key === 'id' && row.id == null) row.id = crypto.randomUUID();
          db[table].push(row);
          out.push(row);
        }
      }
      return prefer.includes('return=representation') ? respond(out, 201) : json(route, 201);
    }
    if (method === 'PATCH') {
      const rows = db[table].filter(match);
      rows.forEach((r) => Object.assign(r, body, stamp()));
      return prefer.includes('return=representation') ? respond(rows) : json(route, 204);
    }
    if (method === 'DELETE') {
      const rows = db[table].filter(match);
      db[table] = db[table].filter((r) => !rows.includes(r));
      return prefer.includes('return=representation') ? respond(rows) : json(route, 204);
    }
    return json(route, 405, { message: 'method not mocked' });
  });

  return {
    db,
    calls,
    /** Make subsequent writes fail (true) or succeed (false). */
    setFailWrites(v) {
      state.failWrites = v;
    },
    /** Change the chat function mock's behaviour (merged). */
    setChat(patch) {
      Object.assign(state.chat, patch);
    },
    /** Change how session refreshes answer: 'ok' | 'network' | 'invalid'. */
    setRefresh(mode) {
      state.refresh = mode;
    },
    /** Calls to the auth refresh endpoint. */
    refreshCalls() {
      return calls.filter((c) => c.path === '/auth/v1/token' && c.search.includes('refresh_token'));
    },
    /** REST calls for a table, optionally by method. */
    restCalls(table, method) {
      return calls.filter((c) => c.path === `/rest/v1/${table}` && (!method || c.method === method));
    },
  };
}

// ---------------------------------------------------------------------------
// `chat` Edge Function mock. Answers are sent as one SSE body with several events (meta, status,
// deltas, done) so the app's stream parser runs; persisted rows land in db like the real function.
// ---------------------------------------------------------------------------

export const DEFAULT_CHAT_REPLY =
  'A las **7 semanas** Tyler debe comer **4 veces al día**.\n\n- Usa la cantidad de la bolsa como guía.\n- Pésalo cada semana.';
export const DEFAULT_CHAT_SOURCES = [{ title: 'AKC: Puppy Feeding Fundamentals', url: 'https://www.akc.org/expert-advice/nutrition/puppy-feeding-fundamentals/' }];
export const DEFAULT_FAQ_DRAFT = {
  category: 'feeding',
  question_es: '¿Cuántas veces al día come Tyler?',
  question_en: 'How many times a day does Tyler eat?',
  answer_es: 'Cuatro comidas al día mientras es cachorro.',
  answer_en: 'Four meals a day while he is a puppy.',
  sources: DEFAULT_CHAT_SOURCES,
};
const CHAT_STATUS = { budget_exhausted: 402, daily_limit: 429, disabled: 403, not_editor: 403, upstream_error: 502, server_error: 500 };

let chatClock = 0;

async function mockChatFunction(route, { body, db, state, nowMs, chat, hold }) {
  const used = chat.budget?.used_usd ?? 1.2;
  const total = chat.budget?.budget_usd ?? 25;
  const usage = (extra = 0, todayExtra = 0) => ({
    budget: { used_usd: +(used + extra).toFixed(6), budget_usd: total, remaining_usd: +Math.max(0, total - used - extra).toFixed(6) },
    daily: { used: db.chat_messages.filter((m) => m.role === 'user').length + todayExtra, limit: 40 },
    enabled: true,
  });
  const headers = { 'access-control-allow-origin': '*' };
  const json = (status, payload) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(payload) });
  if (!state.signedIn) return json(401, { error: 'unauthorized' });
  if (chat.unauthorizedOnce) {
    chat.unauthorizedOnce = false;
    // What the gateway answers for an expired JWT (verify_jwt): not the function's own body.
    return json(401, { code: 401, message: 'Invalid JWT' });
  }
  const action = body?.action;
  if (action === 'status') return json(200, usage());
  if (action === 'draft_faq') {
    if (chat.draftError) return json(CHAT_STATUS[chat.draftError] || 500, { error: chat.draftError, ...usage() });
    return json(200, { draft: chat.draft || DEFAULT_FAQ_DRAFT, ...usage(0.004) });
  }
  if (action !== 'send' || !body.message) return json(400, { error: 'bad_request' });
  if (chat.refuse) return json(CHAT_STATUS[chat.refuse] || 500, { error: chat.refuse, ...usage() });
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // Idempotency (like the real function): a request id that was answered is replayed.
  const prior = body.request_id && db.chat_messages.find((m) => m.id === body.request_id && m.role === 'user');
  if (prior) {
    const answer = db.chat_messages.find((m) => m.thread_id === prior.thread_id && m.role === 'assistant' && m.created_at >= prior.created_at);
    if (answer) {
      chat.replays = (chat.replays || 0) + 1;
      const out = sse('meta', { thread_id: prior.thread_id, title: null, new_thread: false, replayed: true }) + sse('done', { thread_id: prior.thread_id, stopped: false, stop_reason: 'replayed', replayed: true, user_message: prior, message: answer, ...usage() });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers, body: out });
    }
  }
  if (chat.inProgress) return json(409, { error: 'in_progress' });

  if (chat.stall === 'before-save') return hold(); // nothing arrives, nothing saved
  if (chat.delayMs) await new Promise((r) => setTimeout(r, chat.delayMs)); // a slow answer
  if (chat.waitFor) await chat.waitFor; // the answer arrives when the test resolves this promise
  const reply = chat.reply ?? DEFAULT_CHAT_REPLY;
  const sources = chat.sources ?? DEFAULT_CHAT_SOURCES;
  const isNew = !body.thread_id;
  const threadId = body.thread_id || crypto.randomUUID();
  const title = isNew ? body.message.slice(0, 60) : null;
  let out = sse('meta', { thread_id: threadId, title, new_thread: isNew });
  if (sources.length) out += sse('status', { state: 'searching', query: 'puppy feeding' });
  const parts = [reply.slice(0, 12), reply.slice(12, 40), reply.slice(40)].filter(Boolean);
  if (chat.streamError) {
    out += sse('delta', { text: parts[0] }) + sse('error', { error: 'upstream_error', ...usage() });
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers, body: out });
  }
  for (const p of parts) out += sse('delta', { text: p });
  const at = () => new Date(nowMs + ++chatClock * 1000).toISOString();
  const by = { created_by: EDITOR_USER.id, created_by_name: db.editors[0]?.display_name || null };
  if (isNew) db.chat_threads.push({ id: threadId, title, created_at: at(), updated_at: at(), ...by });
  const userRow = { id: body.request_id || crypto.randomUUID(), thread_id: threadId, role: 'user', content: body.message, sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, created_at: at(), updated_at: at(), ...by };
  const assistantRow = { id: crypto.randomUUID(), thread_id: threadId, role: 'assistant', content: reply, sources, model: 'claude-sonnet-5-5', input_tokens: 2400, output_tokens: 120, web_searches: sources.length ? 1 : 0, cost_usd: 0.0172, created_at: at(), updated_at: at(), ...by };
  db.chat_messages.push(userRow, assistantRow);
  const thread = db.chat_threads.find((t) => t.id === threadId);
  if (thread) thread.updated_at = at();
  out += sse('done', { thread_id: threadId, title, stopped: false, stop_reason: 'end_turn', user_message: userRow, message: assistantRow, ...usage(0.0172, 0) });
  if (chat.stall === 'after-save') return hold(); // saved, but the phone never hears back
  return route.fulfill({ status: 200, contentType: 'text/event-stream', headers, body: out });
}
