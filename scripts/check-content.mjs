// Validates /content/*.json against the schemas in docs/CONTENT.md.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'content');
const errors = [];
const err = (file, path, msg) => errors.push(`${file}${path ? ' ' + path : ''}: ${msg}`);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isId = (v) => typeof v === 'string' && /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(v);

function bilingual(file, path, v) {
  if (!v || typeof v !== 'object') return err(file, path, 'must be { "es": "...", "en": "..." }');
  for (const l of ['es', 'en']) if (!isStr(v[l])) err(file, `${path}.${l}`, 'missing or empty');
  for (const k of Object.keys(v)) if (!['es', 'en'].includes(k)) err(file, `${path}.${k}`, 'unknown locale');
}
function sources(file, path, v) {
  if (!Array.isArray(v)) return err(file, path, 'sources must be an array');
  v.forEach((s, i) => {
    if (!isStr(s?.title)) err(file, `${path}[${i}].title`, 'missing');
    if (typeof s?.url !== 'string' || !/^https:\/\/\S+$/.test(s.url)) err(file, `${path}[${i}].url`, 'must be an https URL');
  });
}
function common(file, path, item, { needsSources = true } = {}) {
  if (!isId(item.id)) err(file, `${path}.id`, 'must be a lowercase kebab-case id');
  if (item.sample !== undefined && typeof item.sample !== 'boolean') err(file, `${path}.sample`, 'must be boolean');
  if (needsSources || item.sources !== undefined) sources(file, `${path}.sources`, item.sources);
  if (!isDate(item.reviewed_on)) err(file, `${path}.reviewed_on`, 'must be YYYY-MM-DD');
}
function article(file, path, item) {
  common(file, path, item);
  bilingual(file, `${path}.title`, item.title);
  bilingual(file, `${path}.summary`, item.summary);
  bilingual(file, `${path}.body`, item.body);
}
const oneOf = (file, path, v, options) => {
  if (!options.includes(v)) err(file, path, `must be one of ${options.join(', ')}`);
};
const num = (file, path, v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) err(file, path, 'must be a non-negative number');
};

const itemValidators = {
  'faq.json': (f, p, it) => {
    common(f, p, it);
    if (!isStr(it.category)) err(f, `${p}.category`, 'missing');
    bilingual(f, `${p}.question`, it.question);
    bilingual(f, `${p}.answer`, it.answer);
    if (!isDate(it.added_on)) err(f, `${p}.added_on`, 'must be YYYY-MM-DD');
  },
  'facts.json': (f, p, it) => {
    common(f, p, it);
    bilingual(f, `${p}.text`, it.text);
  },
  'roadmap.json': (f, p, it) => {
    article(f, p, it);
    num(f, `${p}.from_weeks`, it.from_weeks);
    num(f, `${p}.to_weeks`, it.to_weeks);
    if (!(it.to_weeks > it.from_weeks)) err(f, p, 'to_weeks must be greater than from_weeks');
    if (!Array.isArray(it.todos)) return err(f, `${p}.todos`, 'must be an array');
    it.todos.forEach((td, i) => {
      if (!isId(td.key) || !td.key.startsWith(it.id + '.')) err(f, `${p}.todos[${i}].key`, `must be "<stage id>.<kebab-id>"`);
      bilingual(f, `${p}.todos[${i}].text`, td.text);
    });
  },
  'must-know.json': (f, p, it) => {
    article(f, p, it);
    oneOf(f, `${p}.priority`, it.priority, ['critical', 'important', 'good-to-know']);
  },
  'training.json': (f, p, it) => {
    article(f, p, it);
    num(f, `${p}.min_age_weeks`, it.min_age_weeks);
    num(f, `${p}.duration_min`, it.duration_min);
    oneOf(f, `${p}.difficulty`, it.difficulty, ['easy', 'medium', 'hard']);
  },
  'health.json': (f, p, it) => {
    article(f, p, it);
    oneOf(f, `${p}.category`, it.category, ['vaccines', 'parasites', 'nutrition', 'dental', 'grooming', 'emergency', 'exercise', 'general']);
  },
  'parents.json': (f, p, it) => {
    article(f, p, it);
    oneOf(f, `${p}.category`, it.category, ['teamwork', 'routine', 'wellbeing', 'home', 'budget', 'general']);
  },
};

function checkGrowth(f, data) {
  if (data.sample !== undefined && typeof data.sample !== 'boolean') err(f, 'sample', 'must be boolean');
  if (data.sample) bilingual(f, 'placeholder_note', data.placeholder_note);
  if (data.note !== undefined) bilingual(f, 'note', data.note);
  if (data.unit !== 'kg') err(f, 'unit', 'must be "kg"');
  oneOf(f, 'sex', data.sex, ['male', 'female']);
  sources(f, 'sources', data.sources);
  if (!isDate(data.reviewed_on)) err(f, 'reviewed_on', 'must be YYYY-MM-DD');
  if (!Array.isArray(data.points) || data.points.length < 2) return err(f, 'points', 'need at least 2 points');
  data.points.forEach((pt, i) => {
    num(f, `points[${i}].age_weeks`, pt.age_weeks);
    num(f, `points[${i}].min_kg`, pt.min_kg);
    num(f, `points[${i}].max_kg`, pt.max_kg);
    if (pt.min_kg > pt.max_kg) err(f, `points[${i}]`, 'min_kg > max_kg');
    if (i && pt.age_weeks <= data.points[i - 1].age_weeks) err(f, `points[${i}]`, 'age_weeks must increase');
  });
}

const expected = ['faq.json', 'facts.json', 'roadmap.json', 'must-know.json', 'training.json', 'health.json', 'parents.json', 'growth.json'];
const present = readdirSync(dir).filter((n) => n.endsWith('.json'));
for (const name of expected) if (!present.includes(name)) err(name, '', 'file missing');
for (const name of present) if (!expected.includes(name)) err(name, '', 'unexpected content file (add it to docs/CONTENT.md and this checker)');

let count = 0;
for (const name of present.filter((n) => expected.includes(n))) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (e) {
    err(name, '', `invalid JSON: ${e.message}`);
    continue;
  }
  if (data.version !== 1) err(name, 'version', 'must be 1');
  if (name === 'growth.json') {
    checkGrowth(name, data);
    continue;
  }
  if (!Array.isArray(data.items)) {
    err(name, 'items', 'must be an array');
    continue;
  }
  const ids = new Set();
  data.items.forEach((it, i) => {
    const p = `items[${i}]`;
    if (ids.has(it.id)) err(name, `${p}.id`, `duplicate id "${it.id}"`);
    ids.add(it.id);
    itemValidators[name](name, p, it);
    count++;
  });
  if (name === 'roadmap.json') {
    const keys = data.items.flatMap((s) => (s.todos || []).map((t) => t.key));
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dup.length) err(name, '', `duplicate to-do keys: ${dup.join(', ')}`);
    const sorted = [...data.items].sort((a, b) => a.from_weeks - b.from_weeks);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].from_weeks < sorted[i - 1].to_weeks) err(name, '', `stages "${sorted[i - 1].id}" and "${sorted[i].id}" overlap`);
    }
  }
}

if (errors.length) {
  console.error(`Content check failed (${errors.length}):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`Content OK: ${present.length} files, ${count} items`);
