// Claude API prices and the cost of one request. The only place prices live.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-13).
//   Claude Sonnet 5.5: input $2, 5-minute cache write $2.50, 1-hour cache write $4, cache read $0.10,
//     output $10 per million tokens.
//   Claude Haiku 5.5, prompts up to 100,000 tokens: input $0.10, 5m cache write $0.125, 1h cache
//     write $0.20, cache read $0.01, output $0.50. Over 100,000 prompt tokens (input + cache reads +
//     cache writes) the whole request is billed at $0.50 / $0.625 / $1 / $0.05 / $2.50.
//   Web search: $10 per 1,000 searches, plus the tokens of the results (billed as input tokens).
// Usage fields (input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
// cache_creation.ephemeral_5m/1h_input_tokens, server_tool_use.web_search_requests):
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching and
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// Model ids: https://platform.claude.com/docs/en/about-claude/models/overview

export const PRICES_VERIFIED_ON = '2026-11-13';
export const WEB_SEARCH_USD_PER_SEARCH = 10 / 1000;

/** USD per million tokens. */
export interface PriceTier {
  /** This tier applies while the prompt (all input tokens) has at most this many tokens. */
  maxPromptTokens: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export const PRICES: Record<string, PriceTier[]> = {
  'claude-sonnet-5-5': [
    { maxPromptTokens: Infinity, input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  ],
  'claude-haiku-5-5': [
    { maxPromptTokens: 100_000, input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
    { maxPromptTokens: Infinity, input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
  ],
};

/**
 * Used for a model that is not in the table (for example if ai_settings.model is changed to a newer
 * model before this file is updated). Deliberately pessimistic (Claude Opus 5.5 list price with the
 * standard cache multipliers) so the budget is never under-counted.
 */
export const FALLBACK_TIER: PriceTier = {
  maxPromptTokens: Infinity,
  input: 4,
  cacheWrite5m: 5,
  cacheWrite1h: 8,
  cacheRead: 0.4,
  output: 20,
};

export function isKnownModel(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** Usage as reported by the Messages API (all fields optional). */
export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export interface Cost {
  /** Every input token: uncached + cache writes + cache reads. */
  promptTokens: number;
  outputTokens: number;
  webSearches: number;
  usd: number;
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function tierFor(model: string, promptTokens: number): PriceTier {
  const tiers = PRICES[model];
  if (!tiers) return FALLBACK_TIER;
  return tiers.find((t) => promptTokens <= t.maxPromptTokens) || tiers[tiers.length - 1];
}

/** Round to the 6 decimals of chat_messages.cost_usd (numeric(10, 6)), rounding up. */
export function roundUsd(usd: number): number {
  if (!(usd > 0)) return 0;
  return Math.ceil(usd * 1e6 - 1e-6) / 1e6;
}

/** Cost in USD of one Messages API response. */
export function computeCost(model: string, usage: ApiUsage | null | undefined): Cost {
  const u = usage || {};
  const input = n(u.input_tokens);
  const cacheWrite = n(u.cache_creation_input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  const searches = n(u.server_tool_use?.web_search_requests);
  // Split cache writes by TTL when the breakdown is present; otherwise treat them as 5-minute writes
  // (the default TTL and the only one this function requests).
  const write1h = Math.min(cacheWrite, n(u.cache_creation?.ephemeral_1h_input_tokens));
  const write5m = cacheWrite - write1h;
  const promptTokens = input + cacheWrite + cacheRead;
  const t = tierFor(model, promptTokens);
  const tokensUsd =
    (input * t.input + write5m * t.cacheWrite5m + write1h * t.cacheWrite1h + cacheRead * t.cacheRead + output * t.output) / 1e6;
  return {
    promptTokens,
    outputTokens: output,
    webSearches: searches,
    usd: roundUsd(tokensUsd + searches * WEB_SEARCH_USD_PER_SEARCH),
  };
}

/** Rough token count for text we have not sent yet (about 3 characters per token, pessimistic). */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3);
}

/** Search results are billed as input tokens; assume this many per search (and per re-read). */
export const ASSUMED_TOKENS_PER_SEARCH = 15_000;

/**
 * Worst-case cost of one request, used to refuse a request that could overshoot the monthly budget.
 * Each search adds its result tokens, and the model re-reads the prompt after every search.
 */
export function estimateMaxCost(model: string, opts: { promptTokens: number; maxOutputTokens: number; maxSearches: number }): number {
  const searches = Math.max(0, opts.maxSearches);
  const t = tierFor(model, opts.promptTokens);
  let input = opts.promptTokens * (1 + searches);
  for (let i = 1; i <= searches; i++) input += ASSUMED_TOKENS_PER_SEARCH * (searches - i + 1);
  const usd = (input * t.input + opts.maxOutputTokens * t.output) / 1e6 + searches * WEB_SEARCH_USD_PER_SEARCH;
  return roundUsd(usd);
}
