// Builds the vendored ESM bundles in /vendor from packages installed in a temp dir.
// Runs in GitHub Actions only (needs the npm registry). Usage:
//   node scripts/vendor-build.mjs <installDir>
// where <installDir> already contains node_modules with the pinned packages and esbuild.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const installDir = resolve(process.argv[2] || 'vendor-build-tmp');
const require = createRequire(join(installDir, 'package.json'));
const esbuild = require('esbuild');

const versionsPath = join(root, 'vendor', 'versions.json');
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));

const installed = {};
for (const name of Object.keys(versions.packages)) {
  const pkg = JSON.parse(readFileSync(join(installDir, 'node_modules', name, 'package.json'), 'utf8'));
  installed[name] = pkg.version;
}

const entries = {
  'preact.js': `
export { h, render, Fragment, createContext, cloneElement, toChildArray, Component, createRef } from 'preact';
export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer, useId, useErrorBoundary } from 'preact/hooks';
import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
`,
  'supabase.js': `export { createClient } from '@supabase/supabase-js';\n`,
};

mkdirSync(join(root, 'vendor'), { recursive: true });
for (const [file, contents] of Object.entries(entries)) {
  const banner = `/* Vendored by .github/workflows/vendor.yml. Do not edit. ${Object.entries(installed)
    .map(([n, v]) => `${n}@${v}`)
    .join(' ')} */`;
  await esbuild.build({
    stdin: { contents, resolveDir: installDir, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020', 'safari15'],
    minify: true,
    legalComments: 'eof',
    banner: { js: banner },
    outfile: join(root, 'vendor', file),
  });
  console.log('built vendor/' + file);
}

versions.packages = installed;
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
console.log('pinned', installed);
