import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t, registerStrings, resetStrings, setLocale, getLocale, pick, formatDate, formatClock, formatTime, formatNumber, formatRelativeDay } from '../../src/lib/i18n.js';

beforeEach(() => {
  resetStrings();
  setLocale('es');
  registerStrings('es', null, { common: { save: 'Guardar' }, hi: 'Hola, {name}', n: { one: '{count} semana', other: '{count} semanas', zero: 'Ninguna' } });
  registerStrings('en', null, { common: { save: 'Save' }, hi: 'Hi, {name}', n: { one: '{count} week', other: '{count} weeks' } });
  registerStrings('es', 'today', { title: 'Hoy', onlyEs: 'Solo español' });
  registerStrings('en', 'today', { title: 'Today' });
});

test('defaults to Spanish', () => {
  assert.equal(getLocale(), 'es');
  assert.equal(t('common.save'), 'Guardar');
});

test('interpolation and missing vars', () => {
  assert.equal(t('hi', { name: 'Tyler' }), 'Hola, Tyler');
  assert.equal(t('hi'), 'Hola, {name}');
});

test('plurals, including zero form', () => {
  assert.equal(t('n', { count: 1 }), '1 semana');
  assert.equal(t('n', { count: 7 }), '7 semanas');
  assert.equal(t('n', { count: 0 }), 'Ninguna');
  setLocale('en');
  assert.equal(t('n', { count: 1 }), '1 week');
  assert.equal(t('n', { count: 0 }), '0 weeks');
});

test('feature namespaces, locale switch, fallback to Spanish, missing key returns key', () => {
  assert.equal(t('today.title'), 'Hoy');
  setLocale('en');
  assert.equal(t('today.title'), 'Today');
  assert.equal(t('today.onlyEs'), 'Solo español');
  assert.equal(t('nope.key'), 'nope.key');
});

test('setLocale ignores unknown locales', () => {
  setLocale(/** @type {any} */ ('fr'));
  assert.equal(getLocale(), 'es');
});

test('pick bilingual fields', () => {
  assert.equal(pick({ es: 'Hola', en: 'Hello' }), 'Hola');
  assert.equal(pick({ es: 'Hola', en: 'Hello' }, 'en'), 'Hello');
  assert.equal(pick({ es: 'Solo' }, 'en'), 'Solo');
  assert.equal(pick('plain'), 'plain');
  assert.equal(pick(null), '');
});

test('date formatting does not shift calendar dates', () => {
  assert.match(formatDate('2026-11-13', 'medium', 'es'), /13.*nov.*2026/);
  assert.match(formatDate('2026-11-13', 'medium', 'en'), /Nov 13, 2026/);
  assert.match(formatDate('2026-01-01', 'short', 'en'), /Jan 1/);
});

test('time formatting uses the given timezone', () => {
  assert.match(formatTime('2026-11-13T12:30:00Z', 'America/Bogota', 'en'), /7:30\sAM/);
  assert.match(formatClock('19:05', 'en'), /7:05\sPM/);
});

test('numbers and relative days', () => {
  assert.equal(formatNumber(4.5, { maximumFractionDigits: 1 }, 'es'), '4,5');
  assert.equal(formatNumber(4.5, { maximumFractionDigits: 1 }, 'en'), '4.5');
  assert.equal(formatRelativeDay('2026-11-14', '2026-11-13', 'es'), 'mañana');
  assert.equal(formatRelativeDay('2026-11-13', '2026-11-13', 'en'), 'today');
  assert.equal(formatRelativeDay('2026-11-10', '2026-11-13', 'en'), '3 days ago');
});

test('shipped dictionaries load and pluralize age', () => {
  resetStrings();
  for (const l of ['es', 'en']) registerStrings(l, null, JSON.parse(readFileSync(new URL(`../../src/i18n/${l}.json`, import.meta.url), 'utf8')));
  setLocale('es');
  assert.equal(t('age.weeks', { count: 1 }), '1 semana');
  assert.equal(t('age.weeks', { count: 7 }), '7 semanas');
  setLocale('en');
  assert.equal(t('age.days', { count: 2 }), '2 days');
});
