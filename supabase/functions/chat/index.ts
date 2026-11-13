// Supabase Edge Function `chat`: the in-app assistant. See README.md in this folder.
//
// POST JSON { action: 'status' | 'send' | 'draft_faq', ... } with the editor's Supabase JWT.
// Order of checks: origin → method → secrets → user JWT (Supabase Auth) → editors row (with the
// caller's JWT, so RLS decides) → body (size-capped) → ai_settings limits → spend reservation and
// re-check (lib/budget.ts) → Claude.
//
// Docs this follows (read 2026-11-13):
//  - Messages API + streaming: https://platform.claude.com/docs/en/api/messages,
//    https://platform.claude.com/docs/en/build-with-claude/streaming, API version header:
//    https://platform.claude.com/docs/en/api/versioning (current: 2026-10-21)
//  - Edge Functions: CORS https://supabase.com/docs/guides/functions/cors, auth headers
//    https://supabase.com/docs/guides/functions/auth-headers, secrets/env
//    https://supabase.com/docs/guides/functions/secrets, background work (EdgeRuntime.waitUntil)
//    https://supabase.com/docs/guides/functions/background-tasks, limits (150 s idle timeout, 2 s CPU)
//    https://supabase.com/docs/guides/functions/limits
import {
  bearerToken,
  corsHeaders,
  errorResponse,
  isAllowedOrigin,
  jsonResponse,
  parseRequest,
  readBodyText,
  upstreamReason,
  type ErrorCode,
  type UpstreamReason,
} from './lib/http.ts';
import { checkReserved, InProgressError, pendingSends, release, reserve, settle, STALE_RESERVATION_MS, type ReservationKind } from './lib/budget.ts';
import { KEEPALIVE_MS, pickAnswer, SSE_KEEPALIVE, type StoredMessage } from './lib/replay.ts';
import { budgetInfo, checkLimits, num, sumCosts, type AiSettings } from './lib/limits.ts';
import { computeCost, estimateMaxCost, estimateTokens, type ApiUsage } from './lib/pricing.ts';
import { buildContext, type ContextData } from './lib/context.ts';
import {
  buildChatRequest,
  buildFaqRequest,
  buildTranscript,
  faqMaxTokens,
  FAQ_DRAFT_TAG,
  isFaqDraftRow,
  makeThreadTitle,
  MAX_FAQ_MESSAGES,
  MAX_HISTORY_MESSAGES,
  SYSTEM_INSTRUCTIONS,
  FAQ_INSTRUCTIONS,
  type HistoryMessage,
} from './lib/prompt.ts';
import { createClaudeAccumulator, createSseParser, formatSse } from './lib/sse.ts';
import { parseFaqDraft, threadSources } from './lib/faq.ts';
import { enc, pickKey, RestError, serviceRest, userRest, verifyUser, type Rest } from './lib/rest.ts';
import { addDays, periodStarts, startOfLocalDay } from './lib/dates.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
/** Abort a Claude call that has not finished in this time (the platform's idle limit is 150 s). */
const UPSTREAM_TIMEOUT_MS = 120_000;

// deno-lint-ignore no-explicit-any
const runtime = (globalThis as any).EdgeRuntime as { waitUntil?: (p: Promise<unknown>) => void } | undefined;

/** Log without secrets or message contents. */
function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ fn: 'chat', msg, ...extra }));
}

interface Editor {
  id: string;
  name: string;
}

interface Ctx {
  svc: Rest;
  user: Rest;
  editor: Editor;
  settings: AiSettings;
  timezone: string;
  cors: Record<string, string>;
  apiKey: string;
  now: Date;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (origin && !isAllowedOrigin(origin)) return errorResponse('forbidden_origin', cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return errorResponse('bad_request', cors);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  const publishable = pickKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'), Deno.env.get('SUPABASE_ANON_KEY'));
  const secret = pickKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  if (!apiKey || !url || !publishable || !secret) {
    log('error', 'missing configuration', { anthropic: !!apiKey, url: !!url, publishable: !!publishable, secret: !!secret });
    return errorResponse('server_error', cors);
  }

  try {
    // ---- Who is calling ----
    const jwt = bearerToken(req.headers.get('Authorization'));
    if (!jwt || jwt === publishable) return errorResponse('unauthorized', cors);
    const userId = await verifyUser(url, publishable, jwt);
    if (!userId) return errorResponse('unauthorized', cors);
    const user = userRest(url, publishable, jwt);
    const editors = await user.select<{ display_name: string }>('editors', `select=display_name&user_id=eq.${enc(userId)}&limit=1`);
    if (!editors.length) return errorResponse('not_editor', cors);
    const editor = { id: userId, name: editors[0].display_name };

    // ---- What they want ----
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

    // ---- Limits (service role, every request) ----
    const svc = serviceRest(url, secret);
    const [aiRows, settingsRows] = await Promise.all([
      svc.select<AiSettings>('ai_settings', 'select=*&id=eq.1'),
      svc.select<{ timezone: string }>('settings', 'select=timezone&id=eq.1'),
    ]);
    const settings = aiRows[0];
    if (!settings) return errorResponse('disabled', cors);
    const ctx: Ctx = { svc, user, editor, settings, timezone: settingsRows[0]?.timezone || 'America/Bogota', cors, apiKey, now: new Date() };

    if (parsed.action === 'status') return await handleStatus(ctx);
    if (parsed.action === 'send') return await handleSend(ctx, parsed.threadId, parsed.message, parsed.requestId);
    return await handleDraftFaq(ctx, parsed.threadId);
  } catch (e) {
    if (e instanceof InProgressError) return errorResponse('in_progress', cors);
    log('error', 'request failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : String((e as Error)?.name || e) });
    return errorResponse('server_error', cors);
  }
});

// ---------------------------------------------------------------------------
// Spend and usage
// ---------------------------------------------------------------------------

/** null until the first read tells whether the ai_usage ledger (migration 0004) exists. */
let ledgerAvailable: boolean | null = null;

/**
 * Spend since `since`. Uses the append-only `ai_usage` ledger (migration 0004, applied), which
 * survives thread deletion; falls back to chat_messages.cost_usd if the table is missing.
 */
async function spendSince(svc: Rest, since: string): Promise<number> {
  if (ledgerAvailable !== false) {
    try {
      const rows = await svc.select<{ cost_usd: unknown }>('ai_usage', `select=cost_usd&created_at=gte.${enc(since)}`);
      ledgerAvailable = true;
      return sumCosts(rows);
    } catch (e) {
      if (!(e instanceof RestError && (e.status === 404 || e.code === '42P01' || e.code === 'PGRST205'))) throw e;
      ledgerAvailable = false;
    }
  }
  const rows = await svc.select<{ cost_usd: unknown }>('chat_messages', `select=cost_usd&cost_usd=gt.0&created_at=gte.${enc(since)}`);
  return sumCosts(rows);
}

/**
 * Month spend (ledger, including in-flight reservations) and today's questions of this editor
 * (saved ones plus sends still in flight).
 */
async function usageNow(ctx: Ctx) {
  const { dayStart, monthStart } = periodStarts(ctx.now, ctx.timezone);
  const [spend, todays, pending] = await Promise.all([
    spendSince(ctx.svc, monthStart),
    ctx.svc.select('chat_messages', `select=id&role=eq.user&created_by=eq.${enc(ctx.editor.id)}&created_at=gte.${enc(dayStart)}`),
    ledgerAvailable === false ? Promise.resolve(0) : pendingSends(ctx.svc, ctx.editor.id, dayStart).catch(() => 0),
  ]);
  return { spend, todayCount: todays.length + pending };
}

/**
 * Reserve the worst-case cost in the ledger, then re-check the limits with every reservation counted
 * (closes the race between parallel requests). Returns the reservation id or a refusal.
 */
async function reserveSpend(
  ctx: Ctx,
  kind: ReservationKind,
  estimate: number,
  threadId: string | null,
  requestId: string | null = null,
): Promise<{ id: string | null; refused: Response | null }> {
  // Throws InProgressError when another request with this request id is still being answered.
  const id = await reserve(ctx.svc, kind, estimate, { editorId: ctx.editor.id, editorName: ctx.editor.name, threadId, requestId }, ctx.now);
  if (!id) return { id: null, refused: null }; // no ledger table: pre-check only
  try {
    const { spend, todayCount } = await usageNow(ctx);
    const limit = checkReserved({ settings: ctx.settings, monthSpendUsd: spend, todayUserMessages: todayCount, countsAsMessage: kind === 'send' });
    if (!limit) return { id, refused: null };
    await releaseQuietly(ctx, id);
    return { id: null, refused: errorResponse(limit, ctx.cors, usagePayload(ctx, Math.max(0, spend - estimate), Math.max(0, todayCount - (kind === 'send' ? 1 : 0)))) };
  } catch (e) {
    await releaseQuietly(ctx, id);
    throw e;
  }
}

async function releaseQuietly(ctx: Ctx, id: string | null) {
  try {
    await release(ctx.svc, id);
  } catch (e) {
    // The reservation stays and over-counts the spend (the safe direction).
    log('warn', 'reservation release failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error' });
  }
}

/** A call that Claude billed but that could not be saved as a message: keep its cost in the ledger. */
async function chargeQuietly(ctx: Ctx, id: string | null, usd: number, tokens: { input: number; output: number; searches: number }) {
  if (!id) return;
  try {
    if (usd > 0) await settle(ctx.svc, id, usd, ctx.settings.model, tokens);
    else await release(ctx.svc, id);
  } catch (e) {
    log('error', 'reservation settle failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error', cost_usd: usd });
  }
}

function usagePayload(ctx: Ctx, spend: number, todayCount: number) {
  return {
    budget: budgetInfo(ctx.settings, spend),
    daily: { used: todayCount, limit: num(ctx.settings.daily_message_limit) },
    enabled: !!ctx.settings.enabled,
    web_search: !!ctx.settings.web_search_enabled,
    model: ctx.settings.model,
  };
}

async function handleStatus(ctx: Ctx): Promise<Response> {
  const { spend, todayCount } = await usageNow(ctx);
  return jsonResponse(usagePayload(ctx, spend, todayCount), 200, ctx.cors);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function callClaude(apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/** Refusal sent to the app when Claude fails: `reason` tells it whether retrying can help. */
function upstreamResponse(ctx: Ctx, reason: UpstreamReason, spend: number, todayCount: number): Response {
  return errorResponse('upstream_error', ctx.cors, { reason, ...usagePayload(ctx, spend, todayCount) });
}

/** Read Claude's error type for logs (never the prompt). */
async function upstreamErrorType(res: Response): Promise<string> {
  try {
    const j = await res.json();
    // Anthropic's error text names the rejected parameter; it is needed to diagnose 4xx responses.
    // Truncated, and never the request body.
    log('warn', 'claude error detail', { message: String(j?.error?.message || '').slice(0, 300) });
    return String(j?.error?.type || '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Context (caller's JWT: RLS applies; public tables only)
// ---------------------------------------------------------------------------

const cleanLocation = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null);

async function loadContext(ctx: Ctx): Promise<string> {
  const tz = ctx.timezone;
  const { today } = periodStarts(ctx.now, tz);
  const since = startOfLocalDay(addDays(today, -1), tz).toISOString();
  const u = ctx.user;
  try {
    const [profile, settings, vaccinations, dewormings, weights, vetVisits, medications, feedings, routineEvents, trainingSkills, reminders] =
      await Promise.all([
        u.select('pet_profile', 'select=name,full_name,breed,sex,birth_date,home_date,food,about&id=eq.1'),
        u.select('settings', 'select=timezone,meal_slots,meal_amount_note&id=eq.1'),
        u.select('vaccinations', 'select=vaccine,given_on,next_due_on&order=given_on.desc&limit=4'),
        u.select('dewormings', 'select=product,kind,given_on,next_due_on&order=given_on.desc&limit=3'),
        u.select('weights', 'select=measured_on,weight_kg&order=measured_on.desc&limit=4'),
        u.select('vet_visits', 'select=visited_on,reason,findings,treatment,follow_up_on&order=visited_on.desc&limit=3'),
        u.select('medications', 'select=name,frequency,start_on,end_on&order=start_on.desc&limit=10'),
        u.select('feedings', `select=fed_at,meal_slot,amount_g,appetite&fed_at=gte.${enc(since)}&order=fed_at.asc&limit=40`),
        u.select('routine_events', `select=type,started_at,ended_at,location,accident&started_at=gte.${enc(since)}&order=started_at.asc&limit=120`),
        u.select('training_skills', 'select=skill_key,status'),
        u.select('reminders', `select=title,due_on,done_at&done_at=is.null&due_on=gte.${today}&order=due_on.asc&limit=4`),
      ]);
    const data: ContextData = {
      profile: profile[0] || null,
      settings: settings[0] || null,
      vaccinations,
      dewormings,
      weights,
      vetVisits,
      medications,
      feedings,
      routineEvents,
      trainingSkills,
      reminders,
    };
    return buildContext(data, ctx.now, cleanLocation(ctx.settings.location));
  } catch (e) {
    log('warn', 'context failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error' });
    return "Tyler's data could not be loaded right now. Answer in general terms and say that his records were not available.";
  }
}

// ---------------------------------------------------------------------------
// send: stream an answer, then persist question + answer
// ---------------------------------------------------------------------------

async function loadThread(ctx: Ctx, threadId: string, limit: number) {
  const threads = await ctx.svc.select<{ id: string; title: string | null }>('chat_threads', `select=id,title&id=eq.${enc(threadId)}`);
  if (!threads.length) return null;
  const rows = await ctx.svc.select<HistoryMessage & { sources: unknown }>(
    'chat_messages',
    `select=role,content,sources,created_by_name&thread_id=eq.${enc(threadId)}&order=created_at.desc&limit=${limit}`,
  );
  return { thread: threads[0], messages: rows.reverse() };
}

/**
 * A question with this request id was already saved by this editor: its answer if there is one
 * (replay it), 'in_progress' while it is being saved, or the orphan question (saved without an
 * answer by a request that failed half-way) to answer again under the same id.
 */
async function findRequest(ctx: Ctx, requestId: string): Promise<{ question: StoredMessage; answer: StoredMessage | null } | null> {
  const found = await ctx.svc.select<StoredMessage>(
    'chat_messages',
    `select=*&id=eq.${enc(requestId)}&role=eq.user&created_by=eq.${enc(ctx.editor.id)}&limit=1`,
  );
  if (!found.length) return null;
  const question = found[0];
  const rows = await ctx.svc.select<StoredMessage>(
    'chat_messages',
    `select=*&thread_id=eq.${enc(question.thread_id)}&role=eq.assistant&created_at=gte.${enc(question.created_at)}&order=created_at.asc&limit=5`,
  );
  return { question, answer: pickAnswer(question, rows) };
}

/** Send the saved answer again as a normal stream (no Claude call, nothing billed). */
async function replayResponse(ctx: Ctx, question: StoredMessage, answer: StoredMessage): Promise<Response> {
  const { spend, todayCount } = await usageNow(ctx);
  const threads = await ctx.svc.select<{ title: string | null }>('chat_threads', `select=title&id=eq.${enc(question.thread_id)}`);
  const title = threads[0]?.title ?? null;
  log('info', 'replayed', { thread: 'existing' });
  const body =
    formatSse('meta', { thread_id: question.thread_id, title, new_thread: false, replayed: true }) +
    formatSse('done', {
      thread_id: question.thread_id,
      title,
      stopped: false,
      stop_reason: 'replayed',
      replayed: true,
      user_message: question,
      message: answer,
      ...usagePayload(ctx, spend, todayCount),
    });
  return new Response(body, {
    status: 200,
    headers: { ...ctx.cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store' },
  });
}

async function handleSend(ctx: Ctx, threadIdIn: string | null, question: string, requestId: string | null): Promise<Response> {
  const { settings, cors } = ctx;
  let threadId = threadIdIn;
  // ---- Idempotency: never answer (and bill) the same request id twice ----
  let savedQuestion: StoredMessage | null = null;
  if (requestId) {
    const prior = await findRequest(ctx, requestId);
    if (prior?.answer) return await replayResponse(ctx, prior.question, prior.answer);
    if (prior) {
      // Saved moments ago and the answer is being saved: wait. Older: the save failed half-way.
      if (ctx.now.getTime() - Date.parse(prior.question.created_at) < STALE_RESERVATION_MS) return errorResponse('in_progress', cors);
      savedQuestion = prior.question;
      threadId = prior.question.thread_id;
    }
  }
  let history: HistoryMessage[] = [];
  if (threadId) {
    const t = await loadThread(ctx, threadId, MAX_HISTORY_MESSAGES + 4);
    if (!t) return errorResponse('not_found', cors);
    history = t.messages;
  }

  const { spend, todayCount } = await usageNow(ctx);
  const maxSearches = settings.web_search_enabled ? num(settings.max_searches_per_message) : 0;
  const context = await loadContext(ctx);
  const estimate = estimateMaxCost(settings.model, {
    promptTokens:
      estimateTokens(SYSTEM_INSTRUCTIONS) + estimateTokens(context) + estimateTokens(question) + history.reduce((a, m) => a + estimateTokens(m.content || ''), 0) + 200,
    maxOutputTokens: num(settings.max_output_tokens),
    maxSearches,
  });
  const limit = checkLimits({ settings, monthSpendUsd: spend, todayUserMessages: todayCount, estimatedCostUsd: estimate, countsAsMessage: true });
  if (limit) return errorResponse(limit, cors, usagePayload(ctx, spend, todayCount));

  const request = buildChatRequest({
    model: settings.model,
    maxOutputTokens: num(settings.max_output_tokens),
    context,
    history,
    question,
    webSearch: { enabled: !!settings.web_search_enabled, maxUses: maxSearches },
    timezone: ctx.timezone,
    location: cleanLocation(settings.location),
  });

  const reservation = await reserveSpend(ctx, 'send', estimate, threadId, savedQuestion ? null : requestId);
  if (reservation.refused) return reservation.refused;
  const reservationId = reservation.id;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await callClaude(ctx.apiKey, request, abort.signal);
  } catch (e) {
    clearTimeout(timer);
    const timedOut = (e as Error)?.name === 'AbortError';
    log('warn', 'claude unreachable', { error: String((e as Error)?.name || e) });
    // A timeout may have been billed: keep the worst case. A connection failure was not.
    if (timedOut) await chargeQuietly(ctx, reservationId, estimate, { input: 0, output: 0, searches: 0 });
    else await releaseQuietly(ctx, reservationId);
    return upstreamResponse(ctx, 'temporary', spend, todayCount);
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    const type = await upstreamErrorType(upstream);
    log('warn', 'claude error', { status: upstream.status, type });
    await releaseQuietly(ctx, reservationId); // refused requests are not billed
    return upstreamResponse(ctx, upstreamReason(upstream.status, type), spend, todayCount);
  }

  const isNew = !threadId;
  const id = threadId || crypto.randomUUID();
  const title = isNew ? makeThreadTitle(question) : null;
  const encoder = new TextEncoder();
  let clientOpen = true;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let userStopped = false;
  const sendRaw = (text: string) => {
    if (!clientOpen) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      clientOpen = false;
    }
  };
  const send = (event: string, data: unknown) => sendRaw(formatSse(event, data));
  const close = () => {
    if (!clientOpen) return;
    clientOpen = false;
    try {
      controller.close();
    } catch {
      // already closed
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // The app pressed "stop" or went away: stop generating (and paying for) more tokens.
      clientOpen = false;
      userStopped = true;
      abort.abort();
    },
  });

  const job = (async () => {
    send('meta', { thread_id: id, title, new_thread: isNew });
    // Web searches and long answers can leave the stream silent for a while: a comment every 15 s
    // tells the app the connection is alive (it gives up after 45 s of silence).
    const keepAlive = setInterval(() => sendRaw(SSE_KEEPALIVE), KEEPALIVE_MS);
    try {
      await answer();
    } finally {
      clearInterval(keepAlive);
    }
    close();
  })();
  async function answer() {
    const acc = createClaudeAccumulator();
    const parser = createSseParser((e) => {
      for (const u of acc.apply(e)) {
        if (u.type === 'text') send('delta', { text: u.text });
        else send('status', { state: 'searching', query: u.query || null });
      }
    });
    let readFailed = false;
    try {
      const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
        if (acc.error) break;
      }
      parser.end();
    } catch {
      readFailed = !userStopped;
    } finally {
      clearTimeout(timer);
    }

    const stopped = userStopped && !acc.complete;
    // Stopped or cut off early: the final usage never arrived, so estimate the output generated so far.
    const usage: ApiUsage = { ...acc.usage };
    if (!acc.complete) usage.output_tokens = Math.max(num(usage.output_tokens), estimateTokens(acc.text) + 50);
    const cost = computeCost(settings.model, usage);
    const tokens = { input: cost.promptTokens, output: cost.outputTokens, searches: cost.webSearches };

    if (acc.error || readFailed || (!acc.complete && !stopped)) {
      const type = acc.error?.type || (readFailed ? 'read_failed' : 'incomplete');
      log('warn', 'claude stream failed', { type, cost_usd: acc.started ? cost.usd : 0 });
      // What was generated before the failure is billed: record it (nothing if it never started).
      await chargeQuietly(ctx, reservationId, acc.started ? cost.usd : 0, tokens);
      const reason = acc.error ? upstreamReason(0, acc.error.type) : 'temporary';
      send('error', { error: 'upstream_error' as ErrorCode, reason, ...usagePayload(ctx, spend + (acc.started ? cost.usd : 0), todayCount) });
      return;
    }
    if (stopped && !acc.started) {
      await releaseQuietly(ctx, reservationId);
      return; // nothing was generated
    }

    const sources = acc.sources;

    try {
      const by = { created_by: ctx.editor.id, created_by_name: ctx.editor.name };
      if (isNew) await ctx.svc.insert('chat_threads', { id, title, ...by });
      // The question's id is the client's request id, so a repeat of this request finds it.
      const userRow = savedQuestion || (await ctx.svc.insert('chat_messages', { ...(requestId ? { id: requestId } : {}), thread_id: id, role: 'user', content: question, ...by }));
      const assistantRow = await ctx.svc.insert('chat_messages', {
        thread_id: id,
        role: 'assistant',
        content: acc.text,
        sources,
        model: settings.model,
        input_tokens: cost.promptTokens,
        output_tokens: cost.outputTokens,
        web_searches: cost.webSearches,
        cost_usd: cost.usd,
        ...by,
      });
      // The chat_messages trigger wrote the real cost to the ledger: drop the reservation.
      await releaseQuietly(ctx, reservationId);
      if (!isNew) await ctx.svc.patch('chat_threads', `id=eq.${enc(id)}`, { updated_at: new Date().toISOString() });
      log('info', 'answered', {
        model: settings.model,
        prompt_tokens: cost.promptTokens,
        output_tokens: cost.outputTokens,
        cache_read: num(usage.cache_read_input_tokens),
        web_searches: cost.webSearches,
        cost_usd: cost.usd,
        stop_reason: stopped ? 'user_stopped' : acc.stopReason,
      });
      send('done', {
        thread_id: id,
        title,
        stopped,
        stop_reason: stopped ? 'user_stopped' : acc.stopReason,
        user_message: userRow,
        message: assistantRow,
        ...usagePayload(ctx, spend + cost.usd, todayCount + 1),
      });
    } catch (e) {
      log('error', 'persist failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error', cost_usd: cost.usd });
      await chargeQuietly(ctx, reservationId, cost.usd, tokens);
      send('error', { error: 'server_error' as ErrorCode, ...usagePayload(ctx, spend + cost.usd, todayCount) });
    }
  }
  // Keep the worker alive until the answer is saved, even if the app disconnects.
  runtime?.waitUntil?.(job);

  return new Response(stream, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' },
  });
}

// ---------------------------------------------------------------------------
// draft_faq: one bilingual FAQ entry from a thread (not streamed; costs count toward the budget)
// ---------------------------------------------------------------------------

async function handleDraftFaq(ctx: Ctx, threadId: string): Promise<Response> {
  const { settings, cors } = ctx;
  const t = await loadThread(ctx, threadId, MAX_FAQ_MESSAGES + 10);
  if (!t) return errorResponse('not_found', cors);
  const messages = t.messages.filter((m) => !isFaqDraftRow(m));
  if (!messages.some((m) => m.role === 'assistant' && m.content?.trim())) return errorResponse('bad_request', cors);

  const { spend, todayCount } = await usageNow(ctx);
  const sources = threadSources(messages);
  const transcript = buildTranscript(messages, sources);
  const estimate = estimateMaxCost(settings.model, {
    promptTokens: estimateTokens(FAQ_INSTRUCTIONS + transcript) + 300,
    maxOutputTokens: faqMaxTokens(num(settings.max_output_tokens)),
    maxSearches: 0,
  });
  const limit = checkLimits({ settings, monthSpendUsd: spend, todayUserMessages: todayCount, estimatedCostUsd: estimate, countsAsMessage: false });
  if (limit) return errorResponse(limit, cors, usagePayload(ctx, spend, todayCount));

  const reservation = await reserveSpend(ctx, 'faq', estimate, threadId);
  if (reservation.refused) return reservation.refused;
  const reservationId = reservation.id;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  // deno-lint-ignore no-explicit-any
  let result: any;
  try {
    const res = await callClaude(ctx.apiKey, buildFaqRequest({ model: settings.model, maxOutputTokens: num(settings.max_output_tokens), transcript }), abort.signal);
    if (!res.ok) {
      const type = await upstreamErrorType(res);
      log('warn', 'claude error (faq)', { status: res.status, type });
      await releaseQuietly(ctx, reservationId);
      return upstreamResponse(ctx, upstreamReason(res.status, type), spend, todayCount);
    }
    result = await res.json();
  } catch (e) {
    const timedOut = (e as Error)?.name === 'AbortError';
    log('warn', 'claude unreachable (faq)', { error: String((e as Error)?.name || e) });
    if (timedOut) await chargeQuietly(ctx, reservationId, estimate, { input: 0, output: 0, searches: 0 });
    else await releaseQuietly(ctx, reservationId);
    return upstreamResponse(ctx, 'temporary', spend, todayCount);
  } finally {
    clearTimeout(timer);
  }

  const text = (Array.isArray(result?.content) ? result.content : [])
    // deno-lint-ignore no-explicit-any
    .filter((b: any) => b?.type === 'text')
    // deno-lint-ignore no-explicit-any
    .map((b: any) => b.text)
    .join('');
  const cost = computeCost(settings.model, result?.usage);
  // Record the spend even if the draft turns out unusable: Claude billed it. The tag lets the app hide
  // this row from the conversation.
  try {
    await ctx.svc.insert('chat_messages', {
      thread_id: threadId,
      role: 'assistant',
      content: `${FAQ_DRAFT_TAG}${text.slice(0, 20000)}`,
      sources: [],
      model: settings.model,
      input_tokens: cost.promptTokens,
      output_tokens: cost.outputTokens,
      web_searches: 0,
      cost_usd: cost.usd,
      created_by: ctx.editor.id,
      created_by_name: ctx.editor.name,
    });
    await releaseQuietly(ctx, reservationId);
  } catch (e) {
    log('error', 'persist failed (faq)', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error', cost_usd: cost.usd });
    await chargeQuietly(ctx, reservationId, cost.usd, { input: cost.promptTokens, output: cost.outputTokens, searches: 0 });
  }
  const draft = parseFaqDraft(text, sources);
  const usage = usagePayload(ctx, spend + cost.usd, todayCount);
  if (!draft) {
    log('warn', 'faq draft unparseable', { stop_reason: result?.stop_reason || null });
    return errorResponse('upstream_error', cors, { reason: 'temporary', ...usage });
  }
  log('info', 'faq drafted', { model: settings.model, prompt_tokens: cost.promptTokens, output_tokens: cost.outputTokens, cost_usd: cost.usd });
  return jsonResponse({ draft, ...usage }, 200, cors);
}
