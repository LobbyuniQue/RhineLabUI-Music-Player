// Local music library: scanning, incremental indexing and queries.
//
// The scan is restartable and never blocks the main thread for long: entries
// are walked in batches, unchanged files are reused from IndexedDB by
// (size, mtime), and metadata parsing only touches the head/tail of a file.

import { MusicSearchIndex, type SearchField, type SearchableTrack } from "./music-search";
import { MusicStore, type StoredTrack } from "./music-store";
import {
  asDirHandle,
  directorySource,
  ensurePermission,
  fileListSource,
  pickDirectory,
  type DirHandle,
  type MusicSource,
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
  added: number;
  updated: number;
  removed: number;
  failed: number;
  ms: number;
};

const BATCH = 40;
const COVER_MAX = 256;

/** Yields to the event loop (and to idle time when the browser offers it). */
function breathe(): Promise<void> {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback;
  return new Promise((resolve) => {
    if (typeof idle === "function") idle(() => resolve(), { timeout: 180 });
    else setTimeout(resolve, 0);
  });
}

/** Downscales cover art so a 10k library does not store gigabytes of JPEG. */
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

  async restore(): Promise<boolean> {
    await this.store.open();
    const saved = await this.store.allTracks();
    this.stored = new Map(saved.map((track) => [track.id, track]));
    this.tracks = saved.map(toLibraryTrack);
    this.refreshIndex();
    const root = await this.store.root();
    const handle = asDirHandle(root?.handle);
    if (handle) {
      this.source = directorySource(handle, root?.name ?? handle.name);
      this.label = this.source.label;
      this.persistent = true;
      return true;
    }
    if (saved.length) {
      this.label = "上次会话（需重新选择目录）";
      this.persistent = false;
      return true;
    }
    return false;
  }

  /** Re-opens the remembered directory inside a user gesture. */
  async reconnect(): Promise<boolean> {
    const root = await this.store.root();
    const handle = asDirHandle(root?.handle);
    if (!handle) return false;
    if (!(await ensurePermission(handle, true))) return false;
    this.source = directorySource(handle, root?.name ?? handle.name);
    this.label = this.source.label;
    this.persistent = true;
    return true;
  }

  async pick(): Promise<boolean> {
    const handle: DirHandle = await pickDirectory();
    const granted = await ensurePermission(handle, true);
    if (!granted) throw new Error("permission");
    this.source = directorySource(handle);
    this.label = handle.name;
    this.persistent = true;
    await this.store.putRoot({ name: handle.name, handle, savedAt: Date.now() });
    return true;
  }

  /** Fallback path for browsers without the File System Access API. */
  useFiles(files: FileList | File[]) {
    this.source = fileListSource(files, "本次选择（不保存）");
    this.label = this.source.label;
    this.persistent = false;
  }

  /**
   * Replaces the library with the VLC bridge catalogue. The bridge owns the
   * files, the tags and playback, so the page only searches and displays it.
   */
  useBridgeTracks(tracks: readonly BridgeTrack[], root: string) {
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

  search(query: string, field: SearchField = "all", limit = 240): LibraryTrack[] {
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

  async coverUrl(track: LibraryTrack): Promise<string | null> {
    const cached = this.coverUrls.get(track.id);
    if (cached) return cached;
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
      return url;
    })();
    this.coverPromises.set(track.id, request);
    try {
      return await request;
    } finally {
      this.coverPromises.delete(track.id);
    }
  }

  async file(track: LibraryTrack): Promise<File | null> {
    if (!this.source) return null;
    const file = await this.source.resolve(track.path);
    if (!file) {
      track.missing = true;
      const stored = this.stored.get(track.id);
      if (stored) {
        stored.missing = true;
        void this.store.putTracks([stored]);
      }
    }
    return file;
  }

  async clear(): Promise<void> {
    await this.store.clearLibrary();
    this.stored.clear();
    this.tracks = [];
    this.refreshIndex();
    this.releaseCovers();
  }

  releaseCovers() {
    this.coverGeneration++;
    for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
    this.coverUrls.clear();
    this.coverPromises.clear();
  }

  private refreshIndex() {
    this.index = new MusicSearchIndex<LibraryTrack>(this.tracks);
    this.tracks = [...this.tracks].sort((a, b) =>
      a.path.localeCompare(b.path, "zh-Hans-CN"),
    );
    this.index = new MusicSearchIndex<LibraryTrack>(this.tracks);
  }

  /**
   * Walks the source and updates the index. Unchanged files keep their stored
   * metadata, so a second scan of a large library is mostly directory I/O.
   */
  async scan(
    onProgress: (progress: ScanProgress) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScanReport> {
    const started = Date.now();
    const report: ScanReport = {
      phase: "walking",
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
    if (!this.source || this.scanning) return report;
    this.scanning = true;
    const source = this.source;
    const seen = new Set<string>();
    const stale: {
      id: string;
      path: string;
      name: string;
      size: number;
      modified: number;
      load: () => Promise<File>;
    }[] = [];
    const pending: StoredTrack[] = [];
    const covers: { id: string; blob: Blob }[] = [];

    try {
      report.phase = "walking";
      for await (const entry of source.entries()) {
        if (options.signal?.aborted) {
          report.phase = "cancelled";
          break;
        }
        report.seen++;
        report.bytes += entry.size;
        if (!isAudioFile(entry.name)) continue;
        seen.add(entry.path);
        report.total++;
        const previous = this.stored.get(entry.path);
        const unchanged =
          previous && previous.size === entry.size && previous.modified === entry.modified && !previous.missing;
        if (unchanged) {
          report.reused++;
        } else {
          stale.push({
            id: entry.path,
            path: entry.path,
            name: entry.name,
            size: entry.size,
            modified: entry.modified,
            load: entry.load,
          });
        }
        if (report.seen % 200 === 0) {
          onProgress({ ...report });
          await breathe();
        }
      }

      if (report.phase === "cancelled") {
        report.ms = Date.now() - started;
        onProgress({ ...report });
        return report;
      }

      report.phase = "reading";
      onProgress({ ...report });
      let processed = 0;
      for (const item of stale) {
        if (options.signal?.aborted) {
          report.phase = "cancelled";
          break;
        }
        try {
          const file = await item.load();
          const meta = await readTrackMeta(file, item.name);
          let hasCover = this.stored.get(item.id)?.hasCover ?? false;
          if (meta.picture) {
            const cover = await thumbnail(
              new Blob([meta.picture.data as unknown as BlobPart], { type: meta.picture.mime }),
            );
            if (cover) {
              covers.push({ id: item.id, blob: cover });
              hasCover = true;
            }
          }
          pending.push(toStored(item, meta, hasCover));
          report.parsed++;
          if (this.stored.has(item.id)) report.updated++;
          else report.added++;
        } catch {
          report.failed++;
        }
        if (++processed % BATCH === 0) {
          onProgress({ ...report });
          await breathe();
        }
      }

      // Files that disappeared from the source are dropped from the index.
      const removed: string[] = [];
      for (const id of this.stored.keys()) if (!seen.has(id)) removed.push(id);
      report.removed = removed.length;

      report.phase = "saving";
      onProgress({ ...report });
      for (let i = 0; i < pending.length; i += 200) {
        await this.store.putTracks(pending.slice(i, i + 200));
        await breathe();
      }
      await this.store.removeTracks(removed);
      for (let i = 0; i < covers.length; i += 20) {
        for (const cover of covers.slice(i, i + 20)) await this.store.putCover(cover.id, cover.blob);
        await breathe();
      }

      // Rebuild the in-memory view from the store so reused and parsed entries
      // share one code path.
      const all = await this.store.allTracks();
      this.stored = new Map(all.map((track) => [track.id, track]));
      this.tracks = all.map(toLibraryTrack);
      this.refreshIndex();
      report.phase = "done";
      report.ms = Date.now() - started;
      onProgress({ ...report });
      return report;
    } catch {
      report.phase = "error";
      report.ms = Date.now() - started;
      onProgress({ ...report });
      return report;
    } finally {
      this.scanning = false;
    }
  }
}
