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
import { defaultFixtures, EDITOR_USER, FIXED_NOW, PRIVATE_TABLES } from './fixtures.js';

export const SUPABASE_URL = 'https://kegtfxoiijbytprfwqrl.supabase.co';
export const AUTH_STORAGE_KEY = 'tt-auth';

const KEYS = { training_skills: 'skill_key', checklist_done: 'item_key', vet_visit_private: 'visit_id', editors: 'user_id' };
const keyOf = (table) => KEYS[table] || 'id';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A session object as supabase-js stores it. @param {number} nowMs */
export function makeSession(nowMs) {
  const exp = Math.floor(nowMs / 1000) + 3600;
  const user = {
    id: EDITOR_USER.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: EDITOR_USER.email,
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
 *   failWrites?: boolean, password?: string }} [opts]
 */
export async function mockSupabase(page, opts = {}) {
  const mode = opts.mode || 'signedOut';
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
    [AUTH_STORAGE_KEY, mode === 'asEditor' ? makeSession(nowMs) : null],
  );

  const json = (route, status, body, headers = {}) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', ...headers },
      body: body === undefined ? '' : JSON.stringify(body),
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
    calls.push({ method, path: url.pathname, search: url.search, body });

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
      if (ep === 'token') return json(route, 200, makeSession(Date.now())); // refresh
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
      if (!state.signedIn) return json(route, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (state.failWrites) return json(route, 500, { message: 'mock failure' });
      return json(route, 200, method === 'DELETE' ? [] : { Key: url.pathname.split('/object/')[1] || '', Id: 'mock' });
    }

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
    /** REST calls for a table, optionally by method. */
    restCalls(table, method) {
      return calls.filter((c) => c.path === `/rest/v1/${table}` && (!method || c.method === method));
    },
  };
}
