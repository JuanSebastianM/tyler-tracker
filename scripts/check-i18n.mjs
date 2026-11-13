// i18n checks:
//  1. every key exists in both es and en (shared strings and each feature), with the same plural forms
//  2. every literal t('key') used in src/ exists in Spanish
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];
const isPlural = (v) => v && typeof v === 'object' && 'other' in v && Object.values(v).every((x) => typeof x === 'string');

/** Flatten to dot keys; plural objects become one key with a ".#forms" suffix list. */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlural(v)) out.set(key, `plural:${Object.keys(v).sort().join(',')}`);
    else if (v && typeof v === 'object') flatten(v, key, out);
    else if (typeof v === 'string') out.set(key, v.trim() === '' ? 'empty' : 'string');
    else errors.push(`${key}: unsupported value type ${typeof v}`);
  }
  return out;
}

const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const dicts = [['', 'src/i18n']];
for (const id of readdirSync(join(root, 'src/features'))) {
  if (existsSync(join(root, 'src/features', id, 'i18n'))) dicts.push([id, `src/features/${id}/i18n`]);
}

const allEs = new Map();
for (const [ns, dir] of dicts) {
  let es, en;
  try {
    es = flatten(read(`${dir}/es.json`));
    en = flatten(read(`${dir}/en.json`));
  } catch (e) {
    errors.push(`${dir}: ${e.message}`);
    continue;
  }
  for (const [k, kind] of es) {
    if (!en.has(k)) errors.push(`${dir}/en.json missing "${k}"`);
    else if (en.get(k) !== kind) errors.push(`${dir}: "${k}" differs (es ${kind}, en ${en.get(k)})`);
    if (kind === 'empty') errors.push(`${dir}/es.json "${k}" is empty`);
    allEs.set(ns ? `${ns}.${k}` : k, kind);
  }
  for (const k of en.keys()) if (!es.has(k)) errors.push(`${dir}/es.json missing "${k}"`);
}

// Literal keys used in code.
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}
const re = /\bt\(\s*'([a-zA-Z0-9_.-]+)'/g;
let used = 0;
for (const file of walk(join(root, 'src'))) {
  // Ignore comment lines (examples in docs comments).
  const src = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  for (const m of src.matchAll(re)) {
    used++;
    if (!allEs.has(m[1])) errors.push(`${relative(root, file)}: t('${m[1]}') has no string`);
  }
}

if (errors.length) {
  console.error(`i18n check failed (${errors.length}):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`i18n OK: ${allEs.size} keys in ${dicts.length} dictionaries, ${used} literal uses checked`);
