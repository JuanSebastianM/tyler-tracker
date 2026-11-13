// Pure helpers for the assistant screens (no DOM, no I/O): unit-tested in tests/unit/assistant.test.mjs.

/** Marks the accounting row the function writes for an FAQ draft (see supabase/functions/chat/lib/prompt.ts). */
export const FAQ_DRAFT_TAG = '<!--faq-draft-->';

/** Same limit as the function (MAX_QUESTION_CHARS). */
export const MAX_QUESTION_CHARS = 2000;

/** FAQ categories, as in the function's schema and content/faq.json. */
export const FAQ_CATEGORIES = ['feeding', 'health', 'training', 'routine', 'behaviour', 'general'];

/** Error codes the function returns, plus client-side ones. */
export const ERROR_CODES = [
  'budget_exhausted',
  'daily_limit',
  'disabled',
  'not_editor',
  'upstream_error',
  'server_error',
  'unauthorized',
  'bad_request',
  'not_found',
  'network',
];

/** Codes where trying again can help. */
export const RETRYABLE = new Set(['upstream_error', 'server_error', 'network']);

/** Map any error string to a known code (unknown → server_error). @param {unknown} code */
export function normalizeError(code) {
  return typeof code === 'string' && ERROR_CODES.includes(code) ? code : 'server_error';
}

/**
 * Messages of one thread to show, oldest first: hides the FAQ accounting rows.
 * @param {any[]} rows rows of chat_messages
 * @returns {any[]}
 */
export function visibleMessages(rows) {
  return rows
    .filter((m) => !(m.role === 'assistant' && (m.content || '').startsWith(FAQ_DRAFT_TAG)))
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** True when a thread has at least one non-empty answer (it can be saved to the FAQ). @param {any[]} rows */
export function canDraftFaq(rows) {
  return visibleMessages(rows).some((m) => m.role === 'assistant' && (m.content || '').trim());
}

/**
 * Starter questions for his age in weeks: i18n keys + vars.
 * @param {number} weeks
 * @returns {Array<{ key: string, vars: Record<string, number> }>}
 */
export function starterKeys(weeks) {
  const w = Math.max(0, Math.floor(weeks || 0));
  const keys = [{ key: 'assistant.starters.food', vars: { weeks: w } }, { key: 'assistant.starters.potty', vars: { weeks: w } }];
  if (w < 16) keys.push({ key: 'assistant.starters.outside', vars: { weeks: w } });
  else keys.push({ key: 'assistant.starters.walks', vars: { weeks: w } });
  keys.push({ key: w < 20 ? 'assistant.starters.biting' : 'assistant.starters.training', vars: { weeks: w } });
  return keys;
}

/**
 * Budget numbers for the indicator.
 * @param {{ used_usd: number, budget_usd: number } | null | undefined} budget
 */
export function budgetLevel(budget) {
  if (!budget || !(budget.budget_usd > 0)) return { ratio: 1, level: 'out' };
  const ratio = Math.min(1, Math.max(0, budget.used_usd / budget.budget_usd));
  return { ratio, level: ratio >= 1 ? 'out' : ratio >= 0.8 ? 'high' : 'ok' };
}

/** Text for a question to send, or '' when it is not sendable. @param {string} text */
export function cleanQuestion(text) {
  const q = (text || '').trim();
  return q.length > MAX_QUESTION_CHARS ? '' : q;
}

/**
 * Validate an edited FAQ draft before saving. Returns error keys per field (empty when valid).
 * @param {{ category: string, question_es: string, question_en: string, answer_es: string, answer_en: string }} d
 */
export function validateDraft(d) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const f of ['question_es', 'question_en', 'answer_es', 'answer_en']) {
    if (!(/** @type {any} */ (d)[f] || '').trim()) errors[f] = 'errors.required';
  }
  if (!FAQ_CATEGORIES.includes(d.category)) errors.category = 'errors.required';
  return errors;
}

/**
 * Row for faq_entries from a confirmed draft.
 * @param {any} d @param {string | null} threadId
 */
export function faqRowFromDraft(d, threadId) {
  return {
    category: d.category,
    question_es: d.question_es.trim(),
    question_en: d.question_en.trim(),
    answer_es: d.answer_es.trim(),
    answer_en: d.answer_en.trim(),
    sources: (d.sources || []).filter((/** @type {any} */ s) => s && typeof s.url === 'string' && /^https:\/\//.test(s.url)),
    source_thread_id: threadId,
  };
}
