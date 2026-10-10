// Cover-plane calibration probe: two tracks with distinct embedded covers,
// music archive mode screenshots (array + extracted detail card).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DIST_DIR,
  SHOTS_DIR,
  STATIC_SERVER,
  BROWSER,
  profilePath,
  resetLocalDirectory,
  removeLocalDirectory,
  requireE2EEnvironment,
} from "../lib/workspace-paths.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";
const DIST = DIST_DIR;
const SHOTS = SHOTS_DIR;
const PORT = 4197,
  DEBUG_PORT = 9350;
const EDGE = BROWSER;
const PROFILE = profilePath("probe-cover");
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
    "--window-size=1600,1000",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

class Cdp {
  constructor(socket) {
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.consoleAPICalled")
        this.logs.push(
          (m.params.args ?? [])
            .map((a) => a.value ?? a.description ?? "")
            .join(" ")
            .slice(0, 300),
        );
      if (m.method === "Runtime.exceptionThrown")
        this.logs.push(
          "exception: " +
            m.params.exceptionDetails?.exception?.description?.slice(0, 300),
        );
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
  await mkdir(SHOTS, { recursive: true });
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
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${PORT}/?review=1`,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    if (
      await cdp
        .evaluate(
          "Boolean(window.rhine && window.rhine.stats().ready && window.rhine.stats().startup === 'started')",
          false,
          15000,
        )
        .catch(() => false)
    )
      break;
  }
  console.log("ready");

  // Build two mp3-ish files whose ID3v2.3 tags carry distinct JPEG covers.
  // Every step is kick + poll: awaited evaluates stall in this throttled page.
  await cdp.evaluate(
    `(() => {
    const jpeg = (hue) => new Promise((done) => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 512;
      const c = cv.getContext("2d");
      const g = c.createLinearGradient(0, 0, 512, 512);
      g.addColorStop(0, hue[0]); g.addColorStop(1, hue[1]);
      c.fillStyle = g; c.fillRect(0, 0, 512, 512);
      c.fillStyle = "rgba(255,255,255,.85)"; c.font = "bold 200px sans-serif"; c.textAlign = "center"; c.fillText(hue[2], 256, 330);
      cv.toBlob(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        window.__coverRaw = { type: blob.type, size: blob.size, bytes: Array.from(bytes.slice(0, 16)) };
        done(bytes);
      }, "image/jpeg", 0.85);
    });
    const text = (s) => new TextEncoder().encode(s);
    const frame = (id, payload) => { const h = new Uint8Array(10); h.set(text(id), 0); const v = new DataView(h.buffer); const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload); v.setUint32(4, p.length); return [h, p]; };
    const txxx = (id, str) => frame(id, [3, ...text(str)]);
    const apic = (img) => frame("APIC", [3, ...text("image/jpeg"), 0, 3, 0, ...img]);
    const syncsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
    const mp3 = async (title, artist, album, hue) => {
      const img = await jpeg(hue);
      const frames = [...txxx("TIT2", title), ...txxx("TPE1", artist), ...txxx("TALB", album), ...apic(img)];
      const frameParts = frames.flat();
      const size = frameParts.reduce((n, part) => n + part.length, 0);
      const head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(size)]);
      const audio = new Uint8Array(4000).fill(0x20);
      const header = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      return new File([head, ...frameParts, header, audio], title + ".mp3", { type: "audio/mpeg", lastModified: 1759600000000 });
    };
    window.__kick = null;
    (async () => {
      const files = [
        await mp3("红色测试曲", "Alpha", "红专辑", ["#c0392b", "#e74c3c", "红"]),
        await mp3("蓝色测试曲", "Beta", "蓝专辑", ["#2c3e50", "#3498db", "蓝"]),
      ];
      window.rhine.music.library.useFiles(files);
      window.__kick = "files";
      await window.rhine.music.library.scan(() => {});
      // Store known-good canvas JPEGs separately so this probe isolates the
      // archive renderer from the synthetic ID3/APIC byte fixture.
      const makeCover = (from, to, label) => new Promise((done) => {
        const cover = document.createElement("canvas"); cover.width = cover.height = 512;
        const ctx = cover.getContext("2d");
        const gradient = ctx.createLinearGradient(0, 0, 512, 512);
        gradient.addColorStop(0, from); gradient.addColorStop(1, to);
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
        ctx.fillStyle = "#fff"; ctx.font = "bold 200px sans-serif"; ctx.textAlign = "center"; ctx.fillText(label, 256, 330);
        cover.toBlob(done, "image/jpeg", 0.85);
      });
      const seeded = window.rhine.music.library.tracks;
      const blobs = [
        await makeCover("#c0392b", "#e74c3c", "红"),
        await makeCover("#2c3e50", "#3498db", "蓝"),
      ];
      for (let i = 0; i < Math.min(seeded.length, blobs.length); i++) {
        seeded[i].hasCover = true;
        await window.rhine.music.library.store.putCover(seeded[i].id, blobs[i]);
      }
      window.__kick = seeded.map((t) => ({ id: t.id, title: t.title, hasCover: t.hasCover, album: t.album }));
    })();
    return "ok";
  })()`,
    false,
    30000,
  );
  let built = null;
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const kick = await cdp
      .evaluate(`window.__kick`, false, 15000)
      .catch(() => null);
    if (Array.isArray(kick)) {
      built = kick;
      break;
    }
    if (i % 15 === 14)
      console.log(
        `  scan ${kick === "files" ? "running" : "building"} (${i + 1}s)`,
      );
  }
  if (!built) throw new Error("scan never finished");
  console.log("library:", JSON.stringify(built));
  const coverCheck = await cdp
    .evaluate(
      `(async () => {
    const track = window.rhine.music.library.tracks[0];
    if (!track) return { track: null };
    const stored = await window.rhine.music.library.store.cover(track.id);
    if (!stored) return { id: track.id, hasCover: track.hasCover, stored: null };
    const storedBytes = new Uint8Array(await stored.arrayBuffer());
    const url = URL.createObjectURL(stored);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      return { id: track.id, hasCover: track.hasCover, stored: { type: stored.type, size: stored.size }, decoded: { width: image.naturalWidth, height: image.naturalHeight } };
    } catch (error) {
      return { id: track.id, hasCover: track.hasCover, stored: { type: stored.type, size: stored.size }, decoded: false, error: String(error) };
    } finally { URL.revokeObjectURL(url); }
  })()`,
      true,
      30000,
    )
    .catch((error) => ({ error: error.message }));
  console.log("cover check:", JSON.stringify(coverCheck));
  const coverUrlCheck = await cdp
    .evaluate(
      `(async () => {
    const track = window.rhine.music.library.tracks[0];
    if (!track) return { track: null };
    const url = await window.rhine.music.library.coverUrl(track);
    const image = new Image(); image.src = url ?? "";
    try {
      await image.decode();
      return { url: url?.slice(0, 32), decoded: { width: image.naturalWidth, height: image.naturalHeight } };
    } catch (error) {
      return { url: url?.slice(0, 32), decoded: false, error: String(error) };
    }
  })()`,
      true,
      30000,
    )
    .catch((error) => ({ error: error.message }));
  console.log("cover URL check:", JSON.stringify(coverUrlCheck));

  const attempt = async (label, fn, tries = 3) => {
    for (let t = 0; t < tries; t++) {
      try {
        return await fn();
      } catch (e) {
        if (t === tries - 1) throw e;
        console.log(`  ${label}: retry ${t + 1} (${e.message})`);
        await sleep(1500);
      }
    }
  };
  // A click is not retry-safe: CDP may time out after dispatching it. Click
  // once, then poll state before considering another dispatch.
  const beforeMode = await cdp
    .evaluate(
      `(() => { const s = window.rhine.stats(); return { ready:s.ready, startup:s.startup, mode:s.libraryMode, tracks:s.music.tracks, label:document.querySelector('#library-mode-label')?.textContent, pressed:document.querySelector('[data-action="library-mode"]')?.getAttribute('aria-pressed') }; })()`,
      false,
      20000,
    )
    .catch((e) => ({ error: e.message }));
  console.log("before mode click:", JSON.stringify(beforeMode));
  if (beforeMode?.mode !== "music") {
    await cdp
      .evaluate(
        `(() => { const b=document.querySelector('[data-action="library-mode"]'); b?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return Boolean(b); })()`,
        false,
        20000,
      )
      .catch((e) => console.log(`mode click response: ${e.message}`));
  }
  let stats1 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    stats1 = await cdp
      .evaluate(
        `(() => { const s = window.rhine.stats(); return { mode: s.libraryMode, columns: s.columns, coverVisible: s.coverVisible, coverCount: s.coverCount, coverMapped: s.coverMapped, coverAttr: s.coverAttr, coverFilled: s.coverFilled, coverLoading: s.coverLoading, coverRequested: s.coverRequested, selected: s.selected, label: document.querySelector('#library-mode-label')?.textContent, pressed: document.querySelector('[data-action="library-mode"]')?.getAttribute('aria-pressed') }; })()`,
        false,
        20000,
      )
      .catch(() => null);
    if (stats1?.mode === "music") break;
  }
  if (stats1?.mode !== "music")
    throw new Error(`mode did not switch: ${JSON.stringify(stats1)}`);
  // The app may still be showing the opening cinematic even after startup is
  // ready; force the real archive mode so the scene update loop and cover atlas
  // are exercised rather than the static opening frame.
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  await sleep(1200);
  const navState = await attempt("nav state", () =>
    cdp.evaluate(
      `({ text: document.querySelector("#library-mode-label")?.textContent, pressed: document.querySelector('[data-action="library-mode"]')?.getAttribute("aria-pressed"), kind: window.rhine.stats().libraryMode })`,
      false,
      20000,
    ),
  );
  console.log("music mode:", JSON.stringify({ ...stats1, nav: navState }));
  // Let IndexedDB cover URLs decode and the atlas upload before capturing the array.
  await sleep(4000);
  const finalCoverState = await cdp
    .evaluate(
      `(() => { const s = window.rhine.stats(); return { filled: s.coverFilled, loading: s.coverLoading, requested: s.coverRequested, loadStarted: s.coverLoadStarted, loadSucceeded: s.coverLoadSucceeded, loadFailed: s.coverLoadFailed, loadError: s.coverLoadError, frameCalls: s.coverFrameCalls, visible: s.coverVisible, mapped: s.coverMapped, attr: s.coverAttr, selected: s.selected, activeKind: s.libraryMode, tracks: window.rhine.music.library.tracks.map(t => ({ id: t.id, hasCover: t.hasCover })) }; })()`,
      false,
      20000,
    )
    .catch((error) => ({ error: error.message }));
  console.log("final cover state:", JSON.stringify(finalCoverState));
  const shot1 = await attempt("shot array", () =>
    cdp.send("Page.captureScreenshot", { format: "png" }),
  );
  await writeFile(
    join(SHOTS, "probe-cover-array.png"),
    Buffer.from(shot1.data, "base64"),
  );

  await attempt("open detail", () =>
    cdp.evaluate(
      `window.rhine.archive(); document.querySelector('[data-action="open"]').click();`,
      false,
      20000,
    ),
  );
  await sleep(3500);
  const shot2 = await attempt("shot detail", () =>
    cdp.send("Page.captureScreenshot", { format: "png" }),
  );
  await writeFile(
    join(SHOTS, "probe-cover-detail.png"),
    Buffer.from(shot2.data, "base64"),
  );
  const calib = cdp.logs.filter((l) => l.includes("cover-calib"));
  console.log("calib:", calib.length ? "\n" + calib.join("\n") : "none");
  console.log("console tail:", cdp.logs.slice(-4).join(" | ") || "clean");
} catch (error) {
  console.log("probe error:", error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([stopProcessTree(edge), stopProcessTree(server)]);
  await sleep(800);
  await removeLocalDirectory(PROFILE).catch(() => {});
}
