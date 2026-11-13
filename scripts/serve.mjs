// Zero-dependency static dev server for the repo root.
//   node scripts/serve.mjs [--port 5173] [--host 127.0.0.1]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt('port', process.env.PORT || 5173));
const host = opt('host', '127.0.0.1');
const root = resolve(opt('root', resolve(import.meta.dirname, '..')));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://x');
    let rel = decodeURIComponent(url.pathname);
    // Mirror the GitHub Pages sub-path so relative URLs behave the same locally.
    rel = rel.replace(/^\/tyler-tracker(?=\/|$)/, '') || '/';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || /(^|\/)\.(git|env)/.test(rel)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, host, () => {
  console.log(`Tyler Tracker dev server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
});
