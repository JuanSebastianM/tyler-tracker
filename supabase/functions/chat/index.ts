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
import { computeCost, costOfCalls, estimateMaxCost, estimateTokens, estimateTurnCost, roundUsd } from './lib/pricing.ts';
import { buildContext, contextFromRows, contextQueries } from './lib/context.ts';
import {
  answerMaxTokens,
  buildChatRequest,
  buildFaqRequest,
  buildTranscript,
  CONTINUATION_TAG,
  faqMaxTokens,
  FAQ_DRAFT_TAG,
  isHiddenRow,
  makeThreadTitle,
  modelOptions,
  MAX_FAQ_MESSAGES,
  MAX_HISTORY_MESSAGES,
  SYSTEM_INSTRUCTIONS,
  FAQ_INSTRUCTIONS,
  type HistoryMessage,
  type WireMessage,
} from './lib/prompt.ts';
import { formatSse, MAX_SOURCES, type Source } from './lib/sse.ts';
import {
  continuationSearches,
  MAX_CONTINUATIONS,
  MAX_RESUMES,
  MIN_CONTINUATION_MS,
  parseContinuationMeta,
  parseContinuationState,
  runTurn,
  type CallOutcome,
  type ContinuationMeta,
  type ContinuationState,
  type TurnResult,
} from './lib/turn.ts';
import { parseFaqDraft, threadSources } from './lib/faq.ts';
import { enc, pickKey, RestError, serviceRest, userRest, verifyUser, type Rest } from './lib/rest.ts';
import { periodStarts } from './lib/dates.ts';

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
  try {
    const queries = contextQueries(ctx.now, ctx.timezone);
    const results = await Promise.all(queries.map((q) => ctx.user.select(q.table, q.query)));
    return buildContext(contextFromRows(queries, results), ctx.now, cleanLocation(ctx.settings.location));
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
  // Continuation rows carry whole API turns (search results included): never load them as history.
  const rows = await ctx.svc.select<HistoryMessage & { sources: unknown }>(
    'chat_messages',
    `select=role,content,sources,created_by_name&thread_id=eq.${enc(threadId)}&content=not.like.${enc(CONTINUATION_TAG)}*&order=created_at.desc&limit=${limit}`,
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
    `select=*&thread_id=eq.${enc(question.thread_id)}&role=eq.assistant&created_at=gte.${enc(question.created_at)}&content=not.like.${enc(CONTINUATION_TAG)}*&order=created_at.asc&limit=5`,
  );
  return { question, answer: pickAnswer(question, rows) };
}

interface ContinuationRow {
  id: string;
  meta: ContinuationMeta;
  state: ContinuationState | null;
}

/** The saved continuation of this question's answer, if its answer was cut (newest first). */
async function findContinuation(ctx: Ctx, question: StoredMessage): Promise<ContinuationRow | null> {
  const rows = await ctx.svc.select<{ id: string; content: string; sources: unknown }>(
    'chat_messages',
    `select=id,content,sources&thread_id=eq.${enc(question.thread_id)}&role=eq.assistant&content=like.${enc(CONTINUATION_TAG)}*&order=created_at.desc&limit=5`,
  );
  for (const r of rows) {
    const meta = parseContinuationMeta(r.content, CONTINUATION_TAG);
    if (meta?.question_id === question.id) return { id: r.id, meta, state: parseContinuationState(r.sources) };
  }
  return null;
}

/** Save what is needed to resume a cut answer (a hidden row: no cost, so no ledger row). */
async function saveContinuation(ctx: Ctx, threadId: string, meta: ContinuationMeta, state: ContinuationState) {
  await ctx.svc.insert('chat_messages', {
    thread_id: threadId,
    role: 'assistant',
    content: CONTINUATION_TAG + JSON.stringify(meta),
    sources: state,
    model: ctx.settings.model,
    cost_usd: 0,
    created_by: ctx.editor.id,
    created_by_name: ctx.editor.name,
  });
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

/** The response body of a Claude call, decoded, as an async iterable of text chunks. */
async function* readChunks(res: Response): AsyncIterable<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Build and send one Claude call of a turn; non-OK answers are logged and turned into an outcome. */
async function claudeCall(ctx: Ctx, body: Record<string, unknown>, signal: AbortSignal): Promise<CallOutcome> {
  let res: Response;
  try {
    res = await callClaude(ctx.apiKey, body, signal);
  } catch (e) {
    return { ok: false, status: 0, type: String((e as Error)?.name || 'error') };
  }
  if (!res.ok || !res.body) {
    const type = await upstreamErrorType(res);
    log('warn', 'claude error', { status: res.status, type });
    return { ok: false, status: res.status, type };
  }
  return { ok: true, chunks: readChunks(res) };
}

/** Log a finished turn: stop reasons and token counts by type, never any text. */
function logTurn(ctx: Ctx, msg: string, r: TurnResult, cost: { promptTokens: number; outputTokens: number; webSearches: number; usd: number }, extra: Record<string, unknown> = {}) {
  const thinking = r.calls.reduce((a, c) => a + (c.thinking_tokens || 0), 0);
  log(r.text.trim() || r.stopped ? 'info' : 'warn', msg, {
    model: ctx.settings.model,
    stop_reason: r.stopped ? 'user_stopped' : r.stopReason,
    complete: r.complete,
    continuations: r.continuations,
    calls: r.calls,
    prompt_tokens: cost.promptTokens,
    output_tokens: cost.outputTokens,
    thinking_tokens: r.calls.some((c) => c.thinking_tokens !== null) ? thinking : null,
    text_chars: r.text.length,
    web_searches: cost.webSearches,
    cost_usd: cost.usd,
    failure: r.failure?.kind || null,
    ...extra,
  });
}

interface TurnStream {
  stream: ReadableStream<Uint8Array>;
  send: (event: string, data: unknown) => void;
  isStopped: () => boolean;
}

/**
 * The SSE stream to the app. Closing it (the stop button, or the app went away) aborts the Claude
 * call so no more tokens are generated or paid for. `job` runs with keep-alives and is kept alive
 * by the runtime until it has saved everything, even if the app disconnects.
 */
function openTurnStream(abort: AbortController, job: (t: TurnStream) => Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let clientOpen = true;
  let userStopped = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const sendRaw = (text: string) => {
    if (!clientOpen) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      clientOpen = false;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      clientOpen = false;
      userStopped = true;
      abort.abort();
    },
  });
  const t: TurnStream = { stream, send: (event, data) => sendRaw(formatSse(event, data)), isStopped: () => userStopped };
  const run = (async () => {
    // Web searches and long answers can leave the stream silent for a while: a comment every 15 s
    // tells the app the connection is alive (it gives up after 45 s of silence).
    const keepAlive = setInterval(() => sendRaw(SSE_KEEPALIVE), KEEPALIVE_MS);
    try {
      await job(t);
    } catch (e) {
      log('error', 'turn failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : String((e as Error)?.name || e) });
      t.send('error', { error: 'server_error' as ErrorCode });
    } finally {
      clearInterval(keepAlive);
    }
    if (!clientOpen) return;
    clientOpen = false;
    try {
      controller.close();
    } catch {
      // already closed
    }
  })();
  runtime?.waitUntil?.(run);
  return stream;
}

const sseResponse = (ctx: Ctx, stream: ReadableStream<Uint8Array>) =>
  new Response(stream, {
    status: 200,
    headers: { ...ctx.cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' },
  });

const turnTokens = (cost: { promptTokens: number; outputTokens: number; webSearches: number }) => ({ input: cost.promptTokens, output: cost.outputTokens, searches: cost.webSearches });

async function handleSend(ctx: Ctx, threadIdIn: string | null, question: string, requestId: string | null): Promise<Response> {
  const { settings, cors } = ctx;
  let threadId = threadIdIn;
  // ---- Idempotency: never answer (and bill) the same request id twice ----
  let savedQuestion: StoredMessage | null = null;
  if (requestId) {
    const prior = await findRequest(ctx, requestId);
    let dropped = false;
    if (prior) {
      // The answer was cut (or came back empty): go on from where it stopped, reusing the searches.
      const cont = await findContinuation(ctx, prior.question);
      if (cont) {
        const resumed = await handleResume(ctx, prior.question, prior.answer, cont);
        if (resumed) return resumed;
        dropped = true; // the saved turn could not be used: replay what there is, or ask again
      }
    }
    if (prior?.answer) return await replayResponse(ctx, prior.question, prior.answer);
    if (prior) {
      // Saved moments ago and the answer is being saved: wait. Older: the save failed half-way.
      if (!dropped && ctx.now.getTime() - Date.parse(prior.question.created_at) < STALE_RESERVATION_MS) return errorResponse('in_progress', cors);
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
  if (!Object.keys(modelOptions(settings.model)).length) log('warn', 'model without explicit thinking settings', { model: settings.model });
  const estimate = estimateTurnCost(settings.model, {
    promptTokens:
      estimateTokens(SYSTEM_INSTRUCTIONS) + estimateTokens(context) + estimateTokens(question) + history.reduce((a, m) => a + estimateTokens(m.content || ''), 0) + 200,
    maxOutputTokens: answerMaxTokens(num(settings.max_output_tokens)),
    maxSearches,
    maxContinuations: MAX_CONTINUATIONS,
    continuationSearches: maxSearches ? continuationSearches(maxSearches, maxSearches) : 0,
  });
  const limit = checkLimits({ settings, monthSpendUsd: spend, todayUserMessages: todayCount, estimatedCostUsd: estimate, countsAsMessage: true });
  if (limit) return errorResponse(limit, cors, usagePayload(ctx, spend, todayCount));

  const chatOptions = {
    model: settings.model,
    maxOutputTokens: num(settings.max_output_tokens),
    context,
    history,
    question,
    timezone: ctx.timezone,
    location: cleanLocation(settings.location),
  };
  const request = buildChatRequest({ ...chatOptions, webSearch: { enabled: !!settings.web_search_enabled, maxUses: maxSearches } });

  const reservation = await reserveSpend(ctx, 'send', estimate, threadId, savedQuestion ? null : requestId);
  if (reservation.refused) return reservation.refused;
  const reservationId = reservation.id;

  const abort = new AbortController();
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
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
  const by = { created_by: ctx.editor.id, created_by_name: ctx.editor.name };
  const firstMessages = request.messages as WireMessage[];

  const stream = openTurnStream(abort, async ({ send, isStopped }) => {
    send('meta', { thread_id: id, title, new_thread: isNew });
    const r = await runTurn({
      messages: firstMessages,
      first: readChunks(upstream),
      call: (messages, used) =>
        claudeCall(ctx, buildChatRequest({ ...chatOptions, messages, webSearch: { enabled: maxSearches > 0, maxUses: continuationSearches(maxSearches, used) } }), abort.signal),
      onUpdate: (u) => (u.type === 'text' ? send('delta', { text: u.text }) : send('status', { state: 'searching', query: u.query || null })),
      stopped: isStopped,
      canContinue: () => Date.now() < deadline - MIN_CONTINUATION_MS,
    });
    clearTimeout(timer);
    const cost = costOfCalls(settings.model, r.usages);
    const hasText = !!r.text.trim();

    /** Thread and question rows (once). */
    let userRow: StoredMessage | null = savedQuestion;
    const saveQuestion = async () => {
      if (userRow) return userRow;
      if (isNew) await ctx.svc.insert('chat_threads', { id, title, ...by });
      // The question's id is the client's request id, so a repeat of this request finds it.
      userRow = await ctx.svc.insert<StoredMessage>('chat_messages', { ...(requestId ? { id: requestId } : {}), thread_id: id, role: 'user', content: question, ...by });
      return userRow;
    };

    if (r.stopped && !hasText) {
      // Stopped before any text: nothing to show. Whatever Claude already billed stays in the ledger.
      logTurn(ctx, 'stopped before text', r, cost);
      if (r.started && cost.usd > 0) await chargeQuietly(ctx, reservationId, cost.usd, turnTokens(cost));
      else await releaseQuietly(ctx, reservationId);
      return;
    }
    if (!hasText || (!r.complete && !r.stopped && !r.next)) {
      // No visible text (or a broken first call): never saved or shown as an answer. The cost Claude
      // billed is recorded; if the turn can be resumed, its state is saved so a retry goes on from
      // here instead of searching (and paying) again.
      logTurn(ctx, hasText ? 'claude stream failed' : 'empty answer', r, cost);
      await chargeQuietly(ctx, reservationId, r.started ? cost.usd : 0, turnTokens(cost));
      let continuable = false;
      if (!hasText && r.next && requestId) {
        try {
          const q = await saveQuestion();
          await saveContinuation(ctx, id, { question_id: q.id, answer_id: null, reason: 'empty' }, { v: 1, messages: r.next, searches: cost.webSearches, resumes: 0 });
          continuable = true;
        } catch (e) {
          log('error', 'continuation save failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error' });
        }
      }
      const reason: UpstreamReason | 'empty' = !hasText && !r.failure ? 'empty' : r.failure?.kind === 'error' ? upstreamReason(0, r.failure.type) : 'temporary';
      send('error', { error: 'upstream_error' as ErrorCode, reason, continuable, ...usagePayload(ctx, spend + (r.started ? cost.usd : 0), todayCount + (continuable ? 1 : 0)) });
      return;
    }

    try {
      const q = await saveQuestion();
      const assistantRow = await ctx.svc.insert('chat_messages', {
        thread_id: id,
        role: 'assistant',
        content: r.text,
        sources: r.sources,
        model: settings.model,
        input_tokens: cost.promptTokens,
        output_tokens: cost.outputTokens,
        web_searches: cost.webSearches,
        cost_usd: cost.usd,
        ...by,
      });
      // The chat_messages trigger wrote the real cost to the ledger: drop the reservation.
      await releaseQuietly(ctx, reservationId);
      const cut = !r.complete && !r.stopped;
      if (cut && r.next) {
        await saveContinuation(ctx, id, { question_id: q.id, answer_id: assistantRow.id, reason: r.failure ? 'error' : 'length' }, { v: 1, messages: r.next, searches: cost.webSearches, resumes: 0 }).catch((e) =>
          log('error', 'continuation save failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error' }),
        );
      }
      if (!isNew) await ctx.svc.patch('chat_threads', `id=eq.${enc(id)}`, { updated_at: new Date().toISOString() });
      logTurn(ctx, cut ? 'answered (cut)' : 'answered', r, cost, { cache_read: r.usages.reduce((a, u) => a + num(u.cache_read_input_tokens), 0) });
      send('done', {
        thread_id: id,
        title,
        stopped: r.stopped,
        stop_reason: r.stopped ? 'user_stopped' : r.stopReason,
        cut,
        continuations: r.continuations,
        user_message: q,
        message: assistantRow,
        ...usagePayload(ctx, spend + cost.usd, todayCount + 1),
      });
    } catch (e) {
      log('error', 'persist failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error', cost_usd: cost.usd });
      await chargeQuietly(ctx, reservationId, cost.usd, turnTokens(cost));
      send('error', { error: 'server_error' as ErrorCode, ...usagePayload(ctx, spend + cost.usd, todayCount) });
    }
  });
  return sseResponse(ctx, stream);
}

// ---------------------------------------------------------------------------
// Resume a cut answer: the app resends the question's request id ("Continuar", or Retry after an
// empty answer) and the saved turn is continued, reusing its search results.
// ---------------------------------------------------------------------------

/**
 * Continue a saved turn. Null when the saved state cannot be used (unreadable, resumed too often, or
 * the API no longer accepts it): the caller then replays the saved answer or asks again.
 */
async function handleResume(ctx: Ctx, question: StoredMessage, answer: StoredMessage | null, cont: ContinuationRow): Promise<Response | null> {
  const { settings, cors } = ctx;
  const state = cont.state;
  // Claim the saved state: a second request for the same answer finds nothing and waits.
  const claimed = await ctx.svc.take('chat_messages', `id=eq.${enc(cont.id)}`);
  if (!claimed.length) return errorResponse('in_progress', cors);
  if (!state || state.resumes >= MAX_RESUMES) {
    log('info', 'continuation dropped', { reason: state ? 'too_many_resumes' : 'unreadable' });
    return null;
  }
  const restore = (s: ContinuationState = state, meta: ContinuationMeta = cont.meta) =>
    saveContinuation(ctx, question.thread_id, meta, s).catch((e) => log('error', 'continuation save failed', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error' }));

  const threadId = question.thread_id;
  const { spend, todayCount } = await usageNow(ctx);
  const maxSearches = settings.web_search_enabled ? num(settings.max_searches_per_message) : 0;
  const context = await loadContext(ctx);
  const searchesLeft = maxSearches ? continuationSearches(maxSearches, state.searches) : 0;
  const estimate = estimateTurnCost(settings.model, {
    promptTokens: estimateTokens(SYSTEM_INSTRUCTIONS) + estimateTokens(context) + estimateTokens(JSON.stringify(state.messages)) + 200,
    maxOutputTokens: answerMaxTokens(num(settings.max_output_tokens)),
    maxSearches: searchesLeft,
    maxContinuations: MAX_CONTINUATIONS,
    continuationSearches: searchesLeft,
  });
  const limit = checkLimits({ settings, monthSpendUsd: spend, todayUserMessages: todayCount, estimatedCostUsd: estimate, countsAsMessage: false });
  if (limit) {
    await restore();
    return errorResponse(limit, cors, usagePayload(ctx, spend, todayCount));
  }
  const chatOptions = {
    model: settings.model,
    maxOutputTokens: num(settings.max_output_tokens),
    context,
    history: [],
    question: question.content || '',
    timezone: ctx.timezone,
    location: cleanLocation(settings.location),
  };
  const bodyFor = (messages: WireMessage[], used: number) =>
    buildChatRequest({ ...chatOptions, messages, webSearch: { enabled: maxSearches > 0, maxUses: continuationSearches(maxSearches, used) } });

  let reservation: { id: string | null; refused: Response | null };
  try {
    reservation = await reserveSpend(ctx, 'continue', estimate, threadId);
  } catch (e) {
    await restore();
    throw e;
  }
  if (reservation.refused) {
    await restore();
    return reservation.refused;
  }
  const reservationId = reservation.id;

  const abort = new AbortController();
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  const first = await claudeCall(ctx, bodyFor(state.messages, state.searches), abort.signal);
  if (!first.ok) {
    clearTimeout(timer);
    const timedOut = first.type === 'AbortError';
    if (timedOut) await chargeQuietly(ctx, reservationId, estimate, { input: 0, output: 0, searches: 0 });
    else await releaseQuietly(ctx, reservationId);
    if (first.status === 400) {
      // The saved turn is no longer accepted: it cannot be continued, so it is dropped.
      log('warn', 'continuation rejected', { status: first.status, type: first.type });
      return null;
    }
    await restore();
    return upstreamResponse(ctx, first.status ? upstreamReason(first.status, first.type) : 'temporary', spend, todayCount);
  }

  const nextState = (messages: WireMessage[], searches: number): ContinuationState => ({ v: 1, messages, searches, resumes: state.resumes + 1 });
  const stream = openTurnStream(abort, async ({ send, isStopped }) => {
    send('meta', { thread_id: threadId, title: null, new_thread: false, continued: true });
    const r = await runTurn({
      messages: state.messages,
      first: first.chunks,
      call: (messages, used) => claudeCall(ctx, bodyFor(messages, state.searches + used), abort.signal),
      onUpdate: (u) => (u.type === 'text' ? send('delta', { text: u.text }) : send('status', { state: 'searching', query: u.query || null })),
      stopped: isStopped,
      canContinue: () => Date.now() < deadline - MIN_CONTINUATION_MS,
    });
    clearTimeout(timer);
    const cost = costOfCalls(settings.model, r.usages);
    const searches = state.searches + cost.webSearches;
    const hasText = !!r.text.trim();

    if (!hasText) {
      logTurn(ctx, r.stopped ? 'resume stopped before text' : 'empty answer (resumed)', r, cost);
      await chargeQuietly(ctx, reservationId, r.started ? cost.usd : 0, turnTokens(cost));
      // Keep a way to resume, unless this was the last allowed attempt.
      const keep = state.resumes + 1 < MAX_RESUMES;
      if (keep) await restore(nextState(r.next || state.messages, searches));
      if (r.stopped) return;
      const reason = !r.failure ? 'empty' : r.failure.kind === 'error' ? upstreamReason(0, r.failure.type) : 'temporary';
      send('error', { error: 'upstream_error' as ErrorCode, reason, continuable: keep, ...usagePayload(ctx, spend + cost.usd, todayCount) });
      return;
    }

    try {
      let saved: StoredMessage;
      if (answer) {
        // The cut answer grows in place; this call's cost goes to the ledger through the reservation
        // (the ledger trigger only runs on insert).
        const merged = mergeSources(Array.isArray(answer.sources) ? (answer.sources as Source[]) : [], r.sources);
        const patch = {
          content: (answer.content || '') + r.text,
          sources: merged,
          input_tokens: num(answer.input_tokens) + cost.promptTokens,
          output_tokens: num(answer.output_tokens) + cost.outputTokens,
          web_searches: num(answer.web_searches) + cost.webSearches,
          cost_usd: roundUsd(num(answer.cost_usd) + cost.usd),
        };
        await ctx.svc.patch('chat_messages', `id=eq.${enc(answer.id)}`, patch);
        await chargeQuietly(ctx, reservationId, cost.usd, turnTokens(cost));
        saved = { ...answer, ...patch };
      } else {
        saved = await ctx.svc.insert<StoredMessage>('chat_messages', {
          thread_id: threadId,
          role: 'assistant',
          content: r.text,
          sources: r.sources,
          model: settings.model,
          input_tokens: cost.promptTokens,
          output_tokens: cost.outputTokens,
          web_searches: cost.webSearches,
          cost_usd: cost.usd,
          created_by: ctx.editor.id,
          created_by_name: ctx.editor.name,
        });
        await releaseQuietly(ctx, reservationId);
      }
      const cut = !r.complete && !r.stopped;
      if (cut && r.next && state.resumes + 1 < MAX_RESUMES) {
        await restore(nextState(r.next, searches), { question_id: question.id, answer_id: saved.id, reason: r.failure ? 'error' : 'length' });
      }
      await ctx.svc.patch('chat_threads', `id=eq.${enc(threadId)}`, { updated_at: new Date().toISOString() });
      logTurn(ctx, cut ? 'resumed (cut)' : 'resumed', r, cost, { resumes: state.resumes + 1 });
      send('done', {
        thread_id: threadId,
        title: null,
        stopped: r.stopped,
        stop_reason: r.stopped ? 'user_stopped' : r.stopReason,
        cut,
        continued: true,
        continuations: r.continuations,
        user_message: question,
        message: saved,
        ...usagePayload(ctx, spend + cost.usd, todayCount),
      });
    } catch (e) {
      log('error', 'persist failed (resume)', { error: e instanceof RestError ? `${e.status} ${e.code}` : 'error', cost_usd: cost.usd });
      await chargeQuietly(ctx, reservationId, cost.usd, turnTokens(cost));
      send('error', { error: 'server_error' as ErrorCode, ...usagePayload(ctx, spend + cost.usd, todayCount) });
    }
  });
  return sseResponse(ctx, stream);
}

/** Sources of a resumed answer: the old ones first, then new ones, without duplicates. */
function mergeSources(a: Source[], b: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of [...a, ...b]) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, MAX_SOURCES);
}

// ---------------------------------------------------------------------------
// draft_faq: one bilingual FAQ entry from a thread (not streamed; costs count toward the budget)
// ---------------------------------------------------------------------------

async function handleDraftFaq(ctx: Ctx, threadId: string): Promise<Response> {
  const { settings, cors } = ctx;
  const t = await loadThread(ctx, threadId, MAX_FAQ_MESSAGES + 10);
  if (!t) return errorResponse('not_found', cors);
  const messages = t.messages.filter((m) => !isHiddenRow(m));
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
