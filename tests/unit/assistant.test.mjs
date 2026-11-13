// Pure helpers of the assistant feature (src/features/assistant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../../src/features/assistant/sse.js';
import {
  visibleMessages,
  canDraftFaq,
  starterKeys,
  budgetLevel,
  cleanQuestion,
  validateDraft,
  faqRowFromDraft,
  normalizeError,
  pendingIsSaved,
  FAQ_DRAFT_TAG,
  RETRYABLE,
} from '../../src/features/assistant/logic.js';
import { FAQ_DRAFT_TAG as FN_TAG, FAQ_CATEGORIES as FN_CATEGORIES } from '../../supabase/functions/chat/lib/prompt.ts';
import { FAQ_CATEGORIES } from '../../src/features/assistant/logic.js';
import { MAX_QUESTION_CHARS as FN_MAX } from '../../supabase/functions/chat/lib/http.ts';
import { MAX_QUESTION_CHARS } from '../../src/features/assistant/logic.js';

test('app and function agree on shared constants', () => {
  assert.equal(FAQ_DRAFT_TAG, FN_TAG);
  assert.deepEqual(FAQ_CATEGORIES, [...FN_CATEGORIES]);
  assert.equal(MAX_QUESTION_CHARS, FN_MAX);
});

test('client SSE parser handles split chunks and CRLF', () => {
  const out = [];
  const p = createSseParser((e) => out.push(e));
  p.push('event: meta\r\ndata: {"thread_id":"t1"}\r\n\r\nevent: del');
  p.push('ta\ndata: {"text":"Ho"}\n\n');
  p.push('event: delta\ndata: {"text":"la"}\n\n: keep-alive\n\nevent: done\ndata: {}');
  p.end();
  assert.deepEqual(out.map((e) => e.event), ['meta', 'delta', 'delta', 'done']);
  assert.equal(JSON.parse(out[1].data).text + JSON.parse(out[2].data).text, 'Hola');
});

test('visible messages hide FAQ accounting rows and sort by time', () => {
  const rows = [
    { id: 'b', role: 'assistant', content: 'A', created_at: '2026-11-13T10:00:02Z' },
    { id: 'a', role: 'user', content: 'Q', created_at: '2026-11-13T10:00:01Z' },
    { id: 'c', role: 'assistant', content: `${FAQ_DRAFT_TAG}{}`, created_at: '2026-11-13T10:00:03Z' },
  ];
  assert.deepEqual(visibleMessages(rows).map((r) => r.id), ['a', 'b']);
  assert.equal(canDraftFaq(rows), true);
  assert.equal(canDraftFaq([rows[1], { ...rows[0], content: '' }]), false);
  assert.equal(canDraftFaq([rows[2]]), false);
});

test('starters depend on his age', () => {
  const young = starterKeys(7).map((s) => s.key);
  assert.deepEqual(young, ['assistant.starters.food', 'assistant.starters.potty', 'assistant.starters.outside', 'assistant.starters.biting']);
  assert.equal(starterKeys(7)[0].vars.weeks, 7);
  const older = starterKeys(22).map((s) => s.key);
  assert.ok(older.includes('assistant.starters.walks') && older.includes('assistant.starters.training'));
  assert.equal(starterKeys(-3)[0].vars.weeks, 0);
});

test('budget level', () => {
  assert.deepEqual(budgetLevel({ used_usd: 5, budget_usd: 25 }), { ratio: 0.2, level: 'ok' });
  assert.equal(budgetLevel({ used_usd: 21, budget_usd: 25 }).level, 'high');
  assert.equal(budgetLevel({ used_usd: 30, budget_usd: 25 }).ratio, 1);
  assert.equal(budgetLevel({ used_usd: 30, budget_usd: 25 }).level, 'out');
  assert.equal(budgetLevel({ used_usd: 0, budget_usd: 0 }).level, 'out');
  assert.equal(budgetLevel(null).level, 'out');
});

test('questions are trimmed and capped', () => {
  assert.equal(cleanQuestion('  hola  '), 'hola');
  assert.equal(cleanQuestion('   '), '');
  assert.equal(cleanQuestion('x'.repeat(2001)), '');
});

test('errors map to known codes; only transient ones are retryable', () => {
  assert.equal(normalizeError('daily_limit'), 'daily_limit');
  assert.equal(normalizeError('weird'), 'server_error');
  assert.equal(normalizeError('upstream_error', 'config'), 'upstream_config');
  assert.equal(normalizeError('upstream_error', 'busy'), 'upstream_busy');
  assert.equal(normalizeError('upstream_error', 'temporary'), 'upstream_error');
  assert.equal(normalizeError('daily_limit', 'config'), 'daily_limit');
  assert.equal(normalizeError(undefined), 'server_error');
  assert.ok(RETRYABLE.has('upstream_error') && !RETRYABLE.has('budget_exhausted'));
});

test('FAQ draft validation and row', () => {
  const d = { category: 'health', question_es: ' ¿Q? ', question_en: 'Q?', answer_es: 'R', answer_en: 'A', sources: [{ title: 'S', url: 'https://s.example' }, { title: 'bad', url: 'javascript:x' }] };
  assert.deepEqual(validateDraft(d), {});
  assert.deepEqual(Object.keys(validateDraft({ ...d, answer_en: ' ', category: 'x' })).sort(), ['answer_en', 'category']);
  const row = faqRowFromDraft(d, 't1');
  assert.equal(row.question_es, '¿Q?');
  assert.deepEqual(row.sources, [{ title: 'S', url: 'https://s.example' }]);
  assert.equal(row.source_thread_id, 't1');
  assert.equal('created_by' in row, false);
});

test('pendingIsSaved: the streaming bubble gives way to the saved answer, whichever signal comes first', () => {
  const q = { id: 'req-1', role: 'user', content: '¿Agua?', created_at: '2026-11-13T15:00:01.000Z' };
  const a = { id: 'ans-1', role: 'assistant', content: 'Siempre', created_at: '2026-11-13T15:00:02.000Z' };
  const older = { id: 'old-a', role: 'assistant', content: 'Antes', created_at: '2026-11-13T14:00:00.000Z' };
  assert.equal(pendingIsSaved(null, [q, a]), false);
  // 'done' handled and the thread reloaded.
  assert.equal(pendingIsSaved({ savedId: 'ans-1' }, [q, a]), true);
  assert.equal(pendingIsSaved({ savedId: 'ans-1' }, [older]), false);
  // A thread load that already holds the answer, before 'done' was handled.
  assert.equal(pendingIsSaved({ requestId: 'req-1' }, [older, q, a]), true);
  // The question alone (answer not saved yet) or another question's answer: keep streaming.
  assert.equal(pendingIsSaved({ requestId: 'req-1' }, [older, q]), false);
  assert.equal(pendingIsSaved({ requestId: 'req-2' }, [older, q, a]), false);
});
