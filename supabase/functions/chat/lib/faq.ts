// Parse and validate the FAQ draft returned by Claude.
import { FAQ_CATEGORIES, type Source } from './prompt.ts';

export interface FaqDraft {
  category: string;
  question_es: string;
  question_en: string;
  answer_es: string;
  answer_en: string;
  sources: Source[];
}

/** First JSON object in a text (tolerates code fences or stray text around it). */
export function extractJsonObject(text: string): unknown {
  const t = (text || '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Validate a draft. Sources are limited to URLs the conversation actually cited (no invented links);
 * if the model kept none, the thread's sources are used.
 */
export function parseFaqDraft(text: string, threadSources: Source[]): FaqDraft | null {
  const o = extractJsonObject(text) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const draft = {
    category: str(o.category, 40).toLowerCase(),
    question_es: str(o.question_es, 300),
    question_en: str(o.question_en, 300),
    answer_es: str(o.answer_es, 6000),
    answer_en: str(o.answer_en, 6000),
  };
  if (!draft.question_es || !draft.question_en || !draft.answer_es || !draft.answer_en) return null;
  if (!(FAQ_CATEGORIES as readonly string[]).includes(draft.category)) draft.category = 'general';
  const allowed = new Map(threadSources.map((s) => [s.url, s]));
  const picked: Source[] = [];
  if (Array.isArray(o.sources)) {
    for (const s of o.sources as Array<Record<string, unknown>>) {
      const url = typeof s?.url === 'string' ? s.url.trim() : '';
      const known = allowed.get(url);
      if (known && !picked.some((p) => p.url === url)) picked.push(known);
    }
  }
  return { ...draft, sources: picked.length ? picked : threadSources.slice(0, 5) };
}

/** Unique sources across a thread's assistant messages. */
export function threadSources(messages: Array<{ role: string; sources?: unknown }>): Source[] {
  const out: Source[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.sources)) continue;
    for (const s of m.sources as Array<Record<string, unknown>>) {
      if (typeof s?.url === 'string' && typeof s?.title === 'string' && !out.some((o) => o.url === s.url)) out.push({ title: s.title, url: s.url });
    }
  }
  return out;
}
