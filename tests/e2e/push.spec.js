// Ajustes → Notificaciones: the enable flow from a tap, toggles (with rollback), test notification,
// and the not-installed, unsupported, denied and lost states. The browser's push machinery
// (service worker registration, PushManager, Notification permission) is faked in the page, and the
// `push` Edge Function is mocked (push-fixtures.js); the real service worker is covered by push-sw.spec.js.
import { test, expect } from 'playwright/test';
import { toastWith, EDITOR_USER } from './helpers.js';
import { openSettings, IPHONE_UA } from './push-fixtures.js';

const section = (page) => page.getByTestId('push-settings');
const browserState = (page) => page.evaluate(() => window.__push);

test('visitors see no notification settings', async ({ page }) => {
  await openSettings(page, { mode: 'signedOut' });
  await expect(page.getByTestId('settings-card')).toBeVisible();
  await expect(section(page)).toHaveCount(0);
});

test('editor turns notifications on from a tap, switches meals off and sends a test', async ({ page }) => {
  const { push } = await openSettings(page);
  await expect(section(page)).toContainText('Notificaciones');
  await expect(section(page)).toContainText('vacunas');
  const enable = page.getByTestId('push-enable');
  await expect(enable).toHaveText('Activar en este teléfono');
  // Nothing is asked before the tap.
  expect((await browserState(page)).prompts).toBe(0);
  await enable.click();
  await expect(toastWith(page, 'Notificaciones activadas en este teléfono')).toBeVisible();
  const b = await browserState(page);
  expect(b.prompts).toBe(1);
  expect(b.subscribeCalls).toEqual([{ userVisibleOnly: true, keyLength: 65 }]);
  const saved = push.calls.find((c) => c.action === 'subscribe');
  expect(saved.subscription.endpoint).toBe('https://web.push.apple.com/fake-1');
  expect(saved.locale).toBe('es');
  await expect(section(page).getByText('Activas')).toBeVisible();

  const meals = page.getByRole('switch', { name: /Comidas/ });
  const due = page.getByRole('switch', { name: /Vencimientos/ });
  await expect(meals).toHaveAttribute('aria-checked', 'true');
  await expect(due).toHaveAttribute('aria-checked', 'true');
  await meals.click();
  await expect(meals).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => push.subs.get('https://web.push.apple.com/fake-1')?.meals).toBe(false);
  expect(push.calls.at(-1)).toEqual({ action: 'update_prefs', endpoint: 'https://web.push.apple.com/fake-1', meals: false });

  await page.getByTestId('push-test').click();
  await expect(toastWith(page, 'Prueba enviada')).toBeVisible();
  expect(push.calls.at(-1)).toEqual({ action: 'test', endpoint: 'https://web.push.apple.com/fake-1' });

  // Survives a reload: the launch check finds the subscription on both sides.
  await page.reload();
  await expect(section(page).getByText('Activas')).toBeVisible();
  await expect(page.getByRole('switch', { name: /Comidas/ })).toHaveAttribute('aria-checked', 'false');

  await page.getByTestId('push-disable').click();
  await expect(toastWith(page, 'Notificaciones desactivadas')).toBeVisible();
  await expect(page.getByTestId('push-enable')).toBeVisible();
  expect(push.subs.size).toBe(0);
});

test('a toggle that fails to save goes back, with an error', async ({ page }) => {
  const endpoint = 'https://web.push.apple.com/known';
  const { push } = await openSettings(page, { browser: { permission: 'granted', existing: endpoint, record: endpoint }, fn: { known: [endpoint] } });
  const due = page.getByRole('switch', { name: /Vencimientos/ });
  await expect(due).toHaveAttribute('aria-checked', 'true');
  push.failWrites = true;
  await due.click();
  await expect(toastWith(page, 'Algo falló en el servidor')).toBeVisible();
  await expect(due).toHaveAttribute('aria-checked', 'true');
  expect(push.subs.get(endpoint).due).toBe(true);
});

test('saving the subscription fails: the browser subscription is rolled back', async ({ page }) => {
  const { push } = await openSettings(page, { fn: { failWrites: true } });
  await page.getByTestId('push-enable').click();
  await expect(toastWith(page, 'Algo falló en el servidor')).toBeVisible();
  await expect(page.getByTestId('push-enable')).toBeVisible();
  const b = await browserState(page);
  expect(b.unsubscribed).toBe(1);
  expect(b.current).toBeNull();
  expect(push.subs.size).toBe(0);
});

test('denying the permission at the prompt shows how to re-enable it in iOS Settings', async ({ page }) => {
  await openSettings(page, { browser: { answer: 'denied' } });
  await page.getByTestId('push-enable').click();
  const denied = page.getByTestId('push-denied');
  await expect(denied).toBeVisible();
  await expect(denied).toContainText('Ajustes');
  await expect(denied).toContainText('Permitir notificaciones');
  await expect(page.getByTestId('push-enable')).toHaveCount(0);
});

test('permission already blocked: the denied state at launch', async ({ page }) => {
  const { push } = await openSettings(page, { browser: { permission: 'denied' }, locale: 'en' });
  await expect(page.getByTestId('push-denied')).toContainText('Notifications are blocked');
  expect(push.calls.some((c) => c.action === 'subscribe')).toBe(false);
});

test('iPhone Safari tab: explains it must be installed to the Home Screen first', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'es-CO', serviceWorkers: 'block' });
  const page = await context.newPage();
  await openSettings(page, { browser: { noPush: true } });
  const install = page.getByTestId('push-install');
  await expect(install).toBeVisible();
  await expect(install).toContainText('Agregar a inicio');
  await expect(install).toContainText('iOS 16.4');
  await expect(page.getByTestId('push-enable')).toHaveCount(0);
  await context.close();
});

test('a browser without Web Push says so', async ({ page }) => {
  await openSettings(page, { browser: { noPush: true } });
  await expect(page.getByTestId('push-unsupported')).toBeVisible();
});

test('launch: a subscription the server lost is renewed without a tap', async ({ page }) => {
  const endpoint = 'https://web.push.apple.com/old';
  const { push } = await openSettings(page, { browser: { permission: 'granted', existing: endpoint, record: endpoint } });
  await expect(section(page).getByText('Activas')).toBeVisible();
  const saved = push.calls.find((c) => c.action === 'subscribe');
  expect(saved.subscription.endpoint).toBe('https://web.push.apple.com/fake-1');
  expect(push.subs.has(endpoint)).toBe(false);
  expect((await browserState(page)).unsubscribed).toBe(1);
});

test('launch: lost subscription without permission asks for a tap to turn it back on', async ({ page }) => {
  await openSettings(page, { browser: { permission: 'default', record: 'https://web.push.apple.com/gone' } });
  await expect(page.getByTestId('push-lost')).toBeVisible();
  await page.getByTestId('push-enable').click();
  await expect(section(page).getByText('Activas')).toBeVisible();
});

test('test notification for a subscription the push service dropped: lost state', async ({ page }) => {
  const endpoint = 'https://web.push.apple.com/known';
  const { push } = await openSettings(page, { browser: { permission: 'granted', existing: endpoint, record: endpoint }, fn: { known: [endpoint] } });
  push.testStatus = 410;
  await page.getByTestId('push-test').click();
  await expect(toastWith(page, 'ya no recibe avisos')).toBeVisible();
  await expect(page.getByTestId('push-lost')).toBeVisible();
});

test('changing the app language updates the notification language', async ({ page }) => {
  const endpoint = 'https://web.push.apple.com/known';
  const { push } = await openSettings(page, { browser: { permission: 'granted', existing: endpoint, record: endpoint }, fn: { known: [endpoint] } });
  await expect(section(page).getByText('Activas')).toBeVisible();
  await page.getByRole('radio', { name: 'English' }).click();
  await expect.poll(() => push.subs.get(endpoint).locale).toBe('en');
  await expect(section(page)).toContainText('Notifications');
});

// ---- Sign-out: this phone stops getting alerts ----
const KNOWN = 'https://web.push.apple.com/known';
const enabled = { browser: { permission: 'granted', existing: KNOWN, record: KNOWN }, fn: { known: [KNOWN] } };
const recordOf = (page) => page.evaluate((k) => localStorage.getItem(k), `tt.push.device.${EDITOR_USER.id}`);

async function signOutFromProfile(page) {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(toastWith(page, 'Sesión cerrada')).toBeVisible();
  await expect(page.getByTestId('header-editor')).toHaveCount(0);
}

test('signing out unsubscribes this phone; signing in again shows notifications off', async ({ page }) => {
  const { push } = await openSettings(page, enabled);
  await expect(section(page).getByText('Activas')).toBeVisible();
  await signOutFromProfile(page);
  const b = await browserState(page);
  expect(b.current).toBeNull();
  expect(b.unsubscribed).toBe(1);
  expect(push.subs.size).toBe(0);
  expect(push.calls.at(-1)).toEqual({ action: 'unsubscribe', endpoint: KNOWN });
  expect(await recordOf(page)).toBeNull();
  await expect(section(page)).toHaveCount(0);

  await page.getByTestId('header-sign-in').click();
  const dialog = page.getByRole('dialog', { name: 'Iniciar sesión' });
  await dialog.getByLabel('Correo').fill('editor@example.test');
  await dialog.getByLabel('Contraseña').fill('correct-password');
  await dialog.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(dialog).toBeHidden();
  // Honest state: off, with the button; nothing re-subscribed without a tap.
  await expect(page.getByTestId('push-enable')).toHaveText('Activar en este teléfono');
  expect((await browserState(page)).subscribeCalls).toHaveLength(0);
  expect(push.calls.some((c) => c.action === 'subscribe')).toBe(false);
});

test('signing out without a connection to the function still signs out at once and silences the phone', async ({ page }) => {
  const { push } = await openSettings(page, enabled);
  await expect(section(page).getByText('Activas')).toBeVisible();
  push.down = true;
  const started = Date.now();
  await signOutFromProfile(page);
  expect(Date.now() - started).toBeLessThan(4000);
  const b = await browserState(page);
  expect(b.current).toBeNull(); // the push service now rejects the endpoint; the server drops its row on the next send
  expect(push.subs.has(KNOWN)).toBe(true);
  expect(await recordOf(page)).toBeNull();
});

test('launch with nobody signed in: a leftover subscription is dropped locally', async ({ page }) => {
  await openSettings(page, { mode: 'signedOut', browser: { permission: 'granted', existing: KNOWN } });
  await expect.poll(async () => (await browserState(page)).current).toBeNull();
  expect((await browserState(page)).unsubscribed).toBe(1);
});
