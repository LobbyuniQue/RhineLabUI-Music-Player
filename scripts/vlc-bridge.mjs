#!/usr/bin/env node
// Rhine Lab local music bridge — VLC as the playback kernel.
//
// The web page cannot link libVLC, so this companion process owns playback:
//   * VLC decodes and plays every format it supports (no hand written codecs);
//   * the loopback HTTP interface of VLC is used for transport, position,
//     volume and metadata;
//   * the decoded audio is duplicated to a raw PCM stream on loopback, which
//     this bridge folds into the 128 sample spectrum layout the archive music
//     reaction already consumes, and pushes to the page over SSE.
//
// Security: binds 127.0.0.1 only and requires a per-run token; it never accepts
// a path from the page — the page can only reference ids from the scanned root.
//
// Usage:
//   node --experimental-strip-types scripts/vlc-bridge.mjs --root "D:\Music"
//   options: --port 8788  --vlc <path to vlc.exe>  --token <fixed>  --rescan
//
// Requires Node 22+ (type stripping) and a VLC install under an ASCII path —
// see scripts/fetch-vlc.mjs and docs/LOCAL-MUSIC.md for why.

import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { spawn } from "node:child_process";
import { open, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrackMeta, isAudioFile } from "../src/music-metadata.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

// ---------------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) out.flags.add(key);
      else {
        out[key] = value;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 8788);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65533) {
  console.error("bridge port must be an integer from 1024 to 65533");
  process.exit(1);
}
// VLC's control interface and the PCM tap need ports of their own. They are
// chosen at startup so a stale VLC from an earlier run cannot block playback.
let TAP_PORT = PORT + 1;
let VLC_HTTP_PORT = PORT + 2;

async function freePort(preferred, excluded = new Set()) {
  for (let port = preferred; port <= 65535; port++) {
    if (excluded.has(port)) continue;
    const available = await new Promise((resolve) => {
      const probe = createProbe();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`no available port from ${preferred}`);
}
const TOKEN = args.token ?? randomUUID().replace(/-/g, "").slice(0, 24);
const MUSIC_ROOT = args.root ? resolve(args.root) : null;
const CACHE_FILE = join(PROJECT, ".tools", "cache", `music-index-${PORT}.json`);
const ASCII = /^[\x20-\x7e]*$/;

function findVlc() {
  if (args.vlc) return resolve(args.vlc);
  // scripts/fetch-vlc.mjs records where it installed VLC (an ASCII path, which
  // VLC's Lua interfaces require).
  try {
    const pointer = JSON.parse(readFileSync(join(PROJECT, ".tools", "vlc-location.json"), "utf8"));
    if (pointer?.exe && looksPresent(pointer.exe)) return pointer.exe;
  } catch {
    /* no pointer yet */
  }
  const candidates = [
    join(PROJECT, ".tools", "vlc", "vlc.exe"),
    "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
  ];
  for (const candidate of candidates) if (looksPresent(candidate)) return candidate;
  return candidates[0];
}

function looksPresent(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

const VLC = findVlc();

if (!MUSIC_ROOT) {
  console.error("missing --root <音乐目录>");
  console.error('example: node --experimental-strip-types scripts/vlc-bridge.mjs --root "D:\\Music"');
  process.exit(1);
}
if (!ASCII.test(VLC)) {
  console.error("VLC 的安装路径包含非 ASCII 字符，VLC 的 Lua 控制接口在该路径下无法加载。");
  console.error(`  当前: ${VLC}`);
  console.error("  处理: 复制到纯英文路径，例如 C:\\rhine-vlc，然后用 --vlc 指定；");
  console.error("        或把项目移动到纯英文路径后重跑 scripts/fetch-vlc.mjs。");
  process.exit(2);
}

// ------------------------------------------------------------------ library
let library = [];
let scanState = { phase: "idle", seen: 0, added: 0, reused: 0, failed: 0, ms: 0 };
/** False until VLC answered and the first scan finished. */
let ready = false;

const idOf = (path) => createHash("sha1").update(path).digest("hex").slice(0, 16);

// Embedded art lives beside the metadata cache, one file per track id.
const COVER_DIR = join(dirname(CACHE_FILE), "covers");

async function readBlobLike(path, size) {
  // The metadata reader only needs a handful of small ranges, so each slice
  // opens, reads and closes the file — no handle is left to the GC.
  return {
    size,
    slice: (start, end) => ({
      arrayBuffer: async () => {
        const length = Math.max(0, Math.min(end, size) - start);
        if (length <= 0) return new ArrayBuffer(0);
        const handle = await open(path, "r");
        try {
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, start);
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        } finally {
          await handle.close();
        }
      },
    }),
  };
}

async function walk(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 8) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && isAudioFile(entry.name)) found.push(full);
    }
  }
  return found;
}

async function loadCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    return new Map((parsed.tracks ?? []).map((track) => [track.path, track]));
  } catch {
    return new Map();
  }
}

async function saveCache() {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ root: MUSIC_ROOT, tracks: library }, null, 1), "utf8");
}

async function scan({ rescan = false } = {}) {
  const started = Date.now();
  scanState = { phase: "walking", seen: 0, added: 0, reused: 0, failed: 0, ms: 0 };
  const cached = rescan ? new Map() : await loadCache();
  const files = await walk(MUSIC_ROOT);
  const tracks = [];
  for (const path of files) {
    scanState.seen++;
    try {
      const info = await stat(path);
      const previous = cached.get(path);
      if (previous && previous.size === info.size && previous.mtime === info.mtimeMs) {
        tracks.push(previous);
        scanState.reused++;
        continue;
      }
      scanState.phase = "reading";
      const meta = await readTrackMeta(await readBlobLike(path, info.size), basename(path));
      // Cover art stays on disk next to the metadata cache; the cache entry only
      // records the mime so reused tracks keep reporting it without re-parsing.
      let cover = null;
      if (meta.picture?.data?.length) {
        try {
          await mkdir(COVER_DIR, { recursive: true });
          await writeFile(join(COVER_DIR, idOf(path)), Buffer.from(meta.picture.data));
          cover = meta.picture.mime || "image/jpeg";
        } catch { /* cover is best-effort */ }
      } else {
        try { await stat(join(COVER_DIR, idOf(path))); cover = "image/jpeg"; } catch { /* no art */ }
      }
      tracks.push({
        id: idOf(path),
        path,
        name: basename(path),
        size: info.size,
        mtime: info.mtimeMs,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        track: meta.track,
        disc: meta.disc ?? null,
        year: meta.year ?? "",
        genre: meta.genre ?? "",
        duration: meta.duration,
        codec: meta.codec,
        cover,
      });
      scanState.added++;
    } catch {
      scanState.failed++;
    }
  }
  library = tracks.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
  scanState.phase = "done";
  scanState.ms = Date.now() - started;
  await saveCache().catch(() => {});
  return scanState;
}

// ---------------------------------------------------------------- VLC control
let vlc;
let vlcReady = false;
let stopping = false;
let vlcInfo = { version: "", startedAt: 0 };
const vlcUrl = (query = "") => `http://127.0.0.1:${VLC_HTTP_PORT}/requests/status.json${query}`;
const vlcAuth = "Basic " + Buffer.from(`:${TOKEN}`).toString("base64");
let current = { id: null, startedAt: 0 };
let prepared = null;
let transportRevision = 0;
let transportTask = Promise.resolve();
let transportIntent = "stopped";
let hasStarted = false;
let desiredVolume = 256;
let preparationMuted = false;
const clientSequences = new Map();

async function vlcCall(query = "") {
  const response = await fetch(vlcUrl(query), { headers: { authorization: vlcAuth }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`VLC HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function startVlc() {
  const chain = `#duplicate{dst=display,dst="transcode{acodec=s16l,channels=2,samplerate=44100}:std{access=http,mux=raw,dst=127.0.0.1:${TAP_PORT}}"}`;
  const verbose = args.flags?.has("verbose") || args.verbose !== undefined;
  try {
    vlc = spawn(
      VLC,
      [
        "--intf", "dummy",
        "--extraintf", "http",
        "--http-port", String(VLC_HTTP_PORT),
        "--http-password", TOKEN,
        "--http-host", "127.0.0.1",
        "--no-video",
        "--no-one-instance",
        "--start-paused",
        "--no-repeat", "--no-loop", "--no-random",
        "--no-video-title-show",
        // A music player must win the CPU against a browser rendering a 3D scene;
        // without this VLC can sit in "stopped" for a long time on a busy machine.
        "--high-priority",
        ...(verbose ? ["-vv"] : ["--quiet"]),
        ...(args.aout ? [`--aout=${args.aout}`] : []),
        "--sout", chain,
      ],
      { cwd: dirname(VLC), stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    console.error(`[bridge] VLC 启动失败：${error.message ?? error}`);
    return false;
  }
  vlcInfo.startedAt = Date.now();
  vlc.once("error", (error) => {
    console.error(`[bridge] VLC error：${error.message ?? error}`);
    vlcReady = false;
    ready = false;
    if (!stopping) shutdown(1);
  });
  vlc.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (verbose) {
      // Full VLC log: useful when a platform refuses to start an output.
      for (const line of text.split("\n")) if (line.trim()) console.log("[vlc]", line.trim().slice(0, 240));
    } else if (/error|failed|denied/i.test(text)) {
      console.error("[vlc]", text.trim().slice(0, 200));
    }
  });
  vlc.on("exit", (code) => {
    console.log(`[bridge] VLC exited (${code})`);
    vlcReady = false;
    ready = false;
    vlc = undefined;
  });
  return true;
}

async function waitForVlc(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await vlcCall();
      if (status) {
        vlcInfo.version = String(status.version ?? "");
        return true;
      }
    } catch {
      /* starting up */
    }
    await sleep(300);
  }
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fileUri = (path) =>
  "file:///" + path.replace(/\\/g, "/").split("/").map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/");

/**
 * Starts the loaded item and verifies that VLC really plays it.
 *
 * VLC's HTTP interface only *loads* the item on `in_play`; depending on the
 * platform and on how busy the machine is, the state then stays "stopped" until
 * the playlist is nudged again. Retrying here is what makes playback reliable
 * from the page, where a second manual click is not an option.
 */
async function startPlayback(revision) {
  // `in_play` only loads the item; VLC reports "playing" once it has opened the
  // file and bound the PCM tap. On a busy machine that takes a moment, and the
  // page shows a loading state meanwhile — so wait instead of nudging the
  // transport, which would fight the asynchronous playlist thread.
  for (let attempt = 0; attempt < 100; attempt++) {
    assertTransport(revision);
    await sleep(100);
    assertTransport(revision);
    const raw = await refreshStatus();
    assertTransport(revision);
    if (raw?.state === "playing") { hasStarted = true; return true; }
  }
  return false;
}

function assertTransport(revision) {
  if (revision !== transportRevision) throw new Error("superseded transport request");
}

async function controlledCall(query, revision) {
  assertTransport(revision);
  const result = await vlcCall(query);
  assertTransport(revision);
  return result;
}

async function restoreVolume(revision) {
  // A slider update may arrive while the HTTP volume command is in flight.
  // Keep preparation muted until the most recent requested volume is applied.
  let applied;
  do {
    applied = desiredVolume;
    await controlledCall(`?command=volume&val=${applied}`, revision);
  } while (applied !== desiredVolume);
  preparationMuted = false;
}

function serialTransport(url, operation) {
  const client = url.searchParams.get("client");
  const sequence = Number(url.searchParams.get("sequence"));
  if (client !== null) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(client) || !Number.isSafeInteger(sequence) || sequence <= 0)
      return Promise.reject(new Error("invalid transport sequence"));
    if (sequence <= (clientSequences.get(client) ?? 0))
      return Promise.reject(new Error("superseded transport request"));
    clientSequences.set(client, sequence);
    if (clientSequences.size > 256) clientSequences.delete(clientSequences.keys().next().value);
  }
  const revision = ++transportRevision;
  const task = transportTask.then(() => { assertTransport(revision); return operation(revision); });
  transportTask = task.catch(() => {});
  return task;
}

async function prepareTrack(id, revision, position = 0) {
  const track = library.find((entry) => entry.id === id);
  if (!track) throw new Error("unknown id");
  prepared = null;
  transportIntent = "preparing";
  hasStarted = false;
  current = { id, startedAt: 0 };
  // Muting is a second guard even on VLC versions whose start-paused option
  // opens output before pausing. No preparation may send audible samples.
  preparationMuted = true;
  await controlledCall("?command=volume&val=0", revision);
  await controlledCall("?command=pl_empty", revision);
  await controlledCall(`?command=in_play&input=${encodeURIComponent(fileUri(track.path))}&option=start-paused`, revision);
  let loaded = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assertTransport(revision);
    const raw = await controlledCall("", revision);
    if (raw?.state === "playing") await controlledCall("?command=pl_forcepause", revision);
    if (raw?.state === "paused" && Number(raw.length) > 0) { loaded = true; break; }
    await sleep(100);
  }
  if (!loaded) throw new Error("VLC preparation timed out");
  await controlledCall(`?command=seek&val=${Math.max(0, position)}`, revision);
  prepared = { id, ticket: randomUUID(), position: Math.max(0, position) };
  transportIntent = "ready";
  await refreshStatus();
  assertTransport(revision);
  return { ready: true, prepared: true, id, ticket: prepared.ticket };
}

async function startPrepared(ticket, revision) {
  if (!prepared || prepared.ticket !== ticket || transportIntent !== "ready") throw new Error("no matching prepared track");
  transportIntent = "starting";
  await restoreVolume(revision);
  await controlledCall("?command=pl_forceresume", revision);
  current.startedAt = Date.now();
  const started = await startPlayback(revision);
  if (!started) throw new Error("VLC playback timed out");
  prepared = null;
  transportIntent = "playing";
  startTapWatch();
  return { started: true, status: await status() };
}

let cachedRaw = null;
let cachedAt = 0;

async function refreshStatus() {
  try {
    cachedRaw = await vlcCall();
    cachedAt = Date.now();
  } catch {
    cachedRaw = null;
  }
  return cachedRaw;
}

/** Maps a raw VLC status into the shape the page consumes. */
function mapStatus(raw) {
  const meta = raw?.information?.category?.meta ?? {};
  const state = !raw ? "offline" : raw.state === "playing" ? "playing" : raw.state === "paused" ? "paused" : "stopped";
  return {
    state,
    time: Number(raw?.time ?? 0),
    length: Number(raw?.length ?? 0),
    volume: preparationMuted ? desiredVolume : Number(raw?.volume ?? desiredVolume),
    loading: transportIntent === "preparing" || transportIntent === "starting",
    prepared: transportIntent === "ready",
    ended: hasStarted && transportIntent === "playing" && raw?.state === "stopped",
    currentId: current.id,
    title: meta.title ?? "",
    artist: meta.artist ?? "",
    album: meta.album ?? "",
    codec: library.find((entry) => entry.id === current.id)?.codec ?? "",
    vlc: { version: vlcInfo.version, pid: vlc?.pid ?? null, startedAt: vlcInfo.startedAt, cachedAt },
  };
}

/** Live status with a cached fallback while VLC is busy. */
async function status() {
  const raw = await refreshStatus();
  return mapStatus(raw ?? cachedRaw);
}

/**
 * Cached status. VLC's Lua interface can take a moment while it opens a file, so
 * health and the SSE loop must never wait on it — the page would stall behind a
 * slow render frame.
 */
function statusCached() {
  return mapStatus(cachedRaw);
}

// -------------------------------------------------------------- spectrum tap
const BANDS = 64;
const FFT_SIZE = 1024;
const BAND_EDGES = [[20, 250], [250, 2500], [2500, 16000]];
const binFrequency = (index) => {
  const [from, to] = index < 8 ? BAND_EDGES[0] : index < 32 ? BAND_EDGES[1] : BAND_EDGES[2];
  const start = index < 8 ? 0 : index < 32 ? 8 : 32;
  const span = index < 8 ? 8 : index < 32 ? 24 : 32;
  return from * Math.pow(to / from, (index - start) / span);
};

/** Iterative radix-2 FFT; magnitudes only. */
function fftMagnitudes(real, imaginary) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImaginary = Math.sin(angle);
    for (let i = 0; i < n; i += length) {
      let curReal = 1;
      let curImaginary = 0;
      for (let j = 0; j < length / 2; j++) {
        const uReal = real[i + j];
        const uImaginary = imaginary[i + j];
        const vReal = real[i + j + length / 2] * curReal - imaginary[i + j + length / 2] * curImaginary;
        const vImaginary = real[i + j + length / 2] * curImaginary + imaginary[i + j + length / 2] * curReal;
        real[i + j] = uReal + vReal;
        imaginary[i + j] = uImaginary + vImaginary;
        real[i + j + length / 2] = uReal - vReal;
        imaginary[i + j + length / 2] = uImaginary - vImaginary;
        const nextReal = curReal * wReal - curImaginary * wImaginary;
        curImaginary = curReal * wImaginary + curImaginary * wReal;
        curReal = nextReal;
      }
    }
  }
  const magnitudes = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) magnitudes[i] = Math.hypot(real[i], imaginary[i]) / (n / 4);
  return magnitudes;
}

const spectrum = new Float32Array(BANDS * 2);
let tapTimer = null;
let tapActive = false;

async function pumpTap() {
  if (tapActive) return;
  tapActive = true;
  const sampleBuffer = [];
  try {
    const response = await fetch(`http://127.0.0.1:${TAP_PORT}/`, { signal: AbortSignal.timeout(1000 * 60 * 30) });
    let carry = Buffer.alloc(0);
    for await (const chunk of response.body) {
      const buffer = Buffer.concat([carry, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
      const usable = buffer.length - (buffer.length % 4);
      for (let i = 0; i + 3 < usable; i += 4) {
        sampleBuffer.push((buffer.readInt16LE(i) / 32768 + buffer.readInt16LE(i + 2) / 32768) / 2);
      }
      carry = buffer.subarray(usable);
      while (sampleBuffer.length >= FFT_SIZE) {
        computeBands(sampleBuffer.splice(0, FFT_SIZE));
      }
    }
  } catch {
    /* the tap ends with the input */
  } finally {
    tapActive = false;
  }
}

function computeBands(frame) {
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) real[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const magnitudes = fftMagnitudes(real, imaginary);
  const nyquist = 22050;
  const binHz = nyquist / magnitudes.length;
  for (let band = 0; band < BANDS; band++) {
    const from = binFrequency(band);
    const to = binFrequency(band + 1);
    const start = Math.max(0, Math.floor(from / binHz));
    const end = Math.max(start + 1, Math.min(magnitudes.length, Math.ceil(to / binHz)));
    let peak = 0;
    for (let bin = start; bin < end; bin++) if (magnitudes[bin] > peak) peak = magnitudes[bin];
    const level = Math.min(1, Math.pow(peak * 3.2, 0.62));
    // Attack fast, decay slowly: the archive wave should not flicker.
    const previous = spectrum[band];
    spectrum[band] = level > previous ? level : previous * 0.82 + level * 0.18;
    spectrum[band + BANDS] = spectrum[band];
  }
}

function startTapWatch() {
  if (tapTimer) return;
  tapTimer = setInterval(() => {
    if (!tapActive) void pumpTap();
  }, 1500);
  void pumpTap();
}

// --------------------------------------------------------------------- server
const clients = new Set();

const CORS = {
  // The page is served from another origin (dev server, preview, or the packaged
  // site), so the loopback API has to allow it. Authorisation still needs the
  // per-run token, and only ever through a header or query parameter.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "600",
};

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
  });
  res.end(body);
}

function authorized(req, url) {
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${TOKEN}`) return true;
  return url.searchParams.get("token") === TOKEN;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === "/api/health") {
    const status_ = statusCached();
    return json(res, 200, {
      ok: true,
      ready,
      root: MUSIC_ROOT,
      tracks: library.length,
      scan: scanState,
      vlc: status_.vlc,
    });
  }
  if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });

  if (url.pathname === "/api/library") {
    return json(res, 200, {
      root: MUSIC_ROOT,
      scan: scanState,
      tracks: library.map(({ id, name, title, artist, album, track, disc, year, genre, duration, codec, size, path, cover }) => ({
        id,
        name,
        title,
        artist,
        album,
        track,
        disc: disc ?? null,
        year: year ?? "",
        genre: genre ?? "",
        duration,
        codec,
        size,
        hasCover: Boolean(cover),
        folder: relative(MUSIC_ROOT, dirname(path)).split(sep).join("/"),
      })),
    });
  }
  if (url.pathname === "/api/cover") {
    const id = url.searchParams.get("id") ?? "";
    // Ids are sha1 hex digests minted by the scan, so this can never escape the
    // cache directory; arbitrary paths are impossible by construction.
    if (!/^[0-9a-f]{16}$/.test(id)) return json(res, 400, { error: "bad id" });
    const track = library.find((item) => item.id === id);
    const file = join(COVER_DIR, id);
    try {
      if (!track?.cover) throw new Error("no cover");
      const data = await readFile(file);
      res.writeHead(200, { ...CORS, "content-type": track.cover, "cache-control": "no-cache" });
      return res.end(data);
    } catch {
      return json(res, 404, { error: "no cover" });
    }
  }
  if (url.pathname === "/api/scan") {
    const report = await scan({ rescan: url.searchParams.get("full") === "1" });
    return json(res, 200, { scan: report, tracks: library.length });
  }
  if (["/api/prepare", "/api/start", "/api/play", "/api/resume", "/api/pause", "/api/stop"].includes(url.pathname)) {
    const id = url.searchParams.get("id");
    if (["/api/prepare", "/api/play"].includes(url.pathname) && !library.some((track) => track.id === id))
      return json(res, 400, { error: "unknown id" });
    // Reject an obsolete/forged ticket before it can invalidate a newer
    // transport operation or stop a track that has already begun playing.
    if (url.pathname === "/api/start" && (!prepared || prepared.ticket !== url.searchParams.get("ticket") || transportIntent !== "ready"))
      return json(res, 409, { error: "no matching prepared track" });
    const position = Number(url.searchParams.get("position") ?? 0);
    if (url.pathname === "/api/prepare" && (!Number.isFinite(position) || position < 0))
      return json(res, 400, { error: "invalid playback position" });
    try {
      const result = await serialTransport(url, async (revision) => {
        try {
          if (url.pathname === "/api/prepare") return await prepareTrack(id, revision, position);
          if (url.pathname === "/api/start") return await startPrepared(url.searchParams.get("ticket"), revision);
          if (url.pathname === "/api/play") {
            const ready = await prepareTrack(id, revision);
            return await startPrepared(ready.ticket, revision);
          }
          prepared = null;
          hasStarted = false;
          if (url.pathname === "/api/stop") {
            transportIntent = "stopped";
            await controlledCall("?command=pl_stop", revision);
            current = { id: null, startedAt: 0 };
          } else if (url.pathname === "/api/pause") {
            transportIntent = "paused";
            await controlledCall("?command=pl_forcepause", revision);
          } else {
            if (!current.id) throw new Error("no current track");
            transportIntent = "starting";
            await restoreVolume(revision);
            await controlledCall("?command=pl_forceresume", revision);
            if (!await startPlayback(revision)) throw new Error("VLC resume timed out");
            transportIntent = "playing";
            return { status: await status() };
          }
          // Restore the user's volume only after output has stopped/paused.
          await restoreVolume(revision);
          return { status: await status() };
        } catch (error) {
          if (revision === transportRevision) {
            prepared = null;
            transportIntent = "stopped";
            hasStarted = false;
            await vlcCall("?command=pl_stop").catch(() => {});
            current = { id: null, startedAt: 0 };
            await vlcCall(`?command=volume&val=${desiredVolume}`).catch(() => {});
            preparationMuted = false;
          }
          throw error;
        }
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, /superseded|matching prepared/.test(String(error.message)) ? 409 : 400, { error: String(error.message ?? error) });
    }
  }
  if (url.pathname === "/api/seek") {
    const seconds = Number(url.searchParams.get("seconds") ?? 0);
    if (!Number.isFinite(seconds)) return json(res, 400, { error: "invalid playback position" });
    await vlcCall(`?command=seek&val=${encodeURIComponent(String(Math.max(0, seconds)))}`);
    return json(res, 200, await status());
  }
  if (url.pathname === "/api/volume") {
    const requested = Number(url.searchParams.get("value") ?? 256);
    if (!Number.isFinite(requested)) return json(res, 400, { error: "invalid volume" });
    const value = Math.max(0, Math.min(512, requested));
    desiredVolume = Math.round(value);
    if (!preparationMuted) await vlcCall(`?command=volume&val=${desiredVolume}`);
    return json(res, 200, await status());
  }
  if (url.pathname === "/api/status") return json(res, 200, await status());
  if (url.pathname === "/api/bands") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(JSON.stringify({ bands: Array.from(preparationMuted ? new Float32Array(128) : spectrum) }));
  }
  if (url.pathname === "/api/spectrum") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      ...CORS,
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return undefined;
  }
  return json(res, 404, { error: "not found" });
}

setInterval(() => {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify({ bands: Array.from(preparationMuted ? new Float32Array(128) : spectrum), tap: tapActive })}\n\n`;
  for (const client of clients) client.write(payload);
}, 40);

const server = createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 500, { error: String(error.message ?? error) }));
});

server.on("error", (error) => {
  console.error(`[bridge] HTTP 服务启动失败：${error.message}`);
  shutdown(1);
});

server.listen(PORT, "127.0.0.1", async () => {
  try {
    // Pick ports that are actually free: a stale VLC from an earlier run must not
    // be able to block the PCM tap or the control interface.
    TAP_PORT = await freePort(PORT + 1, new Set([PORT]));
    VLC_HTTP_PORT = await freePort(TAP_PORT + 1, new Set([PORT, TAP_PORT]));
    console.log(`[bridge] listening http://127.0.0.1:${PORT}  (token ${TOKEN})`);
    console.log(`[bridge] vlc control port ${VLC_HTTP_PORT} · PCM tap port ${TAP_PORT}`);
    console.log(`[bridge] music root: ${MUSIC_ROOT}`);
    console.log(`[bridge] vlc: ${VLC}`);
    const started = startVlc();
    vlcReady = started && await waitForVlc();
    console.log(vlcReady ? `[bridge] VLC ${vlcInfo.version || "ready"}` : "[bridge] VLC 未响应，请检查路径与端口占用");
    if (!vlcReady) {
      console.error("[bridge] 无法连接 VLC 控制接口，桥接启动失败");
      return shutdown(1);
    }
    // Keep a cached status so health and the spectrum loop never wait on VLC.
    setInterval(() => void refreshStatus(), 1000);
    await refreshStatus();
    const first = await scan();
    ready = true;
    console.log(`[bridge] library: ${library.length} tracks (added ${first.added}, reused ${first.reused}, failed ${first.failed}, ${first.ms}ms)`);
    console.log("[bridge] 在网页「设置 → 本地音乐」中填入端口与令牌，或直接打开本地音乐面板。");
  } catch (error) {
    console.error(`[bridge] 初始化失败：${error.message ?? error}`);
    shutdown(1);
  }
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  ready = false;
  console.log("[bridge] shutting down");
  try {
    vlcCall("?command=quit").catch(() => {});
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    vlc?.kill();
    server.close();
    process.exit(code);
  }, 400);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
