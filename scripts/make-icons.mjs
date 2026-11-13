// Generates PWA icons from assets/source/tyler-icon-source.jpg (run locally; outputs are committed).
//   NODE_PATH=/opt/npm-tools/node_modules node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = resolve(import.meta.dirname, '..');
const src = join(root, 'assets/source/tyler-icon-source.jpg');
const out = join(root, 'assets/icons');
mkdirSync(out, { recursive: true });

const GOLD = { r: 232, g: 168, b: 58, alpha: 1 };
// Tighter crop around the face for small sizes.
const face = { left: 120, top: 250, width: 770, height: 770 };

const jobs = [
  ['apple-touch-icon.png', 180, face],
  ['icon-192.png', 192, face],
  ['icon-512.png', 512, null],
  ['favicon-32.png', 32, face],
  ['favicon-16.png', 16, face],
];
for (const [name, size, crop] of jobs) {
  let img = sharp(src);
  if (crop) img = img.extract(crop);
  await img.resize(size, size).png({ compressionLevel: 9, palette: true, quality: 88, effort: 10 }).toFile(join(out, name));
  console.log('wrote', name);
}

// Maskable: the photo inside the 80% safe zone on a gold background.
const inner = Math.round(512 * 0.8);
const photo = await sharp(src).extract(face).resize(inner, inner).toBuffer();
const circle = Buffer.from(`<svg width="${inner}" height="${inner}"><circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}" fill="#fff"/></svg>`);
const rounded = await sharp(photo).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: GOLD } })
  .composite([{ input: rounded, left: (512 - inner) / 2, top: (512 - inner) / 2 }])
  .png({ compressionLevel: 9, palette: true, quality: 88, effort: 10 })
  .toFile(join(out, 'icon-maskable-512.png'));
console.log('wrote icon-maskable-512.png');
