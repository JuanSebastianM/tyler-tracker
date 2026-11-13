// Assembles the deployable site into _site/ and stamps the service worker with a version and
// the precache list. Used by CI before deploying to GitHub Pages.
//   node scripts/build-site.mjs [outDir]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] || join(root, '_site'));

/** Files and folders that make up the site. Everything else (tests, docs, scripts) stays out. */
const INCLUDE = ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/icons', 'src', 'vendor', 'content'];
/** Never published. */
const EXCLUDE = [/\.d\.ts$/, /\.md$/, /(^|\/)\./, /^vendor\/versions\.json$/];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of INCLUDE) {
  cpSync(join(root, item), join(out, item), {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src).replaceAll('\\', '/');
      return !EXCLUDE.some((re) => re.test(rel));
    },
  });
}
writeFileSync(join(out, '.nojekyll'), '');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(out)
  .map((p) => relative(out, p).replaceAll('\\', '/'))
  .filter((p) => p !== 'sw.js' && p !== '.nojekyll')
  .sort();

let sha = process.env.GITHUB_SHA || '';
if (!sha) {
  try {
    sha = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  } catch {
    sha = 'local';
  }
}
const version = `${sha.slice(0, 7)}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
const precache = ['./', ...files.map((f) => `./${f}`)];

const swPath = join(out, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes("'__SW_VERSION__'") || !sw.includes('/* __PRECACHE__ */')) {
  throw new Error('sw.js placeholders not found');
}
writeFileSync(
  swPath,
  sw.replace("'__SW_VERSION__'", JSON.stringify(version)).replace('/* __PRECACHE__ */', precache.map((f) => JSON.stringify(f)).join(',\n  ')),
);
console.log(`Built ${out}: ${files.length} files, service worker ${version}`);
