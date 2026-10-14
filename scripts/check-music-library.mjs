// Real library/store/search regression checks. All files and covers are
// synthetic; controllable delays complete obsolete work after cancellation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { MusicStore } from "../src/music-store.ts";
import { MusicSearchIndex } from "../src/music-search.ts";

const libraryFile = new URL("../src/music-library.ts", import.meta.url);
const code = ts.transpileModule(readFileSync(libraryFile, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/from "(\.\/.+?)"/g, (_, name) => `from "${new URL(`${name}.ts`, libraryFile).href}"`);
const { MusicLibrary } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => [...new TextEncoder().encode(value)];
const fixture = (name = "track.mp3", cover = "red", modified = 1000) => {
  const frames = [];
  const frame = (id, payload) => frames.push(...text(id), 0, 0, 0, payload.length, 0, 0, ...payload);
  frame("TIT2", [3, ...text(name)]);
  frame("TPE1", [3, ...text("Bulk Artist")]);
  if (cover) frame("APIC", [0, ...text("image/svg+xml"), 0, 3, 0,
    ...text(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${cover}"/></svg>`)]);
  const size = [(frames.length >>> 21) & 127, (frames.length >>> 14) & 127, (frames.length >>> 7) & 127, frames.length & 127];
  class MetadataFile extends File {
    arrayBuffer() { throw new Error("whole audio file loading is prohibited during indexing"); }
  }
  return new MetadataFile([Uint8Array.from([...text("ID3"), 3, 0, 0, ...size, ...frames, 0xff, 0xfb, 0x90, 0, ...new Array(600).fill(0)])], name, { lastModified: modified });
};
const source = (file, load = async () => file) => ({
  label: "Synthetic", persistent: false, resolve: load,
  async *entries() { yield { path: file.name, name: file.name, size: file.size, modified: file.lastModified, load }; },
});
const bridgeTrack = id => ({ id, name: `${id}.mp3`, folder: "Fixtures", title: id,
  artist: "Bulk Artist", album: "Fixtures", track: 1, duration: 60, codec: "mp3", hasCover: true, size: 1 });
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
const urls = new Map(), revoked = [];
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  createElement() { throw new Error("indexing may not instantiate audio or video elements"); },
} });
URL.createObjectURL = blob => { const url = createUrl(blob); urls.set(url, blob); return url; };
URL.revokeObjectURL = url => { revoked.push(url); urls.delete(url); revokeUrl(url); };
const libraries = [];
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`library: ${name}`); }
const library = (budget) => { const value = new MusicLibrary(budget); libraries.push(value); return value; };
const seed = async () => {
  const value = library(); value.useFiles([fixture("old.mp3")]);
  assert.equal((await value.scan(() => {})).phase, "done");
  return value;
};
const directory = (name, file, fail = false) => ({
  kind: "directory", name,
  async *values() { if (fail) throw new Error("unreadable directory"); yield { kind: "file", name: file.name, getFile: async () => file }; },
  async getFileHandle() { return { getFile: async () => file }; },
});
// Exercise the real IDB transaction branch, including queued writes, atomic
// rollback and synchronous structured-clone failures; no extra test dependency.
function indexedDbFixture() {
  const data = new Map(["tracks", "covers", "meta"].map(name => [name, new Map()]));
  let failNext = false, beforeComplete = null;
  return {
    failNext() { failNext = true; },
    beforeComplete(callback) { beforeComplete = callback; },
    transaction(names, mode) {
      const stores = Array.isArray(names) ? names : [names];
      const draft = new Map(stores.map(name => [name, new Map(data.get(name))]));
      const queue = [];
      let aborted = false;
      const tx = {
        error: null, oncomplete: null, onabort: null, onerror: null,
        abort() {
          if (aborted) return;
          aborted = true;
          tx.error ??= new DOMException("transaction aborted", "AbortError");
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name) {
          assert.ok(draft.has(name), `transaction must include ${name}`);
          const map = draft.get(name);
          const request = (run) => {
            const result = { result: undefined, error: null, onsuccess: null, onerror: null };
            queue.push(() => {
              if (aborted) return;
              try { result.result = run(); result.onsuccess?.(); }
              catch (error) { result.error = tx.error = error; result.onerror?.(); tx.abort(); }
            });
            return result;
          };
          return {
            put(value, key) {
              const clone = structuredClone(value);
              return request(() => map.set(key ?? clone.id, clone));
            },
            delete(key) { return request(() => map.delete(key)); },
            clear() { return request(() => map.clear()); },
            get(key) { return request(() => structuredClone(map.get(key))); },
            getAll() { return request(() => structuredClone([...map.values()])); },
            getAllKeys() { return request(() => [...map.keys()]); },
          };
        },
      };
      queueMicrotask(() => {
        while (queue.length && !aborted) queue.shift()();
        if (mode === "readwrite") {
          const callback = beforeComplete; beforeComplete = null; callback?.();
          if (failNext) { failNext = false; tx.error = new Error("simulated disk failure"); tx.abort(); }
        }
        if (aborted) return;
        if (mode === "readwrite") for (const name of stores) data.set(name, draft.get(name));
        tx.oncomplete?.();
      });
      return tx;
    },
  };
}
try {
  await check("selected source and root publish only with a successful scan", async () => {
    const value = library(), a = fixture("same.mp3", "red"), b = fixture("same.mp3", "tan");
    const rootA = directory("A", a), rootB = directory("B", b, true);
    window.showDirectoryPicker = async () => rootA;
    assert.equal(await value.pick(), true);
    assert.equal(value.source, null, "the picker creates a candidate, not a published source");
    assert.equal(value.hasSource, true);
    assert.equal((await value.scan(() => {})).phase, "done");
    const selected = value.tracks[0], sourceA = value.source, savedA = await value.store.root();
    window.showDirectoryPicker = async () => rootB;
    assert.equal(await value.pick(), true);
    assert.equal(value.source, sourceA); assert.deepEqual(await value.store.root(), savedA);
    assert.equal(await value.file(selected), a, "old rows keep using their own published source");
    assert.equal((await value.scan(() => {})).phase, "error");
    assert.equal(value.tracks[0], selected); assert.equal(value.source, sourceA);
    assert.deepEqual(await value.store.root(), savedA);
    await value.restore(); assert.equal(value.label, "A"); assert.equal(await value.file(value.tracks[0]), a);
    rootB.values = async function* () { yield { kind: "file", name: b.name, getFile: async () => b }; };
    window.showDirectoryPicker = async () => rootB;
    await value.pick(); assert.equal((await value.scan(() => {})).phase, "done");
    assert.equal(value.label, "B"); assert.equal((await value.store.root()).name, "B");
    assert.equal(await value.file(selected), null, "a retained old track cannot resolve against the new catalogue");
    assert.equal(await value.coverUrl(selected), null, "a retained old cover cannot resolve against the new catalogue");
    delete window.showDirectoryPicker;
  });
  await check("over-limit candidates require explicit splitting and parse one stable volume", async () => {
    const value = await seed(), selected = value.tracks[0], sourceBefore = value.source;
    const files = Array.from({length: 1001}, (_, index) => fixture(`track-${String(index).padStart(4, "0")}.mp3`, null));
    let reads = 0;
    for (const file of files) { const slice = file.slice.bind(file); file.slice = (...args) => { reads++; return slice(...args); }; }
    value.useFiles([...files].reverse());
    await assert.rejects(value.scan(() => {}), error => error.name === "PlaylistLimitError" && error.total === 1001 && error.parts === 2);
    assert.equal(reads, 0, "the limit is checked before any metadata bytes are read");
    assert.equal(value.source, sourceBefore); assert.equal(value.tracks[0], selected);
    const first = await value.scan(() => {}, {split: true});
    assert.equal(first.totalFiles, 1001); assert.equal(first.parts, 2); assert.equal(first.part, 0);
    assert.equal(first.parsed, 1000); assert.equal(value.tracks.length, 1000);
    assert.equal(value.tracks[0].name, "track-0000.mp3"); assert.equal(value.tracks.at(-1).name, "track-0999.mp3");
    const second = await value.scan(() => {}, {part: 1});
    assert.equal(second.parsed, 1); assert.equal(second.part, 1); assert.equal(value.tracks.length, 1);
    assert.equal(value.tracks[0].name, "track-1000.mp3");
    assert.equal((await value.store.allTracks()).length, 1, "inactive volumes have no stored index");
  });
  await check("directory discovery opens only the chosen volume, and restores that volume after reload", async () => {
    const value = library();
    const files = Array.from({length: 1001}, (_, index) => fixture(`track-${String(index).padStart(4, "0")}.mp3`, null));
    const opened = [];
    const handle = {kind: "directory", name: "Split directory", async *values() {
      for (const file of [...files].reverse()) yield {kind: "file", name: file.name, getFile: async () => { opened.push(file.name); return file; }};
      yield {kind: "file", name: "notes.txt", getFile: async () => { throw new Error("non-audio files must not be opened"); }};
    }, async getFileHandle(name) { return {getFile: async () => files.find(file => file.name === name)}; }};
    window.showDirectoryPicker = async () => handle;
    await value.pick();
    await assert.rejects(value.scan(() => {}), error => error.name === "PlaylistLimitError");
    assert.deepEqual(opened, [], "counting and the split prompt must not open audio files");
    assert.equal((await value.scan(() => {}, {split: true, part: 1})).parsed, 1);
    assert.deepEqual(opened, ["track-1000.mp3"]);
    assert.equal((await value.store.root()).part, 1);
    await value.restore();
    assert.equal(value.playlistSource().part, 1); assert.equal(value.tracks[0].name, "track-1000.mp3");
    opened.length = 0;
    assert.equal((await value.scan(() => {})).reused, 1);
    assert.deepEqual(opened, ["track-1000.mp3"], "an active-volume rescan must not open the other thousand files");
    const invalid = await value.scan(() => {}, {part: 2});
    assert.equal(invalid.phase, "error"); assert.equal(value.tracks[0].name, "track-1000.mp3");
    delete window.showDirectoryPicker;
  });
  await check("IDB commits root, active tracks and covers together, with full rollback on clone, disk or cancellation failures", async () => {
    const value = await seed(), initial = (await value.store.allTracks())[0];
    const store = new MusicStore(), db = indexedDbFixture(); store.db = db;
    const a = {...initial, id: "a", hasCover: true}, b = {...initial, id: "b", hasCover: true};
    const rootA = {name: "A", handle: {kind: "directory", name: "A"}, savedAt: 1, part: 0};
    const rootB = {name: "B", handle: {kind: "directory", name: "B"}, savedAt: 2, part: 1};
    await store.commitScan([a], [{id: "a", blob: new Blob(["A"])}], {root: rootA});
    const unchanged = async () => {
      assert.deepEqual(await store.root(), rootA);
      assert.deepEqual((await store.allTracks()).map(track => track.id), ["a"]);
      assert.equal(await (await store.cover("a")).text(), "A");
      assert.equal(await store.cover("b"), undefined);
    };
    await assert.rejects(store.commitScan([b], [{id: "b", blob: () => {}}], {root: rootB}), error => error.name === "DataCloneError");
    await unchanged();
    db.failNext();
    await assert.rejects(store.commitScan([b], [{id: "b", blob: new Blob(["B"])}], {root: rootB}), /simulated disk failure/);
    await unchanged();
    const controller = new AbortController(); db.beforeComplete(() => controller.abort());
    await assert.rejects(store.commitScan([b], [{id: "b", blob: new Blob(["B"])}], {root: rootB, signal: controller.signal}), error => error.name === "AbortError");
    await unchanged();
    await store.commitScan([b], [{id: "b", blob: new Blob(["B"])}], {root: rootB});
    assert.deepEqual(await store.root(), rootB); assert.equal((await store.allTracks())[0].id, "b");
    assert.equal(await store.cover("a"), undefined); assert.equal(await (await store.cover("b")).text(), "B");
    await store.putPlaylists([{id: "second", name: "Second", kind: "browser", part: 1}], "second");
    assert.equal((await store.root()).playlistId, "second"); assert.equal((await store.playlists())[0].part, 1);
    const presetAbort = new AbortController(); db.beforeComplete(() => presetAbort.abort());
    await assert.rejects(store.putPlaylists([{id: "obsolete", name: "Obsolete", kind: "browser", part: 0}], "obsolete",
      {signal: presetAbort.signal}), error => error.name === "AbortError");
    assert.equal((await store.root()).playlistId, "second"); assert.equal((await store.playlists())[0].id, "second");
  });
  await check("directory presets store mappings and restore the active volume", async () => {
    const value = library(), file = fixture("playlist.mp3", null), handle = directory("Preset root", file);
    const presets = [{id: "browser-test", name: "My playlist", kind: "browser", handle, part: 0, total: 1},
      {id: "vlc-test", name: "Native playlist", kind: "vlc", root: "D:\\SyntheticMusic", part: 0, total: 5}];
    assert.equal(await value.usePlaylist(presets[0]), true);
    assert.equal((await value.scan(() => {})).phase, "done");
    await value.savePlaylists(presets, "browser-test");
    assert.deepEqual(await value.playlists(), presets);
    assert.equal((await value.store.allTracks()).length, 1);
    const saved = await value.store.root(); assert.equal(saved.playlistId, "browser-test"); assert.equal(saved.part, 0);
    await value.restore(); assert.equal(value.currentRoot.playlistId, "browser-test");
    assert.equal(value.playlistSource().total, 1); assert.equal(value.playlistSource().part, 0);
    assert.equal(await value.usePlaylist(presets[1]), false, "VLC mappings must not become browser file handles");
  });
  await check("an obsolete preset save cannot associate a newer folder, and cancellation still allows later preset edits", async () => {
    const value = library(), fileA = fixture("a.mp3", null), fileC = fixture("c.mp3", null);
    const a = {id: "A", name: "A", kind: "browser", handle: directory("A", fileA), part: 0, total: 1};
    const c = {id: "C", name: "C", kind: "browser", handle: directory("C", fileC), part: 0, total: 1};
    await value.usePlaylist(a); await value.scan(() => {}); await value.savePlaylists([a], a.id);
    const open = value.store.open.bind(value.store), gate = deferred(); let calls = 0;
    value.store.open = async () => { if (++calls === 1) await gate.promise; return open(); };
    const saving = assert.rejects(value.savePlaylists([{...a, name: "Obsolete"}], a.id), error => error.name === "AbortError");
    await settle(); await value.usePlaylist(c); await value.scan(() => {}); await value.savePlaylists([a, c], c.id);
    gate.resolve(); await saving; value.store.open = open;
    assert.equal((await value.store.root()).playlistId, c.id); assert.equal(value.currentRoot.playlistId, c.id);
    assert.deepEqual((await value.playlists()).map(item => item.name), ["A", "C"]);
    value.useFiles([fixture("cancelled.mp3", null)]);
    const scan = value.scan(() => {}); value.cancelScan(); assert.equal((await scan).phase, "cancelled");
    await value.savePlaylists([{...a, name: "Edited after cancel"}, c]);
    assert.equal((await value.playlists())[0].name, "Edited after cancel");
  });
  await check("an unsplit preset whose folder grows past the limit must ask again", async () => {
    const value = library(), file = fixture("old.mp3", null), handle = directory("Growing", file);
    const preset = {id: "unsplit", name: "Growing", kind: "browser", handle, part: 0, total: 1};
    await value.usePlaylist(preset); await value.scan(() => {});
    const selected = value.tracks[0];
    handle.values = async function* () {
      for (let index = 0; index < 1001; index++) yield {kind: "file", name: `track-${index}.mp3`, getFile: async () => { throw new Error("no file may be opened before the choice"); }};
    };
    await value.usePlaylist(preset);
    await assert.rejects(value.scan(() => {}), error => error.name === "PlaylistLimitError");
    assert.equal(value.tracks[0], selected);
  });
  await check("a failed IDB replacement preserves the published files, metadata and covers", async () => {
    const value = library(), db = indexedDbFixture(); value.store.db = db;
    const a = fixture("same.mp3", "red"), b = fixture("same.mp3", "tan", 2000);
    value.useFiles([a]); await value.scan(() => {});
    const original = value.tracks[0], originalSource = value.source;
    value.useFiles([b]); db.failNext();
    assert.equal((await value.scan(() => {})).phase, "error");
    assert.equal(value.tracks[0], original); assert.equal(value.source, originalSource);
    assert.equal(await value.file(original), a);
    assert.match(await (await value.store.cover("same.mp3")).text(), /red/);
    assert.equal((await value.store.allTracks())[0].modified, 1000);
    assert.equal((await value.scan(() => {})).phase, "done");
    assert.equal(await value.file(value.tracks[0]), b);
    assert.match(await (await value.store.cover("same.mp3")).text(), /tan/);
    assert.equal(await value.file(original), null);
  });
  await check("a late playback reconnect cannot cancel or replace a pending playlist", async () => {
    const value = library(), a = fixture("same.mp3", "red"), b = fixture("same.mp3", "tan");
    const rootA = directory("A", a), rootB = directory("B", b), permission = deferred();
    window.showDirectoryPicker = async () => rootA; await value.pick(); await value.scan(() => {});
    rootA.queryPermission = () => permission.promise;
    const reconnecting = value.reconnect(); await settle();
    window.showDirectoryPicker = async () => rootB; await value.pick();
    assert.equal(await value.reconnect(), false, "a queued playback fallback must not invalidate the candidate");
    permission.resolve("granted"); assert.equal(await reconnecting, false);
    assert.equal((await value.scan(() => {})).phase, "done"); assert.equal(value.label, "B");
    assert.equal(await value.file(value.tracks[0]), b);
    delete window.showDirectoryPicker;
  });
  await check("an entirely unreadable candidate cannot replace a working catalogue with an empty one", async () => {
    const value = await seed(), original = value.tracks[0], published = value.source;
    window.showDirectoryPicker = async () => ({kind: "directory", name: "Denied files", async *values() {
      yield {kind: "file", name: "unreadable.mp3", getFile: async () => { throw new Error("permission lost"); }};
    }});
    await value.pick(); const report = await value.scan(() => {});
    assert.equal(report.phase, "error"); assert.equal(report.failed, 1);
    assert.equal(value.tracks[0], original); assert.equal(value.source, published);
    assert.equal((await value.store.allTracks())[0].id, original.id);
    delete window.showDirectoryPicker;
  });
  await check("oversized historical catalogues remain candidates until a split is chosen", async () => {
    const value = await seed(), original = value.tracks[0], handle = directory("Legacy", fixture("legacy.mp3", null));
    const stored = (await value.store.allTracks())[0];
    await value.store.commitScan(Array.from({length: 1001}, (_, index) => ({...stored, id: `legacy-${index}`, path: `legacy-${index}.mp3`})), [],
      {root: {name: "Legacy", handle, savedAt: 1}});
    await assert.rejects(value.restore(), error => error.name === "PlaylistLimitError" && error.total === 1001);
    assert.equal(value.tracks[0], original); assert.equal(value.hasSource, true);
    assert.equal((await value.scan(() => {}, {split: true})).phase, "done");
    assert.equal(value.tracks.length, 1);
    const noHandle = library(); await noHandle.store.putTracks(Array.from({length: 1001}, (_, index) => ({...stored, id: String(index)})));
    await assert.rejects(noHandle.restore(), error => error.name === "PlaylistLimitError");
    assert.equal(noHandle.tracks.length, 0); assert.equal(noHandle.hasSource, false);
  });
  await check("cancellation before atomic source commit leaves the root and index paired", async () => {
    const value = library(), a = fixture("same.mp3", "red"), b = fixture("same.mp3", "tan");
    window.showDirectoryPicker = async () => directory("A", a);
    await value.pick(); await value.scan(() => {});
    const original = value.tracks[0], root = await value.store.root(), gate = deferred();
    window.showDirectoryPicker = async () => directory("B", b); await value.pick();
    const open = value.store.open.bind(value.store); let waiting = false;
    value.store.open = async () => { waiting = true; await gate.promise; return open(); };
    const pending = value.scan(() => {}); await settle();
    assert.equal(waiting, true); value.cancelScan(); gate.resolve();
    assert.equal((await pending).phase, "cancelled"); value.store.open = open;
    assert.equal(value.tracks[0], original); assert.deepEqual(await value.store.root(), root);
    assert.equal(await value.file(original), a); assert.equal((await value.store.allTracks())[0].id, original.id);
    assert.equal((await value.scan(() => {})).phase, "done");
    assert.equal((await value.store.root()).name, "B"); assert.equal(await value.file(value.tracks[0]), b);
    delete window.showDirectoryPicker;
  });
  await check("all 320 metadata records are indexed without preparing audio; explicit limits remain available", async () => {
    const value = library(); value.useFiles(Array.from({ length: 320 }, (_, index) => fixture(`track-${index}.mp3`, null)));
    const before = urls.size;
    const report = await value.scan(() => {});
    assert.equal(report.phase, "done"); assert.equal(report.parsed, 320);
    assert.equal(value.search("").length, 320); assert.equal(value.search("Bulk Artist").length, 320);
    assert.equal(value.search("", "all", 25).length, 25);
    assert.equal(value.search("", "all", 0).length, 0);
    assert.equal(value.search("track-319")[0].title, "track-319.mp3");
    assert.equal(urls.size, before, "metadata scans create no media or cover URLs");
    const index = new MusicSearchIndex(value.tracks);
    assert.equal(index.search("Bulk Artist").length, 320);
    assert.equal(index.search("Bulk Artist", "artist", 30).length, 30);
  });
  await check("abort during metadata read leaves the published and stored catalogue unchanged", async () => {
    const value = await seed(), original = await value.store.allTracks(), gate = deferred();
    value.source = source(fixture("new.mp3"), () => gate.promise);
    const controller = new AbortController();
    const pending = value.scan(() => {}, { signal: controller.signal }); await settle();
    controller.abort(); gate.resolve(fixture("new.mp3"));
    assert.equal((await pending).phase, "cancelled");
    assert.deepEqual(await value.store.allTracks(), original);
    assert.equal(value.tracks[0].id, "old.mp3");
    assert.equal(value.scanning, false);
  });
  await check("abort while the real atomic store waits to open prevents any save", async () => {
    const value = await seed(), original = await value.store.allTracks(), gate = deferred();
    const open = value.store.open.bind(value.store); let waiting = false;
    value.store.open = async () => { waiting = true; await gate.promise; return open(); };
    value.source = source(fixture("new.mp3"));
    const controller = new AbortController(), phases = [];
    const pending = value.scan(p => phases.push(p.phase), { signal: controller.signal }); await settle();
    assert.equal(waiting, true); assert.ok(phases.includes("saving"));
    controller.abort(); gate.resolve();
    assert.equal((await pending).phase, "cancelled"); assert.equal(phases.includes("done"), false);
    value.store.open = open;
    assert.deepEqual(await value.store.allTracks(), original);
    assert.equal(value.tracks[0].id, "old.mp3");
  });
  await check("replacement by files, bridge or restored library invalidates an older read", async () => {
    for (const action of ["files", "bridge", "restore", "clear"]) {
      const value = await seed(), gate = deferred();
      value.source = source(fixture("obsolete.mp3"), () => gate.promise);
      const pending = value.scan(() => {}); await settle();
      if (action === "files") value.useFiles([fixture("current.mp3")]);
      if (action === "bridge") value.useBridgeTracks([bridgeTrack("current")], "Current root");
      if (action === "restore") assert.equal(await value.restore(), true);
      if (action === "clear") await value.clear();
      gate.resolve(fixture("obsolete.mp3"));
      assert.equal((await pending).phase, "cancelled");
      assert.equal(value.tracks.some(track => track.id === "obsolete.mp3"), false);
      assert.equal((await value.store.allTracks()).some(track => track.id === "obsolete.mp3"), false);
      if (action === "bridge") assert.equal(value.tracks[0].id, "current");
      if (action === "files") {
        assert.equal(value.hasSource, true);
        assert.equal(value.source.label, "Synthetic", "a new candidate does not replace the published source");
      }
      if (action === "clear") assert.deepEqual(await value.store.allTracks(), []);
    }
  });
  await check("cancelScan allows an immediate new scan and old finally cannot clear its busy state", async () => {
    const value = await seed(), old = deferred(), fresh = deferred(); let calls = 0;
    value.source = source(fixture("new.mp3"), () => (++calls === 1 ? old : fresh).promise);
    const first = value.scan(() => {}); await settle(); value.cancelScan();
    const second = value.scan(() => {}); await settle();
    old.resolve(fixture("new.mp3")); assert.equal((await first).phase, "cancelled");
    assert.equal(value.scanning, true);
    fresh.resolve(fixture("new.mp3")); assert.equal((await second).phase, "done");
    assert.equal(value.scanning, false); assert.equal(value.tracks[0].id, "new.mp3");
  });
  await check("a delayed restore and delayed clear cannot overwrite a newer library", async () => {
    const value = await seed(), gate = deferred(), read = value.store.allTracks.bind(value.store);
    value.store.allTracks = async () => { const saved = await read(); await gate.promise; return saved; };
    const pending = value.restore(); await settle();
    value.useBridgeTracks([bridgeTrack("current")], "Current root"); gate.resolve();
    assert.equal(await pending, false); assert.equal(value.tracks[0].id, "current");
    value.store.allTracks = read;
    const clearGate = deferred(), open = value.store.open.bind(value.store); let calls = 0;
    value.store.open = async () => { if (++calls === 1) await clearGate.promise; return open(); };
    const clearing = value.clear(); await settle();
    value.useFiles([fixture("replacement.mp3")]); assert.equal((await value.scan(() => {})).phase, "done");
    clearGate.resolve(); await clearing; value.store.open = open;
    assert.equal(value.tracks[0].id, "replacement.mp3");
    assert.equal((await value.store.allTracks())[0].id, "replacement.mp3");
  });
  await check("engine handoff invalidates pending picker and restore before a new source is applied", async () => {
    const value = await seed(), picker = deferred();
    window.showDirectoryPicker = () => picker.promise;
    const picking = value.pick(); await settle();
    value.cancelPending();
    picker.resolve({ kind: "directory", name: "obsolete", async *values() {} });
    assert.equal(await picking, false);
    assert.equal(await value.store.root(), null);
    delete window.showDirectoryPicker;
    const gate = deferred(), read = value.store.allTracks.bind(value.store);
    value.store.allTracks = async () => { const saved = await read(); await gate.promise; return saved; };
    const restoring = value.restore(); await settle(); value.cancelPending(); gate.resolve();
    assert.equal(await restoring, false);
    assert.equal(value.tracks[0].id, "old.mp3");
  });
  await check("same-source rescans reuse metadata while a newly selected source rereads equal size and timestamp", async () => {
    const value = library(), original = fixture("same.mp3", "red");
    value.useFiles([original]); assert.equal((await value.scan(() => {})).parsed, 1);
    const reused = await value.scan(() => {});
    assert.equal(reused.parsed, 0); assert.equal(reused.reused, 1);
    const replacement = fixture("same.mp3", "tan");
    assert.equal(replacement.size, original.size); assert.equal(replacement.lastModified, original.lastModified);
    value.useFiles([replacement]);
    const changed = await value.scan(() => {});
    assert.equal(changed.parsed, 1); assert.equal(changed.reused, 0);
    assert.match(await (await value.store.cover("same.mp3")).text(), /tan/);
  });
  await check("same path with removed embedded art deletes the old stored cover", async () => {
    const value = library(); value.useFiles([fixture("same.mp3", "red", 1000)]);
    assert.equal((await value.scan(() => {})).phase, "done");
    assert.ok(await value.store.cover("same.mp3"));
    value.useFiles([fixture("same.mp3", null, 2000)]);
    assert.equal((await value.scan(() => {})).phase, "done");
    assert.equal(value.tracks[0].hasCover, false); assert.equal(await value.store.cover("same.mp3"), undefined);
    assert.equal(await value.coverUrl(value.tracks[0]), null);
  });
  await check("late playback file reads and cover bytes cannot publish into a new same-path playlist", async () => {
    const value = await seed(), oldTrack = value.tracks[0], fileGate = deferred(), coverGate = deferred();
    value.source.resolve = () => fileGate.promise;
    const oldCover = await value.store.cover(oldTrack.id);
    oldCover.arrayBuffer = () => coverGate.promise;
    const oldFile = value.file(oldTrack), oldUrl = value.coverUrl(oldTrack); await settle();
    value.useFiles([fixture("old.mp3", "tan", 2000)]); await value.scan(() => {});
    const newTrack = value.tracks[0], currentUrl = await value.coverUrl(newTrack);
    const revocations = revoked.length;
    fileGate.resolve(fixture("old.mp3", "red")); coverGate.resolve(new Uint8Array([1, 2, 3]).buffer);
    assert.equal(await oldFile, null); assert.equal(await oldUrl, null);
    assert.equal(revoked.length, revocations + 1, "the late materialized old blob is revoked");
    assert.ok(urls.has(currentUrl)); assert.equal(await value.file(oldTrack), null);
    assert.match(await (await value.store.cover(newTrack.id)).text(), /tan/);
  });
  await check("LRU preserves pins and decoding leases, then revokes only unneeded old URLs", async () => {
    const value = library(2); const tracks = ["A", "B", "C", "D"].map(bridgeTrack);
    value.useBridgeTracks(tracks, "Cover fixtures");
    value.bridgeCoverUrl = async id => URL.createObjectURL(new Blob([id]));
    value.pinCoverIds(["A"]);
    const a = await value.coverUrl(value.tracks.find(track => track.id === "A"));
    const lease = await value.acquireCover(value.tracks.find(track => track.id === "B"));
    const c = await value.coverUrl(value.tracks.find(track => track.id === "C"));
    const d = await value.coverUrl(value.tracks.find(track => track.id === "D"));
    assert.ok(urls.has(c) && urls.has(d), "freshly returned URLs are not revoked immediately");
    await sleep(1100);
    assert.ok(urls.has(a)); assert.ok(urls.has(lease.url));
    assert.ok(revoked.includes(c) && revoked.includes(d));
    value.pinCoverIds([]); lease.release(); lease.release();
    const extra = { ...bridgeTrack("E"), bridge: true }; value.tracks.push(extra);
    const e = await value.coverUrl(extra);
    await sleep(1100);
    assert.ok(revoked.includes(a), "oldest unpinned URL is evicted after leases are released");
    assert.ok(urls.has(e));
    value.releaseCovers();
  });
  await check("late covers from a replaced catalogue are revoked without releasing current decoding leases", async () => {
    const value = library(1), gate = deferred();
    value.useBridgeTracks([bridgeTrack("A")], "Old");
    value.bridgeCoverUrl = () => gate.promise;
    const old = value.acquireCover(value.tracks[0]); await settle();
    value.useBridgeTracks([bridgeTrack("A"), bridgeTrack("B")], "New");
    value.bridgeCoverUrl = async id => URL.createObjectURL(new Blob([`new-${id}`]));
    const current = await value.acquireCover(value.tracks[0]);
    const obsolete = URL.createObjectURL(new Blob(["old"])); gate.resolve(obsolete);
    assert.equal(await old, null); assert.ok(revoked.includes(obsolete));
    await value.coverUrl(value.tracks[1]); await sleep(1100);
    assert.ok(urls.has(current.url), "stale lease cleanup cannot unpin the replacement cover");
    current.release();
  });
} finally {
  for (const value of libraries) value.releaseCovers();
  for (const url of urls.keys()) revokeUrl(url);
  URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
  for (const [name, descriptor] of [["window", windowDescriptor], ["document", documentDescriptor]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
console.log(`Music library checks passed (${passed} scenarios).`);
