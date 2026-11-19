// Answers that are cut, empty or stopped (tests/e2e/supabase-mock.js mirrors the `chat` function):
// a cut answer shows a note and "Continuar"; an empty answer is an error that is never saved as a
// message and whose retry continues the saved turn (no new search); "Respuesta detenida" only after
// the person pressed stop.
import { test, expect } from 'playwright/test';
import { openApp, EDITOR_USER } from './helpers.js';
import { DEFAULT_CHAT_REPLY, DEFAULT_CHAT_REST } from './supabase-mock.js';

test.describe.configure({ timeout: 40_000 });

const THREAD_ID = 'c0000000-0000-4000-8000-000000000002';
const Q_ID = 'd0000000-0000-4000-8000-000000000001';
const by = { created_by: EDITOR_USER.id, created_by_name: 'Alex' };
const base = { sources: [], model: null, input_tokens: 0, output_tokens: 0, web_searches: 0, cost_usd: 0, ...by };
const chatCalls = (sb, action) => sb.calls.filter((c) => c.path === '/functions/v1/chat' && (!action || c.body?.action === action));
const visibleAnswers = (sb) => sb.db.chat_messages.filter((m) => m.role === 'assistant' && !(m.content || '').startsWith('<!--'));

test.describe('signed out', () => {
  test('a visitor never loads conversation rows, hidden or not', async ({ page }) => {
    const sb = await openApp(page, '/assistant');
    await expect(page.getByTestId('assistant-signed-out')).toBeVisible();
    expect(sb.restCalls('chat_messages')).toHaveLength(0);
    expect(chatCalls(sb)).toHaveLength(0);
  });
});

test.describe('editor', () => {
  test('an answer cut for length shows a note and Continuar, which completes it without searching again', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { cut: true } });
    await page.getByLabel('Tu pregunta').fill('¿Cuánto debe comer?');
    await page.getByTestId('assistant-send').click();

    const cut = page.getByTestId('assistant-cut');
    await expect(cut).toContainText('La respuesta se cortó por longitud.');
    await expect(cut).toContainText(DEFAULT_CHAT_REPLY.slice(0, 20).replace(/\*\*/g, ''));
    await expect(page.getByTestId('assistant-error')).toHaveCount(0);
    const requestId = chatCalls(sb, 'send')[0].body.request_id;

    sb.setChat({ cut: false });
    await cut.getByTestId('assistant-continue').click();
    const answer = page.locator('.msg-assistant');
    await expect(answer).toHaveCount(1);
    await expect(answer).toContainText(DEFAULT_CHAT_REST.trim());
    await expect(page.getByTestId('assistant-cut')).toHaveCount(0);
    await expect(page.getByText('La respuesta se cortó por longitud.')).toHaveCount(0);
    await expect(page.locator('.msg-user')).toHaveCount(1); // the question is not shown twice

    // The continuation resent the same request id; the mock (like the function) resumed instead of
    // asking again: one search in total, one saved answer that grew in place.
    const sends = chatCalls(sb, 'send');
    expect(sends).toHaveLength(2);
    expect(sends[1].body.request_id).toBe(requestId);
    expect(sb.chat.searches).toBe(1);
    expect(sb.chat.resumes).toBe(1);
    const answers = visibleAnswers(sb);
    expect(answers).toHaveLength(1);
    expect(answers[0].content.endsWith(DEFAULT_CHAT_REST)).toBe(true);
    expect(sb.db.chat_messages.some((m) => (m.content || '').startsWith('<!--continuation-->'))).toBe(false);
    expect(sb.pageErrors).toEqual([]);
  });

  test('an empty answer is an error, never a message; retry continues the saved turn', async ({ page }) => {
    const chat = { empty: true };
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat });
    await page.getByLabel('Tu pregunta').fill('¿Puede comer arroz?');
    await page.getByTestId('assistant-send').click();

    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'upstream_empty');
    await expect(err).toContainText('La respuesta llegó vacía');
    await expect(err).toContainText('sin repetirlas');
    await expect(page.getByText('Respuesta detenida')).toHaveCount(0);
    // The question is saved in its thread (with a failed answer), so it does not go back to the
    // composer; nothing was saved as an answer (only the question and the hidden resume point).
    await expect(page).toHaveURL(/#\/assistant\?t=/);
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.getByTestId('assistant-failed')).toContainText('La respuesta llegó vacía');
    await expect(page.getByTestId('assistant-continue')).toHaveCount(0); // the error's Retry does it
    await expect(page.getByLabel('Tu pregunta')).toHaveValue('');
    expect(visibleAnswers(sb)).toHaveLength(0);
    const requestId = chatCalls(sb, 'send')[0].body.request_id;

    sb.setChat({ empty: false });
    await err.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.msg-assistant')).toHaveCount(1);
    await expect(page.locator('.msg-assistant')).toContainText(DEFAULT_CHAT_REST.trim());
    await expect(page.getByTestId('assistant-error')).toHaveCount(0);
    await expect(page.locator('.msg-user')).toHaveCount(1);
    const sends = chatCalls(sb, 'send');
    expect(sends[1].body.request_id).toBe(requestId);
    expect(sb.chat.searches).toBe(1);
    expect(sb.chat.resumes).toBe(1);
    expect(visibleAnswers(sb)).toHaveLength(1);
    expect(sb.pageErrors).toEqual([]);
  });

  test('after a reload, a question whose answer came back empty shows a failed answer with Continuar', async ({ page }) => {
    const sb = await openApp(page, `/assistant?t=${THREAD_ID}`, {
      mode: 'asEditor',
      fixtures: {
        chat_threads: [{ id: THREAD_ID, title: '¿Arroz?', created_at: '2026-11-12T15:00:00.000Z', updated_at: '2026-11-12T15:00:00.000Z', ...by }],
        chat_messages: [
          { ...base, id: Q_ID, thread_id: THREAD_ID, role: 'user', content: '¿Puede comer arroz?', created_at: '2026-11-12T15:00:01.000Z', updated_at: '2026-11-12T15:00:01.000Z' },
          {
            ...base,
            id: 'cont-1',
            thread_id: THREAD_ID,
            role: 'assistant',
            content: `<!--continuation-->${JSON.stringify({ question_id: Q_ID, answer_id: null, reason: 'empty' })}`,
            sources: { v: 1, messages: [{ role: 'user', content: 'big turn' }] },
            created_at: '2026-11-12T15:00:09.000Z',
            updated_at: '2026-11-12T15:00:09.000Z',
          },
        ],
      },
    });
    const failed = page.getByTestId('assistant-failed');
    await expect(failed).toContainText('La respuesta llegó vacía');
    // The hidden row is loaded without its (large) turn.
    const lean = sb.restCalls('chat_messages', 'GET').find((c) => c.search.includes('content=like.'));
    expect(lean.search).toContain('select=id%2Cthread_id%2Crole%2Ccontent%2Ccreated_at');
    await failed.getByTestId('assistant-continue').click();
    await expect(page.locator('.msg-assistant')).toContainText(DEFAULT_CHAT_REST.trim());
    await expect(page.getByTestId('assistant-failed')).toHaveCount(0);
    expect(chatCalls(sb, 'send')[0].body.request_id).toBe(Q_ID);
    await expect(page.locator('.msg-user')).toHaveCount(1);
  });

  test('an old empty answer row is shown as failed, not as stopped', async ({ page }) => {
    await openApp(page, `/assistant?t=${THREAD_ID}`, {
      mode: 'asEditor',
      fixtures: {
        chat_threads: [{ id: THREAD_ID, title: 'Vieja', created_at: '2026-11-12T15:00:00.000Z', updated_at: '2026-11-12T15:00:00.000Z', ...by }],
        chat_messages: [
          { ...base, id: 'u1', thread_id: THREAD_ID, role: 'user', content: '¿Hola?', created_at: '2026-11-12T15:00:01.000Z', updated_at: '2026-11-12T15:00:01.000Z' },
          { ...base, id: 'a1', thread_id: THREAD_ID, role: 'assistant', content: '', model: 'claude-sonnet-5-5', web_searches: 2, cost_usd: 0.084, created_at: '2026-11-12T15:00:05.000Z', updated_at: '2026-11-12T15:00:05.000Z' },
        ],
      },
    });
    const failed = page.getByTestId('assistant-failed');
    await expect(failed).toContainText('No llegó la respuesta. Vuelve a preguntar.');
    await expect(failed.getByTestId('assistant-continue')).toHaveCount(0);
    await expect(page.getByText('Respuesta detenida')).toHaveCount(0);
    // An empty row is not an answer: nothing to save in the FAQ.
    await expect(page.getByTestId('assistant-save-faq')).toHaveCount(0);
  });

  test('pressing stop before any text shows "Respuesta detenida" and keeps the question', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { waitFor: new Promise(() => {}) } });
    await page.getByLabel('Tu pregunta').fill('¿Cuándo lo vacuno?');
    await page.getByTestId('assistant-send').click();
    await expect(page.getByTestId('assistant-streaming')).toBeVisible();
    await page.getByTestId('assistant-stop').click();
    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'stopped');
    await expect(err).toContainText('Respuesta detenida');
    await expect(page.getByLabel('Tu pregunta')).toHaveValue('¿Cuándo lo vacuno?');
    await expect(page.getByTestId('assistant-streaming')).toHaveCount(0);
    expect(sb.db.chat_messages).toHaveLength(0);
    await expect(page).toHaveURL(/#\/assistant$/);
  });
});
