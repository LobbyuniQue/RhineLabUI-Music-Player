import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Optional, individually licensed assets stay local. Builds without the kit
// use the fixed phrase artwork already selected by vite.config.ts.
const sources = JSON.parse(await readFile(new URL('../verification/boot-lettering/webfont-sources.json', import.meta.url), 'utf8'));
const files = [
  ...Object.entries(sources).map(([weight, source]) => ({
    path: `webFonts/NovecentoSansWide${weight}/font.woff2`, hash: source.sha256,
  })),
  { path: 'RhineLabNovecento.css', hash: '9495a310fe80cc0c06c56cb9e04926ae4135e41ce674bacb6cd38c0d5f4f0f7a' },
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let verifiedFonts = 0;
for (const file of files) {
  const target = resolve('public/fonts/novecento', file.path);
  let bytes;
  try { bytes = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && digest(bytes) !== file.hash) throw new Error(`Local licensed font checksum mismatch: ${file.path}`);
  if (bytes && file.path.endsWith('.woff2')) verifiedFonts++;
}
console.log(verifiedFonts === Object.keys(sources).length
  ? `Verified ${verifiedFonts} locally installed licensed fonts.`
  : 'Optional font kit incomplete or absent; retaining authored phrase graphics.');
