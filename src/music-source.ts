// Where local music files come from.
//
// Chromium exposes the File System Access API, so the user picks a directory
// once and the handle can be remembered. Safari/Firefox have neither, so the
// same interface is also implemented over an <input type="file" webkitdirectory>
// FileList — usable for the session, but not persistent.

export type PermissionState = "granted" | "denied" | "prompt";

type DirEntryIterator = AsyncIterableIterator<FileHandle | DirHandle>;

export type FileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};

export type DirHandle = {
  kind: "directory";
  name: string;
  values(): DirEntryIterator;
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

export type MusicFileEntry = {
  /** Path relative to the picked root; unique inside a library. */
  path: string;
  name: string;
  size?: number;
  modified?: number;
  load(): Promise<File>;
};

export type MusicSource = {
  label: string;
  /** True when the source can be reopened after a reload. */
  persistent: boolean;
  entries(): AsyncGenerator<MusicFileEntry>;
  /** Resolves one path back to a readable File for playback. */
  resolve(path: string): Promise<File | null>;
};

const MAX_DEPTH = 8;
const MAX_FILES = 40000;
const SKIP_DIRECTORIES = new Set([
  "$recycle.bin",
  "system volume information",
  "node_modules",
  ".git",
  ".cache",
  "windows",
]);

export function directoryPickerSupported() {
  return typeof window !== "undefined" && typeof pickerOf(window) === "function";
}

function pickerOf(target: unknown) {
  return (target as { showDirectoryPicker?: (options?: unknown) => Promise<unknown> }).showDirectoryPicker;
}

/** Opens the native directory chooser. Throws on denial/cancel. */
export async function pickDirectory(): Promise<DirHandle> {
  const picker = pickerOf(window);
  if (typeof picker !== "function") throw new Error("unsupported");
  const handle = (await picker.call(window, { id: "rhine-music", mode: "read" })) as DirHandle;
  if (!handle || handle.kind !== "directory") throw new Error("unsupported");
  return handle;
}

/** Re-checks a remembered handle; `request` must run inside a user gesture. */
export async function ensurePermission(handle: DirHandle, request: boolean): Promise<boolean> {
  try {
    if (!handle.queryPermission) return true; // not a real FS handle
    const current = await handle.queryPermission({ mode: "read" });
    if (current === "granted") return true;
    if (!request || !handle.requestPermission) return false;
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

export function asDirHandle(value: unknown): DirHandle | null {
  const handle = value as DirHandle | null | undefined;
  return handle && handle.kind === "directory" && typeof handle.values === "function" ? handle : null;
}

type SegmentedHandle = DirHandle & {
  getDirectoryHandle?(name: string): Promise<DirHandle>;
  getFileHandle?(name: string): Promise<FileHandle>;
};

/** Walks "Album/01 track.flac" back to a File without rescanning the tree. */
async function resolveInDirectory(root: DirHandle, path: string): Promise<File | null> {
  const parts = path.split("/").filter(Boolean);
  let dir: SegmentedHandle = root as SegmentedHandle;
  for (const part of parts.slice(0, -1)) {
    if (!dir.getDirectoryHandle) return null;
    dir = (await dir.getDirectoryHandle(part)) as SegmentedHandle;
  }
  if (!dir.getFileHandle) return null;
  const file = await dir.getFileHandle(parts[parts.length - 1]);
  return file.getFile();
}

export function directorySource(handle: DirHandle, label = handle.name): MusicSource {
  return {
    label,
    persistent: true,
    resolve: (path) => resolveInDirectory(handle, path).catch(() => null),
    async *entries() {
      const queue: { dir: DirHandle; prefix: string; depth: number }[] = [
        { dir: handle, prefix: "", depth: 0 },
      ];
      let emitted = 0;
      while (queue.length) {
        const { dir, prefix, depth } = queue.shift()!;
        if (depth > MAX_DEPTH) continue;
        for await (const child of dir.values()) {
          if (!child || typeof child.name !== "string") continue;
          const path = prefix ? `${prefix}/${child.name}` : child.name;
          if (child.kind === "directory") {
            const name = child.name.toLowerCase();
            if (name.startsWith(".") || SKIP_DIRECTORIES.has(name)) continue;
            queue.push({ dir: child as DirHandle, prefix: path, depth: depth + 1 });
            continue;
          }
          const fileHandle = child as FileHandle;
          if (typeof fileHandle.getFile !== "function") continue;
          // Enumerate handles only; opening files waits until a volume is chosen.
          let cached: File | null = null;
          const load = async () => {
            if (!cached) cached = await fileHandle.getFile();
            return cached;
          };
          yield { path, name: child.name, load };
          if (++emitted >= MAX_FILES) return;
        }
      }
    },
  };
}

/** Session-only source built from <input type="file" webkitdirectory>. */
export function fileListSource(files: FileList | File[], label: string): MusicSource {
  const list = Array.from(files);
  const byPath = new Map<string, File>();
  for (const file of list) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    byPath.set(relative && relative.length ? relative : file.name, file);
  }
  return {
    label,
    persistent: false,
    resolve: async (path) => byPath.get(path) ?? null,
    async *entries() {
      for (const file of list) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        yield {
          path: relative && relative.length ? relative : file.name,
          name: file.name,
          size: file.size,
          modified: file.lastModified,
          load: async () => file,
        };
      }
    },
  };
}
