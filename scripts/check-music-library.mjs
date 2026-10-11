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
try {
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
      if (action === "files") assert.equal(value.source.label, "本次选择（不保存）");
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
    const e = await value.coverUrl({ ...bridgeTrack("E"), bridge: true });
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
