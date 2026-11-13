// Runs a tool binary from node_modules/.bin. In the agent workspace (no npm access) it first
// links ./node_modules to the preinstalled tools in /opt/npm-tools/node_modules.
//   node scripts/bin.mjs tsc -p tsconfig.json
import { existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const local = join(root, 'node_modules');
const tools = '/opt/npm-tools/node_modules';
if (!existsSync(local) && existsSync(tools)) {
  symlinkSync(tools, local, 'dir');
  console.error(`linked node_modules -> ${tools}`);
}
const [bin, ...args] = process.argv.slice(2);
const path = join(local, '.bin', bin);
if (!existsSync(path)) {
  console.error(`Missing ${bin}. Run "npm install" (CI) or check /opt/npm-tools (agent workspace).`);
  process.exit(1);
}
const r = spawnSync(path, args, { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
