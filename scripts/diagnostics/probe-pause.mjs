// Focused probe: (1) pausing decays the envelope with the panel closed,
// (2) the IndexedDB index survives a reload of the same dist build.
import { spawn } from "node:child_process";
import {
  DIST_DIR,
  STATIC_SERVER,
  BROWSER,
  profilePath,
  resetLocalDirectory,
  removeLocalDirectory,
  requireE2EEnvironment,
} from "../lib/workspace-paths.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";

const DIST = DIST_DIR;
const PORT = 4193,
  DEBUG_PORT = 9344;
const EDGE = BROWSER;
const PROFILE = profilePath("probe-pause");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

requireE2EEnvironment();
await resetLocalDirectory(PROFILE);

const server = spawn(process.execPath, [STATIC_SERVER, DIST, String(PORT)], {
  stdio: "ignore",
  windowsHide: true,
});
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-crash-reporter",
    "--disable-extensions",
    // Emulate a visible page: without these, pausing the only audio lets Chrome
    // throttle the occluded headless page — rAF stalls and frame-driven ticks
    // freeze, which is an artefact of the harness, not the app.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=900,640",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

class Cdp {
  constructor(socket) {
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error
          ? reject(new Error(JSON.stringify(m.error)))
          : resolve(m.result);
      }
    });
    this.socket = socket;
  }
  send(method, params = {}, timeoutMs = 90000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout`));
        }
      }, timeoutMs);
    });
  }
  async evaluate(expression, awaitPromise = true, timeoutMs = 90000) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? "evaluate failed",
      );
    return r.result.value;
  }
}

let edgeKilled = false;
const killEdge = () => {
  if (!edgeKilled) {
    edge.kill();
    edgeKilled = true;
  }
};

const toneFile = `(() => {
  const frames = 8 * 44100, pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(2*Math.PI*220*i/44100)*0.85*32767); pcm[i*2]=v; pcm[i*2+1]=v; }
  const header = new Uint8Array(44); const dv = new DataView(header.buffer);
  const put = (o,s)=>{for(let j=0;j<s.length;j++)header[o+j]=s.charCodeAt(j)};
  put(0,"RIFF"); dv.setUint32(4,36+pcm.length*2,true); put(8,"WAVE"); put(12,"fmt ");
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,2,true);
  dv.setUint32(24,44100,true); dv.setUint32(28,44100*4,true); dv.setUint16(32,4,true); dv.setUint16(34,16,true);
  put(36,"data"); dv.setUint32(40,pcm.length*2,true);
  // Fixed mtime: reuse detection keys on size+modified, so regenerated files
  // must present the same stamp across reloads to exercise the reuse path.
  return new File([header, pcm.buffer], "probe-tone.wav", { type: "audio/wav", lastModified: 1759600000000 });
})()`;

try {
  let page;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      ).json();
      page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res);
    socket.addEventListener("error", rej);
  });
  const cdp = new Cdp(socket);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const load = async () => {
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${PORT}/?review=1`,
    });
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      if (
        await cdp
          .evaluate(
            "Boolean(window.rhine && window.rhine.stats().ready)",
            false,
            15000,
          )
          .catch(() => false)
      )
        return true;
    }
    return false;
  };
  console.log("load1:", await load());

  // Bare timer sanity: if this times out, the page's event loop is stalled and
  // no awaited evaluate can work.
  console.log(
    "timer:",
    await cdp
      .evaluate(
        `new Promise((r) => setTimeout(() => r("ok-3s"), 3000))`,
        true,
        20000,
      )
      .catch((e) => "TIMEOUT: " + e.message),
  );

  // Kick the scan off fire-and-forget, then poll with short evaluates — robust
  // against whatever stalls long awaited promises in this page.
  console.log("step: kick scan");
  await cdp.evaluate(
    `(() => {
    const f = ${toneFile};
    window.rhine.music.library.useFiles([f], { label: "probe-root", persistent: false });
    window.__scan1 = null;
    window.rhine.music.library.scan(() => {}).then(
      (r) => { window.__scan1 = { total: r.total, parsed: r.parsed, reused: r.reused, phase: r.phase }; },
      (e) => { window.__scan1 = { error: String(e) }; },
    );
    return "kicked";
  })()`,
    false,
    30000,
  );
  let scan1 = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    scan1 = await cdp
      .evaluate(`window.__scan1`, false, 15000)
      .catch(() => null);
    if (scan1) break;
    if (i % 10 === 9)
      console.log(
        `  scan still running (${i + 1}s), tracks=${await cdp.evaluate("window.rhine.music.library.tracks.length", false, 15000).catch(() => "?")}`,
      );
  }
  console.log("scan1:", JSON.stringify(scan1));

  console.log("step: play");
  await cdp.evaluate(
    `window.rhine.music.player.setMode("single"); window.rhine.music.play(window.rhine.music.library.tracks[0].id)`,
    false,
    20000,
  );
  let baseline = 0;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    const s = await cdp.evaluate(
      `(() => { const p = window.rhine.music.player.state(); return { a: window.rhine.music.bands().activity, playing: p.playing }; })()`,
      false,
      15000,
    );
    if (s.a > 0.3 && s.playing) {
      baseline = s.a;
      break;
    }
  }
  console.log(
    "baseline activity:",
    baseline.toFixed(3),
    baseline > 0 ? "(band flow with panel closed ✓)" : "(NO FLOW ✗)",
  );

  // Probe 1: pause → envelope must decay to silence even though the panel is closed.
  await cdp.evaluate(`window.rhine.music.player.pause()`, false, 15000);
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(350);
    samples.push(
      await cdp.evaluate(`window.rhine.music.bands().activity`, false, 15000),
    );
  }
  const tail = samples[samples.length - 1];
  console.log("paused activity:", samples.map((v) => v.toFixed(3)).join(" "));
  console.log(
    tail < 0.15
      ? "PROBE-1 PASS: envelope decays after pause with panel closed"
      : "PROBE-1 FAIL: envelope stuck",
  );

  // Probe 2: reload the same build → the persisted index must be reused.
  console.log("load2:", await load());
  // Restore the persisted library BEFORE re-scanning (fire-and-forget + poll).
  await cdp.evaluate(
    `(() => { window.__restored = null; window.rhine.music.library.restore().then((ok) => { window.__restored = ok; }); return "kicked"; })()`,
    false,
    15000,
  );
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await cdp.evaluate(`window.__restored !== null`, false, 15000)) break;
  }
  const persisted = await cdp.evaluate(
    `window.rhine.music.library.tracks.length`,
    false,
    15000,
  );
  console.log(
    "restored:",
    await cdp.evaluate(`window.__restored`, false, 15000),
    "tracks:",
    persisted,
  );

  await cdp.evaluate(
    `(() => {
    const f = ${toneFile};
    window.rhine.music.library.useFiles([f], { label: "probe-root", persistent: false });
    window.__scan2 = null;
    window.rhine.music.library.scan(() => {}).then(
      (r) => { window.__scan2 = { total: r.total, parsed: r.parsed, reused: r.reused }; },
      (e) => { window.__scan2 = { error: String(e) }; },
    );
    return "kicked";
  })()`,
    false,
    30000,
  );
  let scan2 = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    scan2 = await cdp
      .evaluate(`window.__scan2`, false, 15000)
      .catch(() => null);
    if (scan2) break;
  }
  console.log("scan2:", JSON.stringify(scan2));
  console.log(
    scan2 && scan2.parsed === 0 && scan2.reused === scan2.total
      ? "PROBE-2 PASS: index reused on rescan"
      : "PROBE-2 INFO/FAIL: re-parsed",
  );
} catch (error) {
  console.log("probe error:", error.message);
  process.exitCode = 1;
} finally {
  killEdge();
  await stopProcessTree(server);
  await sleep(1000);
  await removeLocalDirectory(PROFILE).catch(() => {});
}
