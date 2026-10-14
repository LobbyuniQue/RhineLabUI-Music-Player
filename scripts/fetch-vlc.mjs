// Fetch the official VLC for Windows into .tools/vlc (never committed).
//
// The project uses VLC as the local playback kernel, but a web page cannot link
// native libraries, so VLC runs as a companion process driven by
// scripts/vlc-bridge.mjs. This script downloads the pinned upstream release and
// verifies the SHA256 published by VideoLAN before unpacking it.
//
// Usage: node scripts/fetch-vlc.mjs [--force] [--version 3.0.21]
//
// Licence note: the VLC Windows build is GPLv2+ (libVLC is LGPLv2.1+). It is
// used here as a separate process and installed locally; redistributing it with
// a release requires offering its corresponding source, see docs/LOCAL-MUSIC.md.

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const versionIndex = args.indexOf("--version");
const VERSION = versionIndex >= 0 ? args[versionIndex + 1] : "3.0.21";
const ARCH = "win64";
const BASE = `https://download.videolan.org/pub/videolan/vlc/${VERSION}/${ARCH}`;
const ZIP_NAME = `vlc-${VERSION}-${ARCH}.zip`;
const CACHE = join(ROOT, ".tools", "cache");

/**
 * VLC's Lua interfaces resolve their module paths through the legacy ANSI API,
 * so an install directory containing non-ASCII characters breaks them. When the
 * project itself lives under such a path (very common here), VLC is installed in
 * an ASCII location instead and the project keeps a pointer to it.
 */
const ASCII = /^[\x20-\x7e]*$/;
const projectIsAscii = ASCII.test(ROOT);
const TARGET = projectIsAscii
  ? join(ROOT, ".tools", "vlc")
  : join(process.env.LOCALAPPDATA || homedir(), "RhineLab", "vlc");
const POINTER = join(ROOT, ".tools", "vlc-location.json");
const VLC_EXE = join(TARGET, "vlc.exe");

const log = (...parts) => console.log("[vlc]", ...parts);

async function sha256(file) {
  const buffer = await readFile(file);
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function alreadyInstalled() {
  if (!(await exists(VLC_EXE))) return false;
  if (force) return false;
  const record = await readFile(join(TARGET, "VERSION.txt"), "utf8").catch(() => "");
  const version = record.match(/^(\d+\.\d+\.\d+)/)?.[1];
  const hash = record.match(/^SHA256 ([a-f0-9]{64})\r?$/m)?.[1];
  if (version !== VERSION || !hash) return false;
  // A new checkout still needs its own pointer to the shared installation.
  await recordPointer(version, hash);
  log(`already installed: ${version} (${VLC_EXE})`);
  return true;
}

async function recordPointer(version, hash) {
  await mkdir(dirname(POINTER), { recursive: true });
  await writeFile(POINTER, JSON.stringify({ exe: VLC_EXE, version, arch: ARCH, sha256: hash, projectAscii: projectIsAscii }, null, 2), "utf8");
}

async function download(url, file) {
  log(`downloading ${url}`);
  const response = await fetch(url, { headers: { "user-agent": "rhine-lab-ui" } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
    received += chunk.byteLength;
    const now = Date.now();
    if (now - lastReport > 2000) {
      lastReport = now;
      const pct = total ? `${((received / total) * 100).toFixed(1)}%` : `${(received / 1048576).toFixed(1)} MB`;
      log(`  ${pct}${total ? ` (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)` : ""}`);
    }
  }
  await writeFile(file, Buffer.concat(chunks));
  return received;
}

/**
 * Minimal ZIP reader: the Windows VLC archive is a plain deflate zip and the
 * fetch script must not depend on child processes (a locked-down environment
 * may forbid spawning tar) nor on a zip npm dependency.
 */
async function unzipInto(zipPath, destination, stripPrefix = true) {
  const buffer = await readFile(zipPath);
  const eocd = (() => {
    for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error("not a zip archive: end of central directory not found");
  })();
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    files.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  let written = 0;
  for (const file of files) {
    const name = stripPrefix ? file.name.split("/").slice(1).join("/") : file.name;
    if (!name || file.name.endsWith("/")) continue;
    const target = join(destination, name);
    // The archive only contains relative paths; reject anything else outright.
    const child = relative(destination, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`unsafe archive entry: ${file.name}`);
    const localNameLength = buffer.readUInt16LE(file.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(file.localOffset + 28);
    const dataStart = file.localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + file.compressedSize);
    if (file.method !== 0 && file.method !== 8) throw new Error(`unsupported ZIP method for ${file.name}`);
    const data = file.method === 0 ? raw : inflateRawSync(raw);
    if (file.uncompressedSize && data.length !== file.uncompressedSize)
      throw new Error(`size mismatch for ${file.name}: ${data.length} != ${file.uncompressedSize}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written++;
  }
  return written;
}

await mkdir(CACHE, { recursive: true });
if (await alreadyInstalled()) process.exit(0);

const zipPath = join(CACHE, ZIP_NAME);
if (!(await exists(zipPath))) await download(`${BASE}/${ZIP_NAME}`, zipPath);
else log(`reusing cached ${zipPath}`);

const response = await fetch(`${BASE}/${ZIP_NAME}.sha256`, { headers: { "user-agent": "rhine-lab-ui" } });
if (!response.ok) throw new Error(`official SHA256 unavailable: HTTP ${response.status}`);
const expected = (await response.text()).trim().split(/\s+/)[0].toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("official SHA256 unavailable or malformed");
const actual = await sha256(zipPath);
if (expected !== actual) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
log(`SHA256 verified (${actual.slice(0, 16)}…)`);

await rm(TARGET, { recursive: true, force: true });
await mkdir(TARGET, { recursive: true });
const written = await unzipInto(zipPath, TARGET);
log(`unpacked ${written} files`);
if (!(await exists(VLC_EXE))) throw new Error(`vlc.exe not found under ${TARGET}`);
const libvlc = (await readdir(TARGET)).filter((name) => name.toLowerCase().startsWith("libvlc"));
await writeFile(
  join(TARGET, "VERSION.txt"),
  `${VERSION} (${ARCH})\nSHA256 ${actual}\nlibvlc: ${libvlc.join(", ") || "missing"}\n`,
  "utf8",
);
await recordPointer(VERSION, actual);
log(`installed VLC ${VERSION} (${ARCH}) → ${TARGET}`);
log(`libvlc: ${libvlc.join(", ") || "missing"}`);
if (!projectIsAscii)
  log("项目路径含非 ASCII 字符，VLC 已安装到英文路径以保住它的 Lua 控制接口（指针: .tools/vlc-location.json）");
log("next: node --experimental-strip-types scripts/vlc-bridge.mjs --root <你的音乐目录>");
