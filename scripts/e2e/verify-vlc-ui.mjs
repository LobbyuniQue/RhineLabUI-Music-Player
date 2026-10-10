// Page + VLC bridge integration check (screenshots included).
//
// Transport playback through VLC is verified separately against the bridge API
// (see scripts/diagnostics/bridge-test.mjs / bridge-isolate.mjs): starting VLC while a headless
// software-rendered page saturates the CPU is an environment artefact, not a
// product behaviour, so it is reported here as informational only.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROJECT_ROOT,
  DIST_DIR,
  SHOTS_DIR,
  VLC_FIXTURES,
  STATIC_SERVER,
  BROWSER,
  profilePath,
  resetLocalDirectory,
  removeLocalDirectory,
  requireE2EEnvironment,
} from "../lib/workspace-paths.mjs";
import { buildMusicFixtures, FIXTURE_ARTIST } from "../lib/music-fixtures.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";

const ROOT = PROJECT_ROOT;
const DIST = DIST_DIR;
const SHOTS = SHOTS_DIR;
const MUSIC_ROOT = VLC_FIXTURES;
const PORT = 8801;
const TOKEN = "uicheck";
const WEB_PORT = 4190;
const DEBUG_PORT = 9336;
const EDGE = BROWSER;
const PROFILE = profilePath("vlc");

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run test:e2e:vlc
Requires npm run build, VLC, and Edge/Chrome; RHINE_BROWSER overrides the browser path.
Fixtures and screenshots are stored in .local/.`);
  process.exit(0);
}
requireE2EEnvironment();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

async function connect(debugPort) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      ).json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("no debug target");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
    });
  }
  async evaluate(expression, awaitPromise = true, timeoutMs = 60000) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      timeoutMs,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? "evaluate failed",
      );
    return result.result.value;
  }
}

await mkdir(SHOTS, { recursive: true });
// Same reason as verify-music.mjs: a stale profile can serve an older build.
await resetLocalDirectory(PROFILE);
await buildMusicFixtures(MUSIC_ROOT);
const bridge = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    join(ROOT, "scripts", "vlc-bridge.mjs"),
    "--root",
    MUSIC_ROOT,
    "--port",
    String(PORT),
    "--token",
    TOKEN,
  ],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let bridgeLog = "";
bridge.stdout.on("data", (c) => (bridgeLog += c));
bridge.stderr.on("data", (c) => (bridgeLog += c));
const server = spawn(
  process.execPath,
  [STATIC_SERVER, DIST, String(WEB_PORT)],
  { stdio: "ignore", windowsHide: true },
);
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--disable-crash-reporter",
    "--disable-extensions",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=420,300",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

try {
  let health = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      health = await (
        await fetch(`http://127.0.0.1:${PORT}/api/health`)
      ).json();
      if (health.ready) break;
    } catch {}
  }
  check(
    "桥接服务就绪（VLC 已启动）",
    health?.ready === true && Boolean(health?.vlc?.version),
    `vlc ${health?.vlc?.version} · ${health?.tracks} 首`,
  );

  const socket = new WebSocket(await connect(DEBUG_PORT));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const cdp = new Cdp(socket);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const load = async () => {
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${WEB_PORT}/?review=1`,
    });
    for (let i = 0; i < 120; i++) {
      await sleep(300);
      const ready = await cdp
        .evaluate(
          "Boolean(window.rhine && window.rhine.stats().ready)",
          false,
          20000,
        )
        .catch(() => false);
      if (ready) return true;
    }
    return false;
  };

  check("页面就绪", await load());
  await cdp.evaluate(
    `(() => {
    const stored = JSON.parse(localStorage.getItem("rhine-settings") || "{}");
    stored.musicEngine = "vlc";
    stored.vlcPort = ${PORT};
    stored.vlcToken = ${JSON.stringify(TOKEN)};
    stored.musicReactive = true;
    stored.superPerformance = true;
    localStorage.setItem("rhine-settings", JSON.stringify(stored));
    return true;
  })()`,
    false,
  );
  check("切换到 VLC 内核并重新载入", await load());

  let info = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    info = await cdp
      .evaluate(
        `(() => { const b = window.rhine.music.bridge(); return { connected: b.connected, engine: b.engine, root: b.health?.root ?? "", error: b.error, tracks: window.rhine.music.library.tracks.length }; })()`,
        false,
        20000,
      )
      .catch(() => null);
    if (info?.connected && info.tracks > 0) break;
  }
  console.log("bridge view:", JSON.stringify(info));
  // Expectations follow the bridge's own catalogue, so adding or removing test
  // files never invalidates the check.
  const expected = health.tracks;
  check(
    "页面自动连接 VLC 内核并载入桥接曲库",
    info?.connected === true && info?.tracks === expected,
    `${info?.root} · ${expected} 首`,
  );

  const library = await cdp.evaluate(
    `({
    bridgeTracks: window.rhine.music.library.tracks.filter(t => t.bridge).length,
    artist: window.rhine.music.search(${JSON.stringify(FIXTURE_ARTIST)}).length,
    chinese: window.rhine.music.search("正弦").length,
  })`,
    false,
  );
  check(
    "桥接曲库可检索（含中文与标签艺术家）",
    library.bridgeTracks === expected &&
      library.artist >= 1 &&
      library.chinese >= 1,
    JSON.stringify(library),
  );

  await cdp.evaluate(
    `(async () => { window.rhine.music.open(); await new Promise(r => setTimeout(r, 900)); return true; })()`,
    true,
    40000,
  );
  const panel = await cdp.evaluate(
    `({
    rows: document.querySelectorAll(".result-row").length,
    status: document.querySelector("#music-status")?.innerText.replace(/\\s+/g, " ").trim(),
    engine: document.querySelector("#music-engine-label")?.innerText.replace(/\\s+/g, " ").trim() ?? "",
    count: document.querySelector("#music-result-count")?.innerText ?? "",
  })`,
    false,
  );
  check(
    "音乐面板沿用档案检索结构（内核与曲库可见）",
    panel.rows === expected && /VLC 内核/.test(panel.engine),
    `${panel.engine} · ${panel.count} · ${panel.status}`,
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
  const panelShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(SHOTS, "music-panel-vlc.png"),
    Buffer.from(panelShot.data, "base64"),
  );

  // 2.3: ACCESS FILE from a music archive must route the selected real bridge id
  // to VLC, not the synthetic M-### archive display id.
  await cdp.evaluate(`window.rhine.music.close()`, false, 20000);
  await sleep(500);
  await cdp.evaluate(
    `document.querySelector('[data-action="library-mode"]').click()`,
    false,
    20000,
  );
  await sleep(900);
  await cdp.evaluate(
    `window.rhine.archive(); window.rhine.select(0)`,
    false,
    20000,
  );
  const archiveTarget = await cdp.evaluate(
    `(() => { const track = window.rhine.music.library.tracks[0]; return { id: track?.id ?? "", title: track?.title ?? "" }; })()`,
    false,
    20000,
  );
  await cdp.evaluate(
    `document.querySelector('.read-file[data-action="open"]')?.click()`,
    false,
    20000,
  );
  let archiveStatus = null;
  for (let i = 0; i < 35; i++) {
    await sleep(1000);
    archiveStatus = await (
      await fetch(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    if (
      archiveStatus.currentId === archiveTarget.id &&
      (archiveStatus.state === "playing" || archiveStatus.time > 0.4)
    )
      break;
  }
  check(
    "音乐档案 ACCESS FILE 通过真实曲目 ID 播放 VLC",
    archiveStatus?.currentId === archiveTarget.id &&
      (archiveStatus?.state === "playing" || archiveStatus?.time > 0.4),
    JSON.stringify({ archiveTarget, archiveStatus }),
  );

  // Informational: issue another direct play and report what VLC does while the headless
  // page keeps rendering (this environment can starve VLC; bridge-only tests remain authoritative).
  const targetId = await cdp.evaluate(
    `window.rhine.music.library.tracks.find(t => /60Hz/.test(t.name))?.id ?? ""`,
    false,
  );
  await cdp
    .evaluate(
      `window.rhine.music.bridgePlay(${JSON.stringify(targetId)})`,
      true,
      60000,
    )
    .catch(() => null);
  let state = "stopped";
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const status = await (
      await fetch(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    state = status.state;
    if (state === "playing") break;
  }
  console.log(`informational: VLC state under headless load = ${state}`);
  const playingShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    join(SHOTS, "music-panel-vlc-playing.png"),
    Buffer.from(playingShot.data, "base64"),
  );

  await cdp.evaluate(
    `(async () => {
    window.rhine.music.close();
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('[data-action="settings"]').click();
    await new Promise(r => setTimeout(r, 900));
    return true;
  })()`,
    true,
    40000,
  );
  const settings = await cdp.evaluate(
    `(() => {
    const block = document.querySelector("[data-music-settings]");
    return {
      hasBlock: Boolean(block),
      status: block?.querySelector(".music-bridge-status")?.textContent?.trim() ?? "",
      engine: block?.querySelector('[data-music-engine="vlc"]')?.getAttribute("aria-pressed"),
    };
  })()`,
    false,
  );
  check(
    "设置面板显示播放内核与桥接状态",
    settings.hasBlock === true &&
      settings.engine === "true" &&
      /已连接/.test(settings.status),
    settings.status,
  );

  const rhythm = await cdp.evaluate(
    `(() => {
    const block = document.querySelector("[data-music-settings]");
    return {
      buttons: [...block.querySelectorAll("[data-music-rhythm]")].map(b => b.dataset.musicRhythm),
      active: block.querySelector('[data-music-rhythm][aria-pressed="true"]')?.dataset.musicRhythm ?? "",
      stats: window.rhine.stats().music.rhythm,
    };
  })()`,
    false,
  );
  check(
    "律动方式含宽频/高频微光并为新装默认",
    rhythm.buttons.join(",") ===
      "legacy,wave,lift,pulse,ripple,groove,shimmer" &&
      rhythm.active === "ripple" &&
      rhythm.stats === "ripple",
    JSON.stringify(rhythm),
  );

  await cdp.evaluate(
    `document.querySelector('[data-music-rhythm="wave"]').click()`,
    true,
    20000,
  );
  const switched = await cdp.evaluate(
    `window.rhine.stats().music.rhythm`,
    false,
    20000,
  );
  check("律动方式可切换并持久化", switched === "wave", `→ ${switched}`);
  await cdp.evaluate(
    `document.querySelector('[data-music-rhythm="ripple"]').click()`,
    true,
    20000,
  );

  const settingsShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    join(SHOTS, "music-settings-vlc.png"),
    Buffer.from(settingsShot.data, "base64"),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length)
    console.log("failed:", failed.map((f) => f.name).join("; "));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.log("harness error:", error.message);
  console.log("bridge log tail:", bridgeLog.split("\n").slice(-6).join("\n"));
  process.exitCode = 1;
} finally {
  await Promise.all([
    stopProcessTree(edge),
    stopProcessTree(server),
    stopProcessTree(bridge),
  ]);
  await removeLocalDirectory(PROFILE).catch(() => {});
}
