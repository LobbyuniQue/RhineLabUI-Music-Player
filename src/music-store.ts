// Local music persistence.
//
// The library index, the remembered directory handle and cover thumbnails live
// in IndexedDB — the project's first use of it, because a 10k track catalogue
// cannot go into localStorage. Everything degrades to an in-memory map when
// IndexedDB is unavailable (private windows, blocked storage), so the music
// panel still works for the current session instead of failing outright.

export type StoredTrack = {
  /** Full path inside the picked directory; also the primary key. */
  id: string;
  path: string;
  name: string;
  size: number;
  modified: number;
  title: string;
  artist: string;
  album: string;
  track: number | null;
  disc: number | null;
  year: string;
  genre: string;
  duration: number | null;
  codec: string;
  tagged: boolean;
  hasCover: boolean;
  /** True when the file could not be read during the last scan. */
  missing: boolean;
  added: number;
};

export type StoredRoot = { name: string; handle: unknown; savedAt: number };

const DB_NAME = "rhine-music";
const DB_VERSION = 1;
const TRACKS = "tracks";
const COVERS = "covers";
const META = "meta";
const ROOT_KEY = "root";

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class MusicStore {
  private db: IDBDatabase | null = null;
  private memory: {
    tracks: Map<string, StoredTrack>;
    covers: Map<string, Blob>;
    root: StoredRoot | null;
  } = { tracks: new Map(), covers: new Map(), root: null };
  private fallback = false;

  get persistent() {
    return !this.fallback && this.db !== null;
  }

  async open(): Promise<boolean> {
    if (this.db) return true;
    if (this.fallback) return false;
    try {
      if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS);
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      this.db = await promisify(request);
      return true;
    } catch {
      // Storage can be unavailable or blocked; keep running from memory.
      this.fallback = true;
      this.db = null;
      return false;
    }
  }

  async allTracks(): Promise<StoredTrack[]> {
    if (await this.open()) {
      const tx = this.db!.transaction(TRACKS, "readonly");
      return promisify(tx.objectStore(TRACKS).getAll() as IDBRequest<StoredTrack[]>);
    }
    return [...this.memory.tracks.values()];
  }

  async putTracks(tracks: readonly StoredTrack[]): Promise<void> {
    if (!tracks.length) return;
    if (await this.open()) {
      const tx = this.db!.transaction(TRACKS, "readwrite");
      const store = tx.objectStore(TRACKS);
      for (const track of tracks) store.put(track);
      await transactionDone(tx);
      return;
    }
    for (const track of tracks) this.memory.tracks.set(track.id, track);
  }

  async removeTracks(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    if (await this.open()) {
      const tx = this.db!.transaction(TRACKS, "readwrite");
      const store = tx.objectStore(TRACKS);
      for (const id of ids) store.delete(id);
      await transactionDone(tx);
    } else {
      for (const id of ids) this.memory.tracks.delete(id);
    }
    await this.removeCovers(ids);
  }

  async putCover(id: string, blob: Blob): Promise<void> {
    if (await this.open()) {
      const tx = this.db!.transaction(COVERS, "readwrite");
      tx.objectStore(COVERS).put(blob, id);
      await transactionDone(tx);
      return;
    }
    this.memory.covers.set(id, blob);
  }

  async cover(id: string): Promise<Blob | undefined> {
    if (await this.open()) {
      const tx = this.db!.transaction(COVERS, "readonly");
      return promisify(tx.objectStore(COVERS).get(id) as IDBRequest<Blob | undefined>);
    }
    return this.memory.covers.get(id);
  }

  async removeCovers(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    if (await this.open()) {
      const tx = this.db!.transaction(COVERS, "readwrite");
      const store = tx.objectStore(COVERS);
      for (const id of ids) store.delete(id);
      await transactionDone(tx);
      return;
    }
    for (const id of ids) this.memory.covers.delete(id);
  }

  async putRoot(root: StoredRoot): Promise<void> {
    if (await this.open()) {
      try {
        const tx = this.db!.transaction(META, "readwrite");
        tx.objectStore(META).put(root, ROOT_KEY);
        await transactionDone(tx);
        return;
      } catch {
        // Handles are only structured-cloneable in Chromium; keep the memory copy.
      }
    }
    this.memory.root = root;
  }

  async root(): Promise<StoredRoot | null> {
    if (await this.open()) {
      try {
        const tx = this.db!.transaction(META, "readonly");
        const value = await promisify(tx.objectStore(META).get(ROOT_KEY) as IDBRequest<StoredRoot | undefined>);
        if (value) return value;
      } catch {
        /* fall through to memory */
      }
    }
    return this.memory.root;
  }

  async clearLibrary(): Promise<void> {
    if (await this.open()) {
      const tx = this.db!.transaction([TRACKS, COVERS], "readwrite");
      tx.objectStore(TRACKS).clear();
      tx.objectStore(COVERS).clear();
      await transactionDone(tx);
    }
    this.memory.tracks.clear();
    this.memory.covers.clear();
  }
}
