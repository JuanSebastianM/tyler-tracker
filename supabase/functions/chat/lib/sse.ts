// Server-sent events: parse the Claude stream and format the events sent to the app.
//
// Claude stream format (https://platform.claude.com/docs/en/build-with-claude/streaming):
// message_start (usage of the prompt) → for each content block: content_block_start,
// content_block_delta (text_delta | input_json_delta | citations_delta | ...), content_block_stop →
// message_delta (stop_reason, cumulative usage incl. server_tool_use.web_search_requests) →
// message_stop. `ping` can appear anywhere; `error` events can arrive mid-stream; unknown event types
// must be ignored. Server tool blocks (server_tool_use, web_search_tool_result) arrive whole.
// Citations on text blocks are `web_search_result_location` objects with url, title, cited_text
// (https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool); while streaming
// each `citations_delta` carries one citation (https://platform.claude.com/docs/en/build-with-claude/citations).
import type { ApiUsage } from './pricing.ts';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed decoded text chunks with push(); complete events go to onEvent.
 * Handles \n, \r\n and \r line endings, multi-line data and comment lines.
 */
export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buf = '';
  let event = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length || event) onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };
  const line = (l: string) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let m: RegExpExecArray | null;
      const re = /\r\n|\r|\n/g;
      let start = 0;
      while ((m = re.exec(buf))) {
        // A lone '\r' at the very end may be the first half of '\r\n': wait for more input.
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
    },
    end() {
      if (buf) line(buf);
      buf = '';
      dispatch();
    },
  };
}

/** One SSE event for the app. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface Source {
  title: string;
  url: string;
}

/** Maximum sources shown under one answer. */
export const MAX_SOURCES = 8;

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u);

/** Dedupe citations into a source list (https only, first title wins). */
export function sourcesFromCitations(citations: Array<{ url?: unknown; title?: unknown }>, max = MAX_SOURCES): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const c of citations) {
    if (!c || !isHttps(c.url) || seen.has(c.url)) continue;
    seen.add(c.url);
    const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 200) : new URL(c.url).hostname;
    out.push({ title, url: c.url });
    if (out.length >= max) break;
  }
  return out;
}

export type StreamUpdate = { type: 'text'; text: string } | { type: 'searching'; query?: string };

/**
 * Accumulates a Claude message from stream events: answer text, citations, usage, stop reason,
 * errors. apply() returns what to forward to the app right away.
 */
export function createClaudeAccumulator() {
  const blocks = new Map<number, { type: string; json: string }>();
  const citations: Array<{ url?: unknown; title?: unknown }> = [];
  let text = '';
  let usage: ApiUsage = {};
  let stopReason: string | null = null;
  let error: { type: string; message: string } | null = null;
  let started = false;
  let stopped = false;
  let searchesStarted = 0;
  let model: string | null = null;

  const mergeUsage = (u: ApiUsage | undefined | null) => {
    if (!u) return;
    for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) (usage as Record<string, unknown>)[k] = v;
  };

  function apply(e: SseEvent): StreamUpdate[] {
    let payload: any;
    try {
      payload = e.data ? JSON.parse(e.data) : {};
    } catch {
      return [];
    }
    const type = payload?.type || e.event;
    switch (type) {
      case 'message_start':
        started = true;
        model = payload.message?.model || null;
        mergeUsage(payload.message?.usage);
        return [];
      case 'content_block_start': {
        const block = payload.content_block || {};
        blocks.set(payload.index, { type: block.type, json: '' });
        if (block.type === 'text') {
          if (Array.isArray(block.citations)) citations.push(...block.citations);
          if (block.text) {
            text += block.text;
            return [{ type: 'text', text: block.text }];
          }
        }
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          searchesStarted++;
          return [{ type: 'searching' }];
        }
        return [];
      }
      case 'content_block_delta': {
        const d = payload.delta || {};
        const block = blocks.get(payload.index);
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text;
          return [{ type: 'text', text: d.text }];
        }
        if (d.type === 'citations_delta' && d.citation) citations.push(d.citation);
        if (d.type === 'input_json_delta' && block && block.type === 'server_tool_use') block.json += d.partial_json || '';
        return [];
      }
      case 'content_block_stop': {
        const block = blocks.get(payload.index);
        if (block?.type === 'server_tool_use' && block.json) {
          try {
            const q = JSON.parse(block.json)?.query;
            if (typeof q === 'string') return [{ type: 'searching', query: q.slice(0, 200) }];
          } catch {
            // partial JSON: ignore
          }
        }
        return [];
      }
      case 'message_delta':
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
        mergeUsage(payload.usage);
        return [];
      case 'message_stop':
        stopped = true;
        return [];
      case 'error':
        error = { type: payload.error?.type || 'error', message: String(payload.error?.message || '') };
        return [];
      default:
        return []; // ping and unknown events
    }
  }

  return {
    apply,
    get text() {
      return text;
    },
    get sources() {
      return sourcesFromCitations(citations);
    },
    get usage(): ApiUsage {
      // Fall back to counting search blocks if the final usage never arrived (stopped stream).
      const u = { ...usage };
      if (!u.server_tool_use?.web_search_requests && searchesStarted) u.server_tool_use = { web_search_requests: searchesStarted };
      return u;
    },
    get stopReason() {
      return stopReason;
    },
    get error() {
      return error;
    },
    get started() {
      return started;
    },
    /** True once message_stop arrived (the answer is complete). */
    get complete() {
      return stopped && !error;
    },
    get model() {
      return model;
    },
  };
}
