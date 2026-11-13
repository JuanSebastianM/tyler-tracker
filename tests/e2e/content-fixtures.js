// Fake reading content for e2e tests. mockSupabase() serves these for every `content/*.json`
// request, so the suite never depends on the real files in /content (which the content pass can
// replace or empty at any time). Override per test with openApp(page, path, { content: { faq: {...} } })
// (null = HTTP 404), or pass { content: 'real' } to serve the real files (review screenshots only).
//
// Tyler is 7 weeks old at FIXED_NOW (2026-11-13), so 'stage-early' (6–10 weeks) is the current stage.

const bi = (es, en) => ({ es, en });
const SRC = [{ title: 'Fuente de prueba', url: 'https://example.org/source' }];
const REVIEWED = '2026-11-01';

/** @param {string} id @param {string} es @param {string} en @param {object} [extra] */
const article = (id, es, en, extra = {}) => ({
  id,
  title: bi(es, en),
  summary: bi(`Resumen de prueba: ${es.toLowerCase()}.`, `Test summary: ${en.toLowerCase()}.`),
  body: bi(
    `Texto de prueba sobre ${es.toLowerCase()}.\n\n## Qué hacer\n- Primer paso de prueba\n- Segundo paso de prueba\n\n1. Uno\n2. Dos`,
    `Test text about ${en.toLowerCase()}.\n\n## What to do\n- First test step\n- Second test step\n\n1. One\n2. Two`,
  ),
  sources: SRC,
  reviewed_on: REVIEWED,
  ...extra,
});

export const CONTENT_FIXTURES = {
  'must-know': {
    version: 1,
    items: [
      article('test-good-to-know', 'Dato útil de prueba', 'Useful test note', { priority: 'good-to-know' }),
      article('test-critical', 'Peligros de prueba en casa', 'Test hazards at home', { priority: 'critical' }),
      article('test-important', 'Rutina importante de prueba', 'Important test routine', { priority: 'important' }),
    ],
  },
  roadmap: {
    version: 1,
    items: [
      article('stage-early', 'Etapa temprana de prueba', 'Early test stage', {
        from_weeks: 6,
        to_weeks: 10,
        todos: [
          { key: 'stage-early.crate', text: bi('Preparar su guacal de prueba', 'Set up his test crate') },
          { key: 'stage-early.vet', text: bi('Pedir cita de prueba', 'Book a test appointment') },
          { key: 'stage-early.names', text: bi('Practicar su nombre', 'Practise his name') },
        ],
      }),
      article('stage-middle', 'Etapa media de prueba', 'Middle test stage', {
        from_weeks: 10,
        to_weeks: 16,
        todos: [{ key: 'stage-middle.walks', text: bi('Paseos cortos de prueba', 'Short test walks') }],
      }),
      article('stage-late', 'Etapa tardía de prueba', 'Late test stage', {
        from_weeks: 16,
        to_weeks: 104,
        todos: [{ key: 'stage-late.class', text: bi('Clase de prueba', 'Test class') }],
      }),
    ],
  },
  training: {
    version: 1,
    items: [
      article('test-sit', 'Sentarse de prueba', 'Test sit', { min_age_weeks: 7, difficulty: 'easy', duration_min: 3 }),
      article('test-come', 'Venir de prueba', 'Test recall', { min_age_weeks: 8, difficulty: 'medium', duration_min: 5 }),
      article('test-stay', 'Quieto de prueba', 'Test stay', { min_age_weeks: 12, difficulty: 'hard', duration_min: 5 }),
    ],
  },
  health: {
    version: 1,
    items: [
      article('test-vaccines', 'Calendario de vacunas de prueba', 'Test vaccine schedule', { category: 'vaccines' }),
      article('test-parasites', 'Desparasitación de prueba', 'Test deworming', { category: 'parasites' }),
    ],
  },
  parents: {
    version: 1,
    items: [
      article('test-teamwork', 'Trabajo en equipo de prueba', 'Test teamwork', { category: 'teamwork' }),
      article('test-routine', 'Rutina en pareja de prueba', 'Test couple routine', { category: 'routine' }),
    ],
  },
  faq: {
    version: 1,
    items: [
      {
        id: 'test-faq-older',
        category: 'feeding',
        question: bi('¿Pregunta de prueba sobre comida?', 'Test question about food?'),
        answer: bi('Respuesta de prueba sobre comida.', 'Test answer about food.'),
        added_on: '2026-11-02',
        sources: SRC,
        reviewed_on: REVIEWED,
      },
      {
        id: 'test-faq-newer',
        category: 'routine',
        question: bi('¿Pregunta de prueba sobre rutina?', 'Test question about routine?'),
        answer: bi('Respuesta de prueba sobre rutina.', 'Test answer about routine.'),
        added_on: '2026-11-05',
        sources: [],
        reviewed_on: REVIEWED,
      },
    ],
  },
  facts: {
    version: 1,
    items: [
      { id: 'test-fact-1', text: bi('Dato curioso de prueba número uno.', 'Test fun fact number one.'), sources: SRC, reviewed_on: REVIEWED },
      { id: 'test-fact-2', text: bi('Dato curioso de prueba número dos.', 'Test fun fact number two.'), sources: SRC, reviewed_on: REVIEWED },
      { id: 'test-fact-3', text: bi('Dato curioso de prueba número tres.', 'Test fun fact number three.'), sources: SRC, reviewed_on: REVIEWED },
    ],
  },
  growth: {
    version: 1,
    note: bi('Nota de prueba sobre el rango de referencia.', 'Test note about the reference range.'),
    breed: 'golden_retriever',
    sex: 'male',
    unit: 'kg',
    points: [
      { age_weeks: 6, min_kg: 3, max_kg: 5 },
      { age_weeks: 12, min_kg: 8, max_kg: 11 },
      { age_weeks: 24, min_kg: 19, max_kg: 24 },
      { age_weeks: 52, min_kg: 29, max_kg: 34 },
    ],
    sources: SRC,
    reviewed_on: REVIEWED,
  },
};

/** A growth reference that starts at 17 weeks, after Tyler's age at FIXED_NOW. */
export const GROWTH_STARTS_LATER = {
  ...CONTENT_FIXTURES.growth,
  points: [{ age_weeks: 17, min_kg: 12, max_kg: 20 }, { age_weeks: 35, min_kg: 22, max_kg: 33 }],
};

/** Items of a fixture content file. @param {keyof typeof CONTENT_FIXTURES} name */
export const contentItems = (name) => CONTENT_FIXTURES[name].items;

/** The fixture roadmap stage for an age in weeks (same rule as currentStage()). @param {number} weeks */
export function fixtureStage(weeks) {
  const stages = [...contentItems('roadmap')].sort((a, b) => a.from_weeks - b.from_weeks);
  return stages.find((s) => weeks >= s.from_weeks && weeks < s.to_weeks) || (weeks < stages[0].from_weeks ? stages[0] : stages.at(-1));
}
