// Theme logic (src/lib/theme.js) and WCAG AA contrast of every theme's text tokens, computed from
// the real CSS (src/styles/tokens.css + themes.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES, MODES, DEFAULT_CHOICE, normalizeChoice, resolveScheme, resolveChoice, sameChoice,
} from '../../src/lib/theme.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const TOKENS_CSS = read('src/styles/tokens.css');
const THEMES_CSS = read('src/styles/themes.css');

// ---------------------------------------------------------------------------
// Tiny CSS reader: top-level rules only (the token files have no nesting or at-rules).
// ---------------------------------------------------------------------------
function rules(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/"/g, "'"));
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    out.push({ selectors, decls });
  }
  return out;
}
const ALL_RULES = [...rules(TOKENS_CSS), ...rules(THEMES_CSS)];
const declsFor = (selector) =>
  Object.assign({}, ...ALL_RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.decls));

/** Token values for a theme and scheme, following the cascade the app uses. */
function tokens(theme, scheme) {
  const t = { ...declsFor('[data-theme]') };
  if (scheme === 'dark') Object.assign(t, declsFor("[data-scheme='dark']"));
  if (theme !== 'default') Object.assign(t, declsFor(`[data-theme='${theme}'][data-scheme='${scheme}']`));
  const resolve = (v, depth = 0) => {
    assert.ok(depth < 10, 'var() cycle');
    return v.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => {
      assert.ok(name in t, `${theme}/${scheme}: ${name} is not defined`);
      return resolve(t[name], depth + 1);
    });
  };
  return Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('--')).map(([k, v]) => [k, resolve(v)]));
}

// ---------------------------------------------------------------------------
// WCAG 2.x contrast
// ---------------------------------------------------------------------------
function rgb(color) {
  let m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*[\d.]+\s*)?\)$/.exec(color);
  if (m) return [+m[1], +m[2], +m[3]];
  throw new Error(`Cannot read colour ${color}`);
}
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => {
  const [r, g, b] = rgb(c).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** [foreground, background, minimum ratio, where it is used] */
const TEXT = 4.5;
const UI = 3;
const PAIRS = [
  ['--c-ink', '--c-bg', TEXT, 'body text'],
  ['--c-ink', '--c-surface', TEXT, 'card text'],
  ['--c-ink', '--c-surface-2', TEXT, 'inset areas'],
  ['--c-ink-2', '--c-bg', TEXT, 'secondary text'],
  ['--c-ink-2', '--c-surface', TEXT, 'secondary text in cards'],
  ['--c-ink-2', '--c-surface-2', TEXT, 'neutral badges, segment labels'],
  ['--c-on-gold', '--c-gold', TEXT, 'primary button, active tab, FAB'],
  ['--c-on-gold', '--c-gold-strong', TEXT, 'primary button hover'],
  ['--c-on-gold-soft', '--c-gold-soft', TEXT, 'accent badges and cards'],
  ['--c-gold-ink', '--c-surface', TEXT, 'links and accent text'],
  ['--c-gold-ink', '--c-bg', TEXT, 'links on the page'],
  ['--c-gold-ink', '--c-surface-2', TEXT, 'accent text on inset areas'],
  ['--c-gold-ink', '--c-gold-soft', TEXT, 'accent text on accent cards'],
  ['--c-on-segment-on', '--c-segment-on', TEXT, 'selected segment'],
  ['--c-bg', '--c-ink', TEXT, 'toast text'],
  ['--c-toast-action', '--c-ink', TEXT, 'toast action'],
  ['--c-green', '--c-green-soft', TEXT, 'success badge'],
  ['--c-green', '--c-surface', TEXT, 'success text'],
  ['--c-red', '--c-red-soft', TEXT, 'danger badge'],
  ['--c-red', '--c-surface', TEXT, 'danger text'],
  ['--c-on-red', '--c-red', TEXT, 'danger button, error toast'],
  ['--c-blue', '--c-blue-soft', TEXT, 'info badge, disclaimer'],
  ['--c-blue', '--c-surface', TEXT, 'info icons'],
  ['--c-focus', '--c-bg', UI, 'focus ring on the page'],
  ['--c-focus', '--c-surface', UI, 'focus ring in cards'],
  ['--c-gold-ink', '--c-surface', UI, 'selected theme swatch border'],
];

for (const theme of THEMES) {
  for (const scheme of ['light', 'dark']) {
    test(`contrast: ${theme} ${scheme} meets WCAG AA`, () => {
      const t = tokens(theme, scheme);
      const failures = PAIRS.map(([fg, bg, min, use]) => ({ fg, bg, min, use, ratio: contrast(t[fg], t[bg]) }))
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.fg} on ${p.bg} (${p.use}): ${p.ratio.toFixed(2)} < ${p.min}`);
      assert.deepEqual(failures, []);
    });
  }
}

test('contrast(): known values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
});

// Default theme must look exactly as before theming existed.
const DEFAULT_LIGHT = {
  '--c-bg': '#f2f5ef', '--c-surface': '#ffffff', '--c-surface-2': '#e8ede4', '--c-ink': '#1d2a22',
  '--c-ink-2': '#536058', '--c-line': '#d6ddd1', '--c-gold': '#e8a83a', '--c-gold-strong': '#d18e1c',
  '--c-on-gold': '#2b1d02', '--c-gold-soft': '#fbedcf', '--c-on-gold-soft': '#5a3b00', '--c-gold-ink': '#8a5700',
  '--c-green': '#2e6b4c', '--c-green-soft': '#dcede2', '--c-red': '#b0321d', '--c-red-soft': '#fbe3dd',
  '--c-blue': '#2c5d86', '--c-blue-soft': '#e0ebf5', '--c-focus': '#1f6fd1',
};
const DEFAULT_DARK = {
  '--c-bg': '#111713', '--c-surface': '#1a221d', '--c-surface-2': '#242e28', '--c-ink': '#e9efe9',
  '--c-ink-2': '#a5b2aa', '--c-line': '#2f3b34', '--c-gold': '#f0b54c', '--c-gold-strong': '#f6c56a',
  '--c-on-gold': '#2b1d02', '--c-gold-soft': '#3b2e13', '--c-on-gold-soft': '#f7d9a0', '--c-gold-ink': '#f3c46c',
  '--c-green': '#7fc79f', '--c-green-soft': '#1d3327', '--c-red': '#f29482', '--c-red-soft': '#3e221c',
  '--c-blue': '#8fbbe3', '--c-blue-soft': '#1d2d3c', '--c-focus': '#7db4ff',
};
test('default theme keeps the original token values', () => {
  const light = tokens('default', 'light');
  const dark = tokens('default', 'dark');
  for (const [k, v] of Object.entries(DEFAULT_LIGHT)) assert.equal(light[k], v, `light ${k}`);
  for (const [k, v] of Object.entries(DEFAULT_DARK)) assert.equal(dark[k], v, `dark ${k}`);
});

test('every theme defines the same accent and neutral tokens in light and dark; semantic colours stay', () => {
  const required = ['--c-bg', '--c-surface', '--c-surface-2', '--c-ink', '--c-ink-2', '--c-line', '--c-gold',
    '--c-gold-strong', '--c-on-gold', '--c-gold-soft', '--c-on-gold-soft', '--c-gold-ink', '--c-focus', '--shadow-fab'];
  for (const theme of THEMES.filter((x) => x !== 'default')) {
    for (const scheme of ['light', 'dark']) {
      const d = declsFor(`[data-theme='${theme}'][data-scheme='${scheme}']`);
      for (const k of required) assert.ok(k in d, `${theme} ${scheme} defines ${k}`);
      for (const k of ['--c-red', '--c-red-soft', '--c-green', '--c-green-soft', '--c-blue', '--c-blue-soft', '--c-on-red']) {
        assert.ok(!(k in d), `${theme} ${scheme} must not override semantic ${k}`);
      }
    }
  }
  const themed = new Set([...THEMES_CSS.matchAll(/\[data-theme='([a-z]+)'\]/g)].map((m) => m[1]));
  assert.deepEqual([...themed].sort(), THEMES.filter((x) => x !== 'default').sort());
});

test('theme-boot.js knows the same themes and modes as theme.js', () => {
  const boot = read('src/lib/theme-boot.js');
  const list = (name) => JSON.parse(new RegExp(`var ${name} = (\\[[^\\]]*\\])`).exec(boot)[1].replace(/'/g, '"'));
  assert.deepEqual(list('THEMES'), [...THEMES]);
  assert.deepEqual(list('MODES'), [...MODES]);
  assert.match(boot, /tt\.theme\.active/);
});

test('feature and kit CSS never query prefers-color-scheme or hard-code the accent', () => {
  const files = ['src/styles/base.css', 'src/styles/components.css', 'src/features/today/today.css',
    'src/features/log/log.css', 'src/features/health/health.css', 'src/features/learn/learn.css',
    'src/features/profile/profile.css', 'src/features/assistant/assistant.css'];
  for (const f of files) {
    const css = read(f);
    assert.doesNotMatch(css, /prefers-color-scheme/, `${f} uses a scheme media query; use a token`);
    assert.doesNotMatch(css, /rgb\(140 90 0/, `${f} hard-codes the gold shadow`);
  }
});

// ---------------------------------------------------------------------------
// Choice logic
// ---------------------------------------------------------------------------
test('normalizeChoice: unknown values fall back to default / auto; rows use color_mode', () => {
  assert.deepEqual(normalizeChoice(null), DEFAULT_CHOICE);
  assert.deepEqual(normalizeChoice({ theme: 'peach', mode: 'sepia' }), { theme: 'default', mode: 'auto' });
  assert.deepEqual(normalizeChoice({ theme: 'rose', mode: 'dark' }), { theme: 'rose', mode: 'dark' });
  assert.deepEqual(normalizeChoice({ user_id: 'u', theme: 'mint', color_mode: 'light' }), { theme: 'mint', mode: 'light' });
  assert.deepEqual(normalizeChoice('rose'), DEFAULT_CHOICE);
});

test('resolveScheme: an explicit mode beats the device', () => {
  assert.equal(resolveScheme('auto', true), 'dark');
  assert.equal(resolveScheme('auto', false), 'light');
  assert.equal(resolveScheme('light', true), 'light');
  assert.equal(resolveScheme('dark', false), 'dark');
});

test('resolveChoice: who sees what', () => {
  const device = { theme: 'sky', mode: 'light' };
  const mine = { user_id: 'u1', theme: 'rose', color_mode: 'dark' };
  // While auth restores the session, keep what was painted at launch.
  assert.deepEqual(resolveChoice({ authStatus: 'loading', active: { theme: 'mint', mode: 'auto' }, device }), { theme: 'mint', mode: 'auto' });
  // Visitors (and after sign-out): the device's own choice.
  assert.deepEqual(resolveChoice({ authStatus: 'signedOut', device }), device);
  assert.deepEqual(resolveChoice({ authStatus: 'signedOut' }), DEFAULT_CHOICE);
  // Signed in: their row wins over the device choice.
  assert.deepEqual(resolveChoice({ authStatus: 'signedIn', userId: 'u1', row: mine, rowsReady: true, device }), { theme: 'rose', mode: 'dark' });
  // Signed in, row not loaded yet: their cached choice, never the device's.
  assert.deepEqual(resolveChoice({ authStatus: 'signedIn', userId: 'u1', userCached: { theme: 'lavender', mode: 'auto' }, device }), { theme: 'lavender', mode: 'auto' });
  assert.deepEqual(resolveChoice({ authStatus: 'signedIn', userId: 'u1', device }), DEFAULT_CHOICE);
  // Loaded from the server and no row: they never chose.
  assert.deepEqual(resolveChoice({ authStatus: 'signedIn', userId: 'u1', rowsReady: true, userCached: { theme: 'rose', mode: 'auto' } }), DEFAULT_CHOICE);
});

test('sameChoice', () => {
  assert.ok(sameChoice({ theme: 'rose', mode: 'auto' }, { theme: 'rose', mode: 'auto' }));
  assert.ok(!sameChoice({ theme: 'rose', mode: 'auto' }, { theme: 'rose', mode: 'dark' }));
  assert.ok(!sameChoice(null, DEFAULT_CHOICE));
});
