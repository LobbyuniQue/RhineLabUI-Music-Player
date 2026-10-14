// Local music library: scanning, incremental indexing and queries.
//
// The scan is restartable and never blocks the main thread for long: entries
// are walked in batches, unchanged files are reused from IndexedDB by
// (size, mtime), and metadata parsing only touches the head/tail of a file.

import { MusicSearchIndex, type SearchField, type SearchableTrack } from "./music-search";
import { MusicStore, type StoredTrack, type StoredRoot, type MusicPlaylist } from "./music-store";
export type { MusicPlaylist, StoredRoot } from "./music-store";
import {
  asDirHandle,
  directorySource,
  ensurePermission,
  fileListSource,
  pickDirectory,
  type DirHandle,
  type MusicSource,
  type MusicFileEntry,
} from "./music-source";
import { isAudioFile, readTrackMeta, type TrackMeta } from "./music-metadata";
import type { BridgeTrack } from "./music-bridge";

export type LibraryTrack = SearchableTrack & {
  id: string;
  duration: number | null;
  codec: string;
  genre: string;
  year: string;
  disc: number | null;
  tagged: boolean;
  hasCover: boolean;
  missing: boolean;
  size: number;
  modified: number;
  /** True when the track comes from the local VLC bridge rather than the page. */
  bridge?: boolean;
};

export type ScanPhase = "walking" | "reading" | "saving" | "done" | "cancelled" | "error";

export type ScanProgress = {
  phase: ScanPhase;
  seen: number;
  parsed: number;
  reused: number;
  total: number;
  bytes: number;
};

export type ScanReport = ScanProgress & {
  totalFiles: number;
  part: number;
  parts: number;
  added: number;
  updated: number;
  removed: number;
  failed: number;
  ms: number;
};

const BATCH = 40;
export const PLAYLIST_TRACK_LIMIT = 1000;
export class PlaylistLimitError extends Error {
  readonly parts: number;
  constructor(readonly total: number) {
    super(`目录有 ${total} 首歌曲，每个歌单最多 ${PLAYLIST_TRACK_LIMIT} 首，请选择自动分卷或自行整理`);
    this.name = "PlaylistLimitError";
    this.parts = Math.ceil(total / PLAYLIST_TRACK_LIMIT);
  }
}
const COVER_MAX = 256;
export const COVER_URL_LIMIT = 384;
const COVER_URL_GRACE_MS = 1000;
export type CoverLease = { url: string; release(): void };

/** Yields to the event loop (and to idle time when the browser offers it). */
function breathe(): Promise<void> {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback;
  return new Promise((resolve) => {
    if (typeof idle === "function") idle(() => resolve(), { timeout: 180 });
    else setTimeout(resolve, 0);
  });
}

/** Keep current-playlist cover storage bounded. */
async function thumbnail(blob: Blob): Promise<Blob | null> {
  try {
    if (blob.size <= 96 * 1024) return blob;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, COVER_MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return blob.size <= 512 * 1024 ? blob : null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/jpeg", 0.82),
    );
  } catch {
    return blob.size <= 512 * 1024 ? blob : null;
  }
}

const toStored = (entry: { id: string; path: string; name: string; size: number; modified: number }, meta: TrackMeta, hasCover: boolean): StoredTrack => ({
  id: entry.id,
  path: entry.path,
  name: entry.name,
  size: entry.size,
  modified: entry.modified,
  title: meta.title,
  artist: meta.artist,
  album: meta.album,
  track: meta.track,
  disc: meta.disc,
  year: meta.year,
  genre: meta.genre,
  duration: meta.duration,
  codec: meta.codec,
  tagged: meta.tagged,
  hasCover,
  missing: false,
  added: Date.now(),
});

const toLibraryTrack = (stored: StoredTrack): LibraryTrack => ({
  id: stored.id,
  path: stored.path,
  name: stored.name,
  title: stored.title,
  artist: stored.artist,
  album: stored.album,
  track: stored.track,
  disc: stored.disc,
  year: stored.year,
  genre: stored.genre,
  duration: stored.duration,
  codec: stored.codec,
  tagged: stored.tagged,
  hasCover: stored.hasCover,
  missing: stored.missing,
  size: stored.size,
  modified: stored.modified,
});

export class MusicLibrary {
  readonly store = new MusicStore();
  tracks: LibraryTrack[] = [];
  source: MusicSource | null = null;
  label = "";
  persistent = false;
  scanning = false;

  private stored = new Map<string, StoredTrack>();
  private index = new MusicSearchIndex<LibraryTrack>([]);
  private coverUrls = new Map<string, string>();
  private coverPromises = new Map<string, Promise<string | null>>();
  private coverGeneration = 0;
  private pinnedCovers = new Set<string>();
  private coverHolds = new Map<string, number>();
  private coverTouchedAt = new Map<string, number>();
  private coverTrimTimer: ReturnType<typeof setTimeout> | null = null;
  private operationGeneration = 0;
  private operation = new AbortController();
  private scanGeneration: number | null = null;
  private reuseSource = true;
  private root: StoredRoot | null = null;
  private part = 0;
  private parts = 1;
  private totalFiles = 0;
  private split = false;
  private pending: { source: MusicSource; root: StoredRoot | null; part: number; split: boolean } | null = null;

  constructor(private readonly coverUrlLimit = COVER_URL_LIMIT) {}

  get hasSource() { return Boolean(this.pending || this.source); }
  get canScan() { return this.hasSource; }
  get currentRoot() { return this.root; }
  playlistSource() {
    if (!this.source) return null;
    return { name: this.root?.name ?? this.label, handle: this.root?.handle, part: this.part,
      parts: this.parts, total: this.totalFiles, persistent: this.persistent };
  }
  playlists() { return this.store.playlists(); }
  async savePlaylists(list: readonly MusicPlaylist[], activeId?: string) {
    const root = this.root;
    await this.store.putPlaylists(list, activeId, { signal: this.operation.signal });
    if (list.some(item => item.id === activeId && item.kind === "browser") && root && this.root === root)
      this.root = { ...root, playlistId: activeId };
  }

  private beginOperation() {
    this.operation.abort();
    this.operation = new AbortController();
    this.scanning = false;
    this.scanGeneration = null;
    return ++this.operationGeneration;
  }
  private currentOperation(generation: number) {
    return generation === this.operationGeneration && !this.operation.signal.aborted;
  }

  async restore(): Promise<boolean> {
    const generation = this.beginOperation();
    this.pending = null;
    await this.store.open();
    const saved = await this.store.allTracks();
    const root = await this.store.root();
    if (!this.currentOperation(generation)) return false;
    const handle = asDirHandle(root?.handle);
    if (saved.length > PLAYLIST_TRACK_LIMIT) {
      if (handle) this.pending = { source: directorySource(handle, root?.name ?? handle.name), root,
        part: 0, split: false };
      throw new PlaylistLimitError(saved.length);
    }
    this.releaseCovers();
    this.stored = new Map(saved.map((track) => [track.id, track]));
    this.tracks = saved.map(toLibraryTrack);
    this.refreshIndex();
    this.root = root;
    this.part = root?.part ?? 0;
    this.parts = root?.parts ?? 1;
    this.totalFiles = root?.total ?? saved.length;
    this.split = root?.split ?? false;
    if (handle) {
      this.source = directorySource(handle, root?.name ?? handle.name);
      this.label = this.source.label;
      this.persistent = true;
      this.reuseSource = true;
      return true;
    }
    if (saved.length) {
      this.source = null;
      this.label = "上次会话（需重新选择目录）";
      this.persistent = false;
      return true;
    }
    this.source = null;
    return false;
  }

  /** Re-opens the remembered directory inside a user gesture. */
  async reconnect(): Promise<boolean> {
    const generation = this.operationGeneration, root = this.root;
    if (this.pending || this.scanning) return false;
    const handle = asDirHandle(root?.handle);
    if (!handle) return false;
    if (!(await ensurePermission(handle, true))) return false;
    if (!this.currentOperation(generation) || root !== this.root || this.pending || this.scanning) return false;
    this.source = directorySource(handle, root?.name ?? handle.name);
    this.label = this.source.label;
    this.persistent = true;
    return true;
  }

  async pick(): Promise<boolean> {
    const generation = this.beginOperation();
    const handle: DirHandle = await pickDirectory();
    if (!this.currentOperation(generation)) return false;
    const granted = await ensurePermission(handle, true);
    if (!this.currentOperation(generation)) return false;
    if (!granted) throw new Error("permission");
    this.pending = { source: directorySource(handle),
      root: { name: handle.name, handle, savedAt: Date.now() }, part: 0, split: false };
    return true;
  }

  async usePlaylist(playlist: MusicPlaylist): Promise<boolean> {
    if (playlist.kind !== "browser") return false;
    const handle = asDirHandle(playlist.handle);
    if (!handle || !Number.isSafeInteger(playlist.part) || playlist.part < 0) return false;
    const generation = this.beginOperation();
    if (!(await ensurePermission(handle, true)) || !this.currentOperation(generation)) return false;
    this.pending = { source: directorySource(handle), root: { name: handle.name, handle,
      savedAt: Date.now(), playlistId: playlist.id }, part: playlist.part,
      split: playlist.part > 0 || (playlist.total ?? 0) > PLAYLIST_TRACK_LIMIT };
    return true;
  }

  /** Fallback path for browsers without the File System Access API. */
  useFiles(files: FileList | File[]) {
    this.beginOperation();
    this.pending = { source: fileListSource(files, "本次选择（不保存）"), root: null, part: 0, split: false };
  }

  /**
   * Replaces the library with the VLC bridge catalogue. The bridge owns the
   * files, the tags and playback, so the page only searches and displays it.
   */
  useBridgeTracks(tracks: readonly BridgeTrack[], root: string) {
    if (tracks.length > PLAYLIST_TRACK_LIMIT) throw new PlaylistLimitError(tracks.length);
    this.beginOperation();
    this.pending = null;
    this.root = null;
    this.releaseCovers();
    this.source = null;
    this.persistent = true;
    this.label = root || "VLC 桥接";
    this.stored.clear();
    this.tracks = tracks.map((track) => ({
      id: track.id,
      path: track.folder ? `${track.folder}/${track.name}` : track.name,
      name: track.name,
      title: track.title || track.name,
      artist: track.artist,
      album: track.album,
      track: track.track,
      disc: track.disc ?? null,
      year: track.year ?? "",
      genre: track.genre ?? "",
      duration: track.duration,
      codec: track.codec,
      tagged: Boolean(track.artist || track.album),
      hasCover: Boolean(track.hasCover),
      missing: false,
      size: track.size,
      modified: 0,
      bridge: true,
    }));
    this.refreshIndex();
  }

  search(query: string, field: SearchField = "all", limit = Infinity): LibraryTrack[] {
    return this.index.search(query, field, limit);
  }

  sorted(): LibraryTrack[] {
    return [...this.tracks].sort(
      (a, b) =>
        a.artist.localeCompare(b.artist, "zh-Hans-CN") ||
        a.album.localeCompare(b.album, "zh-Hans-CN") ||
        (a.track ?? 0) - (b.track ?? 0) ||
        a.title.localeCompare(b.title, "zh-Hans-CN"),
    );
  }

  stats() {
    let bytes = 0;
    let seconds = 0;
    let missing = 0;
    const artists = new Set<string>();
    for (const track of this.tracks) {
      bytes += track.size;
      seconds += track.duration ?? 0;
      if (track.missing) missing++;
      if (track.artist) artists.add(track.artist);
    }
    return { count: this.tracks.length, bytes, seconds, missing, artists: artists.size };
  }

  /** Bridge covers stream from the bridge instead of IndexedDB (2.0). */
  bridgeCoverUrl?: (id: string) => Promise<string | null>;

  /** Protect current visible, selected and playing covers. The budget may be
   * temporarily exceeded when every entry is actively pinned/leased. */
  pinCoverIds(ids: Iterable<string>) {
    const next = new Set(ids);
    if (next.size === this.pinnedCovers.size && [...next].every(id => this.pinnedCovers.has(id))) return;
    this.pinnedCovers = next;
    this.scheduleCoverTrim();
  }

  /** Keep the URL alive until an asynchronous decoder/consumer releases it. */
  async acquireCover(track: LibraryTrack): Promise<CoverLease | null> {
    const generation = this.coverGeneration;
    this.coverHolds.set(track.id, (this.coverHolds.get(track.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (generation !== this.coverGeneration) return;
      const remaining = (this.coverHolds.get(track.id) ?? 1) - 1;
      if (remaining > 0) this.coverHolds.set(track.id, remaining);
      else this.coverHolds.delete(track.id);
      this.scheduleCoverTrim();
    };
    try {
      const url = await this.coverUrl(track);
      if (!url) { release(); return null; }
      return { url, release };
    } catch (error) { release(); throw error; }
  }

  private scheduleCoverTrim(delay = 0) {
    if (this.coverTrimTimer !== null) clearTimeout(this.coverTrimTimer);
    this.coverTrimTimer = null;
    if (this.coverUrls.size <= this.coverUrlLimit) return;
    this.coverTrimTimer = setTimeout(() => {
      this.coverTrimTimer = null;
      let retryIn = Infinity;
      const now = performance.now();
      for (const [id, url] of this.coverUrls) {
        if (this.coverUrls.size <= this.coverUrlLimit) break;
        if (this.pinnedCovers.has(id) || this.coverHolds.has(id) || this.coverPromises.has(id)) continue;
        const grace = COVER_URL_GRACE_MS - (now - (this.coverTouchedAt.get(id) ?? 0));
        if (grace > 0) { retryIn = Math.min(retryIn, grace); continue; }
        URL.revokeObjectURL(url);
        this.coverUrls.delete(id);
        this.coverTouchedAt.delete(id);
      }
      if (this.coverUrls.size > this.coverUrlLimit && Number.isFinite(retryIn))
        this.scheduleCoverTrim(Math.max(1, retryIn));
    }, delay);
  }

  async coverUrl(track: LibraryTrack): Promise<string | null> {
    if (!this.tracks.includes(track)) return null;
    const cached = this.coverUrls.get(track.id);
    if (cached) {
      this.coverUrls.delete(track.id);
      this.coverUrls.set(track.id, cached);
      this.coverTouchedAt.set(track.id, performance.now());
      this.scheduleCoverTrim();
      return cached;
    }
    const pending = this.coverPromises.get(track.id);
    if (pending) return pending;
    if (!track.hasCover) return null;
    const generation = this.coverGeneration;
    const request = (async () => {
      let url: string | null = null;
      if (track.bridge) url = (await this.bridgeCoverUrl?.(track.id).catch(() => null)) ?? null;
      else {
        const blob = await this.store.cover(track.id);
        if (blob) {
          // Re-wrap IndexedDB blobs before creating an object URL. Chromium can
          // retain a stale decoder-backed Blob after an IDB transaction closes;
          // materializing the bytes keeps the URL readable for canvas and WebGL.
          const bytes = await blob.arrayBuffer();
          const materialized = new Blob([bytes], {
            type: blob.type || "application/octet-stream",
          });
          url = URL.createObjectURL(materialized);
        }
      }
      if (!url) return null;
      if (generation !== this.coverGeneration) {
        URL.revokeObjectURL(url);
        return null;
      }
      this.coverUrls.set(track.id, url);
      this.coverTouchedAt.set(track.id, performance.now());
      this.scheduleCoverTrim();
      return url;
    })();
    this.coverPromises.set(track.id, request);
    try {
      return await request;
    } finally {
      if (this.coverPromises.get(track.id) === request) this.coverPromises.delete(track.id);
    }
  }

  async file(track: LibraryTrack): Promise<File | null> {
    if (!this.source || !this.tracks.includes(track)) return null;
    const source = this.source, generation = this.operationGeneration;
    const file = await source.resolve(track.path);
    if (source !== this.source || generation !== this.operationGeneration) return null;
    if (!file) {
      track.missing = true;
      const stored = this.stored.get(track.id);
      if (stored) {
        stored.missing = true;
        void this.store.putTracks([stored], this.operation.signal).catch(() => {});
      }
    }
    return file;
  }

  async clear(): Promise<void> {
    const generation = this.beginOperation(), signal = this.operation.signal;
    this.pending = null;
    this.stored.clear();
    this.tracks = [];
    this.refreshIndex();
    this.releaseCovers();
    try { await this.store.clearLibrary(signal); }
    catch (error) { if (this.currentOperation(generation)) throw error; }
  }

  releaseCovers() {
    this.coverGeneration++;
    for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
    this.coverUrls.clear();
    this.coverPromises.clear();
    this.coverHolds.clear();
    this.coverTouchedAt.clear();
    if (this.coverTrimTimer !== null) clearTimeout(this.coverTrimTimer);
    this.coverTrimTimer = null;
  }

  private refreshIndex() {
    this.tracks = [...this.tracks].sort((a, b) =>
      a.path.localeCompare(b.path, "zh-Hans-CN"),
    );
    this.index = new MusicSearchIndex<LibraryTrack>(this.tracks);
  }

  /** Cancel pending discovery/metadata/commit without changing the last
   * successfully published catalogue. A later scan can start immediately. */
  cancelScan() {
    if (!this.scanning) return;
    this.beginOperation();
  }

  /** Engine/source handoffs also invalidate a pending picker or restore. */
  cancelPending() {
    this.beginOperation();
    this.pending = null;
  }

  /**
   * Walks the source and updates the index. Unchanged files keep their stored
   * metadata, so a second scan of a large library is mostly directory I/O.
   */
  async scan(
    onProgress: (progress: ScanProgress) => void,
    options: { signal?: AbortSignal; part?: number; split?: boolean } = {},
  ): Promise<ScanReport> {
    const started = Date.now();
    const report: ScanReport = {
      phase: "walking",
      totalFiles: 0,
      part: 0,
      parts: 1,
      seen: 0,
      parsed: 0,
      reused: 0,
      total: 0,
      bytes: 0,
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      ms: 0,
    };
    if (!this.hasSource || this.scanning) return report;
    const selection = this.pending;
    const source = selection?.source ?? this.source!;
    const requestedPart = options.part ?? selection?.part ?? this.part;
    const split = options.split ?? selection?.split ?? this.split;
    if (!Number.isSafeInteger(requestedPart) || requestedPart < 0) throw new Error("歌单分卷编号无效");
    const generation = this.beginOperation();
    const controller = this.operation;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.scanning = true;
    this.scanGeneration = generation;
    const previous = new Map(this.stored);
    const reuseSource = this.reuseSource && !selection && requestedPart === this.part;
    const next = new Map<string, StoredTrack>();
    const check = () => {
      if (controller.signal.aborted || !this.currentOperation(generation) ||
        (selection ? this.pending !== selection : this.source !== source))
        throw new DOMException("Scan cancelled", "AbortError");
    };
    const publishProgress = () => {
      if (generation === this.operationGeneration) onProgress({ ...report });
    };
    const entries: MusicFileEntry[] = [];
    const stale: {
      id: string;
      path: string;
      name: string;
      size: number;
      modified: number;
      load: () => Promise<File>;
    }[] = [];
    const covers: { id: string; blob: Blob }[] = [];

    try {
      report.phase = "walking";
      check();
      for await (const entry of source.entries()) {
        check();
        report.seen++;
        if (!isAudioFile(entry.name)) continue;
        entries.push(entry);
        report.totalFiles++;
        if (report.seen % 200 === 0) {
          publishProgress();
          await breathe();
          check();
        }
      }
      check();
      report.parts = Math.max(1, Math.ceil(report.totalFiles / PLAYLIST_TRACK_LIMIT));
      report.part = requestedPart;
      if (report.totalFiles > PLAYLIST_TRACK_LIMIT && !split) throw new PlaylistLimitError(report.totalFiles);
      if (requestedPart >= report.parts) throw new Error("该歌单分卷已不存在，请重新选择");
      entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const selectedEntries = entries.slice(requestedPart * PLAYLIST_TRACK_LIMIT, (requestedPart + 1) * PLAYLIST_TRACK_LIMIT);
      report.total = selectedEntries.length;
      for (const entry of selectedEntries) {
        check();
        const saved = previous.get(entry.path);
        let file: File;
        try { file = await entry.load(); }
        catch {
          check();
          if (reuseSource && saved) next.set(saved.id, saved);
          report.failed++;
          continue;
        }
        check();
        report.bytes += file.size;
        const unchanged =
          reuseSource && saved && saved.size === file.size && saved.modified === file.lastModified && !saved.missing;
        if (unchanged) {
          report.reused++;
          next.set(saved.id, saved);
        } else {
          stale.push({
            id: entry.path,
            path: entry.path,
            name: entry.name,
            size: file.size,
            modified: file.lastModified,
            load: async () => file,
          });
        }
      }

      check();

      report.phase = "reading";
      publishProgress();
      let processed = 0;
      for (const item of stale) {
        check();
        try {
          const file = await item.load();
          check();
          const meta = await readTrackMeta(file, item.name);
          check();
          let hasCover = false;
          if (meta.picture) {
            const cover = await thumbnail(
              new Blob([meta.picture.data as unknown as BlobPart], { type: meta.picture.mime }),
            );
            check();
            if (cover) {
              covers.push({ id: item.id, blob: cover });
              hasCover = true;
            }
          }
          next.set(item.id, toStored(item, meta, hasCover));
          report.parsed++;
          if (previous.has(item.id)) report.updated++;
          else report.added++;
        } catch {
          check();
          const saved = previous.get(item.id);
          if (reuseSource && saved) next.set(item.id, saved);
          report.failed++;
        }
        if (++processed % BATCH === 0) {
          publishProgress();
          await breathe();
          check();
        }
      }

      // Files that disappeared from the source are dropped from the index.
      check();
      if (report.total > 0 && !next.size && report.failed > 0) throw new Error("此歌单的歌曲均无法读取");
      report.removed = [...previous.keys()].filter(id => !next.has(id)).length;

      report.phase = "saving";
      publishProgress();
      check();
      const selectedRoot = selection ? selection.root : this.root;
      const root = selectedRoot ? { ...selectedRoot, part: requestedPart, parts: report.parts,
        total: report.totalFiles, split } : null;
      await this.store.commitScan([...next.values()], covers, { signal: controller.signal, root });
      check();

      // Rebuild the in-memory view from the store so reused and parsed entries
      // share one code path.
      this.releaseCovers();
      this.source = source;
      this.label = source.label;
      this.persistent = source.persistent;
      this.root = root;
      this.part = requestedPart;
      this.parts = report.parts;
      this.totalFiles = report.totalFiles;
      this.split = split;
      if (this.pending === selection) this.pending = null;
      this.stored = next;
      this.tracks = [...next.values()].map(toLibraryTrack);
      this.reuseSource = true;
      this.refreshIndex();
      report.phase = "done";
      report.ms = Date.now() - started;
      publishProgress();
      return report;
    } catch (error) {
      if (error instanceof PlaylistLimitError) throw error;
      report.phase = controller.signal.aborted || !this.currentOperation(generation) ||
        (selection ? this.pending !== selection : this.source !== source)
        ? "cancelled" : "error";
      report.ms = Date.now() - started;
      publishProgress();
      return report;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.scanGeneration === generation) {
        this.scanning = false;
        this.scanGeneration = null;
      }
    }
  }
}
