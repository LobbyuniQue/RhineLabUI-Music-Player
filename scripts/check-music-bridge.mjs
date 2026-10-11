import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { MusicBridge } from "../src/music-bridge.ts";
import { MusicEngineHandoff } from "../src/music-engine.ts";

const health = {
  ok: true,
  ready: true,
  root: "test-library",
  tracks: 2,
  scan: { phase: "done", seen: 2, added: 2, reused: 0, failed: 0, ms: 1 },
  vlc: { version: "test", pid: 1, startedAt: 1 },
};
const status = (state = "stopped", currentId = null) => ({
  state,
  currentId,
  time: 0,
  length: 10,
  volume: 256,
  title: "test",
  artist: "",
  album: "",
  codec: "wav",
  vlc: health.vlc,
});
const response = (value, code = 200) => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => value,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

function harness(t) {
  const originals = {
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  };
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const schedule = (callback, delay, interval = 0) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: now + delay, interval });
    return id;
  };
  globalThis.setTimeout = (callback, delay) => schedule(callback, delay);
  globalThis.setInterval = (callback, delay) =>
    schedule(callback, delay, delay);
  globalThis.clearTimeout = globalThis.clearInterval = (id) =>
    timers.delete(id);
  Date.now = () => now;
  const sources = [];
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
    open() {
      this.onopen?.({});
    }
    fail() {
      this.onerror?.({});
    }
    send(bands) {
      this.onmessage?.({ data: JSON.stringify({ bands }) });
    }
  };
  const calls = [];
  let fetchHandler = async (url) => {
    if (url.endsWith("/api/health")) return response(health);
    if (url.endsWith("/api/library")) return response({ tracks: [] });
    if (url.endsWith("/api/status")) return response(status());
    return response({});
  };
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return fetchHandler(url, options);
  };
  const connections = [];
  const states = [];
  const bands = [];
  let backgroundSuppressed = false;
  const bridge = new MusicBridge({
    port: 8788,
    token: "test-token",
    onBands: (value) => bands.push(value),
    onConnectionChange: (connected, info) => {
      connections.push({ connected, info });
      if (!connected) backgroundSuppressed = false;
    },
    onState: (value) => {
      states.push(value);
      backgroundSuppressed = value.state === "playing";
    },
  });
  t.after(() => {
    bridge.dispose();
    globalThis.fetch = originals.fetch;
    globalThis.EventSource = originals.EventSource;
    globalThis.setTimeout = originals.setTimeout;
    globalThis.clearTimeout = originals.clearTimeout;
    globalThis.setInterval = originals.setInterval;
    globalThis.clearInterval = originals.clearInterval;
    Date.now = originals.now;
  });
  return {
    bridge,
    sources,
    calls,
    connections,
    states,
    bands,
    timers,
    get suppressed() {
      return backgroundSuppressed;
    },
    fetch(handler) {
      fetchHandler = handler;
    },
    async tick(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
        await flush();
      }
      now = end;
      await flush();
    },
    async connect() {
      const pending = bridge.connect();
      await flush();
      sources.at(-1).open();
      assert.equal(await pending, health);
      await flush();
    },
  };
}

function transportHarness(h) {
  let value = status();
  let ticket = 0;
  const preparations = [];
  const starts = [];
  const pauses = [];
  const gates = new Map();
  h.fetch(async (raw, options) => {
    const url = new URL(raw);
    if (url.pathname === "/api/health") return response(health);
    if (url.pathname === "/api/library") return response({ tracks: [] });
    if (url.pathname === "/api/status") return response({ ...value });
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.match(url.searchParams.get("client") ?? "", /^[a-z0-9-]+$/i);
    assert.ok(Number(url.searchParams.get("sequence")) > 0);
    if (url.pathname === "/api/prepare") {
      const id = url.searchParams.get("id");
      preparations.push(id);
      const ready = { ready: true, ticket: `ticket-${++ticket}` };
      if (gates.has(id)) return gates.get(id).promise;
      value = { ...status("paused", id), prepared: true };
      return response(ready);
    }
    if (url.pathname === "/api/start") {
      starts.push(url.searchParams.get("ticket"));
      value = { ...value, state: "playing", prepared: false, ended: false };
    }
    if (url.pathname === "/api/stop") value = status();
    if (url.pathname === "/api/pause") { pauses.push(value.currentId); value = { ...value, state: "paused", ended: false }; }
    if (url.pathname === "/api/resume") value = { ...value, state: "playing", ended: false };
    return response({});
  });
  return {
    preparations, starts, pauses, gates,
    get state() { return value; },
    set state(next) { value = next; },
    end() { value = { ...value, state: "stopped", ended: true }; },
  };
}

test("connection requires an open event stream and shares concurrent probes", async (t) => {
  const h = harness(t);
  const first = h.bridge.connect();
  const second = h.bridge.connect();
  await flush();
  assert.equal(h.sources.length, 1);
  assert.equal(h.bridge.connected, false);
  assert.equal(h.connections.length, 0);
  h.sources[0].open();
  assert.equal(await first, health);
  assert.equal(await second, health);
  assert.equal(h.bridge.connected, true);
  assert.deepEqual(
    h.connections.map((value) => value.connected),
    [true],
  );
  h.sources[0].send(Array(128).fill(0.3));
  assert.equal(h.bands.length, 1);
});

test("stream errors release playback state, reject stale events and reconnect with fresh status", async (t) => {
  const h = harness(t);
  h.fetch(async (url) =>
    response(
      url.endsWith("/api/health")
        ? health
        : url.endsWith("/api/status")
          ? status("playing", "a")
          : { tracks: [] },
    ),
  );
  await h.connect();
  assert.equal(h.suppressed, true);
  const oldSource = h.sources[0];
  oldSource.fail();
  assert.equal(h.bridge.connected, false);
  assert.equal(h.bridge.info, null);
  assert.equal(oldSource.closed, true);
  assert.equal(h.suppressed, false);
  oldSource.open();
  oldSource.send(Array(128).fill(1));
  assert.equal(h.bridge.connected, false);
  assert.equal(h.bands.length, 0);
  await h.tick(499);
  assert.equal(h.sources.length, 1);
  await h.tick(1);
  assert.equal(h.sources.length, 2);
  h.sources[1].open();
  await flush();
  assert.equal(h.bridge.connected, true);
  assert.equal(h.suppressed, true);
  assert.deepEqual(
    h.connections.map((value) => value.connected),
    [true, false, true],
  );
});

test("explicit disconnect cancels reconnection and queued status callbacks", async (t) => {
  const h = harness(t);
  await h.connect();
  const slow = deferred();
  h.fetch(() => slow.promise);
  const pending = h.bridge.status();
  h.sources[0].fail();
  h.bridge.disconnect();
  slow.resolve(response(status("playing", "old")));
  assert.equal(await pending, null);
  await h.tick(16000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.bridge.connected, false);
  assert.equal(h.suppressed, false);
  assert.equal(
    h.states.some((value) => value.currentId === "old"),
    false,
  );
  assert.equal(h.timers.size, 0);
});

test("disconnect during a health probe prevents a late connection", async (t) => {
  const h = harness(t);
  const slow = deferred();
  h.fetch(() => slow.promise);
  const pending = h.bridge.connect();
  await flush();
  h.bridge.disconnect();
  slow.resolve(response(health));
  assert.equal(await pending, null);
  assert.equal(h.sources.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("configure cancels old credentials without restoring them from a delayed probe", async (t) => {
  const h = harness(t);
  const slow = deferred();
  h.fetch((url) =>
    url.startsWith("http://127.0.0.1:8788")
      ? slow.promise
      : Promise.resolve(
          response(
            url.endsWith("/api/health")
              ? health
              : url.endsWith("/api/status")
                ? status()
                : { tracks: [] },
          ),
        ),
  );
  const pending = h.bridge.connect();
  await flush();
  h.bridge.configure({ port: 8789, token: "new-token" });
  await h.connect();
  slow.resolve(response(health));
  assert.equal(await pending, null);
  assert.equal(h.bridge.connected, true);
  assert.match(
    h.sources[0].url,
    /127\.0\.0\.1:8789\/api\/spectrum\?token=new-token/,
  );
  assert.equal(
    h.calls.filter((call) => call.url.startsWith("http://127.0.0.1:8788"))
      .length,
    1,
  );
});

test("dispose stops timers, queued streams and subsequent connections", async (t) => {
  const h = harness(t);
  const pending = h.bridge.connect();
  await flush();
  h.bridge.dispose();
  assert.equal(await pending, null);
  h.sources[0].open();
  h.sources[0].fail();
  await h.tick(16000);
  assert.equal(await h.bridge.connect(), null);
  assert.equal(h.sources.length, 1);
  assert.equal(h.bridge.connected, false);
  assert.equal(h.timers.size, 0);
});

test("network failures and VLC offline responses notify disconnection", async (t) => {
  const h = harness(t);
  await h.connect();
  h.fetch(async () => {
    throw new Error("connection refused");
  });
  assert.equal(await h.bridge.status(), null);
  assert.equal(h.bridge.connected, false);
  assert.equal(h.connections.at(-1).connected, false);
  await assert.rejects(h.bridge.play("a"), /桥接|VLC/);
  h.fetch(async (url) =>
    response(
      url.endsWith("/api/health")
        ? health
        : url.endsWith("/api/status")
          ? status("offline")
          : { tracks: [] },
    ),
  );
  await h.tick(500);
  h.sources.at(-1).open();
  await flush();
  assert.equal(h.bridge.connected, false);
  assert.equal(
    h.states.some((value) => value.state === "offline"),
    false,
  );
});

test("late status responses cannot replace a newer VLC state", async (t) => {
  const h = harness(t);
  await h.connect();
  const older = deferred();
  const newer = deferred();
  let requests = 0;
  h.fetch(() => (++requests === 1 ? older : newer).promise);
  const first = h.bridge.status();
  const second = h.bridge.status();
  newer.resolve(response(status("paused", "b")));
  assert.equal((await second).currentId, "b");
  older.resolve(response(status("playing", "a")));
  assert.equal(await first, null);
  assert.equal(h.states.at(-1).currentId, "b");
  assert.equal(h.suppressed, false);
});

test("an older failed status poll cannot disconnect a newer healthy VLC session", async (t) => {
  const h = harness(t);
  await h.connect();
  for (const failure of ["network", "authorization"]) {
    const older = deferred();
    const newer = deferred();
    let requests = 0;
    h.fetch(() => (++requests === 1 ? older : newer).promise);
    const first = h.bridge.status();
    const second = h.bridge.status();
    newer.resolve(response(status("paused", "b")));
    assert.equal((await second).currentId, "b");
    if (failure === "network") older.reject(new Error("timeout"));
    else older.resolve(response({}, 401));
    assert.equal(await first, null);
    assert.equal(h.bridge.connected, true);
    assert.equal(h.sources[0].closed, false);
    assert.equal(h.states.at(-1).currentId, "b");
    assert.deepEqual(
      h.connections.map((value) => value.connected),
      [true],
    );
  }
});

test("a silent event stream times out and reconnects instead of remaining connected", async (t) => {
  const h = harness(t);
  await h.connect();
  await h.tick(10000);
  assert.equal(h.bridge.connected, false);
  assert.equal(h.sources[0].closed, true);
  await h.tick(500);
  assert.equal(h.sources.length, 2);
});

test("opening timeout retries; manual cancellation aborts probe retry delay", async (t) => {
  const h = harness(t);
  const pending = h.bridge.connect();
  await flush();
  await h.tick(6000);
  assert.equal(await pending, null);
  assert.equal(h.sources[0].closed, true);
  h.bridge.disconnect();
  h.fetch(async () => response({}, 503));
  const failed = h.bridge.connect();
  await flush();
  h.bridge.disconnect();
  assert.equal(await failed, null);
  await h.tick(16000);
  assert.equal(h.timers.size, 0);
});

// Execute the actual main.ts integration functions, with only the scene/audio
// and library boundary replaced; these tests exercise production race guards.
function integrationHarness() {
  const source = ts.createSourceFile(
    "main.ts",
    readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["loadBridgeLibrary", "connectMusicBridge", "setMusicEngine"].includes(
        node.name?.text,
      ),
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(source) === "musicBridge");
  const handoff = source.statements.filter(ts.isVariableStatement).find((node) =>
    node.declarationList.declarations.some((declaration) => declaration.name.getText(source) === "engineHandoff"));
  const options = declaration.initializer.arguments[0];
  const callbacks = options.properties.filter((node) =>
    ["onState", "onConnectionChange"].includes(node.name.getText(source)),
  );
  const applied = [];
  const requests = [];
  const audioActive = [];
  let currentHealth = health;
  let connected = true;
  let refreshes = 0;
  let sceneResets = 0;
  let restored = 0;
  const context = createContext({
    prefs: { musicEngine: "vlc" },
    isWallpaper: false,
    MusicEngineHandoff,
    musicReveal: { pending: false }, musicRevealEngine: "browser", failMusicReveal() {}, cancelMusicArchive() {}, syncSystemMedia() {},
    musicPlayer: { state: () => ({ playing: false }), stop() {} },
    musicBridge: {
      queueTracks() {},
      stop: async () => status("stopped"),
      get info() {
        return currentHealth;
      },
      get connected() {
        return connected;
      },
      library: () => {
        const value = deferred();
        requests.push(value);
        return value.promise;
      },
      connect: async () => {
        if (!connected) {
          connected = true;
          context.api.onConnectionChange(true, currentHealth);
        }
        return currentHealth;
      },
      disconnect: () => {
        connected = false;
        context.api.onConnectionChange(false, null);
      },
    },
    musicLibrary: {
      cancelScan() {},
      cancelPending() {},
      useBridgeTracks: (tracks, root) => applied.push({ tracks, root }),
      restore: async () => {
        restored++;
        return true;
      },
    },
    musicPanel: { refreshLibrary() {}, cancelPending() {} },
    audio: { setLocalMusicActive: (active) => audioActive.push(active) },
    scene: { setPlayfield: () => sceneResets++ },
    quietBands: () => ({}),
    syncMusicIndicators() {},
    refreshMusicSettings() {},
    saveAudioPrefs() {},
    notify() {},
    onLibraryMayHaveChanged: () => refreshes++,
    launcherSession: null,
  });
  const code = `let bridgeHealth = null, bridgeStatus = null, bridgeStatusElapsed = 1, bridgeLibraryLoad = null, bridgeHadAudio = false;
    ${handoff?.getText(source) ?? ""}
    ${functions.map((node) => node.getText(source)).join("\n")}
    globalThis.api = {
      ${callbacks.map((node) => node.getText(source)).join(",\n")},
      loadBridgeLibrary, connectMusicBridge, setMusicEngine,
      status: () => bridgeStatus,
    };`;
  runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return {
    api: context.api,
    context,
    applied,
    requests,
    audioActive,
    get refreshes() {
      return refreshes;
    },
    get sceneResets() {
      return sceneResets;
    },
    get restored() {
      return restored;
    },
    prepareConnect() {
      connected = false;
      currentHealth = health;
    },
    connection(value, info = currentHealth) {
      connected = value;
      currentHealth = value ? info : null;
      context.api.onConnectionChange(value, currentHealth);
    },
  };
}

test("VLC preparation stays paused until one explicit start consumes its ticket", async (t) => {
  const h = harness(t), transport = transportHarness(h);
  await h.connect();
  assert.equal(await h.bridge.prepare("a"), true);
  assert.equal(h.bridge.prepared, true);
  assert.equal(transport.state.state, "paused");
  assert.deepEqual(transport.starts, []);
  assert.equal(h.suppressed, false);
  const starting = h.bridge.startPrepared();
  assert.equal(transport.starts.length, 1, "the final frame sends /api/start before yielding");
  assert.equal(await starting, true);
  assert.equal(h.bridge.prepared, false);
  assert.equal(await h.bridge.startPrepared(), false);
  assert.equal(transport.starts.length, 1);
});

for (const action of ["stop", "disconnect", "dispose"]) {
  test(`${action} invalidates a delayed VLC preparation and its start ticket`, async (t) => {
    const h = harness(t), transport = transportHarness(h);
    await h.connect();
    const slow = deferred(); transport.gates.set("a", slow);
    const preparing = h.bridge.prepare("a");
    await flush();
    await h.bridge[action]();
    slow.resolve(response({ ready: true, ticket: "obsolete-ticket" }));
    assert.equal(await preparing, false);
    assert.equal(h.bridge.prepared, false);
    assert.equal(await h.bridge.startPrepared(), false);
    assert.equal(transport.starts.length, 0);
  });
}

test("a delayed old VLC preparation cannot replace a newer prepared track", async (t) => {
  const h = harness(t), transport = transportHarness(h);
  await h.connect();
  const slow = deferred(); transport.gates.set("a", slow);
  const first = h.bridge.prepare("a");
  assert.equal(await h.bridge.prepare("b"), true);
  slow.resolve(response({ ready: true, ticket: "obsolete-ticket" }));
  assert.equal(await first, false);
  assert.equal(await h.bridge.startPrepared(), true);
  assert.equal(transport.state.currentId, "b");
  assert.ok(transport.starts.every((ticket) => ticket !== "obsolete-ticket"));
});

test("failed VLC preparation sends a newer stop without hiding its error", async (t) => {
  const h = harness(t), transport = transportHarness(h);
  await h.connect();
  const failure = deferred(); transport.gates.set("a", failure);
  const preparing = h.bridge.prepare("a");
  failure.reject(new Error("preparation timeout"));
  assert.equal(await preparing, false);
  assert.match(h.bridge.error, /preparation timeout/);
  assert.equal(h.bridge.prepared, false);
  const commands = h.calls.filter((call) => /\/api\/(prepare|stop)\?/.test(call.url)).map((call) => new URL(call.url));
  assert.deepEqual(commands.map((url) => url.pathname), ["/api/prepare", "/api/stop"]);
  assert.ok(Number(commands[1].searchParams.get("sequence")) > Number(commands[0].searchParams.get("sequence")));
});

test("VLC resume preserves position and does not prepare the same file again", async (t) => {
  const h = harness(t), transport = transportHarness(h);
  await h.connect();
  await h.bridge.play("a");
  transport.state = { ...transport.state, time: 4.5 };
  await h.bridge.pause();
  assert.equal((await h.bridge.resume()).time, 4.5);
  assert.deepEqual(transport.preparations, ["a"]);
  assert.deepEqual(transport.pauses, ["a"]);
});

for (const mode of ["list", "single", "shuffle"]) {
  test(`VLC ${mode} advances on the independent timer while no panel/frame loop runs`, async (t) => {
    const h = harness(t), transport = transportHarness(h);
    await h.connect();
    h.bridge.queueTracks([{ id: "a" }, { id: "b" }, { id: "c" }]);
    h.bridge.setMode(mode);
    await h.bridge.play("b");
    transport.end();
    await h.tick(750);
    await flush();
    assert.equal(transport.preparations.length, 2);
    const next = transport.preparations[1];
    if (mode === "list") assert.equal(next, "c");
    if (mode === "single") assert.equal(next, "b");
    if (mode === "shuffle") assert.ok(next === "a" || next === "c");
    assert.equal(transport.starts.length, 2);
    await h.tick(750);
    assert.equal(transport.preparations.length, 2, "an ended observation is consumed once");
    await h.bridge.stop();
    await h.tick(750);
    assert.equal(transport.preparations.length, 2, "an explicit stop cannot restart the queue");
  });
}

test("VLC manual next/previous use the same complete queue and single only loops automatically", async (t) => {
  const h = harness(t), transport = transportHarness(h);
  await h.connect();
  h.bridge.queueTracks([{ id: "a" }, { id: "b" }, { id: "c" }]);
  h.bridge.setMode("single");
  await h.bridge.play("b");
  await h.bridge.next();
  await h.bridge.next();
  await h.bridge.previous();
  assert.deepEqual(transport.preparations, ["b", "c", "a", "c"]);
});

test("main shares the initial library load and refreshes a new reconnect session", async () => {
  const h = integrationHarness();
  h.prepareConnect();
  const pending = h.api.connectMusicBridge(true);
  await flush();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve([{ id: "first" }]);
  await pending;
  assert.equal(h.applied.length, 1);
  h.connection(false);
  h.connection(true, {
    ...health,
    root: "new-root",
    vlc: { ...health.vlc, startedAt: 2 },
  });
  await flush();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve([{ id: "second" }]);
  await flush();
  assert.equal(h.applied.length, 2);
  assert.equal(h.applied[1].root, "new-root");
  assert.equal(h.refreshes, 2);
});

test("main cannot overwrite the browser library after disconnect, failure or a superseding load", async () => {
  const h = integrationHarness();
  const first = h.api.loadBridgeLibrary();
  const newer = h.api.loadBridgeLibrary(true);
  h.requests[1].resolve([{ id: "new" }]);
  await newer;
  h.requests[0].resolve([{ id: "old" }]);
  await first;
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].tracks[0].id, "new");
  const delayed = h.api.loadBridgeLibrary(true);
  await h.api.setMusicEngine("browser");
  h.requests[2].resolve([{ id: "vlc" }]);
  await delayed;
  assert.equal(h.applied.length, 1);
  assert.equal(h.restored, 1);
  assert.equal(h.refreshes, 2);
  h.context.prefs.musicEngine = "vlc";
  h.connection(true, { ...health });
  h.requests[3].reject(new Error("HTTP 500"));
  await flush();
  assert.equal(h.applied.length, 1);
});

test("main retries a failed same-session load normally without invalidating a newer load", async () => {
  const h = integrationHarness();
  const failed = h.api.loadBridgeLibrary();
  h.requests[0].reject(new Error("HTTP 500"));
  assert.equal(await failed, 0);
  assert.equal(h.applied.length, 0);
  const retry = h.api.loadBridgeLibrary();
  const shared = h.api.loadBridgeLibrary();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve([{ id: "recovered" }]);
  assert.equal(await retry, 1);
  assert.equal(await shared, 1);
  assert.equal(h.applied[0].tracks[0].id, "recovered");

  const obsolete = h.api.loadBridgeLibrary(true);
  const newer = h.api.loadBridgeLibrary(true);
  h.requests[2].reject(new Error("stale timeout"));
  assert.equal(await obsolete, 0);
  const reuseNewer = h.api.loadBridgeLibrary();
  assert.equal(h.requests.length, 4);
  h.requests[3].resolve([{ id: "latest" }]);
  assert.equal(await newer, 1);
  assert.equal(await reuseNewer, 1);
  assert.equal(h.applied.length, 2);
  assert.equal(h.applied[1].tracks[0].id, "latest");
});

test("main disconnect restores BGM, clears bridge status and retains browser playback suppression", async () => {
  const h = integrationHarness();
  h.api.onState(status("playing", "a"));
  assert.equal(h.audioActive.at(-1), true);
  h.connection(false);
  assert.equal(h.api.status(), null);
  assert.equal(h.audioActive.at(-1), false);
  assert.equal(h.sceneResets, 1);
  h.context.musicPlayer.state = () => ({ playing: true });
  h.api.onState(status("playing", "a"));
  h.connection(false);
  assert.equal(h.audioActive.at(-1), true);
  assert.equal(h.sceneResets, 1);
});
