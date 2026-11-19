// One answer ("turn") across several Messages API calls: continue a turn that stopped on
// `pause_turn` or `max_tokens` instead of showing half an answer (or none).
//
// Docs (read 2026-11-18):
//  - Stop reasons: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons —
//    `pause_turn`: the server-side tool loop paused; "add the response's content unchanged as an
//    assistant message, including any server_tool_use block that has no result block. Send the
//    request with the same tools as before and no user message after the assistant message."
//    `max_tokens`: the output was cut; continue with another request.
//  - Server tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools — a
//    continued turn can pause again: cap the continuations and keep every paused response in order.
//  - Thinking: https://platform.claude.com/docs/en/build-with-claude/thinking — after a max_tokens stop
//    "pass the assistant turn back unchanged and append a new user message"; thinking blocks go back
//    complete and unmodified (an omitted block keeps its signature); a block may be dropped only if
//    no kept block follows it.
//  - Web search: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool — search
//    results go back exactly as received (encrypted_content), so a continuation reuses them without
//    searching (or paying for a search) again.
//  - Prefill: Claude Sonnet 5.5 rejects a request that ends with an assistant message (except the
//    paused turn above), so a max_tokens continuation ends with CONTINUE_PROMPT as a user message.
import { createClaudeAccumulator, createSseParser, sourcesFromCitations, type ContentBlock, type Source, type StreamUpdate } from './sse.ts';
import { estimateTokens, type ApiUsage } from './pricing.ts';
import { CONTINUE_PROMPT, type WireMessage } from './prompt.ts';

/** Continuation calls the function makes on its own within one request. */
export const MAX_CONTINUATIONS = 2;
/** Times one question can be resumed from the app ("Continuar" / retry) after that. */
export const MAX_RESUMES = 2;
/** Do not start a continuation with less than this left of the request's time budget. */
export const MIN_CONTINUATION_MS = 30_000;

/** Stop reasons after which the turn can go on. */
export const CONTINUABLE = new Set(['max_tokens', 'pause_turn']);

type Block = Record<string, any>;

const RESULT_TYPES = /_tool_result$/;

/**
 * Blocks of one response that can be sent back. Text is kept even when cut (plain text has no
 * integrity check), empty text is dropped (the API rejects it), thinking needs its signature and
 * a tool call its complete input. Without `keepPendingTool` (a max_tokens continuation, which adds a
 * user message) a server tool call that has no result yet is dropped too.
 */
export function sendableBlocks(blocks: ContentBlock[], opts: { keepPendingTool?: boolean } = {}): Block[] {
  const out: Block[] = [];
  for (const { block, complete } of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue;
      const t: Block = { type: 'text', text: block.text };
      if (Array.isArray(block.citations) && block.citations.length) t.citations = block.citations;
      out.push(t);
      continue;
    }
    if (!complete) continue;
    if (block.type === 'thinking' && !block.signature) continue;
    out.push(block);
  }
  if (opts.keepPendingTool) return out;
  const answered = new Set(out.filter((b) => RESULT_TYPES.test(String(b.type))).map((b) => b.tool_use_id));
  return out.filter((b) => b.type !== 'server_tool_use' || answered.has(b.id));
}

const asBlocks = (content: WireMessage['content']): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : content.slice());

/**
 * Messages for the call that continues a turn: the response goes back unchanged as (the end of)
 * the assistant message; after max_tokens (or an answer with no text) a user message asks for the
 * rest. Null when there is nothing to send back.
 */
export function continuationMessages(messages: WireMessage[], blocks: ContentBlock[], stopReason: string | null): WireMessage[] | null {
  const pause = stopReason === 'pause_turn';
  const content = sendableBlocks(blocks, { keepPendingTool: pause });
  if (!content.length) return null;
  const out: WireMessage[] = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last && last.role === 'assistant') last.content = [...asBlocks(last.content), ...content];
  else out.push({ role: 'assistant', content });
  if (!pause) out.push({ role: 'user', content: CONTINUE_PROMPT });
  return out;
}

export type CallOutcome = { ok: true; chunks: AsyncIterable<string> } | { ok: false; status: number; type: string };

/** What one call of the turn did (for logs: never any text). */
export interface CallLog {
  stop_reason: string | null;
  output_tokens: number;
  thinking_tokens: number | null;
  text_chars: number;
  blocks: Record<string, number>;
  error?: string;
}

export interface TurnResult {
  /** Visible answer text of every call, in order. */
  text: string;
  sources: Source[];
  /** Usage of every call (an unfinished call's output estimated from its text). */
  usages: ApiUsage[];
  calls: CallLog[];
  continuations: number;
  /** Stop reason of the last call. */
  stopReason: string | null;
  /** The answer finished (end_turn, stop_sequence, refusal...). */
  complete: boolean;
  /** The person pressed stop (the app closed the stream). */
  stopped: boolean;
  /** The first call never started (nothing billed). */
  started: boolean;
  /** Why the turn failed, when it did: an API error event, a broken stream, or no message_stop. */
  failure: { kind: 'error' | 'read_failed' | 'incomplete' | 'continuation_refused'; type: string } | null;
  /** Messages to resume from when the turn was cut (max_tokens / pause_turn / no text), else null. */
  next: WireMessage[] | null;
}

function callLog(acc: ReturnType<typeof createClaudeAccumulator>, usage: ApiUsage, error?: string): CallLog {
  const blocks: Record<string, number> = {};
  for (const b of acc.blocks) blocks[b.block.type || 'unknown'] = (blocks[b.block.type || 'unknown'] || 0) + 1;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  const log: CallLog = {
    stop_reason: acc.stopReason,
    output_tokens: Number(usage.output_tokens) || 0,
    thinking_tokens: typeof thinking === 'number' ? thinking : null,
    text_chars: acc.text.length,
    blocks,
  };
  if (error) log.error = error;
  return log;
}

/**
 * Run a turn: read the first call's stream, then continue it while it stops on pause_turn or
 * max_tokens (or ends without any text), up to `maxContinuations` more calls.
 * @param o.messages the messages of the first call
 * @param o.first the first call's response body, decoded
 * @param o.call makes a continuation call with these messages (and the searches used so far)
 * @param o.onUpdate text and search progress, forwarded to the app as it arrives
 * @param o.stopped true once the app closed the stream
 * @param o.canContinue false when there is no time left for another call
 */
export async function runTurn(o: {
  messages: WireMessage[];
  first: AsyncIterable<string>;
  call: (messages: WireMessage[], searchesUsed: number) => Promise<CallOutcome>;
  onUpdate: (u: StreamUpdate) => void;
  stopped: () => boolean;
  canContinue?: () => boolean;
  maxContinuations?: number;
}): Promise<TurnResult> {
  const max = o.maxContinuations ?? MAX_CONTINUATIONS;
  const r: TurnResult = {
    text: '',
    sources: [],
    usages: [],
    calls: [],
    continuations: 0,
    stopReason: null,
    complete: false,
    stopped: false,
    started: false,
    failure: null,
    next: null,
  };
  const citations: Array<{ url?: unknown; title?: unknown }> = [];
  let messages = o.messages;
  let chunks = o.first;
  let searches = 0;
  for (let i = 0; ; i++) {
    const acc = createClaudeAccumulator();
    const parser = createSseParser((e) => {
      for (const u of acc.apply(e)) o.onUpdate(u);
    });
    let readFailed = false;
    try {
      for await (const chunk of chunks) {
        parser.push(chunk);
        if (acc.error) break;
      }
      parser.end();
    } catch {
      readFailed = true;
    }
    if (i === 0) r.started = acc.started;
    const usage: ApiUsage = { ...acc.usage };
    // Stopped or cut off: the final usage never arrived, so estimate the output generated so far.
    if (!acc.complete && acc.started) usage.output_tokens = Math.max(Number(usage.output_tokens) || 0, estimateTokens(acc.text) + 50);
    if (acc.started) r.usages.push(usage);
    searches += Number(usage.server_tool_use?.web_search_requests) || 0;
    r.text += acc.text;
    citations.push(...acc.citations);
    r.stopReason = acc.stopReason;

    if (o.stopped()) {
      r.stopped = true;
      r.calls.push(callLog(acc, usage, 'user_stopped'));
      break;
    }
    if (acc.error || readFailed || !acc.complete) {
      const kind = acc.error ? 'error' : readFailed ? 'read_failed' : 'incomplete';
      r.calls.push(callLog(acc, usage, kind));
      r.failure = { kind, type: acc.error?.type || kind };
      // A continuation that broke: resume from the messages it was sent with.
      if (i > 0) r.next = messages;
      break;
    }
    r.calls.push(callLog(acc, usage));
    const noText = !r.text.trim();
    if (!CONTINUABLE.has(acc.stopReason || '') && !(noText && acc.stopReason === 'end_turn')) {
      r.complete = true;
      break;
    }
    const next = continuationMessages(messages, acc.blocks, acc.stopReason);
    if (!next) break; // nothing to send back: cut, with no way to resume
    if (i >= max || (o.canContinue && !o.canContinue())) {
      r.next = next;
      break;
    }
    const res = await o.call(next, searches);
    if (!res.ok) {
      r.calls.push({ stop_reason: null, output_tokens: 0, thinking_tokens: null, text_chars: 0, blocks: {}, error: `http_${res.status}` });
      r.failure = { kind: 'continuation_refused', type: res.type || String(res.status) };
      r.next = next;
      break;
    }
    r.continuations++;
    messages = next;
    chunks = res.chunks;
  }
  r.sources = sourcesFromCitations(citations);
  return r;
}

/** Continuation state saved in the hidden row (its `sources` column) to resume a cut answer later. */
export interface ContinuationState {
  v: 1;
  messages: WireMessage[];
  searches: number;
  resumes: number;
}

/** Small JSON after CONTINUATION_TAG in the hidden row's content (the app reads it). */
export interface ContinuationMeta {
  question_id: string;
  answer_id: string | null;
  /** 'length': cut by max_tokens / pause_turn; 'empty': no text yet; 'error': a continuation failed. */
  reason: 'length' | 'empty' | 'error';
}

export function parseContinuationMeta(content: string | null | undefined, tag: string): ContinuationMeta | null {
  if (!content || !content.startsWith(tag)) return null;
  try {
    const m = JSON.parse(content.slice(tag.length));
    if (!m || typeof m.question_id !== 'string') return null;
    return { question_id: m.question_id, answer_id: typeof m.answer_id === 'string' ? m.answer_id : null, reason: m.reason === 'empty' || m.reason === 'error' ? m.reason : 'length' };
  } catch {
    return null;
  }
}

export function parseContinuationState(v: unknown): ContinuationState | null {
  const s = v as ContinuationState;
  if (!s || s.v !== 1 || !Array.isArray(s.messages) || !s.messages.length) return null;
  if (!s.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))) return null;
  return { v: 1, messages: s.messages, searches: Number(s.searches) || 0, resumes: Number(s.resumes) || 0 };
}

/** Searches a continuation call may still make: what is left of the per-question limit, at least 1 (the tool must stay defined). */
export const continuationSearches = (maxSearches: number, used: number) => Math.max(1, maxSearches - used);
