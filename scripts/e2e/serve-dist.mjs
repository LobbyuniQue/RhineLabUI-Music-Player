// Loopback-only static server for built assets and optional isolated fixtures.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, isAbsolute, relative, resolve } from "node:path";
import { DIST_DIR } from "../lib/workspace-paths.mjs";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/e2e/serve-dist.mjs [dist-directory] [port] [--fixtures directory]",
  );
  process.exit(0);
}
const ROOT = resolve(process.argv[2] || DIST_DIR);
const PORT = Number(process.argv[3] || 4173);
const fixtureIndex = process.argv.indexOf("--fixtures");
if (fixtureIndex >= 0 && !process.argv[fixtureIndex + 1])
  throw new Error("--fixtures needs a directory");
const FIXTURES =
  fixtureIndex >= 0 ? resolve(process.argv[fixtureIndex + 1]) : null;
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error("Invalid static-server port");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

function fileInside(root, pathname) {
  const file = resolve(root, "." + pathname);
  const child = relative(root, file);
  if (
    child === ".." ||
    child.startsWith("../") ||
    child.startsWith("..\\") ||
    isAbsolute(child)
  )
    return null;
  return file;
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const fixture = p.startsWith("/__fixtures/");
    if (fixture && !FIXTURES)
      return res.writeHead(404).end("No fixtures configured");
    const base = fixture ? FIXTURES : ROOT;
    if (fixture) p = p.slice("/__fixtures".length);
    if (p.endsWith("/")) p += "index.html";
    let file = fileInside(base, p);
    if (!file) return res.writeHead(403).end("Path outside static root");
    let body;
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, "index.html");
      body = await readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      if (fixture || extname(p))
        return res.writeHead(404).end("File not found");
      file = join(ROOT, "index.html");
      body = await readFile(file);
    }
    res.writeHead(200, {
      "content-type":
        MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(e instanceof URIError ? 400 : 500).end(String(e));
  }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`),
);
