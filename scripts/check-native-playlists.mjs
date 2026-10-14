// Native indexing uses generated files only; no VLC or personal library is opened.
import assert from "node:assert/strict";
import { open, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { isAudioFile, readTrackMeta } from "../src/music-metadata.ts";
import { NativePlaylistLibrary, PlaylistError, readPlaylistRequest, loadPlaylistSelection, savePlaylistSelection } from "./lib/native-playlists.mjs";
import { LOCAL_ROOT, resetLocalDirectory, removeLocalDirectory } from "./lib/workspace-paths.mjs";

const root = join(LOCAL_ROOT, "fixtures", `native-playlists-run-${process.pid}`);
const bulk = join(root, "bulk"), small = join(root, "small"), last = join(root, "last");
const cacheFile = join(root, "cache", "library.json");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function mp3(title, art = true) {
  const frame = (id, value) => { const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(value.length, 4); return Buffer.concat([header, value]); };
  const frames = [frame("TIT2", Buffer.concat([Buffer.from([3]), Buffer.from(title)]))];
  if (art) frames.push(frame("APIC", Buffer.concat([Buffer.from([0]), Buffer.from("image/png\0"), Buffer.from([3, 0]),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6m9sAAAAASUVORK5CYII=", "base64")])));
  const body = Buffer.concat(frames), length = body.length;
  return Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, (length >>> 21) & 127, (length >>> 14) & 127, (length >>> 7) & 127, length & 127]), body, Buffer.from([255, 251, 144, 0]), Buffer.alloc(600)]);
}
let reads = 0, active = 0, peak = 0, gate = null;
async function metadata(path, info) {
  reads++; active++; peak = Math.max(peak, active);
  try {
    if (gate) { const hold = gate; gate = null; hold.entered.resolve(); await hold.release.promise; }
    return await readTrackMeta({ size: info.size, slice: (start, end) => ({ arrayBuffer: async () => {
      const handle = await open(path, "r");
      try { const data = Buffer.alloc(Math.max(0, Math.min(end, info.size) - start)); const { bytesRead } = await handle.read(data, 0, data.length, start); return data.buffer.slice(data.byteOffset, data.byteOffset + bytesRead); }
      finally { await handle.close(); }
    } }) }, basename(path));
  } finally { active--; }
}
let commits = 0, refuseCommit = false;
const library = new NativePlaylistLibrary({ root: small, cacheFile, isAudioFile, readMeta: metadata,
  beforeCommit: async () => { if (refuseCommit) throw new Error("commit refused"); commits++; } });
const errorIs = (code, status) => error => error instanceof PlaylistError && error.message === code && error.status === status;
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`native-playlists: ${name}`); }
await resetLocalDirectory(root);
try {
  await Promise.all([mkdir(bulk), mkdir(small), mkdir(last)]);
  await writeFile(join(small, "old.mp3"), mp3("Old"));
  await writeFile(join(last, "last.mp3"), mp3("Last", false));
  for (let first = 0; first < 1001; first += 50)
    await Promise.all(Array.from({ length: Math.min(50, 1001 - first) }, (_, index) => {
      const number = String(first + index).padStart(4, "0"); return writeFile(join(bulk, `${number}.mp3`), mp3(`Track ${number}`));
    }));
  await check("oversized directory asks before reading metadata and preserves the active library", async () => {
    await library.scan(); const old = library.tracks, previousCommits = commits, before = reads;
    await assert.rejects(library.scan({ root: bulk, part: 0, split: false }), error => errorIs("playlist_limit", 409)(error) && error.details.total === 1001 && error.details.parts === 2);
    assert.equal(reads, before); assert.equal(library.root, small); assert.equal(library.tracks, old); assert.equal(commits, previousCommits);
  });
  await check("accepted split reads and retains at most 1000 selected metadata entries and covers", async () => {
    const before = reads; await library.scan({ root: bulk, part: 0, split: true });
    assert.equal(reads - before, 1000); assert.equal(library.tracks.length, 1000); assert.equal(library.playlist.total, 1001);
    assert.equal(library.tracks[0].title, "Track 0000"); assert.equal(library.tracks[999].title, "Track 0999");
    assert.equal((await readdir(library.coverDir)).length, 1000);
    const firstId = library.tracks[0].id;
    await library.scan({ part: 1 });
    assert.equal(reads - before, 1001); assert.equal(library.tracks.length, 1); assert.equal(library.tracks[0].title, "Track 1000");
    assert.equal((await readdir(library.coverDir)).length, 1);
    await assert.rejects(stat(join(library.coverDir, firstId)), { code: "ENOENT" });
    assert.equal((await readdir(bulk)).length, 1001, "splitting must not move or remove songs");
  });
  await check("pending startup exposes the count but reads no oversized metadata", async () => {
    const pending = new NativePlaylistLibrary({ root: bulk, cacheFile: join(root, "pending.json"), isAudioFile, readMeta: metadata });
    const before = reads; await pending.scan({ allowPending: true });
    assert.equal(reads, before); assert.equal(pending.playlist.needsSplit, true); assert.equal(pending.tracks.length, 0);
    assert.equal(pending.scanState.phase, "awaiting_split");
  });
  await check("missing directory, invalid volume and failed commit keep the previous index and covers", async () => {
    const old = library.tracks, oldPlaylist = library.playlist, art = await readFile(join(library.coverDir, old[0].id));
    await assert.rejects(library.scan({ root: join(root, "absent") }), errorIs("playlist_directory_unavailable", 400));
    await assert.rejects(library.scan({ part: 2 }), errorIs("playlist_part_out_of_range", 409));
    refuseCommit = true; await assert.rejects(library.scan({ root: small, part: 0, split: false }), /commit refused/); refuseCommit = false;
    assert.equal(library.tracks, old); assert.equal(library.playlist, oldPlaylist);
    assert.deepEqual(await readFile(join(library.coverDir, old[0].id)), art);
  });
  await check("identical scans share work and different directory requests commit serially", async () => {
    const entered = deferred(), release = deferred(); gate = { entered, release };
    const first = library.scan({ root: small, part: 0, split: false, rescan: true });
    const duplicate = library.scan({ root: small, part: 0, split: false, rescan: true }); assert.equal(first, duplicate);
    await entered.promise;
    const second = library.scan({ root: last, part: 0, split: false, rescan: true });
    assert.equal(library.root, bulk); release.resolve(); await Promise.all([first, second]);
    assert.equal(library.root, last); assert.equal(library.tracks[0].title, "Last"); assert.equal(peak, 1);
  });
  await check("rescan removes deleted artwork instead of reviving a stale image", async () => {
    await library.scan({ root: small, part: 0, split: false });
    const id = library.tracks[0].id; assert.equal(library.tracks[0].cover, "image/png");
    await writeFile(join(small, "old.mp3"), mp3("Updated", false)); await library.scan({ rescan: true });
    assert.equal(library.tracks[0].cover, null); assert.equal(library.tracks[0].title, "Updated");
    await assert.rejects(stat(join(library.coverDir, id)), { code: "ENOENT" });
  });
  await check("root, volume and split survive restart only for their matching directory", async () => {
    await library.scan({ root: bulk, part: 1, split: true });
    const rootFile = join(root, "music-root.txt"), selectionFile = join(root, "music-playlist.json");
    await savePlaylistSelection(rootFile, selectionFile, library.playlist);
    assert.equal(await readFile(rootFile, "utf8"), bulk);
    assert.deepEqual(await loadPlaylistSelection(selectionFile, bulk), { part: 1, split: true });
    assert.deepEqual(await loadPlaylistSelection(selectionFile, small), { part: 0, split: false });
    const restored = new NativePlaylistLibrary({ root: bulk, cacheFile, isAudioFile, readMeta: metadata });
    const before = reads; await restored.scan(await loadPlaylistSelection(selectionFile, bulk));
    assert.equal(restored.tracks[0].title, "Track 1000"); assert.equal(restored.playlist.part, 1); assert.equal(reads, before);
    await writeFile(selectionFile, "{broken"); assert.deepEqual(await loadPlaylistSelection(selectionFile, bulk), { part: 0, split: false });
  });
  await check("playlist payload enforces JSON, a bounded body and valid root/volume/split types", async () => {
    const request = (body, type = "application/json") => Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-type": type } });
    assert.deepEqual(await readPlaylistRequest(request(JSON.stringify({ root: small, part: 0, split: false }))), { root: small, part: 0, split: false });
    await assert.rejects(readPlaylistRequest(request("{}", "text/plain")), errorIs("playlist_json_required", 400));
    for (const body of ["null", "[]", "{", JSON.stringify({ root: " " }), JSON.stringify({ root: small, part: -1 }), JSON.stringify({ root: small, split: "yes" })])
      await assert.rejects(readPlaylistRequest(request(body)), errorIs("invalid_playlist_request", 400));
    await assert.rejects(readPlaylistRequest(request(" ".repeat(16385))), errorIs("playlist_request_too_large", 413));
  });
  await check("oversized HTTP bodies return an explicit 413 instead of resetting the connection", async () => {
    const server = createServer((req, res) => {
      readPlaylistRequest(req).then(() => { res.end("ok"); }).catch(error => { res.writeHead(error.status ?? 500); res.end(error.message); });
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(20000) });
      assert.equal(response.status, 413); assert.equal(await response.text(), "playlist_request_too_large");
    } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  });
  console.log(`${passed} native playlist checks passed.`);
} finally { await removeLocalDirectory(root); }
