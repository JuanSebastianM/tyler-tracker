// Service worker updates against the BUILT site (scripts/build-site.mjs), two deploys in a row:
// a new version never reloads the app while an answer is streaming, a sheet is open or text is typed;
// it shows the "new version" notice and applies when accepted (after in-flight work) or at the next
// launch. Old and new modules never mix: after the update every module is the new version's.
import { test, expect } from 'playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSupabase, toastWith } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.E2E_PORT || 4173) + 1;
const BASE = `http://127.0.0.1:${PORT}/`;

test.describe.configure({ mode: 'serial', timeout: 60_000 });
test.use({ serviceWorkers: 'allow', baseURL: BASE });

let dir = '';
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

/** Build the site into the served folder as the deploy of commit `sha`. */
function deploy(sha) {
  execFileSync(process.execPath, ['scripts/build-site.mjs', dir], { cwd: ROOT, env: { ...process.env, GITHUB_SHA: sha }, stdio: 'ignore' });
  return sha.slice(0, 7);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tt-sw-'));
  deploy('aaaaaaa0000000000000000000000000000000000');
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(PORT), '--root', dir], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}index.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const runningVersion = (page) => page.evaluate(() => import('./src/version.js').then((m) => m.APP_VERSION));

/** Open the app with the service worker on and wait until it controls the page. */
async function openControlled(page, path, opts = {}) {
  const sb = await mockSupabase(page, { mode: 'asEditor', now: null, ...opts });
  await page.goto(`./?sw=on#${path}`);
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  // Mark this document: a reload would lose the mark.
  await page.evaluate(() => {
    /** @type {any} */ (window).__noReload = true;
  });
  return sb;
}

/** Ask the browser to check for the new deploy and wait until it is installed and waiting. */
async function installUpdate(page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    for (let i = 0; i < 100 && !reg.waiting; i++) await new Promise((r) => setTimeout(r, 100));
    if (!reg.waiting) throw new Error('the new version did not install');
  });
}

const notReloaded = (page) => page.evaluate(() => /** @type {any} */ (window).__noReload === true);

/** The app goes to the background (the "idle moment" check). */
const goBackground = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

test('an update waits while an answer is streaming, then applies when accepted', async ({ page }) => {
  const v1 = deploy('aaaaaaa0000000000000000000000000000000000');
  /** @type {() => void} */
  let finishAnswer = () => {};
  const answerHeld = new Promise((r) => (finishAnswer = () => r(undefined)));
  await openControlled(page, '/assistant', { chat: { waitFor: answerHeld } });
  expect(await runningVersion(page)).toMatch(new RegExp(`^${v1}-`));

  await page.getByLabel('Tu pregunta').fill('¿Cuánto duerme?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-streaming')).toBeVisible();

  const v2 = deploy('bbbbbbb0000000000000000000000000000000000');
  await installUpdate(page);
  await goBackground(page); // even "in the background" it must not reload mid-answer
  await expect(toastWith(page, 'Hay una versión nueva')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await notReloaded(page)).toBe(true);
  await expect(page.getByTestId('assistant-streaming')).toBeVisible();

  // Accepting while the answer is in flight waits for it.
  await toastWith(page, 'Hay una versión nueva').getByRole('button', { name: 'Actualizar' }).click();
  await expect(toastWith(page, 'Se actualizará en cuanto termine')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await notReloaded(page)).toBe(true);

  // The answer arrives and is saved: now the update applies, with the new version's modules only.
  finishAnswer();
  await expect(toastWith(page, 'La app se actualizó')).toBeVisible({ timeout: 20_000 });
  expect(await notReloaded(page)).toBe(false);
  expect(await runningVersion(page)).toMatch(new RegExp(`^${v2}-`));
  const versions = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { keys: await caches.keys(), active: reg?.active?.scriptURL };
  });
  expect(versions.keys.filter((k) => k.startsWith('tt-shell-'))).toEqual([expect.stringContaining(v2)]);
});

test('typed text or an open sheet holds the update; going to the background with nothing at stake applies it', async ({ page }) => {
  const v3 = deploy('ccccccc0000000000000000000000000000000000');
  await openControlled(page, '/assistant');
  await page.getByLabel('Tu pregunta').fill('Pregunta sin enviar');
  const v4 = deploy('ddddddd0000000000000000000000000000000000');
  await installUpdate(page);
  await expect(toastWith(page, 'Hay una versión nueva')).toBeVisible();
  await goBackground(page);
  await page.waitForTimeout(500);
  expect(await notReloaded(page)).toBe(true);
  expect(await runningVersion(page)).toMatch(new RegExp(`^${v3}-`));

  // Text gone, but a sheet is open: still held.
  await page.getByLabel('Tu pregunta').fill('');
  await page.getByTestId('header-editor').click();
  await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await goBackground(page);
  await page.waitForTimeout(500);
  expect(await notReloaded(page)).toBe(true);

  // Nothing at stake: the background moment applies it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await goBackground(page);
  await expect(toastWith(page, 'La app se actualizó')).toBeVisible({ timeout: 15_000 });
  expect(await runningVersion(page)).toMatch(new RegExp(`^${v4}-`));
});

test('accepting with typed text applies it and the draft survives; a waiting version applies on the next launch', async ({ page }) => {
  deploy('eeeeeee0000000000000000000000000000000000');
  await openControlled(page, '/assistant');
  await page.getByLabel('Tu pregunta').fill('No pierdas esto');
  const v6 = deploy('fffffff0000000000000000000000000000000000');
  await installUpdate(page);
  await toastWith(page, 'Hay una versión nueva').getByRole('button', { name: 'Actualizar' }).click();
  await expect(toastWith(page, 'La app se actualizó')).toBeVisible({ timeout: 15_000 });
  expect(await runningVersion(page)).toMatch(new RegExp(`^${v6}-`));
  await expect(page.getByLabel('Tu pregunta')).toHaveValue('No pierdas esto');

  // The next deploy installs while the person is typing; they close the app; the next launch
  // (a fresh page, like iOS relaunching the app) applies it before rendering.
  const v7 = deploy('1111111000000000000000000000000000000000');
  await installUpdate(page);
  const context = page.context();
  await page.close();
  const next = await context.newPage();
  await mockSupabase(next, { mode: 'asEditor', now: null });
  await next.goto('./?sw=on#/assistant');
  await expect(next.locator('.tabbar')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => runningVersion(next), { timeout: 15_000 }).toMatch(new RegExp(`^${v7}-`));
  await expect(next.getByLabel('Tu pregunta')).toHaveValue('No pierdas esto');
});

test('resuming the installed app with an update waiting does not reload it mid-answer (launch-day bug)', async ({ page }) => {
  deploy('2222222000000000000000000000000000000000');
  await openControlled(page, '/assistant', { chat: { stall: 'before-save' } });
  await page.reload(); // a later launch: the page starts controlled, like the installed app
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.evaluate(() => {
    /** @type {any} */ (window).__noReload = true;
  });
  await page.getByLabel('Tu pregunta').fill('¿Cuánto duerme?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-streaming')).toBeVisible();
  deploy('3333333000000000000000000000000000000000');
  await installUpdate(page); // installed while the app was in the background
  // iOS resumes the app: the launch-day code treated this as a fresh launch and reloaded.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(toastWith(page, 'Hay una versión nueva')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await notReloaded(page)).toBe(true);
  await expect(page.getByTestId('assistant-streaming')).toBeVisible();
});
