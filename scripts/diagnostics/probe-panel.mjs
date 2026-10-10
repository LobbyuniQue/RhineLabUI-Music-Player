// Focused probe: does the playing-row highlight follow a debug-surface play?
import { spawn } from "node:child_process";
import { join } from "node:path";
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
const PORT = 4194,
  DEBUG_PORT = 9346;
const EDGE = BROWSER;
const PROFILE = profilePath("probe-panel");
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
      break;
  }
  console.log("ready");

  await cdp.evaluate(
    `(() => {
    const frames = 8 * 44100, pcm = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(2*Math.PI*220*i/44100)*0.85*32767); pcm[i*2]=v; pcm[i*2+1]=v; }
    const header = new Uint8Array(44); const dv = new DataView(header.buffer);
    const put = (o,s)=>{for(let j=0;j<s.length;j++)header[o+j]=s.charCodeAt(j)};
    put(0,"RIFF"); dv.setUint32(4,36+pcm.length*2,true); put(8,"WAVE"); put(12,"fmt ");
    dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,2,true);
    dv.setUint32(24,44100,true); dv.setUint32(28,44100*4,true); dv.setUint16(32,4,true); dv.setUint16(34,16,true);
    put(36,"data"); dv.setUint32(40,pcm.length*2,true);
    window.__f = new File([header, pcm.buffer], "probe-tone.wav", { type: "audio/wav", lastModified: 1759600000000 });
    window.rhine.music.library.useFiles([window.__f]);
    window.__scanDone = null;
    window.rhine.music.library.scan(() => {}).then((r) => { window.__scanDone = { total: r.total }; });
    return "kicked";
  })()`,
    false,
    30000,
  );
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const done = await cdp
      .evaluate(`window.__scanDone`, false, 15000)
      .catch(() => null);
    if (done) break;
    if (i % 15 === 14) console.log(`  scan still running (${i + 1}s)`);
  }
  console.log(
    "scan done:",
    await cdp
      .evaluate(`window.__scanDone`, false, 15000)
      .catch(() => "unknown"),
  );
  await cdp.evaluate(`window.rhine.music.open()`, false, 20000);
  console.log("panel open");

  await cdp.evaluate(
    `window.rhine.music.play(window.rhine.music.library.tracks[0].id)`,
    false,
    20000,
  );
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const s = await cdp.evaluate(
      `({
      playing: document.querySelectorAll(".result-row.playing").length,
      state: window.rhine.music.player.state().playing,
      rows: document.querySelectorAll(".result-row").length,
    })`,
      false,
      15000,
    );
    if (s.playing > 0 || s.state) {
      console.log(`poll${i}:`, JSON.stringify(s));
      if (s.playing > 0) {
        console.log("TICK-SYNC PASS: highlight followed debug play");
        break;
      }
    }
    if (i === 11) console.log("poll final:", JSON.stringify(s));
  }

  // Manual call to discriminate method vs caller.
  await cdp.evaluate(
    `window.rhine.music.panel.syncPlayingRow(window.rhine.music.player.state().id)`,
    false,
    15000,
  );
  await sleep(400);
  console.log(
    "after manual sync:",
    await cdp.evaluate(
      `document.querySelectorAll(".result-row.playing").length`,
      false,
      15000,
    ),
  );
} catch (error) {
  console.log("probe error:", error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([stopProcessTree(edge), stopProcessTree(server)]);
  await sleep(1000);
  await removeLocalDirectory(PROFILE).catch(() => {});
}
