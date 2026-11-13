// Pure modules of the `chat` Edge Function (TypeScript, run by Node's built-in type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, estimateMaxCost, roundUsd, tierFor, FALLBACK_TIER } from '../../supabase/functions/chat/lib/pricing.ts';
import { checkLimits, budgetInfo, sumCosts } from '../../supabase/functions/chat/lib/limits.ts';
import { periodStarts, ageOn } from '../../supabase/functions/chat/lib/dates.ts';
import { buildContext } from '../../supabase/functions/chat/lib/context.ts';
import {
  buildChatRequest,
  buildFaqRequest,
  selectHistory,
  appendQuestion,
  makeThreadTitle,
  FAQ_DRAFT_TAG,
  MAX_HISTORY_MESSAGES,
  SYSTEM_INSTRUCTIONS,
} from '../../supabase/functions/chat/lib/prompt.ts';
import { createSseParser, createClaudeAccumulator, formatSse, sourcesFromCitations } from '../../supabase/functions/chat/lib/sse.ts';
import { parseFaqDraft, threadSources, extractJsonObject } from '../../supabase/functions/chat/lib/faq.ts';
import { corsHeaders, isAllowedOrigin, parseRequest, bearerToken } from '../../supabase/functions/chat/lib/http.ts';
import { pickKey } from '../../supabase/functions/chat/lib/rest.ts';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ---------------------------------------------------------------------------
test('Sonnet 5.5 cost: input, cache write/read, output and web searches', () => {
  const c = computeCost('claude-sonnet-5-5', {
    input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 10_000,
    output_tokens: 500,
    server_tool_use: { web_search_requests: 2 },
  });
  // 1000*2 + 2000*2.5 + 10000*0.1 + 500*10 = 2000 + 5000 + 1000 + 5000 = 13000 / 1e6 = 0.013 + 0.02
  close(c.usd, 0.033);
  assert.equal(c.promptTokens, 13_000);
  assert.equal(c.outputTokens, 500);
  assert.equal(c.webSearches, 2);
});

test('1-hour cache writes use their own price when broken down', () => {
  const c = computeCost('claude-sonnet-5-5', {
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 500_000, ephemeral_1h_input_tokens: 500_000 },
  });
  close(c.usd, 0.5 * 2.5 + 0.5 * 4);
});

test('Haiku 5.5 switches tier above 100k prompt tokens', () => {
  close(computeCost('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1000 }).usd, 0.01 + 0.0005);
  // 100,001 prompt tokens (incl. cache reads): the whole request at the higher tier
  const c = computeCost('claude-haiku-5-5', { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 1000 });
  close(c.usd, roundUsd((1 * 0.5 + 100_000 * 0.05 + 1000 * 2.5) / 1e6));
});

test('unknown model is priced pessimistically, missing usage costs 0', () => {
  assert.equal(tierFor('claude-new-9', 10), FALLBACK_TIER);
  assert.equal(computeCost('claude-sonnet-5-5', null).usd, 0);
  assert.equal(computeCost('claude-sonnet-5-5', { input_tokens: -5, output_tokens: null }).usd, 0);
});

test('cost rounds up to 6 decimals', () => {
  assert.equal(roundUsd(0.0000011), 0.000002);
  assert.equal(roundUsd(0.000001), 0.000001);
  assert.equal(computeCost('claude-haiku-5-5', { input_tokens: 1 }).usd, 0.000001);
});

test('max cost estimate grows with searches', () => {
  const none = estimateMaxCost('claude-sonnet-5-5', { promptTokens: 3000, maxOutputTokens: 1200, maxSearches: 0 });
  close(none, (3000 * 2.5 + 1200 * 10) / 1e6); // prompt at the cache-write price
  const two = estimateMaxCost('claude-sonnet-5-5', { promptTokens: 3000, maxOutputTokens: 1200, maxSearches: 2 });
  assert.ok(two > none + 0.02);
});

// ---------------------------------------------------------------------------
const settings = {
  enabled: true,
  model: 'claude-sonnet-5-5',
  monthly_budget_usd: '25.00',
  daily_message_limit: 40,
  web_search_enabled: true,
  max_searches_per_message: 2,
  max_output_tokens: 1200,
};

test('limits: disabled, budget, estimate overshoot, daily limit', () => {
  const base = { settings, monthSpendUsd: 1, todayUserMessages: 0, estimatedCostUsd: 0.05, countsAsMessage: true };
  assert.equal(checkLimits(base), null);
  assert.equal(checkLimits({ ...base, settings: { ...settings, enabled: false } }), 'disabled');
  assert.equal(checkLimits({ ...base, monthSpendUsd: 25 }), 'budget_exhausted');
  assert.equal(checkLimits({ ...base, monthSpendUsd: 24.99 }), 'budget_exhausted'); // estimate does not fit
  assert.equal(checkLimits({ ...base, settings: { ...settings, monthly_budget_usd: 0 } }), 'budget_exhausted');
  assert.equal(checkLimits({ ...base, todayUserMessages: 40 }), 'daily_limit');
  assert.equal(checkLimits({ ...base, todayUserMessages: 40, countsAsMessage: false }), null);
  assert.equal(checkLimits({ ...base, settings: null }), 'disabled');
});

test('budget info and sums of numeric strings', () => {
  assert.equal(sumCosts([{ cost_usd: '0.010000' }, { cost_usd: 0.02 }, { cost_usd: null }]), 0.03);
  assert.deepEqual(budgetInfo(settings, 3.5), { used_usd: 3.5, budget_usd: 25, remaining_usd: 21.5 });
  assert.deepEqual(budgetInfo(settings, 30), { used_usd: 30, budget_usd: 25, remaining_usd: 0 });
});

test('day and month start in Bogota, not UTC', () => {
  // 2026-12-01 03:00 UTC is still 2026-11-30 22:00 in Bogota
  const r = periodStarts(new Date('2026-12-01T03:00:00Z'), 'America/Bogota');
  assert.equal(r.today, '2026-11-30');
  assert.equal(r.dayStart, '2026-11-30T05:00:00.000Z');
  assert.equal(r.monthStart, '2026-11-01T05:00:00.000Z');
});

test('age on a date', () => {
  assert.deepEqual(ageOn('2026-09-25', '2026-11-13'), { totalDays: 49, weeks: 7, days: 0, months: 1 });
});

// ---------------------------------------------------------------------------
const NOW = new Date('2026-11-13T15:30:00Z'); // 10:30 in Bogota
const contextData = () => ({
  profile: { name: 'Tyler', full_name: 'Tyler Test', breed: 'Golden Retriever', sex: 'male', birth_date: '2026-09-25', home_date: '2026-11-10', food: 'Puppy food A', about: null },
  settings: { timezone: 'America/Bogota', meal_slots: [{ slot: 2, time: '11:00', grams: null }, { slot: 1, time: '07:00', grams: 80 }], meal_amount_note: null },
  vaccinations: [{ vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29' }],
  dewormings: [{ product: 'Dewormer X', kind: 'internal', given_on: '2026-11-01', next_due_on: '2026-11-10' }],
  weights: [{ measured_on: '2026-11-08', weight_kg: '4.60' }],
  vetVisits: [],
  medications: [
    { name: 'Old med', frequency: null, start_on: '2026-10-01', end_on: '2026-10-05' },
    { name: 'Probiotic', frequency: 'daily', start_on: '2026-11-10', end_on: null },
  ],
  feedings: [
    { fed_at: '2026-11-13T12:05:00Z', meal_slot: 1, amount_g: 80, appetite: 'all' },
    { fed_at: '2026-11-12T23:58:00Z', meal_slot: 4, amount_g: null, appetite: 'most' },
  ],
  routineEvents: [
    { type: 'pee', started_at: '2026-11-13T12:20:00Z', ended_at: null, location: 'outside', accident: false },
    { type: 'pee', started_at: '2026-11-13T13:20:00Z', ended_at: null, location: 'inside', accident: true },
    { type: 'sleep', started_at: '2026-11-13T13:00:00Z', ended_at: '2026-11-13T14:30:00Z', location: null, accident: false },
  ],
  trainingSkills: [{ skill_key: 'sit', status: 'learning' }, { skill_key: 'come', status: 'not_started' }],
  reminders: [{ title: 'Buy food', due_on: '2026-11-20', done_at: null }],
});

test('context: exact age, schedule, due dates, today and yesterday, compact', () => {
  const c = buildContext(contextData(), NOW, 'Testville, Test Region, Colombia (warm)');
  assert.match(c, /2026-11-13 10:30, America\/Bogota/);
  assert.match(c, /7 weeks and 0 days \(49 days, 1 full month\)/);
  assert.match(c, /Location: Testville, Test Region, Colombia \(warm\)\./);
  assert.doesNotMatch(buildContext(contextData(), NOW), /Location:/); // null location: no line
  assert.match(c, /Meal plan: 2 meals at 07:00 \(80 g\), 11:00/);
  assert.match(c, /Puppy DP on 2026-11-08, next due 2026-11-29/);
  assert.match(c, /Dewormer X \(internal\) on 2026-11-01, next was due 2026-11-10 \(OVERDUE\)/);
  assert.match(c, /4\.6 kg on 2026-11-08/);
  assert.match(c, /Active medications: Probiotic \(daily\)/);
  assert.doesNotMatch(c, /Old med/);
  assert.match(c, /Today so far \(2026-11-13\): meals 1\/2: 07:05 80 g \(ate all\); pee 2 \(1 outside, 1 accidents\); poop 0; sleep logged 1\.5 h/);
  assert.match(c, /Yesterday \(2026-11-12\): meals 1\/2: 18:58 \(ate most\)/);
  assert.match(c, /Training: sit learning\./);
  assert.match(c, /Buy food on 2026-11-20/);
  assert.ok(c.length < 4800, `context too long: ${c.length} chars`);
});

test('context: missing data is stated, long text is clipped', () => {
  const d = { ...contextData(), profile: null, vaccinations: [], weights: [], feedings: [], routineEvents: [], trainingSkills: [] };
  const c = buildContext(d, NOW);
  assert.match(c, /Profile: not recorded/);
  assert.match(c, /Vaccines: none recorded/);
  assert.match(c, /meals 0\/2: none logged/);
  const big = { ...contextData(), vetVisits: Array.from({ length: 10 }, (_, i) => ({ visited_on: `2026-11-0${i % 9 + 1}`, reason: 'x'.repeat(500), findings: 'y'.repeat(500), treatment: null, follow_up_on: null })) };
  assert.ok(buildContext(big, NOW).length < 4800);
});

// ---------------------------------------------------------------------------
test('history: last N, skips FAQ rows and empty answers, alternates, starts with user', () => {
  const msgs = [
    { role: 'assistant', content: 'orphan' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: `${FAQ_DRAFT_TAG}{}` },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'q3' },
  ];
  const h = selectHistory(msgs);
  assert.deepEqual(h, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2\n\nq3' },
  ]);
  assert.deepEqual(appendQuestion(h, 'q4').at(-1), { role: 'user', content: 'q2\n\nq3\n\nq4' });
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  assert.ok(selectHistory(many).length <= MAX_HISTORY_MESSAGES);
});

test('chat request: cached system blocks, output cap, web search only when enabled', () => {
  const o = { model: 'claude-sonnet-5-5', maxOutputTokens: 1200, context: 'CTX', history: [], question: '¿Hola?', webSearch: { enabled: true, maxUses: 2 }, timezone: 'America/Bogota' };
  const r = buildChatRequest(o);
  assert.equal(r.max_tokens, 1200);
  assert.equal(r.stream, true);
  assert.equal(r.system[0].text, SYSTEM_INSTRUCTIONS);
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(r.system[1].text, 'CTX');
  assert.deepEqual(r.messages, [{ role: 'user', content: '¿Hola?' }]);
  assert.equal(r.tools[0].type, 'web_search_20250305');
  assert.equal(r.tools[0].max_uses, 2);
  assert.equal(r.tools[0].user_location.country, 'CO');
  assert.equal('temperature' in r, false);
  assert.equal(buildChatRequest({ ...o, webSearch: { enabled: false, maxUses: 2 } }).tools, undefined);
  assert.equal(buildChatRequest({ ...o, webSearch: { enabled: true, maxUses: 0 } }).tools, undefined);
});

test('system prompt covers the safety rules', () => {
  assert.match(SYSTEM_INSTRUCTIONS, /not a veterinarian/);
  assert.match(SYSTEM_INSTRUCTIONS, /Never give doses/);
  assert.match(SYSTEM_INSTRUCTIONS, /Spanish/);
  assert.match(SYSTEM_INSTRUCTIONS, /cannot change the app/);
  assert.match(SYSTEM_INSTRUCTIONS, /web search only when/i);
});

test('FAQ request uses structured output and a bounded token budget', () => {
  const r = buildFaqRequest({ model: 'claude-haiku-5-5', maxOutputTokens: 1200, transcript: 'T' });
  assert.equal(r.max_tokens, 2400);
  assert.equal(r.output_config.format.type, 'json_schema');
  assert.equal(r.stream, undefined);
  assert.equal(buildFaqRequest({ model: 'x', maxOutputTokens: 4000, transcript: 'T' }).max_tokens, 4000);
});

test('thread titles are short and cut on a word', () => {
  assert.equal(makeThreadTitle('  ¿Cuánto   come? '), '¿Cuánto come?');
  const t = makeThreadTitle('¿Cuántas veces al día debe comer un cachorro Golden Retriever de siete semanas de edad?');
  assert.ok(t.length <= 61 && t.endsWith('…'), t);
  assert.doesNotMatch(t, /\s…$/);
});

// ---------------------------------------------------------------------------
test('SSE parser: chunk boundaries, CRLF, multi-line data, comments', () => {
  const out = [];
  const p = createSseParser((e) => out.push(e));
  p.push('event: a\r\nda');
  p.push('ta: {"x":1}\r');
  p.push('\n\r\n: comment\n\nevent: b\ndata: line1\ndata: line2\n');
  p.push('\n');
  p.push('data: tail');
  p.end();
  assert.deepEqual(out, [
    { event: 'a', data: '{"x":1}' },
    { event: 'b', data: 'line1\nline2' },
    { event: 'message', data: 'tail' },
  ]);
  assert.equal(formatSse('delta', { text: 'hi' }), 'event: delta\ndata: {"text":"hi"}\n\n');
});

/** A realistic Claude stream with a web search and a citation. */
const claudeStream = [
  ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 900, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"parvo' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' vaccine"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'A' }] } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['ping', { type: 'ping' }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Sí, ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.org/a', title: 'A', cited_text: '...' } } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.org/a', title: 'A again' } } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'pronto.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9000, cache_read_input_tokens: 1200, output_tokens: 60, server_tool_use: { web_search_requests: 1 } } }],
  ['message_stop', { type: 'message_stop' }],
];

test('accumulator: text, search status, deduped citations, cumulative usage', () => {
  const acc = createClaudeAccumulator();
  const updates = [];
  const p = createSseParser((e) => updates.push(...acc.apply(e)));
  const raw = claudeStream.map(([ev, d]) => formatSse(ev, d)).join('');
  for (let i = 0; i < raw.length; i += 37) p.push(raw.slice(i, i + 37));
  p.end();
  assert.equal(acc.text, 'Sí, pronto.');
  assert.deepEqual(acc.sources, [{ title: 'A', url: 'https://example.org/a' }]);
  assert.equal(acc.stopReason, 'end_turn');
  assert.equal(acc.complete, true);
  assert.equal(acc.usage.input_tokens, 9000);
  assert.equal(acc.usage.output_tokens, 60);
  assert.equal(acc.usage.server_tool_use.web_search_requests, 1);
  assert.deepEqual(updates, [
    { type: 'searching' },
    { type: 'searching', query: 'parvo vaccine' },
    { type: 'text', text: 'Sí, ' },
    { type: 'text', text: 'pronto.' },
  ]);
});

test('accumulator: error events and incomplete streams are not complete', () => {
  const acc = createClaudeAccumulator();
  acc.apply({ event: 'message_start', data: JSON.stringify(claudeStream[0][1]) });
  acc.apply({ event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
  assert.deepEqual(acc.error, { type: 'overloaded_error', message: 'Overloaded' });
  assert.equal(acc.complete, false);
  const partial = createClaudeAccumulator();
  partial.apply({ event: 'content_block_start', data: JSON.stringify(claudeStream[1][1]) });
  partial.apply({ event: 'bogus', data: 'not json' });
  assert.equal(partial.complete, false);
  assert.equal(partial.usage.server_tool_use.web_search_requests, 1); // counted from blocks when usage is missing
});

test('sources: https only, deduped, capped', () => {
  const s = sourcesFromCitations([
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'http://insecure.example', title: 'x' },
    { url: 'https://a.example/x', title: '' },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://s${i}.example`, title: `S${i}` })),
  ]);
  assert.equal(s[0].title, 'a.example');
  assert.equal(s.length, 8);
});

// ---------------------------------------------------------------------------
test('FAQ draft parsing keeps only sources from the thread', () => {
  const thread = [{ role: 'assistant', sources: [{ title: 'AKC', url: 'https://akc.example/a' }] }, { role: 'user', sources: [] }];
  const known = threadSources(thread);
  const text = JSON.stringify({
    category: 'Feeding',
    question_es: '¿Cuánto come?',
    question_en: 'How much does he eat?',
    answer_es: 'Poco.',
    answer_en: 'A little.',
    sources: [{ title: 'Made up', url: 'https://invented.example' }, { title: 'AKC', url: 'https://akc.example/a' }],
  });
  const d = parseFaqDraft(text, known);
  assert.equal(d.category, 'feeding');
  assert.deepEqual(d.sources, [{ title: 'AKC', url: 'https://akc.example/a' }]);
  assert.equal(parseFaqDraft('```json\n' + text.replace('Feeding', 'weird') + '\n```', known).category, 'general');
  assert.equal(parseFaqDraft('{"question_es":"x"}', known), null);
  assert.equal(parseFaqDraft('nope', known), null);
  assert.equal(extractJsonObject('a {"b":1} c').b, 1);
});

// ---------------------------------------------------------------------------
test('CORS allowlist and request validation', () => {
  assert.ok(isAllowedOrigin('https://juansebastianm.github.io'));
  assert.ok(isAllowedOrigin('http://127.0.0.1:5173'));
  assert.ok(isAllowedOrigin('http://localhost'));
  assert.ok(!isAllowedOrigin('https://evil.example'));
  assert.ok(!isAllowedOrigin('https://juansebastianm.github.io.evil.example'));
  assert.ok(!isAllowedOrigin(null));
  assert.equal(corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders('http://localhost:4187')['Access-Control-Allow-Origin'], 'http://localhost:4187');

  assert.deepEqual(parseRequest({ action: 'send', message: '  hola ' }), { action: 'send', threadId: null, message: 'hola' });
  assert.equal(parseRequest({ action: 'send', message: '   ' }), null);
  assert.equal(parseRequest({ action: 'send', message: 'x'.repeat(2001) }), null);
  assert.equal(parseRequest({ action: 'send', message: 'hi', thread_id: 'nope' }), null);
  assert.equal(parseRequest({ action: 'draft_faq' }), null);
  assert.deepEqual(parseRequest({ action: 'status' }), { action: 'status' });
  assert.equal(parseRequest({ action: 'delete_everything' }), null);
  assert.equal(parseRequest(null), null);
  assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(bearerToken('Basic x'), null);
});

test('API keys from the JSON dictionaries or the legacy variables', () => {
  assert.equal(pickKey('{"default":"sb_secret_x"}', 'legacy'), 'sb_secret_x');
  assert.equal(pickKey('{"other":"k2"}', undefined), 'k2');
  assert.equal(pickKey('not json', 'legacy'), 'legacy');
  assert.equal(pickKey(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// Review fixes: spend reservations, body cap, upstream reasons, location from settings.
import { checkReserved, reservationRow, reserve, release, settle, pendingSends, RESERVATION_PREFIX } from '../../supabase/functions/chat/lib/budget.ts';
import { readBodyText, upstreamReason, MAX_BODY_BYTES } from '../../supabase/functions/chat/lib/http.ts';
import { searchLocation, selectHistory as selectHistory2, isFaqDraftRow } from '../../supabase/functions/chat/lib/prompt.ts';

/** In-memory ai_usage table behind the Rest interface. */
function fakeLedger() {
  const rows = [];
  let n = 0;
  const idOf = (q) => decodeURIComponent(/id=eq\.([^&]+)/.exec(q)[1]);
  return {
    rows,
    async select(_table, q) {
      const model = /model=eq\.([^&]+)/.exec(q);
      const by = /created_by=eq\.([^&]+)/.exec(q);
      return rows.filter((r) => (!model || r.model === decodeURIComponent(model[1])) && (!by || r.created_by === decodeURIComponent(by[1])));
    },
    async insert(_table, row) {
      const r = { id: `r${++n}`, ...row };
      rows.push(r);
      return r;
    },
    async patch(_table, q, body) {
      Object.assign(rows.find((r) => r.id === idOf(q)), body);
    },
    async remove(_table, q) {
      const i = rows.findIndex((r) => r.id === idOf(q));
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

test('reservations: parallel requests cannot both pass over the budget', async () => {
  const s = { ...settings, monthly_budget_usd: '1.00' };
  const svc = fakeLedger();
  svc.rows.push({ id: 'spent', model: 'claude-sonnet-5-5', cost_usd: 0.5 });
  const owner = { editorId: 'u1', editorName: 'Ed', threadId: null };
  // Both pass the pre-check (0.5 + 0.3 <= 1), both reserve before either re-reads.
  const a = await reserve(svc, 'send', 0.3, owner);
  const b = await reserve(svc, 'send', 0.3, owner);
  const spend = svc.rows.reduce((x, r) => x + r.cost_usd, 0);
  assert.equal(checkReserved({ settings: s, monthSpendUsd: spend, todayUserMessages: 2, countsAsMessage: true }), 'budget_exhausted');
  await release(svc, b);
  const spendA = svc.rows.reduce((x, r) => x + r.cost_usd, 0);
  assert.equal(checkReserved({ settings: s, monthSpendUsd: spendA, todayUserMessages: 1, countsAsMessage: true }), null);
  assert.equal(await pendingSends(svc, 'u1', '2026-11-01T05:00:00Z'), 1);
  // Billed but not saved: the reservation becomes the real charge, no longer a pending send.
  await settle(svc, a, 0.12, 'claude-sonnet-5-5', { input: 100, output: 50, searches: 0 });
  assert.equal(svc.rows.find((r) => r.id === a).cost_usd, 0.12);
  assert.equal(await pendingSends(svc, 'u1', '2026-11-01T05:00:00Z'), 0);
});

test('reservations: row shape and the daily limit counts pending sends', () => {
  const row = reservationRow('faq', 0.0123456, { editorId: 'u1', editorName: 'Ed', threadId: 't1' });
  assert.equal(row.model, `${RESERVATION_PREFIX}faq`);
  assert.equal(row.cost_usd, 0.012346);
  assert.equal(row.created_by, 'u1');
  assert.equal(checkReserved({ settings, monthSpendUsd: 1, todayUserMessages: 40, countsAsMessage: true }), null); // 40th incl. this one
  assert.equal(checkReserved({ settings, monthSpendUsd: 1, todayUserMessages: 41, countsAsMessage: true }), 'daily_limit');
  assert.equal(checkReserved({ settings, monthSpendUsd: 1, todayUserMessages: 41, countsAsMessage: false }), null);
  assert.equal(checkReserved({ settings: { ...settings, enabled: false }, monthSpendUsd: 0, todayUserMessages: 0, countsAsMessage: true }), 'disabled');
});

test('request bodies over the cap are rejected before parsing', async () => {
  const ok = new Request('https://x.test/', { method: 'POST', body: JSON.stringify({ action: 'status' }) });
  assert.equal(await readBodyText(ok), '{"action":"status"}');
  const big = new Request('https://x.test/', { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  assert.equal(await readBodyText(big), null);
  const lying = new Request('https://x.test/', { method: 'POST', body: 'x', headers: { 'Content-Length': String(10 * MAX_BODY_BYTES) } });
  assert.equal(await readBodyText(lying), null);
});

test('upstream failures say whether retrying can help', () => {
  assert.equal(upstreamReason(401, 'authentication_error'), 'config');
  assert.equal(upstreamReason(403, ''), 'config');
  assert.equal(upstreamReason(400, 'invalid_request_error'), 'config');
  assert.equal(upstreamReason(429, 'rate_limit_error'), 'busy');
  assert.equal(upstreamReason(529, ''), 'busy');
  assert.equal(upstreamReason(0, 'overloaded_error'), 'busy');
  assert.equal(upstreamReason(500, 'api_error'), 'temporary');
});

test('web search location comes from settings, never from source', () => {
  assert.deepEqual(searchLocation(null, 'America/Bogota'), { type: 'approximate', country: 'CO', timezone: 'America/Bogota' });
  assert.deepEqual(searchLocation('Testville, Test Region, Colombia (1,500 m, warm)', 'America/Bogota'), {
    type: 'approximate',
    country: 'CO',
    timezone: 'America/Bogota',
    city: 'Testville',
    region: 'Test Region',
  });
  const r = buildChatRequest({ model: 'claude-sonnet-5-5', maxOutputTokens: 1200, context: 'C', history: [], question: 'q', webSearch: { enabled: true, maxUses: 1 }, timezone: 'America/Bogota' });
  assert.equal(r.tools[0].user_location.city, undefined);
});

test('a question that starts with the FAQ tag is not hidden from the history', () => {
  assert.equal(isFaqDraftRow({ role: 'user', content: `${FAQ_DRAFT_TAG}hi` }), false);
  assert.equal(isFaqDraftRow({ role: 'assistant', content: `${FAQ_DRAFT_TAG}{}` }), true);
  assert.deepEqual(selectHistory2([{ role: 'user', content: `${FAQ_DRAFT_TAG}hi` }]), [{ role: 'user', content: `${FAQ_DRAFT_TAG}hi` }]);
});
