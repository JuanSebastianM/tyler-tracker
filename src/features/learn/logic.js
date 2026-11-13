// Pure helpers for the Learn feature (no DOM, no I/O) so they are easy to unit test.

/**
 * @typedef {{ es?: string, en?: string } | string} Bilingual
 * @typedef {'es' | 'en'} Locale
 * @typedef {'must-know' | 'roadmap' | 'training' | 'health' | 'parents' | 'faq' | 'facts'} SectionId
 */

/**
 * Sections of the Learn tab, in display order. `file` is the /content file; `health` adds the
 * vet disclaimer to its articles.
 * @type {Array<{ id: SectionId, file: 'must-know' | 'roadmap' | 'training' | 'health' | 'parents' | 'faq' | 'facts', icon: string, tone: 'gold' | 'green' | 'red' | 'blue' | 'neutral', health: boolean }>}
 */
export const SECTIONS = [
  { id: 'must-know', file: 'must-know', icon: 'star', tone: 'gold', health: true },
  { id: 'roadmap', file: 'roadmap', icon: 'calendar', tone: 'green', health: true },
  { id: 'training', file: 'training', icon: 'grad-cap', tone: 'blue', health: true },
  { id: 'health', file: 'health', icon: 'stethoscope', tone: 'red', health: true },
  { id: 'parents', file: 'parents', icon: 'heart', tone: 'gold', health: false },
  { id: 'faq', file: 'faq', icon: 'question', tone: 'blue', health: false },
  { id: 'facts', file: 'facts', icon: 'sparkle', tone: 'green', health: false },
];

/** @param {string} id */
export const sectionById = (id) => SECTIONS.find((s) => s.id === id) || null;

/** Pick a locale from a bilingual field (Spanish fallback). @param {Bilingual | null | undefined} field @param {Locale} locale */
export function pickIn(field, locale) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  return field[locale] ?? field.es ?? Object.values(field)[0] ?? '';
}

// ---------------------------------------------------------------------------
// Must-know
// ---------------------------------------------------------------------------

export const PRIORITIES = /** @type {const} */ (['critical', 'important', 'good-to-know']);

/**
 * Must-know items ordered by priority (critical first), keeping file order within a priority.
 * Unknown priorities go last.
 * @template {{ priority?: string }} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function sortByPriority(items) {
  const rank = (/** @type {any} */ p) => {
    const i = PRIORITIES.indexOf(p);
    return i === -1 ? PRIORITIES.length : i;
  };
  return (items || [])
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.priority) - rank(b.item.priority) || a.i - b.i)
    .map((x) => x.item);
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

/**
 * @template {{ from_weeks: number }} S
 * @param {S[]} stages
 * @returns {S[]}
 */
export function sortStages(stages) {
  return [...(stages || [])].sort((a, b) => a.from_weeks - b.from_weeks);
}

/**
 * Where a stage sits relative to the current one.
 * @param {{ from_weeks: number }} stage
 * @param {{ from_weeks: number } | null} current
 * @returns {'past' | 'current' | 'future'}
 */
export function stageTiming(stage, current) {
  if (!current) return 'future';
  if (stage.from_weeks === current.from_weeks) return 'current';
  return stage.from_weeks < current.from_weeks ? 'past' : 'future';
}

/**
 * To-do progress for a stage.
 * @param {{ todos?: Array<{ key: string }> }} stage
 * @param {Set<string>} doneKeys
 */
export function stageProgress(stage, doneKeys) {
  const todos = stage?.todos || [];
  const done = todos.filter((td) => doneKeys.has(td.key)).length;
  return { done, total: todos.length, complete: todos.length > 0 && done === todos.length };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export const TRAINING_STATUSES = /** @type {const} */ (['not_started', 'learning', 'reliable', 'mastered']);
/** @typedef {typeof TRAINING_STATUSES[number]} TrainingStatus */

/** @type {Record<TrainingStatus, 'neutral' | 'blue' | 'gold' | 'green'>} */
export const STATUS_TONE = { not_started: 'neutral', learning: 'blue', reliable: 'gold', mastered: 'green' };

/** @param {any} s @returns {TrainingStatus} */
export const normalizeStatus = (s) => (TRAINING_STATUSES.includes(s) ? s : 'not_started');

/**
 * Form values after the status changes, filling dates sensibly:
 * - not started: no dates
 * - learning / reliable: started on (kept, or today); not mastered
 * - mastered: started on (kept, or today) and mastered on (kept, or today)
 * @param {{ started_on?: string | null, mastered_on?: string | null }} prev
 * @param {TrainingStatus} status
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ status: TrainingStatus, started_on: string | null, mastered_on: string | null }}
 */
export function applyStatus(prev, status, today) {
  const started = prev?.started_on || null;
  const mastered = prev?.mastered_on || null;
  if (status === 'not_started') return { status, started_on: null, mastered_on: null };
  if (status === 'mastered') {
    const m = mastered || today;
    const s = started && started <= m ? started : m;
    return { status, started_on: s, mastered_on: m };
  }
  return { status, started_on: started || today, mastered_on: null };
}

/**
 * Validate a training form before saving. Returns an i18n key (under learn.training.errors) or null.
 * @param {{ status: TrainingStatus, started_on: string | null, mastered_on: string | null }} v
 * @param {string} today
 */
export function trainingFormError(v, today) {
  if (v.started_on && v.started_on > today) return 'futureDate';
  if (v.mastered_on && v.mastered_on > today) return 'futureDate';
  if (v.started_on && v.mastered_on && v.mastered_on < v.started_on) return 'masteredBeforeStarted';
  return null;
}

/**
 * Overall training progress. Each guide counts 0 / 1 / 2 / 3 points by status.
 * @param {Array<{ id: string }>} guides
 * @param {Array<{ skill_key: string, status: string }>} rows
 */
export function trainingOverview(guides, rows) {
  const byKey = new Map((rows || []).map((r) => [r.skill_key, normalizeStatus(r.status)]));
  /** @type {Record<TrainingStatus, number>} */
  const counts = { not_started: 0, learning: 0, reliable: 0, mastered: 0 };
  let points = 0;
  for (const g of guides || []) {
    const s = byKey.get(g.id) || 'not_started';
    counts[s]++;
    points += TRAINING_STATUSES.indexOf(s);
  }
  const total = (guides || []).length;
  return { total, counts, percent: total ? Math.round((points / (total * 3)) * 100) : 0 };
}

/** @param {{ min_age_weeks?: number }} guide @param {number} ageWeeks */
export const isOldEnough = (guide, ageWeeks) => ageWeeks >= (guide?.min_age_weeks ?? 0);

export const DIFFICULTIES = /** @type {const} */ (['easy', 'medium', 'hard']);

/**
 * Guides ordered by recommended age, then difficulty, keeping file order otherwise.
 * @template {{ min_age_weeks?: number, difficulty?: string }} T
 * @param {T[]} guides
 * @returns {T[]}
 */
export function sortGuides(guides) {
  const d = (/** @type {any} */ x) => {
    const i = DIFFICULTIES.indexOf(x);
    return i === -1 ? DIFFICULTIES.length : i;
  };
  return (guides || [])
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.min_age_weeks ?? 0) - (b.g.min_age_weeks ?? 0) || d(a.g.difficulty) - d(b.g.difficulty) || a.i - b.i)
    .map((x) => x.g);
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FaqItem
 * @property {string} id            route id: file id, or 'saved-<uuid>' for faq_entries rows
 * @property {'file' | 'saved'} origin
 * @property {string | null} rowId  faq_entries.id for saved entries
 * @property {string | null} category
 * @property {{ es: string, en: string }} question
 * @property {{ es: string, en: string }} answer
 * @property {Array<{ title: string, url: string }>} sources
 * @property {string | null} reviewedOn
 * @property {string} addedOn       'YYYY-MM-DD'
 * @property {string} sortKey       '<date>|<0 file | 1 saved + instant>', sorted descending
 * @property {string | null} addedBy
 * @property {boolean} sample
 */

export const SAVED_PREFIX = 'saved-';

/**
 * Merge content/faq.json entries and faq_entries rows into one list, newest first.
 * @param {any[]} fileItems
 * @param {any[]} rows
 * @param {(instant: string) => string} toDate converts an instant to 'YYYY-MM-DD' in the settings timezone
 * @returns {FaqItem[]}
 */
export function mergeFaq(fileItems, rows, toDate) {
  /** @type {FaqItem[]} */
  const out = [];
  for (const f of fileItems || []) {
    const added = f.added_on || f.reviewed_on || '';
    out.push({
      id: f.id,
      origin: 'file',
      rowId: null,
      category: f.category || null,
      question: { es: pickIn(f.question, 'es'), en: pickIn(f.question, 'en') },
      answer: { es: pickIn(f.answer, 'es'), en: pickIn(f.answer, 'en') },
      sources: Array.isArray(f.sources) ? f.sources : [],
      reviewedOn: f.reviewed_on || null,
      addedOn: added,
      // Sort by day; within a day, saved entries ('|1<instant>') come before file entries ('|0').
      sortKey: `${added}|0`,
      addedBy: null,
      sample: !!f.sample,
    });
  }
  for (const r of rows || []) {
    const at = r.created_at || '';
    out.push({
      id: SAVED_PREFIX + r.id,
      origin: 'saved',
      rowId: r.id,
      category: r.category || null,
      question: { es: r.question_es || r.question_en || '', en: r.question_en || r.question_es || '' },
      answer: { es: r.answer_es || r.answer_en || '', en: r.answer_en || r.answer_es || '' },
      sources: Array.isArray(r.sources) ? r.sources.filter((s) => s && s.url) : [],
      reviewedOn: null,
      addedOn: at ? toDate(at) : '',
      sortKey: `${at ? toDate(at) : ''}|1${at}`,
      addedBy: r.created_by_name || null,
      sample: false,
    });
  }
  // Newest day first; within a day, saved entries (they carry a time) before file entries.
  return out
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.sortKey < b.item.sortKey ? 1 : a.item.sortKey > b.item.sortKey ? -1 : a.i - b.i))
    .map((x) => x.item);
}

/** Categories present in a FAQ list, in first-seen order (null excluded). @param {FaqItem[]} items */
export function faqCategories(items) {
  /** @type {string[]} */
  const out = [];
  for (const i of items) if (i.category && !out.includes(i.category)) out.push(i.category);
  return out;
}

/**
 * Filter a FAQ list by category ('' = all) and a search query in a locale.
 * @param {FaqItem[]} items @param {string} category @param {string} query @param {Locale} locale
 */
export function filterFaq(items, category, query, locale) {
  const terms = queryTerms(query);
  return items.filter((i) => {
    if (category && i.category !== category) return false;
    if (!terms.length) return true;
    const hay = normalizeText(`${i.question[locale]} ${stripMarkdown(i.answer[locale])}`);
    return terms.every((t) => hay.includes(t));
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Lowercase, strip accents and collapse spaces. @param {string} s */
export function normalizeText(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Search terms from a query (normalized, deduplicated, 1+ chars). @param {string} q */
export function queryTerms(q) {
  return [...new Set(normalizeText(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/** Plain text from Markdown-lite (keeps link text, drops markers). @param {string} s */
export function stripMarkdown(s) {
  return (s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|\*|_|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {object} SearchDoc
 * @property {SectionId} section
 * @property {string} id
 * @property {string} path     app path to open
 * @property {string} title
 * @property {string} summary
 * @property {string} body     plain text
 */

/**
 * Build searchable documents for one locale from loaded content and saved FAQ rows.
 * @param {Partial<Record<string, any[]>>} content items per content file name
 * @param {FaqItem[]} faq merged FAQ list
 * @param {Locale} locale
 * @returns {SearchDoc[]}
 */
export function buildSearchDocs(content, faq, locale) {
  /** @type {SearchDoc[]} */
  const docs = [];
  for (const sec of ['must-know', 'roadmap', 'training', 'health', 'parents']) {
    for (const item of content[sec] || []) {
      const todos = (item.todos || []).map((/** @type {any} */ td) => pickIn(td.text, locale)).join(' ');
      docs.push({
        section: /** @type {SectionId} */ (sec),
        id: item.id,
        path: `/learn/${sec}/${encodeURIComponent(item.id)}`,
        title: pickIn(item.title, locale),
        summary: pickIn(item.summary, locale),
        body: stripMarkdown(`${pickIn(item.body, locale)} ${todos}`),
      });
    }
  }
  for (const f of faq || []) {
    docs.push({
      section: 'faq',
      id: f.id,
      path: `/learn/faq/${encodeURIComponent(f.id)}`,
      title: f.question[locale],
      summary: '',
      body: stripMarkdown(f.answer[locale]),
    });
  }
  for (const fact of content.facts || []) {
    const text = stripMarkdown(pickIn(fact.text, locale));
    docs.push({ section: 'facts', id: fact.id, path: `/learn/facts/${encodeURIComponent(fact.id)}`, title: text, summary: '', body: '' });
  }
  return docs;
}

/**
 * Rank documents for a query. Every term must appear somewhere; title hits weigh most.
 * @param {SearchDoc[]} docs @param {string} query @param {number} [limit]
 * @returns {Array<SearchDoc & { score: number, snippet: string }>}
 */
export function searchDocs(docs, query, limit = 30) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const results = [];
  for (const d of docs) {
    const title = normalizeText(d.title);
    const summary = normalizeText(d.summary);
    const body = normalizeText(d.body);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const s = (title.includes(t) ? 10 : 0) + (summary.includes(t) ? 4 : 0) + (body.includes(t) ? 1 : 0);
      if (!s) {
        all = false;
        break;
      }
      score += s;
      if (title.startsWith(t)) score += 2;
    }
    if (!all) continue;
    const snippetSource = d.summary && terms.some((t) => summary.includes(t)) ? d.summary : d.body || d.summary;
    results.push({ ...d, score, snippet: makeSnippet(snippetSource, terms) });
  }
  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/**
 * Short excerpt around the first matching term.
 * @param {string} text @param {string[]} terms @param {number} [size]
 */
export function makeSnippet(text, terms, size = 90) {
  const plain = (text || '').replace(/\s+/g, ' ').trim();
  if (plain.length <= size) return plain;
  // normalizeText keeps lengths for Latin text (accents are single combining marks once removed),
  // so positions line up closely enough for an excerpt.
  const norm = plain.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = norm.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at <= size / 3) return plain.slice(0, size).replace(/\s+\S*$/, '') + '…';
  let start = Math.max(0, at - Math.floor(size / 3));
  const space = plain.indexOf(' ', start);
  if (space !== -1 && space < at) start = space + 1;
  const end = Math.min(plain.length, start + size);
  return (start > 0 ? '…' : '') + plain.slice(start, end).replace(/\s+\S*$/, '') + (end < plain.length ? '…' : '');
}
