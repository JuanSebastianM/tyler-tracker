import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortByPriority, sortStages, stageTiming, stageProgress, applyStatus, trainingFormError, trainingOverview,
  isOldEnough, sortGuides, mergeFaq, faqCategories, filterFaq, normalizeText, queryTerms, stripMarkdown,
  buildSearchDocs, searchDocs, makeSnippet, pickIn, SAVED_PREFIX,
} from '../../src/features/learn/logic.js';

const bi = (es, en) => ({ es, en });

test('sortByPriority orders critical > important > good-to-know, stable, unknown last', () => {
  const items = [
    { id: 'a', priority: 'good-to-know' },
    { id: 'b', priority: 'critical' },
    { id: 'c', priority: 'weird' },
    { id: 'd', priority: 'important' },
    { id: 'e', priority: 'critical' },
  ];
  assert.deepEqual(sortByPriority(items).map((i) => i.id), ['b', 'e', 'd', 'a', 'c']);
  assert.deepEqual(sortByPriority(undefined), []);
});

test('stages sort by start week and get past/current/future', () => {
  const stages = sortStages([{ id: 'b', from_weeks: 10 }, { id: 'a', from_weeks: 6 }, { id: 'c', from_weeks: 16 }]);
  assert.deepEqual(stages.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(stageTiming(stages[0], stages[1]), 'past');
  assert.equal(stageTiming(stages[1], stages[1]), 'current');
  assert.equal(stageTiming(stages[2], stages[1]), 'future');
  assert.equal(stageTiming(stages[0], null), 'future');
});

test('stageProgress counts done to-dos', () => {
  const stage = { todos: [{ key: 's.a' }, { key: 's.b' }, { key: 's.c' }] };
  assert.deepEqual(stageProgress(stage, new Set(['s.b', 'other'])), { done: 1, total: 3, complete: false });
  assert.deepEqual(stageProgress(stage, new Set(['s.a', 's.b', 's.c'])), { done: 3, total: 3, complete: true });
  assert.deepEqual(stageProgress({}, new Set()), { done: 0, total: 0, complete: false });
});

test('applyStatus fills dates sensibly', () => {
  const today = '2026-11-13';
  assert.deepEqual(applyStatus({}, 'learning', today), { status: 'learning', started_on: today, mastered_on: null });
  assert.deepEqual(applyStatus({ started_on: '2026-11-01' }, 'reliable', today), { status: 'reliable', started_on: '2026-11-01', mastered_on: null });
  assert.deepEqual(applyStatus({ started_on: '2026-11-01' }, 'mastered', today), { status: 'mastered', started_on: '2026-11-01', mastered_on: today });
  // Straight to mastered: started on the same day.
  assert.deepEqual(applyStatus({}, 'mastered', today), { status: 'mastered', started_on: today, mastered_on: today });
  // Back from mastered clears the mastered date but keeps the start.
  assert.deepEqual(applyStatus({ started_on: '2026-11-01', mastered_on: '2026-11-10' }, 'learning', today), { status: 'learning', started_on: '2026-11-01', mastered_on: null });
  assert.deepEqual(applyStatus({ started_on: '2026-11-01', mastered_on: '2026-11-10' }, 'not_started', today), { status: 'not_started', started_on: null, mastered_on: null });
});

test('trainingFormError catches future and inverted dates', () => {
  const today = '2026-11-13';
  assert.equal(trainingFormError({ status: 'learning', started_on: '2026-11-12', mastered_on: null }, today), null);
  assert.equal(trainingFormError({ status: 'learning', started_on: '2026-11-14', mastered_on: null }, today), 'futureDate');
  assert.equal(trainingFormError({ status: 'mastered', started_on: '2026-11-12', mastered_on: '2026-11-10' }, today), 'masteredBeforeStarted');
});

test('trainingOverview counts statuses and weights progress', () => {
  const guides = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const rows = [
    { skill_key: 'a', status: 'mastered' },
    { skill_key: 'b', status: 'learning' },
    { skill_key: 'zzz', status: 'mastered' }, // not a guide any more
    { skill_key: 'c', status: 'bogus' },
  ];
  const ov = trainingOverview(guides, rows);
  assert.deepEqual(ov.counts, { not_started: 2, learning: 1, reliable: 0, mastered: 1 });
  assert.equal(ov.total, 4);
  assert.equal(ov.percent, Math.round((4 / 12) * 100));
  assert.equal(trainingOverview([], []).percent, 0);
});

test('isOldEnough and sortGuides', () => {
  assert.equal(isOldEnough({ min_age_weeks: 8 }, 7), false);
  assert.equal(isOldEnough({ min_age_weeks: 8 }, 8), true);
  assert.equal(isOldEnough({}, 0), true);
  const g = sortGuides([
    { id: 'x', min_age_weeks: 12, difficulty: 'easy' },
    { id: 'y', min_age_weeks: 8, difficulty: 'hard' },
    { id: 'z', min_age_weeks: 8, difficulty: 'easy' },
  ]);
  assert.deepEqual(g.map((i) => i.id), ['z', 'y', 'x']);
});

const fileFaq = [
  { id: 'old', category: 'feeding', question: bi('¿Cuánto come?', 'How much does he eat?'), answer: bi('Cuatro **comidas**.', 'Four **meals**.'), sources: [], reviewed_on: '2026-11-01', added_on: '2026-11-01' },
  { id: 'same-day', category: 'health', question: bi('¿Vacunas?', 'Vaccines?'), answer: bi('Sí.', 'Yes.'), sources: [], reviewed_on: '2026-11-13', added_on: '2026-11-13', sample: true },
];
const savedRows = [
  { id: 'u1', category: 'training', question_es: '¿Cómo enseñarle a sentarse?', question_en: 'How do I teach sit?', answer_es: 'Con premios.', answer_en: 'With treats.', sources: [{ title: 'AKC', url: 'https://www.akc.org/' }, null], created_at: '2026-11-13T02:00:00.000Z', created_by_name: 'Alex' },
  { id: 'u2', category: null, question_es: '¿Muerde?', question_en: '', answer_es: 'Es normal.', answer_en: 'It is normal.', sources: null, created_at: '2026-11-13T20:00:00.000Z', created_by_name: 'Sam' },
];
// Bogota is UTC-5: 2026-11-13T02:00Z is still 2026-11-12 there.
const toDate = (at) => new Date(Date.parse(at) - 5 * 3600_000).toISOString().slice(0, 10);

test('mergeFaq merges file and saved entries newest first', () => {
  const items = mergeFaq(fileFaq, savedRows, toDate);
  assert.deepEqual(items.map((i) => i.id), [`${SAVED_PREFIX}u2`, 'same-day', `${SAVED_PREFIX}u1`, 'old']);
  const u1 = items.find((i) => i.rowId === 'u1');
  assert.equal(u1.origin, 'saved');
  assert.equal(u1.addedOn, '2026-11-12');
  assert.equal(u1.addedBy, 'Alex');
  assert.deepEqual(u1.sources, [{ title: 'AKC', url: 'https://www.akc.org/' }]);
  const u2 = items.find((i) => i.rowId === 'u2');
  assert.equal(u2.question.en, '¿Muerde?', 'falls back to the other language');
  assert.deepEqual(u2.sources, []);
  assert.equal(items.find((i) => i.id === 'same-day').sample, true);
  assert.deepEqual(mergeFaq(undefined, undefined, toDate), []);
});

test('faqCategories and filterFaq', () => {
  const items = mergeFaq(fileFaq, savedRows, toDate);
  assert.deepEqual(faqCategories(items), ['health', 'training', 'feeding']);
  assert.deepEqual(filterFaq(items, 'feeding', '', 'es').map((i) => i.id), ['old']);
  assert.deepEqual(filterFaq(items, '', 'comidas', 'es').map((i) => i.id), ['old']);
  assert.deepEqual(filterFaq(items, '', 'treats', 'en').map((i) => i.rowId), ['u1']);
  assert.deepEqual(filterFaq(items, 'health', 'treats', 'en'), []);
});

test('text helpers normalise accents and strip Markdown', () => {
  assert.equal(normalizeText('  Vacunación   ÚTIL '), 'vacunacion util');
  assert.deepEqual(queryTerms('¿Cuándo, cuándo vacunas?'), ['cuando', 'vacunas']);
  assert.equal(stripMarkdown('## Pasos\n1. **Sentado** con [premio](https://x.y)\n- *uno*'), 'Pasos Sentado con premio uno');
  assert.equal(pickIn(bi('hola', 'hi'), 'en'), 'hi');
  assert.equal(pickIn({ es: 'solo' }, 'en'), 'solo');
  assert.equal(pickIn(null, 'es'), '');
});

test('search finds by title, summary, body and to-dos, in the given locale', () => {
  const content = {
    'must-know': [{ id: 'toxic', title: bi('Alimentos tóxicos', 'Toxic foods'), summary: bi('Chocolate nunca', 'Never chocolate'), body: bi('Uvas y **cebolla**.', 'Grapes and **onion**.') }],
    roadmap: [{ id: 'home', title: bi('Llegada', 'Settling in'), summary: bi('', ''), body: bi('Rutina', 'Routine'), todos: [{ key: 'home.crate', text: bi('Preparar guacal', 'Set up crate') }] }],
    training: [{ id: 'sit', title: bi('Sentado', 'Sit'), summary: bi('Su primera señal', 'His first cue'), body: bi('Premio', 'Treat') }],
    facts: [{ id: 'teeth', text: bi('Tiene **28 dientes** de leche.', 'He has **28 baby teeth**.') }],
  };
  const faq = mergeFaq(fileFaq, [], toDate);
  const es = buildSearchDocs(content, faq, 'es');
  assert.equal(searchDocs(es, 'cebolla')[0].id, 'toxic');
  assert.equal(searchDocs(es, 'guacal')[0].path, '/learn/roadmap/home');
  assert.equal(searchDocs(es, 'TÓXICOS chocolate')[0].id, 'toxic');
  assert.equal(searchDocs(es, 'dientes')[0].section, 'facts');
  assert.equal(searchDocs(es, 'comidas')[0].path, '/learn/faq/old');
  assert.deepEqual(searchDocs(es, 'onion'), [], 'English text is not searched in Spanish');
  assert.deepEqual(searchDocs(es, '   '), []);
  const en = buildSearchDocs(content, faq, 'en');
  assert.equal(searchDocs(en, 'onion')[0].id, 'toxic');
  // Title hits outrank body hits.
  const docs = [
    { section: 'health', id: 'b', path: '/b', title: 'Otro', summary: '', body: 'habla de vacunas' },
    { section: 'health', id: 'a', path: '/a', title: 'Vacunas', summary: '', body: '' },
  ];
  assert.deepEqual(searchDocs(docs, 'vacunas').map((d) => d.id), ['a', 'b']);
});

test('makeSnippet centres on the match and trims', () => {
  assert.equal(makeSnippet('corto', ['x']), 'corto');
  const long = `${'palabra '.repeat(40)}vacunación importante ${'otra '.repeat(40)}`;
  const s = makeSnippet(long, ['vacunacion']);
  assert.ok(s.includes('vacunación'), s);
  assert.ok(s.startsWith('…') && s.endsWith('…'), s);
  assert.ok(s.length <= 95, String(s.length));
});
