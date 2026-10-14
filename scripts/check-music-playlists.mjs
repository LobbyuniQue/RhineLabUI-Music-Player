import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function load(path) {
  const url = new URL(path, import.meta.url);
  const code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from "(\.\/.+?)"/g, (_, name) => `from "${new URL(name.endsWith(".ts") ? name : `${name}.ts`, url).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { MusicLibrary } = await load("../src/music-library.ts");
const { MusicPanel } = await load("../src/music-panel.ts");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const files = count => Array.from({ length: count }, (_, index) => new File([new Uint8Array(64)], `${String(index).padStart(4, "0")}.wav`));
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(engine = "browser") {
  const library = new MusicLibrary();
  const panel = new MusicPanel();
  const nodes = new Map(["#music-playlist", "#music-playlist-limit", "#music-playlist-name", "#music-playlist-path"].map(id => [id, { innerHTML: "", value: "", hidden: false }]));
  const notices = [];
  const bridge = { connected: true, info: null, queueTracks() {} };
  const host = { library, bridge, engine: () => engine, onSound() {}, onNotify: value => notices.push(value), onLibraryChanged() {},
    player: { queueTracks() {}, state: () => ({ id: null }), currentTrack: () => null } };
  panel.attach(host);
  panel.root = { querySelector: id => nodes.get(id) ?? null };
  panel.mounted = true;
  return { library, panel, bridge, nodes, notices };
}
try {
  const x = fixture();
  x.library.useFiles([new File([new Uint8Array(64)], "previous.wav")]);
  await x.library.scan(() => {});
  const old = x.library.tracks;
  x.library.useFiles(files(1001));
  await x.panel.startScan();
  assert.equal(x.library.tracks, old, "the limit decision must not publish a partial folder");
  assert.match(x.nodes.get("#music-playlist-limit").innerHTML, /playlist-split/);
  assert.match(x.nodes.get("#music-playlist-limit").innerHTML, /playlist-manual/);
  await x.panel.runAction("playlist-manual");
  assert.equal(x.library.tracks, old);
  assert.equal(x.nodes.get("#music-playlist-limit").hidden, true);
  console.log("PASS oversized folder offers both choices; manual choice keeps the previous catalogue");

  await x.panel.startScan();
  await x.panel.runAction("playlist-split");
  await settle();
  assert.equal(x.library.tracks.length, 1000);
  assert.equal(x.panel.presets.length, 2);
  assert.equal((await x.library.playlists()).length, 0, "FileList presets are session-only");
  const second = x.panel.presets.find(item => item.part === 1);
  await x.panel.activatePlaylist(second.id);
  await settle();
  assert.equal(x.library.tracks.length, 1);
  assert.equal(x.library.tracks[0].name, "1000.wav");
  assert.equal(x.panel.presets.length, 2, "volume switching must not duplicate presets");
  x.library.useFiles([new File([new Uint8Array(64)], "replacement.wav")]);
  await x.panel.startScan();
  await settle();
  assert.equal(x.library.tracks[0].name, "replacement.wav");
  assert.equal(x.panel.presets.length, 1, "new session folder releases the old session presets");
  console.log("PASS automatic split retains all 1001 songs across two volumes and releases the previous session");

  const persistentFile = new File([new Uint8Array(64)], "persistent.wav");
  const persistentHandle = { kind: "directory", name: "Persistent", async *values() { yield { kind: "file", name: persistentFile.name, getFile: async () => persistentFile }; } };
  window.showDirectoryPicker = async () => persistentHandle;
  await x.library.pick();
  await x.panel.startScan();
  await settle();
  assert.equal(x.library.tracks[0].name, "persistent.wav");
  assert.ok(x.panel.presets.every(item => !item.id.startsWith("session-")));
  console.log("PASS persistent folder releases obsolete session volume presets");

  const y = fixture("vlc");
  const before = [{ id: "old", name: "old.wav", title: "old", artist: "", album: "", track: null, duration: null, codec: "wav", size: 64, folder: "" }];
  y.library.useBridgeTracks(before, "old-folder");
  const calls = [];
  y.nodes.get("#music-playlist-path").value = "new-folder";
  y.nodes.get("#music-playlist-name").value = "Favorites";
  y.bridge.switchPlaylist = async (root, part, split) => {
    calls.push({ root, part, split });
    if (!split) throw Object.assign(new Error("limit"), { payload: { error: "playlist_limit", total: 1001, parts: 2 } });
    const playlist = { root, part, total: 1001, parts: 2, limit: 1000, split: true, needsSplit: false };
    y.bridge.info = { root, playlist };
    return { root, playlist, tracks: [{ ...before[0], id: "new" }] };
  };
  await y.panel.runAction("playlist-add");
  assert.equal(y.library.tracks[0].id, "old");
  await y.panel.runAction("playlist-split");
  await settle();
  assert.deepEqual(calls.map(item => item.split), [false, true]);
  assert.equal(y.library.tracks[0].id, "new");
  assert.equal((await y.library.playlists()).length, 2);
  assert.equal(y.panel.presets[1].name, "Favorites（2）");
  y.nodes.get("#music-playlist-name").value = "Renamed";
  await y.panel.runAction("playlist-rename");
  assert.equal((await y.library.playlists())[0].name, "Renamed");
  let finishRefresh;
  const delayedPresets = y.library.playlists.bind(y.library);
  const stale = await delayedPresets();
  y.library.playlists = () => new Promise(resolve => { finishRefresh = resolve; });
  const refresh = y.panel.refreshPresets();
  y.nodes.get("#music-playlist-name").value = "Newer name";
  await y.panel.runAction("playlist-rename");
  finishRefresh(stale.map(item => ({ ...item, name: "Old name" })));
  await refresh;
  y.library.playlists = delayedPresets;
  assert.equal(y.panel.presets[0].name, "Newer name");
  assert.equal((await delayedPresets())[0].name, "Newer name");
  console.log("PASS late preset refresh cannot undo a newer rename");
  await y.panel.runAction("playlist-remove");
  assert.equal((await y.library.playlists()).length, 1);
  assert.equal(y.library.tracks[0].id, "new", "removing a preset never deletes its songs");
  console.log("PASS VLC split requires acceptance; named presets persist and removal keeps music");

  const z = fixture();
  let finishCompare;
  const held = new Promise(resolve => { finishCompare = resolve; });
  const b = { ...persistentHandle, name: "B", isSameEntry: () => held };
  z.panel.presets = [{ id: "browser-old-part-0", name: "Old", kind: "browser", handle: persistentHandle, part: 0, total: 1 }];
  window.showDirectoryPicker = async () => b;
  await z.library.pick();
  const pendingB = z.panel.startScan();
  while (!z.library.tracks.length) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(z.panel.switching, true, "metadata completion must not unlock selection before preset commit");
  z.panel.cancelPending();
  z.library.useFiles([new File([new Uint8Array(64)], "C.wav")]);
  await z.panel.startScan();
  finishCompare(false);
  await pendingB;
  await settle();
  assert.equal(z.library.tracks[0].name, "C.wav");
  assert.equal(z.library.currentRoot, null);
  assert.equal(z.panel.presets.find(item => item.id === z.panel.activePreset).kind, "browser");
  assert.ok(z.panel.activePreset.startsWith("session-"));
  console.log("PASS canceled directory comparison cannot bind its preset to a newer folder");
} finally {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
}
