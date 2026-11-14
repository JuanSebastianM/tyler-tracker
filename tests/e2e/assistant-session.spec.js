// Launch-day fixes for the assistant: session-safe requests (refresh + retry), stalled streams,
// idempotent retries, drafts that survive reloads, and a layout where the composer never hides the
// newest message or error. Against the mocked `chat` function (tests/e2e/supabase-mock.js).
import { test, expect } from 'playwright/test';
import { openApp, mockSupabase, toastWith, FIXED_NOW } from './helpers.js';
import { AUTH_STORAGE_KEY, makeSession } from './supabase-mock.js';

test.describe.configure({ timeout: 60_000 });

// Review screenshots (set REVIEW_DIR to keep them elsewhere); test-results/ is not committed.
const SHOTS = process.env.REVIEW_DIR || 'test-results/review-fix-update-session';
const chatCalls = (sb, action) => sb.calls.filter((c) => c.path === '/functions/v1/chat' && (!action || c.body?.action === action));
const input = (page) => page.getByLabel('Tu pregunta');
const ask = async (page, q) => {
  await input(page).fill(q);
  await page.getByTestId('assistant-send').click();
};
/** Shorten the app's stall timeout (45 s in production). */
const fastStall = (page, ms = 1500) =>
  page.evaluate((v) => import('/src/features/assistant/api.js').then((m) => m.configureChat({ stallMs: v })), ms);
/**
 * The chat asks for its usage (`status`) when it opens. Tests that then change how the session or
 * the function answer (expired token, rejected refresh, one-time 401) must wait for that call to be
 * answered first, or the change can hit `status` instead of the question: a rejected refresh then
 * signs the editor out before the question is typed (CI flake), a one-time 401 is used up early.
 */
const usageLoaded = (page) => expect(page.getByTestId('assistant-budget')).toContainText('usados este mes');
/** Put an expired session in storage, as when iOS kept the app suspended past the token's expiry. */
const expireStoredToken = (page, nowMs) =>
  page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [AUTH_STORAGE_KEY, makeSession(nowMs - 3700_000)]);

test.describe('session', () => {
  test('a 401 from the gateway refreshes the session and retries once: no "signed out"', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor' });
    await usageLoaded(page); // else the one-time 401 can hit `status` and the question goes out once
    sb.setChat({ unauthorizedOnce: true });
    await ask(page, '¿Cuánta agua?');
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día');
    const sends = chatCalls(sb, 'send');
    expect(sends).toHaveLength(2);
    expect(sends[1].token).not.toBe(sends[0].token);
    expect(sends[1].body.request_id).toBe(sends[0].body.request_id);
    expect(sb.refreshCalls()).toHaveLength(1);
    await expect(page.getByTestId('assistant-error')).toHaveCount(0);
  });

  test('a token that expired while the app was suspended is refreshed before the question is sent', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor' });
    await usageLoaded(page);
    await expireStoredToken(page, Date.parse(FIXED_NOW));
    const before = sb.refreshCalls().length;
    await ask(page, '¿Puede salir?');
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día');
    expect(sb.refreshCalls().length).toBeGreaterThan(before);
    const send = chatCalls(sb, 'send')[0];
    expect(JSON.parse(Buffer.from(send.token.split('.')[1], 'base64url').toString()).exp * 1000).toBeGreaterThan(Date.parse(FIXED_NOW));
  });

  test('refresh impossible for lack of network: "no connection", still signed in, question kept', async ({ page }) => {
    // Real clock: supabase-js gives up retrying a refresh after ~30 s of real time.
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', now: null, refresh: 'network' });
    await usageLoaded(page);
    await expireStoredToken(page, Date.now());
    await ask(page, '¿Cuándo le toca la vacuna?');
    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'network', { timeout: 30_000 });
    await expect(err).toContainText('Tu sesión sigue activa');
    await expect(input(page)).toHaveValue('¿Cuándo le toca la vacuna?');
    await expect(page.getByTestId('header-editor')).toBeVisible();
    await expect(page.getByTestId('assistant-signed-out')).toHaveCount(0);
    expect(chatCalls(sb, 'send')).toHaveLength(0);
    await page.screenshot({ path: `${SHOTS}/network-error-session-kept.png` });
  });

  test('a launch with an expired token and no network stays signed in', async ({ page }) => {
    await mockSupabase(page, { mode: 'asEditor', now: null, refresh: 'network' });
    await page.addInitScript(([k, v]) => {
      localStorage.setItem(k, JSON.stringify(v));
      localStorage.setItem(`tt.editor.${v.user.id}`, JSON.stringify('Alex')); // known editor on this device
    }, [AUTH_STORAGE_KEY, makeSession(Date.now() - 3700_000)]);
    await page.goto('./#/assistant');
    await expect(page.getByTestId('assistant-chat')).toBeVisible();
    await expect(page.getByTestId('header-editor')).toBeVisible();
    await page.waitForTimeout(9000); // past the boot's session check
    await expect(page.getByTestId('assistant-signed-out')).toHaveCount(0);
    await expect(page.getByTestId('header-editor')).toBeVisible();
  });

  test('a rejected refresh token ends the session: told once, sign in returns to the question', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor' });
    await usageLoaded(page); // else `status` can meet the rejected refresh before the question is typed
    sb.setRefresh('invalid');
    await expireStoredToken(page, Date.parse(FIXED_NOW));
    await ask(page, '¿Cuántas horas duerme?');
    await expect(toastWith(page, 'Tu sesión terminó')).toBeVisible();
    await expect(page.getByTestId('assistant-signed-out')).toBeVisible();
    expect(chatCalls(sb, 'send')).toHaveLength(0);
    await page.screenshot({ path: `${SHOTS}/session-ended.png` });
    // Sign in again from the same screen: the question is back in the composer.
    sb.setRefresh('ok');
    await page.getByTestId('assistant-signed-out').getByRole('button', { name: 'Iniciar sesión' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Correo').fill('editor@example.test');
    await dialog.getByLabel('Contraseña').fill('correct-password');
    await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByTestId('assistant-chat')).toBeVisible();
    await expect(page).toHaveURL(/#\/assistant$/);
    await expect(input(page)).toHaveValue('¿Cuántas horas duerme?');
  });

  test('a write rejected with "JWT expired" refreshes and is saved, no rollback', async ({ page }) => {
    const sb = await openApp(page, '/today', { mode: 'asEditor', jwtExpiredOnce: true });
    await page.getByRole('button', { name: 'Registrar comida 2', exact: true }).click();
    await expect.poll(() => sb.db.feedings.filter((f) => f.meal_slot === 2).length).toBeGreaterThan(0);
    const posts = sb.restCalls('feedings', 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].token).not.toBe(posts[0].token);
    await expect(toastWith(page, 'No se pudo guardar')).toHaveCount(0);
  });
});

test.describe('resume (iOS suspends the installed app)', () => {
  test('frozen with an expired token and no network on resume: stays signed in, keeps data, refreshes once online', async ({ page, context }) => {
    const THREAD = 'c0000000-0000-4000-8000-000000000002';
    const by = { created_by: '00000000-0000-4000-8000-0000000000e1', created_by_name: 'Alex' };
    const sb = await openApp(page, '/assistant/threads', {
      mode: 'asEditor',
      now: null,
      fixtures: { chat_threads: [{ id: THREAD, title: 'Comidas', created_at: '2026-11-12T15:00:00.000Z', updated_at: '2026-11-12T15:00:00.000Z', ...by }], chat_messages: [] },
    });
    await expect(page.getByTestId('thread-row')).toContainText('Comidas');
    // Suspend: the token expires meanwhile, and the network is not back yet when the app resumes.
    await expireStoredToken(page, Date.now());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await context.setOffline(true);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('header-editor')).toBeVisible();
    await expect(page.getByTestId('thread-row')).toContainText('Comidas'); // not wiped by an anonymous read
    const refreshesBefore = sb.refreshCalls().length;
    const threadLoadsBefore = sb.restCalls('chat_threads', 'GET').length;
    await context.setOffline(false); // 'online': refresh the session, then the data
    await expect.poll(() => sb.refreshCalls().length).toBeGreaterThan(refreshesBefore);
    await expect.poll(() => sb.restCalls('chat_threads', 'GET').length).toBeGreaterThan(threadLoadsBefore);
    const last = sb.restCalls('chat_threads', 'GET').at(-1);
    expect(JSON.parse(Buffer.from(last.token.split('.')[1], 'base64url').toString()).exp * 1000).toBeGreaterThan(Date.now());
    await expect(page.getByTestId('thread-row')).toContainText('Comidas');
    await expect(page.getByTestId('header-editor')).toBeVisible();
  });
});

test.describe('stalls, reloads and retries', () => {
  test('a stalled answer: stop waiting, check the thread, keep the question; retry reuses the request id', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { stall: 'before-save' } });
    await fastStall(page);
    await ask(page, '¿Qué juguetes le sirven?');
    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'timeout', { timeout: 10_000 });
    await expect(err).toContainText('La respuesta dejó de llegar');
    await expect(input(page)).toHaveValue('¿Qué juguetes le sirven?');
    expect(sb.calls.some((c) => c.path === '/rest/v1/chat_messages' && c.search.includes('id=eq.'))).toBe(true);
    await expect(page).toHaveURL(/#\/assistant$/); // the new conversation was never saved
    await page.screenshot({ path: `${SHOTS}/stalled-answer.png` });

    sb.setChat({ stall: undefined });
    await err.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día');
    await expect(input(page)).toHaveValue('');
    const sends = chatCalls(sb, 'send');
    expect(sends).toHaveLength(2);
    expect(sends[1].body.request_id).toBe(sends[0].body.request_id);
    expect(sends[1].body.thread_id).toBeNull();
  });

  test('stalled after the server saved the answer: it is shown without asking again', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { stall: 'after-save' } });
    await fastStall(page);
    await ask(page, '¿Cuánto pesa a las 8 semanas?');
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día', { timeout: 10_000 });
    await expect(page.getByTestId('assistant-error')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/assistant\?t=/);
    expect(chatCalls(sb, 'send')).toHaveLength(1);
    await expect(input(page)).toHaveValue('');
  });

  test('the app reloads mid-answer: the question comes back with a retry, nothing asked twice', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { stall: 'before-save' } });
    await ask(page, '¿Le puedo dar zanahoria?');
    await expect(page.getByTestId('assistant-streaming')).toBeVisible();
    await page.reload();
    const err = page.getByTestId('assistant-error');
    await expect(err).toHaveAttribute('data-code', 'interrupted');
    await expect(input(page)).toHaveValue('¿Le puedo dar zanahoria?');
    await expect(page).toHaveURL(/#\/assistant$/);
    sb.setChat({ stall: undefined });
    await err.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día');
    const sends = chatCalls(sb, 'send');
    expect(sends[1].body.request_id).toBe(sends[0].body.request_id);
  });

  test('the app reloads after the answer was saved: it is shown, the retry would only replay it', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { stall: 'after-save' } });
    await ask(page, '¿Cuándo lo baño?');
    await expect(page.getByTestId('assistant-streaming')).toBeVisible();
    await page.reload();
    await expect(page.locator('.msg-assistant').last()).toContainText('4 veces al día');
    await expect(page.getByTestId('assistant-error')).toHaveCount(0);
    expect(chatCalls(sb, 'send')).toHaveLength(1);
  });

  test('offline: says so, keeps the question', async ({ page, context }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor' });
    await context.setOffline(true);
    await ask(page, '¿Qué hago si vomita?');
    await expect(page.getByTestId('assistant-error')).toHaveAttribute('data-code', 'offline');
    await expect(page.getByTestId('assistant-error')).toContainText('Estás sin conexión');
    await expect(input(page)).toHaveValue('¿Qué hago si vomita?');
    expect(chatCalls(sb, 'send')).toHaveLength(0);
    await context.setOffline(false);
  });

  test('in progress elsewhere: waits for the saved answer', async ({ page }) => {
    const sb = await openApp(page, '/assistant', { mode: 'asEditor', chat: { inProgress: true } });
    await ask(page, '¿Por qué llora de noche?');
    await expect(page.getByText('Comprobando si la respuesta se guardó')).toBeVisible();
    expect(chatCalls(sb, 'send')).toHaveLength(1);
  });
});

test.describe('drafts', () => {
  test('typed text survives a reload, per conversation', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await input(page).fill('Pregunta a medio escribir');
    await page.reload();
    await expect(input(page)).toHaveValue('Pregunta a medio escribir');
    await page.goto('./#/assistant?t=c0000000-0000-4000-8000-0000000000ff');
    await expect(input(page)).toHaveValue('');
    await page.goto('./#/assistant');
    await expect(input(page)).toHaveValue('Pregunta a medio escribir');
  });

  test('signing out forgets drafts', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await input(page).fill('Algo privado');
    await page.goto('./#/profile');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    expect(await page.evaluate(() => localStorage.getItem('tt.assistant.drafts'))).toBeNull();
  });
});

test.describe('layout: the composer never hides the newest item', () => {
  const LONG = 'Primera línea de la pregunta\nsegunda línea\ntercera línea\ncuarta línea\nquinta línea\nsexta línea\nséptima línea\noctava línea';

  /**
   * The element's bottom edge is above the composer's top edge once the layout has settled. The
   * composer grows with the text, a ResizeObserver reports it on the next frame, and only then does
   * the chat reserve the space and follow the end; measuring before that (as this test used to, right
   * after `fill`) caught the page mid-update and failed now and then. "Settled" is observable: the
   * textarea is at its grown height and `--composer-space` matches the composer's current height.
   * Both boxes are read in one evaluate, so they come from the same layout.
   */
  const clearOfComposer = async (page, locator) => {
    const measure = () =>
      locator.evaluate((el) => {
        const form = /** @type {HTMLElement} */ (document.querySelector('[data-testid="assistant-composer"]'));
        const ta = /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea'));
        const grown = ta.scrollHeight <= ta.clientHeight + 1 || ta.offsetHeight >= parseFloat(getComputedStyle(ta).maxHeight) - 1;
        const reserved = document.documentElement.style.getPropertyValue('--composer-space') === `${Math.ceil(form.offsetHeight)}px`;
        const overlap = el.getBoundingClientRect().bottom - (form.getBoundingClientRect().top + 1);
        return { settled: grown && reserved, overlap: Math.max(0, Math.round(overlap)) };
      });
    await expect.poll(measure, { message: 'the element ends above the settled composer' }).toEqual({ settled: true, overlap: 0 });
  };

  for (const scheme of ['light', 'dark']) {
    test(`an error stays reachable while a multi-line question is typed (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page, '/assistant', { mode: 'asEditor', chat: { refuse: 'server_error' } });
      await ask(page, '¿Qué vacunas le faltan?');
      const err = page.getByTestId('assistant-error');
      await expect(err).toBeVisible();
      await input(page).fill(LONG);
      const dismiss = err.getByRole('button', { name: 'Descartar' });
      await expect(dismiss).toBeInViewport();
      await clearOfComposer(page, dismiss);
      await page.screenshot({ path: `${SHOTS}/error-above-multiline-composer-${scheme}.png` });
      await dismiss.click(); // fails if the composer covers it
      await expect(err).toHaveCount(0);
      await expect(input(page)).toHaveValue(LONG);
    });
  }

  test('the composer has a maximum height and scrolls inside', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await input(page).fill(Array.from({ length: 30 }, (_, i) => `línea ${i + 1}`).join('\n'));
    const h = await input(page).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(h.client).toBeLessThanOrEqual(162);
    expect(h.scroll).toBeGreaterThan(h.client);
  });

  test('starter questions end above a grown composer', async ({ page }) => {
    await openApp(page, '/assistant', { mode: 'asEditor' });
    await input(page).fill(LONG);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await clearOfComposer(page, page.locator('.chat-starter').last());
  });

  test('a long answer ends above the composer', async ({ page }) => {
    const reply = Array.from({ length: 14 }, (_, i) => `Párrafo ${i + 1}: Tyler necesita rutina, descanso y paciencia.`).join('\n\n');
    await openApp(page, '/assistant', { mode: 'asEditor', chat: { reply, sources: [] } });
    await ask(page, '¿Cómo es un buen día para él?');
    await expect(page.locator('.msg-assistant').last()).toContainText('Párrafo 14');
    // The streamed bubble matches the text above too; wait for the saved answer that replaces it.
    await expect(page.getByTestId('assistant-streaming')).toHaveCount(0);
    await input(page).fill(LONG);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await clearOfComposer(page, page.locator('.msg-assistant .md p').last());
    await page.screenshot({ path: `${SHOTS}/long-answer-multiline-composer.png` });
  });
});
