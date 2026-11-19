// The `push` function's request handler, with its I/O injected (env, fetch, clock) so the whole flow
// runs under Node in tests/unit/push-function.test.mjs against an in-memory PostgREST and a fake push
// service. index.ts wires it to Deno.serve. See ../README.md.
import { bearerToken, corsHeaders, errorResponse, isAllowedOrigin, jsonResponse, parseRequest, readBodyText, type Locale, type ParsedRequest } from './http.ts';
import { enc, pickKey, RestError, serviceRest, userRest, verifyUser, type FetchFn, type Rest } from './rest.ts';
import {
  audienceOf,
  buildPushRequest,
  classifyStatus,
  generateVapidKeys,
  isAllowedEndpoint,
  randomToken,
  safeEqual,
  signVapidJwt,
  validKeys,
  VAPID_MIN_LEFT_S,
  VAPID_TTL_S,
  type PushOutcome,
} from './webpush.ts';
import { feedingsSince, planTick, type Candidate, type TextSpec } from './schedule.ts';
import { notificationText } from './text.ts';

/** Header the scheduler sends with `tick` (value read from push_config at call time). */
export const SECRET_HEADER = 'x-push-secret';
/** Ledger rows older than this are deleted (they only need to outlive the tolerance window). */
const LEDGER_KEEP_DAYS = 35;
/** One test notification per subscription per this window. */
const TEST_WINDOW_MS = 15_000;
/** Give up on a push service that has not answered in this time. */
const PUSH_TIMEOUT_MS = 10_000;
/** Re-read push_config after this long (keys never change; the JWT cache does). */
const CONFIG_TTL_MS = 10 * 60_000;

export interface HandlerDeps {
  env: (name: string) => string | undefined;
  fetch: FetchFn;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface PushConfig {
  id: number;
  vapid_public_key: string;
  vapid_private_jwk: JsonWebKey;
  scheduler_secret: string;
  vapid_jwts: Record<string, { t: string; exp: number }> | null;
}

export interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: Locale;
  meals_enabled: boolean;
  due_enabled: boolean;
  failure_count: number;
}

const SUB_COLUMNS = 'id,user_id,endpoint,p256dh,auth,locale,meals_enabled,due_enabled,failure_count';

/** What the app may see of a subscription row (never the keys). */
export const publicSub = (r: SubRow | null | undefined) =>
  r ? { endpoint: r.endpoint, locale: r.locale, meals: r.meals_enabled, due: r.due_enabled } : null;

export interface TickResult {
  subscriptions: number;
  candidates: number;
  claimed: number;
  duplicates: number;
  sent: number;
  failed: number;
  gone: number;
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now || (() => Date.now());
  /** Log without endpoints, keys, secrets or notification text. */
  const log = deps.log || ((level, msg, extra = {}) => console[level](JSON.stringify({ fn: 'push', msg, ...extra })));
  let config: PushConfig | null = null;
  let configAt = 0;

  /** push_config, created on first use: VAPID key pair and scheduler secret, never handled by a person. */
  async function loadConfig(svc: Rest): Promise<PushConfig> {
    if (config && now() - configAt < CONFIG_TTL_MS) return config;
    let rows = await svc.select<PushConfig>('push_config', 'select=*&id=eq.1');
    if (!rows.length) {
      const keys = await generateVapidKeys();
      // Two first calls at once: ON CONFLICT DO NOTHING keeps the first; both then read the same row.
      const created = await svc.insertIgnore('push_config', { id: 1, vapid_public_key: keys.publicKey, vapid_private_jwk: keys.privateJwk, scheduler_secret: randomToken(32), vapid_jwts: {} }, 'id');
      if (created.length) log('info', 'push config created');
      rows = await svc.select<PushConfig>('push_config', 'select=*&id=eq.1');
    }
    if (!rows.length) throw new Error('push_config missing');
    config = rows[0];
    configAt = now();
    return config;
  }

  /** VAPID JWT for a push service origin, reused for ~11 h (Apple: refresh at most once per hour). */
  async function jwtFor(svc: Rest, cfg: PushConfig, aud: string): Promise<string> {
    const nowS = Math.floor(now() / 1000);
    const cached = cfg.vapid_jwts?.[aud];
    if (cached && cached.exp - nowS > VAPID_MIN_LEFT_S) return cached.t;
    const exp = nowS + VAPID_TTL_S;
    const t = await signVapidJwt({ aud, exp, privateJwk: cfg.vapid_private_jwk });
    cfg.vapid_jwts = { ...(cfg.vapid_jwts || {}), [aud]: { t, exp } };
    await svc.patch('push_config', 'id=eq.1', { vapid_jwts: cfg.vapid_jwts }).catch(() => {});
    return t;
  }

  /** Send one notification to one subscription and record the outcome on the row. */
  async function sendTo(svc: Rest, cfg: PushConfig, sub: SubRow, payload: Record<string, unknown>, ttl: number): Promise<{ outcome: PushOutcome; status: number }> {
    if (!isAllowedEndpoint(sub.endpoint) || !validKeys(sub.p256dh, sub.auth)) {
      log('warn', 'invalid subscription skipped', { sub: sub.id });
      return { outcome: 'error', status: 0 };
    }
    let status = 0;
    try {
      const jwt = await jwtFor(svc, cfg, audienceOf(sub.endpoint));
      const { url, init } = await buildPushRequest(sub, payload, { jwt, publicKey: cfg.vapid_public_key, ttl, urgency: 'high' });
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      log('warn', 'push request failed', { sub: sub.id, error: String((e as Error)?.name || e) });
    }
    const outcome = classifyStatus(status);
    const at = new Date(now()).toISOString();
    const q = `id=eq.${enc(sub.id)}`;
    if (outcome === 'gone') {
      await svc.remove('push_subscriptions', q).catch(() => {});
      log('info', 'subscription gone, deleted', { sub: sub.id, status });
    } else if (outcome === 'ok') {
      await svc.patch('push_subscriptions', q, { last_success_at: at, last_status: status, failure_count: 0 }).catch(() => {});
    } else {
      await svc.patch('push_subscriptions', q, { last_failure_at: at, last_status: status, failure_count: (sub.failure_count || 0) + 1 }).catch(() => {});
      log('warn', 'push rejected', { sub: sub.id, status });
    }
    return { outcome, status };
  }

  const payloadFor = (spec: TextSpec, locale: Locale, petName: string, path: string, tag: string) => ({
    ...notificationText(spec, locale, petName),
    path,
    tag,
  });

  async function petNameOf(svc: Rest): Promise<string> {
    const rows = await svc.select<{ name: string }>('pet_profile', 'select=name&id=eq.1');
    return rows[0]?.name || 'Tyler';
  }

  /** The scheduler's call: work out what is due now and send it, each notification once. */
  async function runTick(svc: Rest, cfg: PushConfig): Promise<TickResult> {
    const t = now();
    const result: TickResult = { subscriptions: 0, candidates: 0, claimed: 0, duplicates: 0, sent: 0, failed: 0, gone: 0 };
    const cutoff = new Date(t - LEDGER_KEEP_DAYS * 86_400_000).toISOString();
    const [subs, editors] = await Promise.all([
      svc.select<SubRow>('push_subscriptions', `select=${SUB_COLUMNS}`),
      svc.select<{ user_id: string }>('editors', 'select=user_id'),
      svc.remove('push_sends', `created_at=lt.${enc(cutoff)}`).catch(() => {}),
    ]);
    // Only people who are still editors get anything.
    const editorIds = new Set(editors.map((e) => e.user_id));
    let active = subs.filter((s) => editorIds.has(s.user_id));
    result.subscriptions = active.length;
    if (!active.length) return result;

    const settingsRows = await svc.select<{ meal_slots: any; timezone: string }>('settings', 'select=meal_slots,timezone&id=eq.1');
    const tz = settingsRows[0]?.timezone || 'America/Bogota';
    const [petName, feedings, vaccinations, dewormings, vetVisits, reminders] = await Promise.all([
      petNameOf(svc),
      svc.select('feedings', `select=fed_at,meal_slot&meal_slot=not.is.null&fed_at=gte.${enc(feedingsSince(t, tz))}`),
      svc.select('vaccinations', 'select=id,vaccine,given_on,next_due_on'),
      svc.select('dewormings', 'select=id,product,kind,given_on,next_due_on'),
      svc.select('vet_visits', 'select=id,reason,visited_on,follow_up_on'),
      svc.select('reminders', 'select=id,title,due_on,due_time,done_at&done_at=is.null'),
    ]);
    const mealSlots = Array.isArray(settingsRows[0]?.meal_slots) ? settingsRows[0].meal_slots : [];
    const plan: Candidate[] = planTick(t, { timezone: tz, mealSlots, feedings, vaccinations, dewormings, vetVisits, reminders });
    result.candidates = plan.length;

    for (const c of plan) {
      const targets = active.filter((s) => (c.pref === 'meals' ? s.meals_enabled : s.due_enabled));
      if (!targets.length) continue;
      // Claim the notification id first: of two overlapping ticks, only one gets the row.
      const claimed = await svc.insertIgnore('push_sends', { id: c.id, kind: c.pref, scheduled_for: new Date(c.at).toISOString() }, 'id');
      if (!claimed.length) {
        result.duplicates++;
        continue;
      }
      result.claimed++;
      const outcomes = await Promise.all(targets.map((s) => sendTo(svc, cfg, s, payloadFor(c.text, s.locale, petName, c.path, c.tag), c.ttl)));
      const counts = { sent: 0, failed: 0, gone: 0 };
      outcomes.forEach((o, i) => {
        if (o.outcome === 'ok') counts.sent++;
        else if (o.outcome === 'gone') {
          counts.gone++;
          active = active.filter((s) => s.id !== targets[i].id);
        } else counts.failed++;
      });
      result.sent += counts.sent;
      result.failed += counts.failed;
      result.gone += counts.gone;
      await svc.patch('push_sends', `id=eq.${enc(c.id)}`, counts).catch(() => {});
    }
    return result;
  }

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);
    if (origin && !isAllowedOrigin(origin)) return errorResponse('forbidden_origin', cors);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return errorResponse('bad_request', cors);

    const url = deps.env('SUPABASE_URL');
    const publishable = pickKey(deps.env('SUPABASE_PUBLISHABLE_KEYS'), deps.env('SUPABASE_ANON_KEY'));
    const secret = pickKey(deps.env('SUPABASE_SECRET_KEYS'), deps.env('SUPABASE_SERVICE_ROLE_KEY'));
    if (!url || !publishable || !secret) {
      log('error', 'missing configuration', { url: !!url, publishable: !!publishable, secret: !!secret });
      return errorResponse('server_error', cors);
    }

    try {
      const raw = await readBodyText(req);
      if (raw === null) return errorResponse('bad_request', cors);
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const parsed = parseRequest(body);
      if (!parsed) return errorResponse('bad_request', cors);
      const svc = serviceRest(url, secret, deps.fetch);

      // ---- Scheduler ----
      if (parsed.action === 'tick') {
        const cfg = await loadConfig(svc);
        const given = req.headers.get(SECRET_HEADER) || '';
        if (!(await safeEqual(given, cfg.scheduler_secret))) {
          log('warn', 'tick rejected');
          return errorResponse('unauthorized', cors);
        }
        const result = await runTick(svc, cfg);
        log('info', 'tick', { ...result });
        return jsonResponse(result, 200, cors);
      }

      // ---- Editors ----
      const jwt = bearerToken(req.headers.get('Authorization'));
      if (!jwt || jwt === publishable) return errorResponse('unauthorized', cors);
      const userId = await verifyUser(url, publishable, jwt, deps.fetch);
      if (!userId) return errorResponse('unauthorized', cors);
      const user = userRest(url, publishable, jwt, deps.fetch);
      const editors = await user.select('editors', `select=user_id&user_id=eq.${enc(userId)}&limit=1`);
      if (!editors.length) return errorResponse('not_editor', cors);
      return await handleEditor(svc, userId, parsed, cors);
    } catch (e) {
      log('error', 'request failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : String((e as Error)?.name || e) });
      return errorResponse('server_error', cors);
    }
  };

  async function ownRow(svc: Rest, userId: string, endpoint: string): Promise<SubRow | null> {
    const rows = await svc.select<SubRow>('push_subscriptions', `select=${SUB_COLUMNS}&endpoint=eq.${enc(endpoint)}&user_id=eq.${enc(userId)}&limit=1`);
    return rows[0] || null;
  }

  async function handleEditor(svc: Rest, userId: string, p: Exclude<ParsedRequest, { action: 'tick' }>, cors: Record<string, string>): Promise<Response> {
    switch (p.action) {
      case 'config': {
        const cfg = await loadConfig(svc);
        const row = p.endpoint ? await ownRow(svc, userId, p.endpoint) : null;
        return jsonResponse({ public_key: cfg.vapid_public_key, subscription: publicSub(row) }, 200, cors);
      }
      case 'subscribe': {
        const s = p.subscription;
        if (!isAllowedEndpoint(s.endpoint)) return errorResponse('bad_request', cors, { reason: 'endpoint' });
        if (!validKeys(s.p256dh, s.auth)) return errorResponse('bad_request', cors, { reason: 'keys' });
        // The browser replaced its subscription: drop this person's old row.
        if (p.oldEndpoint && p.oldEndpoint !== s.endpoint) {
          await svc.remove('push_subscriptions', `endpoint=eq.${enc(p.oldEndpoint)}&user_id=eq.${enc(userId)}`);
        }
        const fields: Record<string, unknown> = { p256dh: s.p256dh, auth: s.auth, locale: p.locale, failure_count: 0, last_status: null, last_failure_at: null };
        if (p.meals !== null) fields.meals_enabled = p.meals;
        if (p.due !== null) fields.due_enabled = p.due;
        const save = async (): Promise<SubRow> => {
          const existing = await svc.select<{ id: string; user_id: string }>('push_subscriptions', `select=id,user_id&endpoint=eq.${enc(s.endpoint)}&limit=1`);
          if (existing[0]?.user_id === userId) {
            const rows = await svc.patch<SubRow>('push_subscriptions', `id=eq.${enc(existing[0].id)}`, fields);
            return rows[0];
          }
          // The same phone was set up by the other editor before: it now belongs to this person.
          if (existing[0]) await svc.remove('push_subscriptions', `id=eq.${enc(existing[0].id)}`);
          return svc.insert<SubRow>('push_subscriptions', { user_id: userId, endpoint: s.endpoint, meals_enabled: true, due_enabled: true, ...fields });
        };
        let row: SubRow;
        try {
          row = await save();
        } catch (e) {
          // Two saves of the same endpoint at once: the unique endpoint stopped the second insert.
          if (!(e instanceof RestError && e.code === '23505')) throw e;
          row = await save();
        }
        log('info', 'subscribed', { sub: row?.id });
        return jsonResponse({ subscription: publicSub(row) }, 200, cors);
      }
      case 'unsubscribe': {
        await svc.remove('push_subscriptions', `endpoint=eq.${enc(p.endpoint)}&user_id=eq.${enc(userId)}`);
        return jsonResponse({ ok: true }, 200, cors);
      }
      case 'update_prefs': {
        const patch: Record<string, unknown> = {};
        if (p.meals !== null) patch.meals_enabled = p.meals;
        if (p.due !== null) patch.due_enabled = p.due;
        if (p.locale) patch.locale = p.locale;
        const rows = await svc.patch<SubRow>('push_subscriptions', `endpoint=eq.${enc(p.endpoint)}&user_id=eq.${enc(userId)}`, patch);
        if (!rows.length) return errorResponse('not_found', cors);
        return jsonResponse({ subscription: publicSub(rows[0]) }, 200, cors);
      }
      case 'test': {
        const row = await ownRow(svc, userId, p.endpoint);
        if (!row) return errorResponse('not_found', cors);
        const cfg = await loadConfig(svc);
        const t = now();
        const claimed = await svc.insertIgnore('push_sends', { id: `test:${row.id}:${Math.floor(t / TEST_WINDOW_MS)}`, kind: 'test', scheduled_for: new Date(t).toISOString() }, 'id');
        if (!claimed.length) return errorResponse('too_many', cors);
        const petName = await petNameOf(svc);
        const { outcome, status } = await sendTo(svc, cfg, row, payloadFor({ type: 'test' }, row.locale, petName, '/profile', 'test'), 300);
        if (outcome === 'ok') return jsonResponse({ sent: true }, 200, cors);
        if (outcome === 'gone') return errorResponse('gone', cors);
        return errorResponse('push_failed', cors, { status });
      }
    }
  }
}
