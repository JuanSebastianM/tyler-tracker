// Learn tab: content sections, search, roadmap to-dos, training progress and the merged FAQ.
// Content comes from the fake content in content-fixtures.js (served by mockSupabase), never from
// /content; store rows come from fixtures.
import { test, expect } from 'playwright/test';
import { openApp, toastWith, tab, EDITOR_USER, contentItems } from './helpers.js';

const content = contentItems;

// Tyler is 7 weeks old at FIXED_NOW (2026-11-13). Same rule as currentStage().
const AGE_WEEKS = 7;
function currentStage() {
  const stages = [...content('roadmap')].sort((a, b) => a.from_weeks - b.from_weeks);
  return stages.find((s) => AGE_WEEKS >= s.from_weeks && AGE_WEEKS < s.to_weeks) || (AGE_WEEKS < stages[0].from_weeks ? stages[0] : stages.at(-1));
}

const audit = (at = '2026-11-12T15:00:00.000Z', by = 'Alex') => ({ created_at: at, updated_at: at, created_by: EDITOR_USER.id, created_by_name: by });
const SAVED_FAQ = {
  id: 'a0000000-0000-4000-8000-0000000000f1',
  category: 'training',
  question_es: '¿Cómo le enseño a no morder las manos?',
  question_en: 'How do I teach him not to bite hands?',
  answer_es: 'Redirige a un **juguete** cada vez que muerda.',
  answer_en: 'Redirect him to a **toy** every time he bites.',
  sources: [{ title: 'Fuente de prueba', url: 'https://example.org/bite' }],
  source_thread_id: null,
  ...audit('2026-11-13T14:00:00.000Z'),
};

const noOverflow = async (page) => {
  const overflow = (await page.evaluate(() => document.documentElement.scrollWidth)) - page.viewportSize().width;
  expect(overflow).toBeLessThanOrEqual(0);
};

test('home lists sections with counts, the current stage and the fact of the day', async ({ page }) => {
  const sb = await openApp(page, '/learn');
  const sections = page.getByTestId('learn-sections');
  for (const id of ['must-know', 'roadmap', 'training', 'health', 'parents', 'faq', 'facts']) {
    await expect(sections.locator(`[data-section="${id}"]`)).toBeVisible();
  }
  await expect(sections.locator('[data-section="training"]')).toContainText(`${content('training').length}`);
  const stage = currentStage();
  await expect(page.getByTestId('current-stage-card')).toContainText(stage.title.es);
  await expect(page.getByTestId('current-stage-card')).toContainText('7 semanas');
  await expect(page.getByTestId('fact-of-the-day')).toBeVisible();
  await noOverflow(page);
  expect(sb.pageErrors).toEqual([]);
});

test('open a must-know article from the list, with sources and the vet line', async ({ page }) => {
  await openApp(page, '/learn');
  await page.locator('[data-section="must-know"]').click();
  await expect(page).toHaveURL(/#\/learn\/must-know$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lo imprescindible');
  const order = ['critical', 'important', 'good-to-know'];
  const first = [...content('must-know')].sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority))[0];
  await page.getByRole('link', { name: new RegExp(first.title.es) }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/learn/must-know/${first.id}$`));
  const article = page.getByTestId('learn-article');
  await expect(article.locator('.article-title')).toHaveText(first.title.es);
  await expect(article.locator('.sources')).toContainText('Fuentes');
  await expect(article.locator('.disclaimer')).toBeVisible();
  await noOverflow(page);
});

test('every section list and article deep link renders; unknown ids show not found', async ({ page }) => {
  const sb = await openApp(page, '/learn');
  for (const name of ['health', 'parents', 'training']) {
    const item = content(name)[0];
    await page.goto(`./#/learn/${name}`);
    await expect(page.getByRole('link', { name: new RegExp(item.title.es) }).first()).toBeVisible();
    await noOverflow(page);
    await page.goto(`./#/learn/${name}/${item.id}`);
    await expect(page.getByTestId('learn-article').locator('.article-title')).toHaveText(item.title.es);
    await noOverflow(page);
  }
  await page.goto('./#/learn/health/this-does-not-exist');
  await expect(page.getByTestId('learn-not-found')).toBeVisible();
  await page.getByRole('link', { name: 'Ir a Consejos de salud' }).click();
  await expect(page).toHaveURL(/#\/learn\/health$/);
  await page.goto('./#/learn/facts');
  await expect(page.getByTestId('fact-of-the-day')).toBeVisible();
  await expect(page.locator('[data-fact]')).toHaveCount(content('facts').length);
  expect(sb.pageErrors).toEqual([]);
});

test('search finds an article in the current language', async ({ page }) => {
  await openApp(page, '/learn');
  const item = content('health')[0];
  const word = item.title.es.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  await page.getByTestId('learn-search').fill(word);
  const results = page.getByTestId('search-results');
  await expect(results).toBeVisible();
  await results.getByRole('link', { name: new RegExp(item.title.es) }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/learn/health/${item.id}$`));
  await page.goto('./#/learn');
  await page.getByTestId('learn-search').fill('zzzqqxx');
  await expect(page.getByText('No encontramos nada')).toBeVisible();
});

test('language switch changes article text', async ({ page }) => {
  const item = content('parents')[0];
  await openApp(page, `/learn/parents/${item.id}`);
  const heading = page.getByTestId('learn-article').locator('.article-title');
  await expect(heading).toHaveText(item.title.es);
  await tab(page, 'profile').click();
  await page.getByRole('radio', { name: 'English' }).click();
  await page.goto(`./#/learn/parents/${item.id}`);
  await expect(heading).toHaveText(item.title.en);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Puppy parents');
});

test.describe('roadmap', () => {
  test('current stage is open and highlighted; visitors see ticks read-only', async ({ page }) => {
    const stage = currentStage();
    const [doneTodo] = stage.todos;
    await openApp(page, '/learn/roadmap', { fixtures: { checklist_done: [{ item_key: doneTodo.key, done_at: '2026-11-12T15:00:00.000Z', ...audit() }] } });
    const current = page.locator('.stage[data-timing="current"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-stage', stage.id);
    await expect(current.locator('.stage-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toContainText(`1 de ${stage.todos.length} hechas`);
    await expect(current.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(current.locator(`[data-todo="${doneTodo.key}"] [role="checkbox"]`)).toHaveAttribute('aria-checked', 'true');
    // Other stages are browsable.
    const other = page.locator('.stage:not([data-timing="current"])').first();
    if (await other.count()) {
      await other.locator('.stage-head').click();
      await expect(other.locator('.stage-head')).toHaveAttribute('aria-expanded', 'true');
      await expect(other.locator('.stage-body')).toBeVisible();
    }
    await noOverflow(page);
  });

  test('editor ticks and unticks a to-do', async ({ page }) => {
    const stage = currentStage();
    const todo = stage.todos[0];
    const sb = await openApp(page, '/learn/roadmap', { mode: 'asEditor' });
    const box = page.locator(`[data-todo="${todo.key}"] input[type="checkbox"]`);
    await box.check();
    await expect.poll(() => sb.db.checklist_done.map((r) => r.item_key)).toEqual([todo.key]);
    await expect(page.locator(`.stage[data-stage="${stage.id}"]`)).toContainText(`1 de ${stage.todos.length} hechas`);
    await box.uncheck();
    await expect.poll(() => sb.db.checklist_done.length).toBe(0);
  });

  test('a failed tick rolls back with a toast', async ({ page }) => {
    const todo = currentStage().todos[0];
    const sb = await openApp(page, '/learn/roadmap', { mode: 'asEditor', failWrites: true });
    const box = page.locator(`[data-todo="${todo.key}"] input[type="checkbox"]`);
    await box.click();
    await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
    await expect(box).not.toBeChecked();
    expect(sb.db.checklist_done).toHaveLength(0);
  });

  test('deep link opens a specific stage; unknown stage shows not found', async ({ page }) => {
    const stages = [...content('roadmap')].sort((a, b) => a.from_weeks - b.from_weeks);
    const last = stages.at(-1);
    await openApp(page, `/learn/roadmap/${last.id}`);
    await expect(page.locator(`.stage[data-stage="${last.id}"] .stage-head`)).toHaveAttribute('aria-expanded', 'true');
    await page.goto('./#/learn/roadmap/nope');
    await expect(page.getByTestId('learn-not-found')).toBeVisible();
  });
});

test.describe('training', () => {
  test('visitors see status read-only and overall progress', async ({ page }) => {
    const guide = content('training')[0];
    await openApp(page, '/learn/training', {
      fixtures: { training_skills: [{ skill_key: guide.id, status: 'reliable', started_on: '2026-11-11', mastered_on: null, notes: 'Va bien', ...audit() }] },
    });
    await expect(page.getByTestId('training-overview')).toBeVisible();
    await expect(page.locator(`[data-guide="${guide.id}"]`)).toContainText('Confiable');
    await page.locator(`[data-guide="${guide.id}"]`).click();
    const progress = page.getByTestId('training-progress');
    await expect(progress).toContainText('Confiable');
    await expect(progress).toContainText('Va bien');
    await expect(page.getByTestId('training-status')).toHaveCount(0);
    await expect(page.getByTestId('learn-article').locator('.disclaimer')).toBeVisible();
    await noOverflow(page);
  });

  test('editor changes a status; dates are filled in', async ({ page }) => {
    const guide = content('training')[0];
    const sb = await openApp(page, `/learn/training/${guide.id}`, { mode: 'asEditor' });
    await page.getByTestId('training-status').selectOption('learning');
    await expect(page.getByLabel('Empezó el')).toHaveValue('2026-11-13');
    await page.getByLabel('Notas').fill('Responde en casa');
    await page.getByRole('button', { name: 'Guardar progreso' }).click();
    await expect(toastWith(page, 'Progreso guardado')).toBeVisible();
    await expect.poll(() => sb.db.training_skills.find((r) => r.skill_key === guide.id)).toMatchObject({
      status: 'learning', started_on: '2026-11-13', mastered_on: null, notes: 'Responde en casa',
    });
    await page.getByTestId('training-status').selectOption('mastered');
    await expect(page.getByLabel('Lo dominó el')).toHaveValue('2026-11-13');
    await page.getByRole('button', { name: 'Guardar progreso' }).click();
    await expect.poll(() => sb.db.training_skills.find((r) => r.skill_key === guide.id)?.status).toBe('mastered');
    await page.goto('./#/learn/training');
    await expect(page.locator(`[data-guide="${guide.id}"]`)).toContainText('Dominado');
  });

  test('a failed status save rolls back', async ({ page }) => {
    const guide = content('training')[0];
    const sb = await openApp(page, `/learn/training/${guide.id}`, { mode: 'asEditor', failWrites: true });
    await page.getByTestId('training-status').selectOption('learning');
    await page.getByRole('button', { name: 'Guardar progreso' }).click();
    await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
    await expect(page.getByTestId('training-status')).toHaveValue('not_started');
    expect(sb.db.training_skills).toHaveLength(0);
  });
});

test.describe('faq', () => {
  test('shows file entries and saved entries together, newest first, with filter and search', async ({ page }) => {
    const files = content('faq');
    await openApp(page, '/learn/faq', { fixtures: { faq_entries: [SAVED_FAQ] } });
    const list = page.getByTestId('faq-list');
    await expect(list.locator('[data-origin="saved"]')).toHaveCount(1);
    await expect(list.locator('[data-origin="file"]')).toHaveCount(files.length);
    await expect(list.locator('[role="listitem"]').first()).toContainText(SAVED_FAQ.question_es);
    await page.getByTestId('faq-search').fill('juguete');
    await expect(list.locator('[role="listitem"]')).toHaveCount(1);
    await page.getByTestId('faq-search').fill('');
    if (await page.locator('.chips').count()) {
      await page.locator('.chip', { hasText: 'Entrenamiento' }).click();
      await expect(list.locator('[data-origin="saved"]')).toHaveCount(1);
    }
    await noOverflow(page);
    await list.locator('[data-origin="saved"]').click();
    const article = page.getByTestId('learn-article');
    await expect(article.locator('.article-title')).toHaveText(SAVED_FAQ.question_es);
    await expect(article).toContainText('Guardada por Alex');
    await expect(article.locator('.sources')).toContainText('Fuente de prueba');
    await expect(page.getByTestId('faq-delete')).toHaveCount(0);
    await page.goto(`./#/learn/faq/${files[0].id}`);
    await expect(page.getByTestId('learn-article').locator('.article-title')).toHaveText(files[0].question.es);
  });

  test('editor deletes a saved entry after confirming', async ({ page }) => {
    const sb = await openApp(page, `/learn/faq/saved-${SAVED_FAQ.id}`, { mode: 'asEditor', fixtures: { faq_entries: [SAVED_FAQ] } });
    await page.getByTestId('faq-delete').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    expect(sb.db.faq_entries).toHaveLength(1);
    await page.getByTestId('faq-delete').click();
    await dialog.getByRole('button', { name: 'Eliminar' }).click();
    await expect.poll(() => sb.db.faq_entries.length).toBe(0);
    await expect(page).toHaveURL(/#\/learn\/faq$/);
    await expect(toastWith(page, 'Pregunta eliminada')).toBeVisible();
  });

  test('a failed delete keeps the entry', async ({ page }) => {
    const sb = await openApp(page, `/learn/faq/saved-${SAVED_FAQ.id}`, { mode: 'asEditor', failWrites: true, fixtures: { faq_entries: [SAVED_FAQ] } });
    await page.getByTestId('faq-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(toastWith(page, 'No se pudo eliminar')).toBeVisible();
    expect(sb.db.faq_entries).toHaveLength(1);
    await page.goto('./#/learn/faq');
    await expect(page.getByTestId('faq-list').locator('[data-origin="saved"]')).toHaveCount(1);
  });

  test('empty FAQ shows a helpful empty state', async ({ page }) => {
    await openApp(page, '/learn/faq', { content: { faq: { version: 1, items: [] } } });
    await expect(page.getByText('Aún no hay preguntas')).toBeVisible();
    await page.goto('./#/learn/faq/saved-unknown');
    await expect(page.getByTestId('learn-not-found')).toBeVisible();
  });
});
