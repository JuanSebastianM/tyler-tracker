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
//   user: the account that is (or signs in as) the session user (default EDITOR_USER; EDITOR_USER_2
//     needs its own `editors` row in fixtures to be an editor). Own-row tables (user_settings) only
//     show and accept that user's rows.
//   fixtures: { table: rows } overrides
//   now: ISO string for the page clock (default FIXED_NOW); pass null to use the real clock
//   failWrites: true -> every insert/update/delete returns HTTP 500 (test rollback + toast)
//   password: the password that signs in successfully via the sign-in sheet (default 'correct-password')
//   content: { name: json | null } overrides of the fake reading content (content-fixtures.js) that
//     is served for every content/*.json request (null = HTTP 404); 'real' serves the repo files
//   chat: behaviour of the `chat` Edge Function mock (see mockChatFunction below):
//     { reply, sources, refuse: '<error code>', streamError: true, draft, draftError: '<code>', budget }
import { defaultFixtures, EDITOR_USER, FIXED_NOW, PRIVATE_TABLES } from './fixtures.js';
import { CONTENT_FIXTURES } from './content-fixtures.js';

export const SUPABASE_URL = 'https://kegtfxoiijbytprfwqrl.supabase.co';
export const AUTH_STORAGE_KEY = 'tt-auth';

const KEYS = { training_skills: 'skill_key', checklist_done: 'item_key', vet_visit_private: 'visit_id', editors: 'user_id', user_settings: 'user_id' };
/** Tables whose RLS lets a user see and write only rows with their own user_id. */
const OWN_ROW_TABLES = ['editors', 'user_settings'];
const keyOf = (table) => KEYS[table] || 'id';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A session object as supabase-js stores it. @param {number} nowMs */
export function makeSession(nowMs, account = EDITOR_USER) {
  const exp = Math.floor(nowMs / 1000) + 3600;
  const user = {
    id: account.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: account.email,
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-11-10T00:00:00Z',
  };
  const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, role: 'authenticated', aud: 'authenticated', exp, email: user.email })}.c2ln`;
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
 *   failWrites?: boolean, password?: string, chat?: any, user?: { id: string, email: string },
 *   content?: 'real' | Record<string, any> }} [opts]
 */
export async function mockSupabase(page, opts = {}) {
  const mode = opts.mode || 'signedOut';
  const account = opts.user || EDITOR_USER;
  const now = opts.now === undefined ? FIXED_NOW : opts.now;
  const nowMs = now ? Date.parse(now) : Date.now();
  const db = structuredClone({ ...defaultFixtures(), ...(opts.fixtures || {}) });
  const state = { signedIn: mode === 'asEditor', failWrites: !!opts.failWrites };
  /** @type {Array<{ method: string, path: string, search: string, body: any }>} */
  const calls = [];

  if (now) await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(
    ([key, session]) => {
      if (session) localStorage.setItem(key, JSON.stringify(session));
    },
    [AUTH_STORAGE_KEY, mode === 'asEditor' ? makeSession(nowMs, account) : null],
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
    calls.push({ method, path: url.pathname, search: url.search, body });

    // ---- Auth ----
    if (url.pathname.startsWith('/auth/v1/')) {
      const ep = url.pathname.slice('/auth/v1/'.length);
      if (ep === 'token' && url.searchParams.get('grant_type') === 'password') {
        if (body?.password === (opts.password || 'correct-password')) {
          state.signedIn = true;
          return json(route, 200, makeSession(Date.now(), account));
        }
        return json(route, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (ep === 'token') return json(route, 200, makeSession(Date.now(), account)); // refresh
      if (ep === 'logout') {
        state.signedIn = false;
        return json(route, 204);
      }
      if (ep === 'user') {
        if (!state.signedIn) return json(route, 401, { code: 401, error_code: 'no_authorization', msg: 'No session' });
        if (method === 'PUT' && body?.password && body.password.length < 8) {
          return json(route, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
        }
        return json(route, 200, makeSession(nowMs, account).user);
      }
      return json(route, 404, { msg: 'not mocked' });
    }

    // ---- Storage ----
    if (url.pathname.startsWith('/storage/v1/')) {
      if (!state.signedIn) return json(route, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (state.failWrites) return json(route, 500, { message: 'mock failure' });
      return json(route, 200, method === 'DELETE' ? [] : { Key: url.pathname.split('/object/')[1] || '', Id: 'mock' });
    }

    // ---- Edge Function: chat ----
    if (url.pathname === '/functions/v1/chat') return mockChatFunction(route, { body, db, state, nowMs, chat: opts.chat || {} });

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
      if (OWN_ROW_TABLES.includes(table)) rows = state.signedIn ? rows.filter((r) => r.user_id === account.id) : [];
      rows = applyOrder(rows.filter(match), url.searchParams.get('order'));
      const limit = Number(url.searchParams.get('limit') || 0);
      if (limit) rows = rows.slice(0, limit);
      return respond(rows);
    }

    // Writes
    if (!state.signedIn) return json(route, 401, { code: '42501', message: `new row violates row-level security policy for table "${table}"` });
    if (state.failWrites) return json(route, 500, { code: 'XX000', message: 'mock failure' });
    if (OWN_ROW_TABLES.includes(table)) {
      const items = Array.isArray(body) ? body : [body];
      if (method !== 'DELETE' && items.some((it) => it && it.user_id != null && it.user_id !== account.id)) {
        return json(route, 403, { code: '42501', message: `new row violates row-level security policy for table "${table}"` });
      }
    }
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
          const by = db.editors.find((e) => e.user_id === account.id)?.display_name || null;
          const row = { ...it, created_at: new Date(nowMs).toISOString(), ...stamp(), created_by: account.id, created_by_name: by };
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

async function mockChatFunction(route, { body, db, state, nowMs, chat }) {
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
  const action = body?.action;
  if (action === 'status') return json(200, usage());
  if (action === 'draft_faq') {
    if (chat.draftError) return json(CHAT_STATUS[chat.draftError] || 500, { error: chat.draftError, ...usage() });
    return json(200, { draft: chat.draft || DEFAULT_FAQ_DRAFT, ...usage(0.004) });
  }
  if (action !== 'send' || !body.message) return json(400, { error: 'bad_request' });
  if (chat.refuse) return json(CHAT_STATUS[chat.refuse] || 500, { error: chat.refuse, ...usage() });

  const reply = chat.reply ?? DEFAULT_CHAT_REPLY;
  const sources = chat.sources ?? DEFAULT_CHAT_SOURCES;
  const isNew = !body.thread_id;
  const threadId = body.thread_id || crypto.randomUUID();
  const title = isNew ? body.message.slice(0, 60) : null;
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  const userRow = { id: crypto.randomUUID(), thread_id: threadId, role: 'user', content: body.message, sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, created_at: at(), updated_at: at(), ...by };
  const assistantRow = { id: crypto.randomUUID(), thread_id: threadId, role: 'assistant', content: reply, sources, model: 'claude-sonnet-5-5', input_tokens: 2400, output_tokens: 120, web_searches: sources.length ? 1 : 0, cost_usd: 0.0172, created_at: at(), updated_at: at(), ...by };
  db.chat_messages.push(userRow, assistantRow);
  const thread = db.chat_threads.find((t) => t.id === threadId);
  if (thread) thread.updated_at = at();
  out += sse('done', { thread_id: threadId, title, stopped: false, stop_reason: 'end_turn', user_message: userRow, message: assistantRow, ...usage(0.0172, 0) });
  return route.fulfill({ status: 200, contentType: 'text/event-stream', headers, body: out });
}
