import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const PLAYLIST_LIMIT = 1000;

export class PlaylistError extends Error {
  constructor(status, error, details = {}) {
    super(error);
    this.status = status;
    this.details = details;
  }
}

const idOf = (path) => createHash("sha1").update(path).digest("hex").slice(0, 16);

async function writeAtomic(file, contents) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, "utf8"); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function loadPlaylistSelection(file, root) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.root === root && Number.isSafeInteger(value.part) && value.part >= 0 && typeof value.split === "boolean")
      return { part: value.part, split: value.split };
  } catch { /* Missing or stale preferences do not block startup. */ }
  return { part: 0, split: false };
}

export async function savePlaylistSelection(rootFile, file, { root, part, split }) {
  await writeAtomic(file, JSON.stringify({ root, part, split }));
  await writeAtomic(rootFile, root);
}

export async function readPlaylistRequest(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new PlaylistError(400, "playlist_json_required");
  const chunks = [];
  let size = 0;
  // Returning from the default iterator destroys an HTTP request before its 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16384) {
      req.resume();
      throw new PlaylistError(413, "playlist_request_too_large");
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PlaylistError(400, "invalid_playlist_request"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlaylistError(400, "invalid_playlist_request");
  if (typeof value.root !== "string" || !value.root.trim() ||
      (value.part !== undefined && (!Number.isSafeInteger(value.part) || value.part < 0)) ||
      (value.split !== undefined && typeof value.split !== "boolean"))
    throw new PlaylistError(400, "invalid_playlist_request");
  return value;
}

/** Only metadata from the selected, explicitly accepted volume stays in memory. */
export class NativePlaylistLibrary {
  constructor({ root, cacheFile, isAudioFile, readMeta, beforeCommit = async () => {} }) {
    this.root = resolve(root);
    this.cacheFile = cacheFile;
    // Ports have separate caches, so one bridge cannot delete another's covers.
    this.coverDir = join(dirname(cacheFile), `${basename(cacheFile, ".json")}-covers`);
    this.isAudioFile = isAudioFile;
    this.readMeta = readMeta;
    this.beforeCommit = beforeCommit;
    this.tracks = [];
    this.playlist = { root: this.root, part: 0, total: 0, parts: 1, limit: PLAYLIST_LIMIT, split: false, needsSplit: false };
    this.scanState = { phase: "idle", seen: 0, added: 0, reused: 0, failed: 0, ms: 0 };
    this.tasks = new Map();
    this.tail = Promise.resolve();
  }

  scan(options = {}) {
    const root = options.root ?? this.root;
    const part = options.part ?? this.playlist.part;
    const split = options.split ?? this.playlist.split;
    if (typeof root !== "string" || !root.trim() || !Number.isSafeInteger(part) || part < 0 || typeof split !== "boolean")
      return Promise.reject(new PlaylistError(400, "invalid_playlist_request"));
    const request = { root: resolve(root), part, split, rescan: Boolean(options.rescan), allowPending: Boolean(options.allowPending) };
    const key = JSON.stringify(request);
    if (this.tasks.has(key)) return this.tasks.get(key);
    const task = this.tail.then(() => this.read(request));
    this.tasks.set(key, task);
    this.tail = task.catch(() => {});
    void task.finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key); }).catch(() => {});
    return task;
  }

  async files(root) {
    const queue = [{ dir: root, depth: 0 }];
    const found = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { dir, depth } = queue[cursor];
      if (depth > 8) continue;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if (dir === root) throw error; continue; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) queue.push({ dir: path, depth: depth + 1 });
        else if (entry.isFile() && this.isAudioFile(entry.name)) found.push(path);
      }
    }
    return found.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }

  async cache(root, part) {
    try {
      const value = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (value.root !== root || (value.part ?? 0) !== part) return new Map();
      return new Map((value.tracks ?? []).map((track) => [track.path, track]));
    } catch { return new Map(); }
  }

  async read(request) {
    const { root, part, split, rescan, allowPending } = request;
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    } catch { throw new PlaylistError(400, "playlist_directory_unavailable"); }
    const started = Date.now();
    const report = { phase: "walking", seen: 0, added: 0, reused: 0, failed: 0, ms: 0 };
    this.scanState = report;
    const staging = `${this.coverDir}.scan-${randomUUID()}`;
    const backup = `${this.coverDir}.old-${randomUUID()}`;
    try {
      const files = await this.files(root);
      const total = files.length;
      const parts = Math.max(1, Math.ceil(total / PLAYLIST_LIMIT));
      const needsSplit = total > PLAYLIST_LIMIT && !split;
      if (needsSplit && !allowPending) throw new PlaylistError(409, "playlist_limit", { total, parts, limit: PLAYLIST_LIMIT });
      if (part >= parts || (part > 0 && !split)) throw new PlaylistError(409, "playlist_part_out_of_range", { total, parts, limit: PLAYLIST_LIMIT });
      const playlist = { root, part, total, parts, limit: PLAYLIST_LIMIT, split, needsSplit };
      const cached = rescan ? new Map() : await this.cache(root, part);
      const tracks = [];
      await mkdir(staging, { recursive: true });
      for (const path of needsSplit ? [] : files.slice(part * PLAYLIST_LIMIT, (part + 1) * PLAYLIST_LIMIT)) {
        report.seen++;
        try {
          const info = await stat(path);
          const previous = cached.get(path);
          const artExists = !previous?.cover || await stat(join(this.coverDir, previous.id)).then((value) => value.isFile()).catch(() => false);
          if (previous && previous.size === info.size && previous.mtime === info.mtimeMs && artExists) {
            if (previous.cover) await copyFile(join(this.coverDir, previous.id), join(staging, previous.id));
            tracks.push(previous);
            report.reused++;
            continue;
          }
          report.phase = "reading";
          const meta = await this.readMeta(path, info);
          const id = idOf(path);
          const cover = meta.picture?.data?.length ? meta.picture.mime || "image/jpeg" : null;
          // Stage on disk; 1000 large covers must not all stay in memory.
          if (cover) await writeFile(join(staging, id), Buffer.from(meta.picture.data));
          tracks.push({ id, path, name: basename(path), size: info.size, mtime: info.mtimeMs,
            title: meta.title, artist: meta.artist, album: meta.album, track: meta.track,
            disc: meta.disc ?? null, year: meta.year ?? "", genre: meta.genre ?? "",
            duration: meta.duration, codec: meta.codec, cover });
          report.added++;
        } catch { report.failed++; }
      }
      if (!needsSplit && Math.min(PLAYLIST_LIMIT, total - part * PLAYLIST_LIMIT) > 0 && !tracks.length)
        throw new PlaylistError(422, "playlist_tracks_unavailable");
      await this.beforeCommit({ ...playlist, tracks });
      const hadCovers = await stat(this.coverDir).then((value) => value.isDirectory()).catch(() => false);
      if (hadCovers) await rename(this.coverDir, backup);
      try { await rename(staging, this.coverDir); }
      catch (error) { if (hadCovers) await rename(backup, this.coverDir); throw error; }
      this.root = root;
      this.playlist = playlist;
      this.tracks = tracks;
      report.phase = needsSplit ? "awaiting_split" : "done";
      report.ms = Date.now() - started;
      await rm(backup, { recursive: true, force: true }).catch(() => {});
      await this.save().catch(() => {});
      return { ...report };
    } catch (error) {
      this.scanState = { ...report, phase: "failed", ms: Date.now() - started };
      throw error;
    } finally {
      // These are unique siblings created by this operation, never music directories.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async save() {
    await writeAtomic(this.cacheFile, JSON.stringify({ ...this.playlist, tracks: this.tracks }));
  }
}
