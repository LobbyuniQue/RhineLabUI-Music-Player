import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function containsPoint(points, from, to) {
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < points.length && points[low] <= to;
}

export function coreFontFiles(css, text) {
  const points = [...new Set([...text].map(character => character.codePointAt(0)))].sort((a, b) => a - b);
  const fonts = new Set();
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const path = match[1].match(/url\(["']?\/?(fonts\/misans-webfont-[^"')]+)["']?\)/)?.[1];
    if (!path) continue;
    const ranges = match[1].match(/unicode-range\s*:\s*([^;]+)/)?.[1];
    if (!ranges || ranges.split(",").some(range => {
      const normalized = range.trim().replace(/^U\+/i, "");
      const [start, end = start] = normalized.split("-");
      const from = Number.parseInt(start.replaceAll("?", "0"), 16);
      const to = Number.parseInt(end.replaceAll("?", "F"), 16);
      return Number.isFinite(from) && Number.isFinite(to) && containsPoint(points, from, to);
    })) fonts.add(path);
  }
  return fonts;
}

async function coreText(sourceRoot) {
  let text = "";
  for (let point = 32; point < 128; point++) text += String.fromCodePoint(point);
  for (const directory of ["src", "content"]) {
    for (const path of await readdir(resolve(sourceRoot, directory), { recursive: true })) {
      if (!/\.(ts|css|json|html)$/.test(path) || path.replaceAll("\\", "/") === "fonts.css") continue;
      text += await readFile(resolve(sourceRoot, directory, path), "utf8");
    }
  }
  text += await readFile(resolve(sourceRoot, "index.html"), "utf8");
  return text;
}

export async function planOfflineResources(root, sourceRoot = projectRoot) {
  const all = await readdir(root, { recursive: true });
  const files = all.map(path => path.replaceAll("\\", "/")).filter(path =>
    path === "index.html" || path === "manifest.webmanifest" || path === "favicon.svg" ||
    /^(assets|icons|archives|licenses)\/[^/]+\.[^/]+$/.test(path) ||
    /^fonts\/.*\.(woff2|pdf|txt|json|md)$/.test(path) ||
    /^audio\/(atmosphere|motif|pulse)\.ogg$/.test(path)
  ).filter(path => !/^assets\/archive-(cassette|assembly)\.glb$/.test(path)).sort();
  if (!files.some(path => /^assets\/index-.*\.js$/.test(path)))
    throw new Error("Build the application before generating the offline cache.");
  const fonts = coreFontFiles(await readFile(resolve(sourceRoot, "src/fonts.css"), "utf8"), await coreText(sourceRoot));
  const optionalFiles = files.filter(path => /^fonts\/misans-webfont-[^/]+\/[^/]+\/[^/]+\.woff2$/.test(path) && !fonts.has(path));
  const optionalSet = new Set(optionalFiles);
  const precacheFiles = files.filter(path => !optionalSet.has(path));
  const sizes = {}, hashes = {};
  for (const file of files) {
    const bytes = await readFile(resolve(root, file));
    sizes[file] = bytes.length;
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  const bytesFor = list => list.reduce((total, file) => total + sizes[file], 0);
  // `files` remains the FULL release list: Cloudflare must publish every font
  // even though installation no longer downloads every glyph in advance.
  return {
    bytes: bytesFor(files), files, sizes, hashes,
    precache: { bytes: bytesFor(precacheFiles), files: precacheFiles },
    optional: { bytes: bytesFor(optionalFiles), files: optionalFiles },
  };
}

export async function buildPwa(root = resolve(projectRoot, "dist"), sourceRoot = projectRoot) {
  const metadata = await planOfflineResources(root, sourceRoot);
  const worker = await readFile(resolve(projectRoot, "scripts/pwa-worker.js"), "utf8");
  const version = createHash("sha256").update(worker).update(JSON.stringify(metadata)).digest("hex").slice(0, 16);
  const optionalHashes = Object.fromEntries(metadata.optional.files.map(file => [file, metadata.hashes[file]]));
  await writeFile(resolve(root, "sw.js"), worker
    .replace("__CACHE_VERSION__", JSON.stringify(version))
    .replace("__PRECACHE_FILES__", JSON.stringify(metadata.precache.files))
    .replace("__OPTIONAL_FILES__", JSON.stringify(metadata.optional.files))
    .replace("__FILE_SIZES__", JSON.stringify(metadata.sizes))
    .replace("__OPTIONAL_HASHES__", JSON.stringify(optionalHashes)));
  await writeFile(resolve(root, "pwa-build.json"), JSON.stringify({ version, ...metadata }, null, 2));
  console.log(`Offline release ${version}: core ${metadata.precache.files.length} files / ${(metadata.precache.bytes / 1024 / 1024).toFixed(1)} MiB; full ${metadata.files.length} files / ${(metadata.bytes / 1024 / 1024).toFixed(1)} MiB.`);
  return { version, ...metadata };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildPwa();
