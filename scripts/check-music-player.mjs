// Exercise the real player/panel with controllable browser promises. In
// particular, complete old operations after stop or a newer track selection.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadModule(path) {
  const url = new URL(path, import.meta.url);
  const source = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from "(\.\/.+?)"/g, (_, name) => `from "${new URL(name.endsWith(".ts") ? name : `${name}.ts`, url).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { MusicPlayer } = await loadModule("../src/music-player.ts");
const { MusicPanel } = await loadModule("../src/music-panel.ts");
const { queueIndex } = await import("../src/music-queue.ts");
const track = (id) => ({ id, title: id, artist: "Rhine Lab", album: "Fixtures", duration: 60, codec: "wav" });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

function fixture() {
  const saved = new Map(["document", "AudioContext", "navigator", "MediaMetadata"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const states = [], active = [], errors = [], changes = [], contexts = [], urls = new Map(), revoked = [];
  const resumeGates = [], playGates = [], covers = [];
  let resolveFile = async (id) => ({ id });
  let urlIndex = 0;
  class Audio extends EventTarget {
    src = "";
    currentTime = 0;
    duration = 60;
    readyState = 4;
    paused = true;
    ended = false;
    error = null;
    generation = 0;
    playCalls = [];
    pause() { this.paused = true; ++this.generation; }
    load() { this.currentTime = 0; this.ended = false; this.error = null; ++this.generation; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    play() {
      const generation = this.generation;
      this.playCalls.push(this.src);
      return (playGates.shift()?.promise ?? Promise.resolve()).then(() => {
        // Native media aborts a pending play when pause/load replaces it.
        if (generation !== this.generation) throw new DOMException("Interrupted", "AbortError");
        this.paused = false;
        this.ended = false;
      });
    }
  }
  const element = new Audio();
  class Context {
    sampleRate = 48000;
    destination = {};
    closed = false;
    nodes = [];
    constructor() { contexts.push(this); }
    node(extra = {}) {
      const node = { connect() {}, disconnected: false, disconnect() { this.disconnected = true; }, ...extra };
      this.nodes.push(node);
      return node;
    }
    createGain() { return this.node({ gain: { value: 1 } }); }
    createAnalyser() { return this.node({ frequencyBinCount: 1024, getFloatFrequencyData(values) { values.fill(-100); } }); }
    createMediaElementSource() { return this.node(); }
    resume() { return resumeGates.shift()?.promise ?? Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const session = { metadata: null, handlers: new Map(), setActionHandler(name, handler) { this.handlers.set(name, handler); } };
  const globals = { document: { createElement: () => element }, AudioContext: Context, navigator: { mediaSession: session }, MediaMetadata: class { constructor(data) { Object.assign(this, data); } } };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  URL.createObjectURL = (file) => { const url = `blob:fixture-${++urlIndex}`; urls.set(url, file.id); return url; };
  URL.revokeObjectURL = (url) => { assert.ok(urls.has(url), "only owned URLs may be revoked"); assert.ok(!revoked.includes(url), "URLs are revoked once"); revoked.push(url); };
  const player = new MusicPlayer({
    resolve: (id) => resolveFile(id), volume: () => 0.8,
    onState: (state) => states.push(state), onBands() {},
    onActiveChange: (value) => active.push(value), onError: (error) => errors.push(error), onTrackChange: (value) => changes.push(value?.id ?? null),
    coverUrl: (id) => { const gate = deferred(); covers.push({ id, ...gate }); return gate.promise; },
  });
  return {
    player, element, states, active, errors, changes, contexts, urls, revoked, resumeGates, playGates, covers, session,
    resolveWith: (callback) => { resolveFile = callback; },
    cleanup() {
      player.dispose();
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

let passed = 0;
async function check(name, run) {
  const f = fixture();
  try { await run(f); ++passed; console.log(`player: ${name}`); }
  finally { f.cleanup(); }
}

await check("late A cannot replace already playing B", async (f) => {
  const a = deferred(), b = deferred();
  f.resolveWith((id) => (id === "A" ? a : b).promise);
  const first = f.player.play(track("A"));
  const second = f.player.play(track("B"));
  b.resolve({ id: "B" }); await second;
  const source = f.element.src;
  a.resolve({ id: "A" }); await first;
  assert.equal(f.player.state().id, "B");
  assert.equal(f.element.src, source);
  assert.equal(f.urls.get(source), "B");
  assert.equal(f.urls.size, 1);
  assert.ok(f.player.isPlaying());
});

await check("selecting B silences A immediately; B failure releases background audio", async (f) => {
  await f.player.play(track("A"));
  const source = f.element.src;
  const gate = deferred(); f.resolveWith(() => gate.promise);
  const pending = f.player.play(track("B"));
  assert.equal(f.player.state().id, "B");
  assert.equal(f.player.state().loading, true);
  assert.equal(f.element.src, "");
  assert.equal(f.element.paused, true);
  assert.deepEqual(f.revoked, [source]);
  gate.resolve(null); await pending;
  assert.equal(f.player.state().loading, false);
  assert.equal(f.active.at(-1), false);
  assert.equal(f.errors.length, 1);
});

for (const action of ["pause", "stop", "dispose"]) {
  await check(`${action} while resolving invalidates the old file`, async (f) => {
    const gate = deferred(); f.resolveWith(() => gate.promise);
    const pending = f.player.play(track("A"));
    f.player[action]();
    const emitted = f.states.length;
    gate.resolve({ id: "A" }); await pending;
    assert.equal(f.element.playCalls.length, 0);
    assert.equal(f.urls.size, 0);
    assert.equal(f.player.state().loading, false);
    assert.equal(f.player.state().id, action === "pause" ? "A" : null);
    assert.equal(f.states.length, emitted);
    assert.equal(f.active.at(-1), false);
  });
  await check(`${action} while resuming the audio context prevents play`, async (f) => {
    const gate = deferred(); f.resumeGates.push(gate);
    const pending = f.player.play(track("A")); await settle();
    assert.equal(f.contexts.length, 1);
    f.player[action](); gate.resolve(); await pending;
    assert.equal(f.element.playCalls.length, 0);
    assert.equal(f.urls.size, 0);
    assert.equal(f.player.state().loading, false);
    if (action === "dispose") assert.ok(f.contexts[0].closed);
  });
  await check(`${action} cancels an outstanding native play promise`, async (f) => {
    const gate = deferred(); f.playGates.push(gate);
    const pending = f.player.play(track("A")); await settle();
    assert.equal(f.element.playCalls.length, 1);
    const source = f.element.src;
    f.player[action](); gate.resolve(); await pending;
    assert.equal(f.element.paused, true);
    assert.equal(f.player.isPlaying(), false);
    assert.equal(f.player.state().loading, false);
    assert.equal(f.errors.length, 0);
    if (action !== "pause") assert.deepEqual(f.revoked, [source]);
  });
}

await check("an old rejection cannot clear B's loading state or report an error", async (f) => {
  const a = deferred(), b = deferred();
  f.resolveWith((id) => (id === "A" ? a : b).promise);
  const first = f.player.play(track("A")), second = f.player.play(track("B"));
  a.reject(new Error("old read failure")); await first;
  assert.equal(f.player.state().id, "B"); assert.equal(f.player.state().loading, true);
  assert.equal(f.errors.length, 0);
  b.resolve({ id: "B" }); await second;
});

await check("late native A completion does not pause or overwrite B", async (f) => {
  const gate = deferred(); f.playGates.push(gate);
  const first = f.player.play(track("A")); await settle();
  await f.player.play(track("B"));
  const source = f.element.src;
  gate.resolve(); await first;
  assert.equal(f.element.src, source); assert.equal(f.urls.get(source), "B");
  assert.ok(f.player.isPlaying()); assert.equal(f.errors.length, 0);
});

await check("paused resumption cannot resurrect a stopped track", async (f) => {
  await f.player.play(track("A")); f.element.currentTime = 12; f.player.pause();
  const gate = deferred(); f.resumeGates.push(gate);
  const pending = f.player.toggle(); await settle();
  f.player.stop(); gate.resolve(); await pending;
  assert.equal(f.element.playCalls.length, 1);
  assert.equal(f.player.state().id, null); assert.equal(f.element.src, "");
});

await check("pause retains the URL/position and resumes the same audio", async (f) => {
  await f.player.play(track("A"));
  const source = f.element.src; f.element.currentTime = 12;
  f.player.pause(); await f.player.toggle();
  assert.equal(f.element.src, source); assert.equal(f.element.currentTime, 12);
  assert.equal(f.urls.size, 1); assert.ok(f.player.isPlaying());
});

await check("toggle during a pending read cancels instead of restarting it", async (f) => {
  const gate = deferred(); f.resolveWith(() => gate.promise);
  const pending = f.player.play(track("A")); await f.player.toggle();
  gate.resolve({ id: "A" }); await pending;
  assert.equal(f.player.state().loading, false); assert.equal(f.element.playCalls.length, 0);
});

await check("native error clears loading, audio, owned URL and active state", async (f) => {
  const gate = deferred(); f.playGates.push(gate);
  const pending = f.player.play(track("A")); await settle();
  f.element.error = { code: 3 };
  f.element.dispatchEvent(new Event("error")); gate.resolve(); await pending;
  assert.equal(f.player.state().loading, false); assert.equal(f.element.src, "");
  assert.equal(f.revoked.length, 1); assert.equal(f.errors.length, 1);
  assert.equal(f.active.at(-1), false);
});

await check("queued media events from A cannot advance or fail a healthy B", async (f) => {
  f.player.queueTracks([track("A"), track("B"), track("C")]);
  await f.player.play(track("A")); await f.player.play(track("B"));
  f.element.dispatchEvent(new Event("ended")); f.element.dispatchEvent(new Event("error")); await settle();
  assert.equal(f.player.currentTrack().id, "B"); assert.ok(f.player.isPlaying());
  assert.equal(f.errors.length, 0);
});

await check("dispose releases a playing URL, graph and callbacks", async (f) => {
  await f.player.play(track("A"));
  f.player.dispose(); const count = f.states.length;
  f.covers[0].resolve("blob:late-cover"); await settle();
  f.element.dispatchEvent(new Event("ended")); f.element.dispatchEvent(new Event("loadedmetadata"));
  await f.player.play(track("B")); await f.player.toggle();
  assert.equal(f.element.src, ""); assert.equal(f.element.paused, true);
  assert.equal(f.revoked.length, 1); assert.ok(f.contexts[0].closed);
  assert.ok(f.contexts[0].nodes.every((node) => node.disconnected));
  assert.equal(f.states.length, count); assert.equal(f.element.playCalls.length, 1);
  assert.equal(f.session.metadata.artwork, undefined);
});

await check("late cover for an earlier play of the same ID cannot replace new metadata", async (f) => {
  await f.player.play(track("A"));
  await f.player.play(track("B"));
  await f.player.play(track("A"));
  f.covers[2].resolve("blob:new-cover"); await settle();
  f.covers[0].resolve("blob:old-cover"); await settle();
  assert.equal(f.session.metadata.artwork[0].src, "blob:new-cover");
});

await check("ended advances forward, wraps, and ignores stopped/paused events", async (f) => {
  f.player.queueTracks([track("A"), track("B")]);
  await f.player.play(track("A"));
  f.element.ended = true; f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.player.currentTrack().id, "B"); assert.ok(f.player.isPlaying());
  f.element.ended = true; f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.player.currentTrack().id, "A");
  f.player.pause(); f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.player.currentTrack().id, "A"); assert.equal(f.player.isPlaying(), false);
  f.player.stop(); f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.player.currentTrack(), null);
});

await check("single-repeat reuses its URL and is canceled by stop during resume", async (f) => {
  await f.player.play(track("A")); f.player.setMode("single");
  const gate = deferred(); f.resumeGates.push(gate);
  f.element.ended = true; f.element.dispatchEvent(new Event("ended"));
  assert.equal(f.player.state().loading, true);
  f.player.stop(); gate.resolve(); await settle();
  assert.equal(f.player.currentTrack(), null); assert.equal(f.element.playCalls.length, 1);
  assert.equal(f.urls.size, 1);
});

await check("single-repeat continues from zero using the same file", async (f) => {
  await f.player.play(track("A")); f.player.setMode("single");
  const source = f.element.src; f.element.currentTime = 60;
  f.element.ended = true; f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.element.src, source); assert.equal(f.element.currentTime, 0);
  assert.equal(f.urls.size, 1); assert.ok(f.player.isPlaying());
});

await check("ended without a queue releases the active background-audio claim", async (f) => {
  await f.player.play(track("A"));
  f.element.ended = true; f.element.dispatchEvent(new Event("ended")); await settle();
  assert.equal(f.player.isPlaying(), false); assert.equal(f.active.at(-1), false);
});

function panelFixture(f, initialEngine = "browser") {
  const panel = new MusicPanel();
  let engine = initialEngine, currentId = "B", bridgeMode = "list", bridgeState = "playing";
  let bridgeQueue = [], controllable = true, libraryChanges = 0;
  const bridgePlays = [], notices = [];
  const tracks = ["A", "B", "C"].map((id) => ({ ...track(id), name: id, path: id, track: null, bridge: true }));
  const status = () => ({ state: bridgeState, currentId, time: 12, length: 60 });
  const bridge = {
    connected: true,
    play: async (id) => { bridgePlays.push(id); currentId = id; },
    pollStatus: async () => status(), pause: async () => { bridgeState = "paused"; },
    resume: async () => { bridgeState = "playing"; },
    queueTracks: (value) => { bridgeQueue = value; },
    setMode: (value) => { bridgeMode = value; }, mode: () => bridgeMode,
    next: async () => bridge.play(bridgeQueue[queueIndex(bridgeQueue.length, bridgeQueue.findIndex((item) => item.id === currentId), bridgeMode)].id),
    previous: async () => bridge.play(bridgeQueue[queueIndex(bridgeQueue.length, bridgeQueue.findIndex((item) => item.id === currentId), bridgeMode, -1)].id),
  };
  const library = { tracks, label: "Fixtures", source: {}, cancelScan() {}, stats: () => ({ count: 3, artists: 1, bytes: 100, missing: 0 }), search: () => library.tracks };
  panel.attach({ player: f.player, library, bridge, engine: () => engine, canControl: () => controllable, onSound() {}, onNotify: (value) => notices.push(value), onLibraryChanged: () => { ++libraryChanges; } });
  panel.results = tracks; panel.bridgeStatus = status();
  return { panel, bridge, bridgePlays, notices, setEngine(value) { engine = value; }, setControllable(value) { controllable = value; }, get bridgeQueue() { return bridgeQueue; }, get libraryChanges() { return libraryChanges; } };
}

await check("panel browser next/previous and MediaSession actions move in the expected direction", async (f) => {
  const { panel } = panelFixture(f);
  f.player.queueTracks([track("A"), track("B"), track("C")]); await f.player.play(track("B"));
  await panel.runAction("next"); assert.equal(f.player.currentTrack().id, "C");
  await panel.runAction("prev"); assert.equal(f.player.currentTrack().id, "B");
  f.session.handlers.get("previoustrack")(); await settle(); assert.equal(f.player.currentTrack().id, "A");
  f.session.handlers.get("nexttrack")(); await settle(); assert.equal(f.player.currentTrack().id, "B");
});

await check("panel VLC next/previous wraps visible results in the expected direction", async (f) => {
  const { panel, bridgePlays } = panelFixture(f, "vlc");
  await panel.runAction("next"); await panel.runAction("next"); await panel.runAction("prev");
  assert.deepEqual(bridgePlays, ["C", "A", "C"]);
  assert.equal(f.element.playCalls.length, 0);
});

await check("disconnected VLC remains offline and never falls back to the browser", async (f) => {
  const { panel, bridge, bridgePlays, notices } = panelFixture(f, "vlc");
  const nodes = new Map(["#music-status", "#music-engine-label", "#music-bar"].map((name) => [name, { innerHTML: "", dataset: {}, querySelector: () => null }]));
  panel.root = { querySelector: (name) => nodes.get(name) ?? null };
  panel.renderStatus(); assert.match(nodes.get("#music-engine-label").innerHTML, /VLC.*CONNECTED/);
  bridge.connected = false; panel.renderStatus(); panel.renderBar();
  assert.match(nodes.get("#music-engine-label").innerHTML, /VLC.*OFFLINE/);
  assert.equal(nodes.get("#music-bar").dataset.state, "error");
  await panel.runAction("next"); await panel.runAction("toggle");
  panel.cursor = 0; await panel.playCursor();
  assert.equal(bridgePlays.length, 0); assert.equal(f.element.playCalls.length, 0);
  assert.equal(notices.length, 3);
});

await check("late bridge command/poll cannot overwrite a newer command or changed engine", async (f) => {
  const { panel, bridge, setEngine } = panelFixture(f, "vlc");
  const gate = deferred(); bridge.play = () => gate.promise;
  const pending = panel.runAction("next");
  setEngine("browser"); gate.resolve(); await pending;
  assert.equal(panel.bridgeStatus.currentId, "B");
  setEngine("vlc");
  const oldStatus = deferred(); bridge.pollStatus = () => oldStatus.promise;
  const poll = panel.pollBridge();
  bridge.play = async () => {}; bridge.pollStatus = async () => ({ state: "playing", currentId: "C", time: 0, length: 60 });
  await panel.runAction("next");
  oldStatus.resolve({ state: "playing", currentId: "A", time: 0, length: 60 }); await poll;
  assert.equal(panel.bridgeStatus.currentId, "C");
});

await check("same-ID library refresh invalidates both cached and pending panel covers", async (f) => {
  const { panel } = panelFixture(f);
  const node = { dataset: {}, style: { backgroundImage: "url(old-cached)" }, classList: { add() {}, remove() {} } };
  panel.root = { querySelector: (name) => name === "#music-cover" ? node : null };
  const gates = [deferred(), deferred()]; let calls = 0;
  panel.library.acquireCover = () => gates[calls++].promise;
  const first = panel.renderCover("A");
  panel.refreshLibrary();
  assert.equal(node.style.backgroundImage, "");
  const second = panel.renderCover("A");
  let newReleased = 0, oldReleased = 0;
  gates[1].resolve({ url: "blob:new-library-cover", release() { ++newReleased; } }); await second;
  gates[0].resolve({ url: "blob:old-library-cover", release() { ++oldReleased; } }); await first;
  assert.equal(calls, 2);
  assert.equal(node.style.backgroundImage, 'url("blob:new-library-cover")');
  assert.equal(oldReleased, 1); assert.equal(newReleased, 0);
  panel.unmount(); assert.equal(newReleased, 1);
});

await check("unmount prevents a late panel cover from updating the old node", async (f) => {
  const { panel } = panelFixture(f);
  const node = { dataset: {}, style: { backgroundImage: "" }, classList: { add() {}, remove() {} } };
  panel.root = { querySelector: (name) => name === "#music-cover" ? node : null };
  const gate = deferred(); panel.library.acquireCover = () => gate.promise;
  const pending = panel.renderCover("A");
  let released = 0;
  panel.unmount(); gate.resolve({ url: "blob:late-cover", release() { ++released; } }); await pending;
  assert.equal(node.style.backgroundImage, "");
  assert.equal(released, 1);
});

await check("panel resumes paused VLC without reloading its track", async (f) => {
  const { panel, bridgePlays } = panelFixture(f, "vlc");
  await panel.runAction("toggle");
  assert.equal(panel.bridgeStatus.state, "paused");
  await panel.runAction("toggle");
  assert.equal(panel.bridgeStatus.state, "playing");
  assert.equal(panel.bridgeStatus.time, 12); assert.deepEqual(bridgePlays, []);
});

await check("panel mode follows the active engine and updates both queue policies", async (f) => {
  const { panel, bridge } = panelFixture(f, "vlc");
  await panel.runAction("mode");
  assert.equal(bridge.mode(), "single"); assert.equal(f.player.state().mode, "single");
  await panel.runAction("mode");
  assert.equal(bridge.mode(), "shuffle"); assert.equal(f.player.state().mode, "shuffle");
});

await check("engine handoff blocks panel commands, including a command already awaiting cancellation", async (f) => {
  const x = panelFixture(f, "vlc");
  x.setControllable(false);
  await x.panel.runAction("next"); await x.panel.playCursor(); await x.panel.runAction("toggle");
  assert.equal(x.bridgePlays.length, 0);
  x.setControllable(true);
  const gate = deferred(); x.panel.host.beforePlayback = () => gate.promise;
  const pending = x.panel.playCursor();
  x.panel.cancelPending(); x.setEngine("browser"); gate.resolve(); await pending;
  assert.equal(x.bridgePlays.length, 0); assert.equal(f.element.playCalls.length, 0);
});

await check("all metadata stays in the queue while result DOM grows in batches and follows keyboard/playing rows", async (f) => {
  const x = panelFixture(f);
  const tracks = Array.from({ length: 601 }, (_, i) => ({ ...track(`T${i}`), name: `T${i}`, path: `T${i}`, track: null }));
  x.panel.library.tracks = tracks;
  const row = { classList: { add() {}, remove() {} }, scrollIntoView() {}, focus() {} };
  const list = { innerHTML: "", scrollTop: 79, querySelector: () => row, querySelectorAll: () => [] };
  const count = { textContent: "" };
  x.panel.root = { querySelector: (name) => name === "#music-results" ? list : name === "#music-result-count" ? count : row };
  // Only list/count and row selectors exist; no bar/cover/status subtree.
  x.panel.root.querySelector = (name) => name === "#music-results" ? list : name === "#music-result-count" ? count : name.startsWith(".result-row") ? row : null;
  x.panel.mounted = true;
  x.panel.renderResults();
  assert.equal((list.innerHTML.match(/data-music-track=/g) ?? []).length, 240);
  assert.equal(x.panel.results.length, 601); assert.match(count.textContent, /601 TRACKS FOUND/);
  await x.panel.runAction("more");
  assert.equal((list.innerHTML.match(/data-music-track=/g) ?? []).length, 480);
  assert.equal(list.scrollTop, 79);
  x.panel.cursor = 479; x.panel.moveCursor(1);
  assert.equal(x.panel.cursor, 480); assert.match(list.innerHTML, /data-music-index="480"/);
  x.panel.query = "new query"; x.panel.renderResults();
  assert.equal(x.panel.visibleResults, 240); assert.equal(x.panel.cursor, -1);
  x.panel.syncPlayingRow("T600");
  assert.match(list.innerHTML, /data-music-index="600"/);
  x.panel.cursor = 600; await x.panel.playCursor();
  assert.equal(x.bridgeQueue.length, 601); assert.equal(f.player.currentTrack().id, "T600");
  x.panel.unmount();
});

await check("an old VLC rescan cannot replace the browser catalogue after handoff", async (f) => {
  const x = panelFixture(f, "vlc");
  const gate = deferred(); let reads = 0, writes = 0;
  x.bridge.rescan = () => gate.promise;
  x.bridge.library = async () => { ++reads; return []; };
  x.panel.library.useBridgeTracks = () => { ++writes; };
  const pending = x.panel.startScan();
  x.panel.cancelPending(); x.setEngine("browser");
  gate.resolve({ added: 1, reused: 0, failed: 0, ms: 10 }); await pending;
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(x.libraryChanges, 0);
});

await check("VLC catalogue read is guarded separately from the rescan response", async (f) => {
  const x = panelFixture(f, "vlc");
  const gate = deferred(); let writes = 0;
  x.bridge.rescan = async () => ({ added: 1, reused: 0, failed: 0, ms: 10 });
  x.bridge.library = () => gate.promise;
  x.panel.library.useBridgeTracks = () => { ++writes; };
  const pending = x.panel.startScan(); await settle();
  x.panel.cancelPending(); x.setEngine("browser"); gate.resolve([]); await pending;
  assert.equal(writes, 0); assert.equal(x.libraryChanges, 0);
});

await check("cancelled browser scan cannot announce success or update the replacement source", async (f) => {
  const x = panelFixture(f);
  const gate = deferred(); let signal;
  x.panel.library.scan = (_, options) => { signal = options.signal; return gate.promise; };
  const pending = x.panel.startScan();
  x.panel.cancelPending(); assert.equal(signal.aborted, true);
  x.setEngine("vlc"); gate.resolve({ phase: "cancelled" }); await pending;
  assert.equal(x.libraryChanges, 0); assert.deepEqual(x.notices, []);
});

await check("restore never starts under VLC and its old completion cannot repaint after handoff", async (f) => {
  const x = panelFixture(f, "vlc");
  x.panel.library.source = null;
  const gate = deferred(); let restores = 0;
  x.panel.library.restore = () => { ++restores; return gate.promise; };
  await x.panel.autoRestore(); assert.equal(restores, 0);
  x.setEngine("browser"); const pending = x.panel.autoRestore();
  x.panel.cancelPending(); x.setEngine("vlc"); gate.resolve(true); await pending;
  assert.equal(restores, 1); assert.equal(x.libraryChanges, 0);
});

await check("prepare buffers silently and startPrepared invokes play in the calling frame", async (f) => {
  f.element.readyState = 0;
  const preparing = f.player.prepare(track("A"));
  assert.equal(f.contexts.length, 1, "AudioContext must unlock before file I/O yields");
  await settle();
  assert.equal(f.element.playCalls.length, 0); assert.equal(f.player.state().loading, true);
  f.element.readyState = 3; f.element.dispatchEvent(new Event("canplay"));
  assert.equal(await preparing, true); assert.equal(f.player.state().prepared, true);
  assert.equal(f.player.isPlaying(), false); assert.equal(f.element.currentTime, 0);
  const starting = f.player.startPrepared();
  assert.equal(f.element.playCalls.length, 1, "audio.play must be called synchronously by the final reveal frame");
  assert.equal(await starting, true); assert.equal(f.player.state().prepared, false);
  assert.equal(await f.player.startPrepared(), false, "a preparation can only start once");
});

await check("stop while waiting for canplay cancels readiness and removes its URL", async (f) => {
  f.element.readyState = 0;
  const preparing = f.player.prepare(track("A")); await settle();
  f.player.stop();
  assert.equal(await preparing, false);
  f.element.readyState = 4; f.element.dispatchEvent(new Event("canplay")); await settle();
  assert.equal(await f.player.startPrepared(), false); assert.equal(f.element.playCalls.length, 0);
  assert.equal(f.revoked.length, 1);
});

await check("preparation timeout reports an observable error without starting audio", async (f) => {
  f.player.hooks.preparationTimeoutMs = 10;
  f.element.readyState = 0;
  assert.equal(await f.player.prepare(track("A")), false);
  assert.match(f.player.state().error, /超时/);
  assert.equal(f.player.state().loading, false); assert.equal(f.element.playCalls.length, 0);
});

await check("preparing B replaces ready A; media actions may belong to the main router", async (f) => {
  f.player.hooks.mediaSessionActions = false;
  const external = () => {}; f.session.handlers.set("play", external);
  await f.player.prepare(track("A")); await f.player.prepare(track("B"));
  assert.equal(f.session.handlers.get("play"), external);
  assert.equal(f.session.handlers.size, 1);
  await f.player.startPrepared(); assert.equal(f.urls.get(f.element.src), "B");
  assert.equal(f.revoked.length, 1); assert.equal(f.session.metadata.title, "B");
});

assert.equal(queueIndex(0, 0, "list"), -1);
assert.equal(queueIndex(3, 2, "list"), 0);
assert.equal(queueIndex(3, 0, "list", -1), 2);
assert.equal(queueIndex(3, 1, "single", 1, true), 1);
assert.equal(queueIndex(3, 1, "single", 1, false), 2);
assert.equal(queueIndex(3, 1, "shuffle", 1, true, () => 0), 0);
assert.equal(queueIndex(3, 1, "shuffle", 1, true, () => 0.9999), 2);
console.log(`Music player/panel regression checks passed (${passed} scenarios), plus shared queue policy checks.`);
