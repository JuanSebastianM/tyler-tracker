// In-app assistant against the mocked `chat` Edge Function (tests/e2e/supabase-mock.js).
import { test, expect } from 'playwright/test';
import { openApp, toastWith, EDITOR_USER } from './helpers.js';

// These flows stream, reload and open sheets; give them room on a busy machine.
test.describe.configure({ timeout: 40_000 });

const THREAD_ID = 'c0000000-0000-4000-8000-000000000001';
const by = { created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const threadFixtures = () => ({
  chat_threads: [{ id: THREAD_ID, title: '¿Cuánto debe comer?', created_at: '2026-11-12T15:00:00.000Z', updated_at: '2026-11-12T15:01:00.000Z', ...by }],
  chat_messages: [
    { id: 'm1', thread_id: THREAD_ID, role: 'user', content: '¿Cuánto debe comer?', sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, created_at: '2026-11-12T15:00:01.000Z', updated_at: '2026-11-12T15:00:01.000Z', ...by },
    { id: 'm2', thread_id: THREAD_ID, role: 'assistant', content: 'Unos **80 g** por comida.', sources: [{ title: 'Guía de prueba', url: 'https://example.org/guia' }], model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 100, web_searches: 1, cost_usd: 0.015, created_at: '2026-11-12T15:00:05.000Z', updated_at: '2026-11-12T15:00:05.000Z', ...by },
    { id: 'm3', thread_id: THREAD_ID, role: 'assistant', content: '<!--faq-draft-->{"secret":"accounting row"}', sources: [], model: 'claude-sonnet-5-5', input_tokens: 900, output_tokens: 300, web_searches: 0, cost_usd: 0.004, created_at: '2026-11-12T15:02:00.000Z', updated_at: '2026-11-12T15:02:00.000Z', ...by },
  ],
});

const chatCalls = (sb, action) => sb.calls.filter((c) => c.path === '/functions/v1/chat' && (!action || c.body?.action === action));

test.describe('signed out', () => {
  test('visitors do not see the assistant and the route asks them to sign in', async ({ page }) => {
    const sb = await openApp(page, '/today');
    await expect(page.getByTestId('header-assistant')).toHaveCount(0);
    await page.goto('./#/assistant');
    await expect(page.getByTestId('assistant-signed-out')).toBeVisible();
    await expect(page.getByText('Inicia sesión para usar el asistente')).toBeVisible();
    await expect(page.getByTestId('assistant-composer')).toHaveCount(0);
    await page.getByTestId('assistant-signed-out').getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(chatCalls(sb)).toHaveLength(0);
    expect(sb.restCalls('chat_threads')).toHaveLength(0);
    expect(sb.restCalls('chat_messages')).toHaveLength(0);
  });
});

test.describe('editor', () => {
  test('asks a question from a starter-free composer and sees a streamed answer with sources', async ({ page }) => {
    const sb = await openApp(page, '/today', { mode: 'asEditor' });
    await page.getByTestId('header-assistant').click();
    await expect(page.getByTestId('assistant-chat')).toBeVisible();
    // Starters use his age (7 weeks on the fixed clock).
    await expect(page.getByRole('button', { name: '¿Cuánto debería comer Tyler a las 7 semanas?' })).toBeVisible();
    await expect(page.getByTestId('assistant-budget')).toContainText('usados este mes');

    const send = page.getByTestId('assistant-send');
    await expect(send).toBeDisabled();
    await page.getByLabel('Tu pregunta').fill('¿Cuántas veces al día come?');
    await send.click();

    const answer = page.locator('.msg-assistant').last();
    await expect(answer).toContainText('4 veces al día');
    await expect(answer.locator('strong').first()).toHaveText('7 semanas'); // Markdown rendered
    await expect(answer.getByRole('link', { name: 'AKC: Puppy Feeding Fundamentals' })).toHaveAttribute('href', /akc\.org/);
    await expect(page.getByText('Alex preguntó')).toBeVisible();
    await expect(page).toHaveURL(/#\/assistant\?t=/);
    await expect(page.getByTestId('assistant-streaming')).toHaveCount(0);

    expect(chatCalls(sb, 'send')[0].body).toEqual({ action: 'send', thread_id: null, message: '¿Cuántas veces al día come?' });
    expect(sb.db.chat_messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    await expect(page.getByTestId('assistant-budget')).toContainText('1,22');

    // A follow-up goes to the same thread.
    await page.getByLabel('Tu pregunta').fill('¿Y cuánta agua?');
    await page.getByTestId('assistant-send').click();
    await expect(page.locator('.msg-assistant')).toHaveCount(2);
    expect(chatCalls(sb, 'send')[1].body.thread_id).toBe(sb.db.chat_threads[0].id);
    expect(sb.pageErrors).toEqual([]);
  });

  test('a starter question is sent with one tap', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor' });
    await page.getByRole('button', { name: '¿Cómo le enseño a no morder las manos?' }).click();
    await expect(page.locator('.msg-assistant')).toContainText('4 veces al día');
    expect(chatCalls(sb, 'send')[0].body.message).toBe('¿Cómo le enseño a no morder las manos?');
  });

  test('budget exhausted: error state, question kept in the composer, nothing saved', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { refuse: 'budget_exhausted', budget: { used_usd: 25, budget_usd: 25 } } });
    await page.getByLabel('Tu pregunta').fill('¿Puede comer zanahoria?');
    await page.getByTestId('assistant-send').click();
    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'budget_exhausted');
    await expect(err).toContainText('Se acabó el presupuesto de este mes');
    await expect(err.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByLabel('Tu pregunta')).toHaveValue('¿Puede comer zanahoria?');
    await expect(page.getByTestId('assistant-budget')).toContainText('25');
    expect(sb.db.chat_messages).toHaveLength(0);
  });

  test('daily limit: error state with the limit', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor', chat: { refuse: 'daily_limit' } });
    await page.getByLabel('Tu pregunta').fill('Otra pregunta');
    await page.getByTestId('assistant-send').click();
    const err = page.getByTestId('assistant-error');
    await expect(err).toContainText('Llegaste al límite de preguntas de hoy');
    await expect(err).toContainText('hasta 40 preguntas al día');
  });

  test('upstream failure mid-stream shows a retry and saves nothing', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { streamError: true } });
    await page.getByLabel('Tu pregunta').fill('¿Hola?');
    await page.getByTestId('assistant-send').click();
    const err = page.getByTestId('assistant-error');
    await expect(err).toContainText('El asistente no pudo responder');
    await expect(page.getByTestId('assistant-streaming')).toHaveCount(0);
    expect(sb.db.chat_messages).toHaveLength(0);
    await err.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => chatCalls(sb, 'send').length).toBe(2);
  });

  test('opens a saved thread: hides the FAQ accounting row', async ({ page }) => {
    await openApp(page, `/assistant?t=${THREAD_ID}`, { mode: 'asEditor', fixtures: threadFixtures() });
    await expect(page.locator('.chat-title')).toHaveText('¿Cuánto debe comer?');
    await expect(page.locator('.msg')).toHaveCount(2);
    await expect(page.getByText('accounting row')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Guía de prueba' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('save to FAQ inserts only after confirm, with the edits', async ({ page }) => {
    const sb = await openApp(page, `/assistant?t=${THREAD_ID}`, { mode: 'asEditor', fixtures: threadFixtures() });
    await page.getByTestId('assistant-save-faq').click();
    const sheet = page.getByTestId('faq-sheet');
    await expect(sheet.getByLabel('Pregunta').first()).toHaveValue('¿Cuántas veces al día come Tyler?');
    await expect(sheet.getByLabel('Categoría')).toHaveValue('feeding');
    await expect(sheet.getByRole('link', { name: 'AKC: Puppy Feeding Fundamentals' })).toBeVisible();
    expect(chatCalls(sb, 'draft_faq')[0].body).toEqual({ action: 'draft_faq', thread_id: THREAD_ID });
    expect(sb.restCalls('faq_entries', 'POST')).toHaveLength(0);

    await sheet.getByLabel('Pregunta').first().fill('¿Cuántas comidas al día necesita Tyler?');
    await sheet.getByTestId('faq-confirm').click();
    await expect.poll(() => sb.db.faq_entries.length).toBe(1);
    const row = sb.db.faq_entries[0];
    expect(row.question_es).toBe('¿Cuántas comidas al día necesita Tyler?');
    expect(row.answer_en).toBe('Four meals a day while he is a puppy.');
    expect(row.source_thread_id).toBe(THREAD_ID);
    expect(row.sources).toHaveLength(1);
    const t = toastWith(page, 'Guardado en FAQ');
    await expect(t).toBeVisible();
    await t.getByRole('button', { name: 'Ver FAQ' }).click();
    await expect(page).toHaveURL(/#\/(learn|today)/); // '#/learn/faq' (owned by the learn feature)
  });

  test('cancelling the FAQ draft saves nothing; a failed save rolls back', async ({ page }) => {
    const sb = await openApp(page, `/assistant?t=${THREAD_ID}`, { mode: 'asEditor', fixtures: threadFixtures(), failWrites: true });
    await page.getByTestId('assistant-save-faq').click();
    const sheet = page.getByTestId('faq-sheet');
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toHaveCount(0);
    expect(sb.restCalls('faq_entries', 'POST')).toHaveLength(0);

    await page.getByTestId('assistant-save-faq').click();
    await page.getByTestId('faq-confirm').click();
    await expect(toastWith(page, 'No se pudo guardar')).toBeVisible();
    await expect(page.getByTestId('faq-sheet')).toBeVisible(); // still open to try again
    expect(sb.db.faq_entries).toHaveLength(0);
  });

  test('thread list: rename and delete with confirmation', async ({ page }) => {
    const sb = await openApp(page, '/assistant/threads', { mode: 'asEditor', fixtures: threadFixtures() });
    await expect(page.getByTestId('thread-row')).toContainText('Alex');
    await page.getByTestId('thread-options').click();
    await page.getByLabel('Nombre de la conversación').fill('Comidas');
    await page.getByRole('button', { name: 'Guardar nombre' }).click();
    await expect.poll(() => sb.db.chat_threads[0].title).toBe('Comidas');
    await expect(page.getByTestId('thread-row')).toContainText('Comidas');

    await page.getByTestId('thread-options').click();
    await page.getByTestId('thread-delete').click();
    await expect(page.getByText('¿Eliminar esta conversación?')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar conversación' }).click();
    await expect.poll(() => sb.db.chat_threads.length).toBe(0);
    await expect(page.getByText('Aún no hay conversaciones')).toBeVisible();
  });

  test('a failed thread delete is rolled back', async ({ page }) => {
    const sb = await openApp(page, '/assistant/threads', { mode: 'asEditor', fixtures: threadFixtures(), failWrites: true });
    await page.getByTestId('thread-options').click();
    await page.getByTestId('thread-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar conversación' }).click();
    await expect(toastWith(page, 'No se pudo eliminar')).toBeVisible();
    await expect(page.getByTestId('thread-row')).toHaveCount(1);
    expect(sb.db.chat_threads).toHaveLength(1);
  });

  test('English UI', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor', locale: 'en' });
    await expect(page.getByRole('button', { name: 'How much should Tyler eat at 7 weeks?' })).toBeVisible();
    await expect(page.getByTestId('assistant-budget')).toContainText('used this month');
  });
});
