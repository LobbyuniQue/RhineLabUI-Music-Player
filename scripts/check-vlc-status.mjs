import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { VlcOperationQueue, VlcStatusReader, waitWithSignal } from "./lib/vlc-status.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const raw = (state = "playing", time = 1) => ({ state, time, length: 90, volume: 256 });

test("slow timer and API status readers share one native request", async () => {
  const request = deferred();
  let calls = 0;
  const reader = new VlcStatusReader(() => { calls++; return request.promise; }, () => 20);
  const attempts = Array.from({ length: 100 }, () => reader.read());
  assert.equal(calls, 1);
  assert.ok(attempts.every((attempt) => attempt === attempts[0]));
  request.resolve(raw());
  assert.ok((await Promise.all(attempts)).every((result) => result.state === "playing"));
  assert.equal(reader.cachedAt, 20);
  await reader.read();
  assert.equal(calls, 2, "completed status is not reused as a new live read");
});

for (const outcome of ["success", "failure"]) {
  test(`an obsolete ${outcome} cannot overwrite a newer status or clear its pending read`, async () => {
    const old = deferred(), fresh = deferred();
    const requests = [old, fresh];
    const signals = [];
    const reader = new VlcStatusReader((signal) => { signals.push(signal); return requests.shift().promise; }, () => 30);
    const oldRead = reader.read();
    reader.invalidate();
    assert.equal(signals[0].aborted, true);
    const newRead = reader.read();
    if (outcome === "success") old.resolve(raw("playing"));
    else old.reject(new Error("late network failure"));
    assert.equal(await oldRead, null);
    assert.equal(reader.read(), newRead, "old finalizer must not create a duplicate native request");
    fresh.resolve(raw("stopped"));
    assert.equal((await newRead).state, "stopped");
    assert.equal(reader.cachedRaw.state, "stopped");
    assert.equal(reader.cachedAt, 30);
  });

  test(`an obsolete ${outcome} arriving after the new read cannot corrupt its cached status`, async () => {
    const old = deferred(), fresh = deferred();
    const requests = [old, fresh];
    const reader = new VlcStatusReader(() => requests.shift().promise, () => 40);
    const oldRead = reader.read();
    reader.invalidate();
    const newRead = reader.read();
    fresh.resolve(raw("stopped"));
    await newRead;
    if (outcome === "success") old.resolve(raw("playing"));
    else old.reject(new Error("late network failure"));
    await oldRead;
    assert.equal(reader.cachedRaw.state, "stopped");
    assert.equal(reader.cachedAt, 40);
  });
}

test("a current native failure clears the cache and reports offline", async () => {
  let fail = false;
  const reader = new VlcStatusReader(async () => {
    if (fail) throw new Error("VLC unavailable");
    return raw();
  }, () => 50);
  await reader.read();
  fail = true;
  assert.equal(await reader.read(), null);
  assert.equal(reader.cachedRaw, null);
  assert.equal(reader.cachedAt, 0);
});

test("pending controls remain suspended across queued operations and rejected controls", async () => {
  const first = deferred(), second = deferred();
  const queue = new VlcOperationQueue();
  const order = [];
  const a = queue.run(async () => { order.push("a"); await first.promise; throw new Error("failed control"); });
  const rejected = assert.rejects(a, /failed control/);
  const b = queue.run(async () => { order.push("b"); await second.promise; return "done"; });
  assert.equal(queue.pending, 2, "suspension begins before the operation microtask runs");
  let idle = false;
  const wait = queue.idle().then(() => { idle = true; });
  await flush();
  assert.deepEqual(order, ["a"]);
  first.resolve();
  await rejected;
  await flush();
  assert.equal(queue.pending, 1);
  assert.equal(idle, false);
  assert.deepEqual(order, ["a", "b"]);
  second.resolve();
  assert.equal(await b, "done");
  await wait;
  assert.equal(queue.pending, 0);
});

// Exercise the real bridge functions without starting a server or native process.
// Reads and controls are deferred independently so timing does not depend on VLC.
function bridgeHarness(signals = AbortSignal) {
  const source = readFileSync(new URL("./vlc-bridge.mjs", import.meta.url), "utf8");
  const calls = [];
  const diagnostics = [];
  const context = createContext({
    VlcOperationQueue, VlcStatusReader, waitWithSignal, AbortSignal: signals, URL, URLSearchParams, Date, setTimeout,
    console: { ...console, error: (...values) => diagnostics.push(values.join(" ")) },
    fetch: (url, options) => {
      const request = deferred();
      calls.push({ url, signal: options.signal, request });
      return request.promise.then((payload) => ({ ok: true, text: async () => JSON.stringify(payload) }));
    },
  });
  runInContext(`
    let vlc = {pid: 1}, stopping = false, vlcInfo = {version: "test", startedAt: 1};
    const vlcUrl = (query = "") => "http://127.0.0.1/requests/status.json" + query;
    const vlcAuth = "test";
    const nativeLibrary = { root: "fixture", tracks: [], playlist: { part: 0, needsSplit: false } };
    ${source.slice(source.indexOf("let current ="), source.indexOf("// -------------------------------------------------------------- spectrum tap"))}
    globalThis.bridge = {
      status, publicStatus, pollStatus, refreshStatus, vlcCall, serialTransport, controlQueue, statusReader,
      setCurrent: (id) => {current.id = id;},
    };
  `, context);
  return { ...context.bridge, calls, diagnostics };
}

test("real bridge polling skips pending controls and an internal receipt reads after the command", async () => {
  const h = bridgeHarness();
  h.setCurrent("track");
  const old = h.refreshStatus();
  assert.equal(h.calls.length, 1);
  const operation = h.serialTransport(new URL("http://bridge/api/stop"), async () => {
    await h.vlcCall("?command=pl_stop");
    h.setCurrent(null);
    return h.status(); // Internal status must not await its own control queue.
  });
  h.pollStatus();
  assert.equal(h.calls.length, 1, "queued controls pause timer before they execute");
  assert.equal(h.calls[0].signal.aborted, true);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].url, /command=pl_stop/);
  const external = h.publicStatus();
  h.pollStatus();
  assert.equal(h.calls.length, 2, "external API and timer must not add native reads during control");
  h.calls[1].request.resolve(raw("stopped"));
  await flush();
  assert.equal(h.calls.length, 3, "receipt starts a fresh status read after command completion");
  h.calls[2].request.resolve(raw("stopped"));
  const receipt = await operation;
  assert.equal(receipt.state, "stopped");
  assert.equal(receipt.currentId, null);
  await flush();
  assert.equal(h.calls.length, 4, "external status starts only after operation completes");
  h.calls[3].request.resolve(raw("stopped"));
  assert.equal((await external).state, "stopped");
  h.calls[0].request.reject(new Error("obsolete read failed late"));
  await old;
  assert.equal(h.statusReader.cachedRaw.state, "stopped");
});

test("real bridge external status discards pre-command state and waits for fresh post-control state", async () => {
  const h = bridgeHarness();
  const external = h.publicStatus();
  await flush();
  assert.equal(h.calls.length, 1);
  const control = h.controlQueue.run(async () => { await h.vlcCall("?command=seek&val=8"); });
  await flush();
  h.calls[0].request.resolve(raw("playing", 1));
  await flush();
  assert.equal(h.calls.length, 2, "obsolete external read waits, instead of sending another read during seek");
  h.calls[1].request.resolve(raw("playing", 8));
  await control;
  await flush();
  assert.equal(h.calls.length, 3);
  h.calls[2].request.resolve(raw("playing", 8));
  assert.equal((await external).time, 8);
});

test("public status cancels while controls continue, without leaving a pending native read", async () => {
  const h = bridgeHarness();
  const control = deferred();
  const running = h.controlQueue.run(() => control.promise);
  const cancelled = new AbortController();
  const external = h.publicStatus(cancelled.signal);
  await flush();
  assert.equal(h.calls.length, 0);
  cancelled.abort(new Error("HTTP response closed"));
  await assert.rejects(external, /HTTP response closed/);
  assert.equal(h.controlQueue.pending, 1, "a disconnected reader does not cancel native control");
  assert.equal(h.calls.length, 0);
  control.resolve();
  await running;
});

test("public status has one total deadline while a pending native read remains shared", async () => {
  const h = bridgeHarness();
  const cancelled = new AbortController();
  const external = h.publicStatus(cancelled.signal);
  await flush();
  const shared = h.refreshStatus();
  assert.equal(h.calls.length, 1);
  cancelled.abort(new Error("status deadline"));
  await assert.rejects(external, /status deadline/);
  assert.equal(h.calls[0].signal.aborted, false, "one API reader must not cancel other shared readers");
  h.calls[0].request.resolve(raw("playing", 7));
  assert.equal((await shared).time, 7);
  assert.equal(h.statusReader.cachedRaw.time, 7);
});

test("the default public status deadline includes waiting for a control queue that never empties", async () => {
  const deadlines = [];
  const h = bridgeHarness({
    timeout: (ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    },
    any: AbortSignal.any,
  });
  const first = deferred(), second = deferred();
  const a = h.controlQueue.run(() => first.promise);
  const external = h.publicStatus();
  await flush();
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].ms, 8000);
  const b = h.controlQueue.run(() => second.promise);
  first.resolve();
  await a;
  await flush();
  assert.equal(h.controlQueue.pending, 1);
  deadlines[0].controller.abort(new Error("overall status deadline"));
  await assert.rejects(external, /overall status deadline/);
  assert.equal(h.calls.length, 0);
  second.resolve();
  await b;
});

test("a failed post-stop native read reports offline instead of accepting a cached stopped receipt", async () => {
  const h = bridgeHarness();
  const initial = h.refreshStatus();
  h.calls[0].request.resolve(raw("stopped"));
  await initial;
  const operation = h.serialTransport(new URL("http://bridge/api/stop"), async () => {
    await h.vlcCall("?command=pl_stop");
    h.setCurrent(null);
    return h.status();
  });
  await flush();
  h.calls[1].request.resolve(raw("stopped"));
  await flush();
  h.calls[2].request.reject(new TypeError("native connection failed"));
  const receipt = await operation;
  assert.equal(receipt.state, "offline");
  assert.equal(receipt.currentId, null);
  assert.equal(h.statusReader.cachedRaw, null);
  assert.equal(h.statusReader.cachedAt, 0);
  assert.match(h.diagnostics[0], /^\[bridge\] VLC status failed \(TypeError, \d+ms\)$/);
});
