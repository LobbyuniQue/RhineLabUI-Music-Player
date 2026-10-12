// Page + VLC bridge integration check (screenshots included).
//
// Panel previous/next and archive playback strictly verify the real bridge
// track IDs. Bridge disconnect/reconnect also verifies current UI/library state.
// Only the extra direct-play diagnostic remains informational: a headless
// software-rendered page can delay VLC playback under CPU load.
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
import {
  buildMusicFixtures,
  FIXTURE_ARTIST,
  sineWav,
} from "../lib/music-fixtures.mjs";
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
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
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
      const pending = { resolve, reject, timer: null };
      this.pending.set(id, pending);
      this.socket.send(JSON.stringify({ id, method, params }));
      pending.timer = setTimeout(() => {
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
      { expression, awaitPromise, returnByValue: true, userGesture: true },
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
let bridgeLog = "";
function startBridge() {
  const child = spawn(
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
      ...(process.env.RHINE_VLC_AOUT ? ["--aout", process.env.RHINE_VLC_AOUT] : []),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.on("data", (c) => (bridgeLog += c));
  child.stderr.on("data", (c) => (bridgeLog += c));
  return child;
}
let bridge = startBridge();
const server = spawn(
  process.execPath,
  [STATIC_SERVER, DIST, String(WEB_PORT), "--fixtures", MUSIC_ROOT],
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
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=420,300",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

let cdp;
let handoffStage = "not started";
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
  cdp = new Cdp(socket);
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

  const closeModal = async () => {
    await cdp.evaluate(`window.rhine.music.close()`, false, 20000);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const closed = await cdp.evaluate(
        `!document.querySelector('#modal-root [role="dialog"]')`,
        false,
        20000,
      );
      if (closed) return;
      await sleep(300);
    }
    throw new Error("Modal closing animation did not remove its dialog");
  };
  const nativeStatus = async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`VLC status HTTP ${response.status}`);
    return response.json();
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
    stored.reduced = false;
    delete stored.motion;
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

  const panelIds = await cdp.evaluate(
    `[...document.querySelectorAll('#music-results .result-row')].map(row => row.dataset.musicTrack)`,
    false,
  );
  const waitForPanelTrack = async (id) => {
    let current = null;
    let highlighted = "";
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(700);
      current = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(4000),
      })
        .then((response) => response.json())
        .catch(() => null);
      highlighted = await cdp
        .evaluate(
          `document.querySelector('#music-results .result-row.playing')?.dataset.musicTrack ?? ''`,
          false,
          20000,
        )
        .catch(() => "");
      if (current?.currentId === id && highlighted === id) break;
    }
    return {
      currentId: current?.currentId ?? null,
      highlighted,
      state: current?.state ?? "offline",
    };
  };
  const selectedIndex = 1;
  if (panelIds.length < 3)
    throw new Error("VLC direction fixtures require three visible tracks");
  await cdp.evaluate(
    `document.querySelector('#music-results .result-row[data-music-index="${selectedIndex}"]').click()`,
    false,
  );
  const selectedTrack = await waitForPanelTrack(panelIds[selectedIndex]);
  check(
    "音乐面板点击曲目通过真实 ID 选中 VLC",
    selectedTrack.currentId === panelIds[selectedIndex] &&
      selectedTrack.highlighted === panelIds[selectedIndex],
    JSON.stringify(selectedTrack),
  );
  await cdp.evaluate(
    `document.querySelector('[data-music="prev"]').click()`,
    false,
  );
  const previousTrack = await waitForPanelTrack(panelIds[selectedIndex - 1]);
  check(
    "VLC 上一首按钮沿检索结果向前移动",
    previousTrack.currentId === panelIds[selectedIndex - 1] &&
      previousTrack.highlighted === panelIds[selectedIndex - 1],
    JSON.stringify(previousTrack),
  );
  await cdp.evaluate(
    `document.querySelector('[data-music="next"]').click()`,
    false,
  );
  const nextTrack = await waitForPanelTrack(panelIds[selectedIndex]);
  check(
    "VLC 下一首按钮沿检索结果向后移动",
    nextTrack.currentId === panelIds[selectedIndex] &&
      nextTrack.highlighted === panelIds[selectedIndex],
    JSON.stringify(nextTrack),
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
  // The large viewport is for the screenshot; use the normal test viewport
  // while waiting for full-motion animation under software rendering.
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  // 2.3: ACCESS FILE from a music archive must route the selected real bridge id
  // to VLC, not the synthetic M-### archive display id.
  await closeModal();
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
    `(() => {
      const selected = document.querySelector('#file-ticks [aria-pressed="true"]');
      const label = selected?.title ?? '';
      const title = label.replace(/^M-\\d+\\s*·\\s*/, '');
      const matches = window.rhine.music.library.tracks.filter(track => track.bridge && track.title === title);
      return { id: matches.length === 1 ? matches[0].id : '', title, label, matches: matches.length };
    })()`,
    false,
    20000,
  );
  // Archive order is grouped/sorted separately from the bridge catalogue.
  // Resolve the currently selected visible archive title, not catalogue[0].
  if (!archiveTarget.id || archiveTarget.matches !== 1)
    throw new Error(
      `ambiguous selected music archive: ${JSON.stringify(archiveTarget)}`,
    );
  await cdp.evaluate(`window.rhine.music.bridgeStop()`, true, 60000);
  let beforeArchive = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    beforeArchive = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(4000),
    })
      .then((response) => response.json())
      .catch(() => null);
    if (beforeArchive?.state === "stopped" && beforeArchive.currentId === null)
      break;
  }
  if (beforeArchive?.state !== "stopped" || beforeArchive.currentId !== null)
    throw new Error(
      `previous VLC playback did not stop: ${JSON.stringify(beforeArchive)}`,
    );
  await cdp.evaluate(
    `(() => {
      window.__vlcStartFrames=[]; window.__originalFetch=window.fetch;
      window.fetch=function(...args) {
        if (String(args[0]).includes('/api/start?')) window.__vlcStartFrames.push({
          masks:document.querySelectorAll('#detail-content .document-redaction-window').length,
          access:window.rhine.music.access(), motion:window.rhine.stats().motion });
        return window.__originalFetch.apply(this,args);
      };
      document.querySelector('.read-file[data-action="open"]')?.click();
    })()`,
    false,
    20000,
  );
  let archiveStatus = null;
  let archiveProgress = null;
  // Preparation, the complete reveal, and start each retain their real checks.
  // Use a total deadline, and preserve the first error instead of cascading
  // through the remaining controls after an unsuccessful preparation.
  const archiveDeadline = Date.now() + 180000;
  let nextArchiveLog = 0;
  while (Date.now() < archiveDeadline) {
    await sleep(1000);
    archiveStatus = await nativeStatus();
    archiveProgress = await cdp.evaluate(`(() => {
      const access=window.rhine.music.access(), bridge=window.rhine.music.bridge(), stats=window.rhine.stats();
      return {access:access.phase,error:access.error,connected:bridge.connected,bridgeError:bridge.error,
        decryption:stats.decryption?.phase,decryptionTime:stats.decryption?.time,
        fps:stats.fps,frames:stats.renderedFrames,reusedFrames:stats.reusedFrames,
        masks:document.querySelectorAll('#detail-content .document-redaction-window').length,hidden:document.hidden};
    })()`,false,20000);
    if (Date.now() >= nextArchiveLog || archiveProgress.access === "error") {
      console.log("archive animation:",JSON.stringify(archiveProgress));
      nextArchiveLog = Date.now() + 10000;
    }
    if (archiveProgress.access === "error") break;
    if (
      archiveStatus.currentId === archiveTarget.id &&
      (archiveStatus.state === "playing" || archiveStatus.time > 0.4) &&
      archiveProgress.access === "playing" && !archiveProgress.error
    )
      break;
  }
  const openedArchiveTitle = await cdp.evaluate(
    `document.querySelector('#detail-ui h2')?.textContent?.trim() ?? ''`,
    false,
    20000,
  );
  check(
    "音乐档案 ACCESS FILE 通过真实曲目 ID 播放 VLC",
    archiveStatus?.currentId === archiveTarget.id &&
      (archiveStatus?.state === "playing" || archiveStatus?.time > 0.4) &&
      archiveProgress?.access === "playing" && !archiveProgress?.error &&
      openedArchiveTitle === archiveTarget.title,
    JSON.stringify({
      archiveTarget,
      beforeArchive,
      archiveStatus,
      archiveProgress,
      openedArchiveTitle,
    }),
  );
  const vlcStartFrames=await cdp.evaluate(`(() => { window.fetch=window.__originalFetch; return window.__vlcStartFrames; })()`,false,20000);
  check("完整揭示动画结束帧发送 VLC 起播请求", vlcStartFrames.length===1 && vlcStartFrames[0].masks===0 &&
    vlcStartFrames[0].access.phase==="starting" && vlcStartFrames[0].access.startFrame>0 &&
    vlcStartFrames[0].motion.preset==="full", JSON.stringify(vlcStartFrames));
  if (results.some((result) => !result.ok))
    throw new Error(`VLC archive playback failed: ${JSON.stringify({ archiveStatus, archiveProgress })}`);

  // The complete detail reveal has been verified. Return through the normal
  // animation while exercising the remaining controls, so the browser engine
  // handoff starts from the same archive surface as the browser-only suite.
  await cdp.evaluate(`window.rhine.archive()`,false,20000);

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

  await closeModal();
  await cdp.evaluate(`document.querySelector('[data-action="settings"]').click()`,false,20000);
  await sleep(900);
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

  // Stop only this harness's bridge + VLC process tree. The page must release
  // BGM suppression and remain on the chosen VLC engine while reconnecting.
  await stopProcessTree(bridge);
  let offline = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    offline = await cdp
      .evaluate(
        `(() => {
      const bridge = window.rhine.music.bridge();
      return {
        connected: bridge.connected, engine: bridge.engine, state: bridge.status,
        localMusic: window.rhine.stats().audio.localMusic,
        display: document.querySelector('.music-bridge-status')?.textContent?.trim() ?? '',
        idle: document.querySelector('.music-bridge-status')?.classList.contains('idle') ?? false,
      };
    })()`,
        false,
        20000,
      )
      .catch(() => null);
    if (
      offline &&
      !offline.connected &&
      offline.state === null &&
      !offline.localMusic &&
      offline.idle
    )
      break;
  }
  check(
    "桥接进程停止后页面报告断线并恢复背景配乐",
    offline?.connected === false &&
      offline?.engine === "vlc" &&
      offline?.state === null &&
      offline?.localMusic === false &&
      offline?.idle === true &&
      Boolean(offline?.display),
    JSON.stringify(offline),
  );

  // A changed catalogue makes this assertion prove that automatic reconnect
  // actually reloads the library rather than merely reopening EventSource.
  const reconnectName = "06 自动重连更新.wav";
  await writeFile(join(MUSIC_ROOT, reconnectName), sineWav(6, 880));
  const previousStart = health?.vlc?.startedAt;
  bridge = startBridge();
  let reconnected = null;
  for (let i = 0; i < 80; i++) {
    await sleep(700);
    reconnected = await cdp
      .evaluate(
        `(() => {
      const bridge = window.rhine.music.bridge();
      const tracks = window.rhine.music.library.tracks;
      return {
        connected: bridge.connected, engine: bridge.engine,
        startedAt: bridge.health?.vlc?.startedAt ?? 0,
        healthTracks: bridge.health?.tracks ?? 0, tracks: tracks.length,
        added: tracks.some(track => track.name === ${JSON.stringify(reconnectName)} && track.bridge),
        connectedDisplay: document.querySelector('.music-bridge-status')?.classList.contains('ok') ?? false,
      };
    })()`,
        false,
        20000,
      )
      .catch(() => null);
    if (
      reconnected?.connected &&
      reconnected.tracks === expected + 1 &&
      reconnected.added &&
      reconnected.connectedDisplay
    )
      break;
  }
  check(
    "桥接重启后自动重连并载入更新曲库",
    reconnected?.connected === true &&
      reconnected?.engine === "vlc" &&
      reconnected?.startedAt !== previousStart &&
      reconnected?.healthTracks === expected + 1 &&
      reconnected?.tracks === expected + 1 &&
      reconnected?.added === true &&
      reconnected?.connectedDisplay === true,
    JSON.stringify(reconnected),
  );

  await closeModal();
  await cdp.evaluate(`window.rhine.music.open()`,false,20000);
  let restoredPanel = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    restoredPanel = await cdp
      .evaluate(
        `({ rows: document.querySelectorAll('#music-results .result-row').length, engine: document.querySelector('#music-engine-label')?.textContent ?? '' })`,
        false,
        20000,
      )
      .catch(() => null);
    if (
      restoredPanel?.rows === expected + 1 &&
      /VLC.*CONNECTED/.test(restoredPanel.engine)
    )
      break;
  }
  check(
    "自动重连后音乐面板显示刷新曲库与 VLC 内核",
    restoredPanel?.rows === expected + 1 &&
      /VLC.*CONNECTED/.test(restoredPanel?.engine ?? ""),
    JSON.stringify(restoredPanel),
  );

  const mediaTrackId = await cdp.evaluate(
    `window.rhine.music.library.tracks.find(t=>t.codec==='mp3')?.id`,false,20000);
  const mediaStarted = await cdp.evaluate(
    `window.rhine.music.bridgePlay(${JSON.stringify(mediaTrackId)})`,true,60000);
  if (mediaStarted?.state !== "playing" || mediaStarted.currentId !== mediaTrackId) {
    const bridge = await cdp.evaluate(`window.rhine.music.bridge()`,false,20000);
    throw new Error(`Media-key setup did not start VLC: ${JSON.stringify({ mediaStarted, bridge })}`);
  }
  const mediaSeek = await cdp.evaluate(`window.rhine.music.bridgeSeek(3)`,true,20000);
  if (!mediaSeek) throw new Error("Media-key setup did not acknowledge the seek");
  const paused = await cdp.evaluate(`(async () => {
    await window.rhine.music.mediaAction('pause'); return window.rhine.music.bridge().status;
  })()`,true,20000);
  const resumed = await cdp.evaluate(`(async () => {
    await window.rhine.music.mediaAction('play'); return window.rhine.music.bridge().status;
  })()`,true,40000);
  const browserPlaying = await cdp.evaluate(`window.rhine.music.player.state().playing`,false,20000);
  const mediaResume = { id: mediaTrackId, paused, resumed, browser: browserPlaying };
  check("系统媒体键路由 VLC，暂停后继续保留进度", mediaResume.paused?.state === "paused" &&
    mediaResume.resumed?.state === "playing" && mediaResume.resumed.currentId === mediaResume.id &&
    mediaResume.resumed.time >= 2 && !mediaResume.browser,JSON.stringify(mediaResume));

  const toBrowser=await cdp.evaluate(`(async()=>{
    const m=window.rhine.music; const switched=await m.setEngine('browser');
    return {switched,engine:m.bridge().engine,playing:m.player.state().playing};
  })()`,true,60000);
  const vlcAfterSwitch=await nativeStatus();
  check("VLC 切浏览器前停止旧输出",toBrowser.switched && toBrowser.engine === "browser" &&
    !toBrowser.playing && vlcAfterSwitch.state === "stopped",JSON.stringify({toBrowser,vlcAfterSwitch}));
  if (!toBrowser.switched || toBrowser.engine !== "browser" || vlcAfterSwitch.state !== "stopped")
    throw new Error(`VLC handoff did not stop the old output: ${JSON.stringify({ toBrowser, vlcAfterSwitch })}`);
  await closeModal();
  handoffStage = "waiting for archive return";
  console.log("handoff:", handoffStage);
  const returnDeadline = Date.now() + 120000;
  let returnState = null;
  while (Date.now() < returnDeadline) {
    returnState = await cdp.evaluate(`(() => {
      const stats=window.rhine.stats();
      return {mode:stats.mode,cameraDetail:stats.cameraDetail,extraction:stats.extraction,
        returningFiles:stats.returningFiles,motion:stats.motion,
        modal:!!document.querySelector('#modal-root [role="dialog"]')};
    })()`,false,20000);
    if (returnState.mode === "archive" && returnState.cameraDetail < .01 &&
        returnState.extraction <= .41 && returnState.returningFiles === 0 && !returnState.modal)
      break;
    await sleep(1000);
  }
  console.log("handoff archive:",JSON.stringify(returnState));
  if (returnState?.mode !== "archive" || !(returnState.cameraDetail < .01) ||
      !(returnState.extraction <= .41) || returnState.returningFiles !== 0 || returnState.modal ||
      returnState.motion.preset !== "full")
    throw new Error(`Archive return did not finish before handoff: ${JSON.stringify(returnState)}`);
  handoffStage = "indexing browser fixture";
  console.log("handoff:", handoffStage);
  const handoffId=await cdp.evaluate(`(async()=>{
    const m=window.rhine.music;
    const bytes=Uint8Array.from(atob(${JSON.stringify(sineWav(90,440,8000).toString('base64'))}),char=>char.charCodeAt(0));
    await m.useFiles([new File([bytes],'handoff.wav',{type:'audio/wav'})]);
    return m.library.tracks[0]?.id;
  })()`,true,60000);
  if (!handoffId) throw new Error("Browser handoff fixture was not indexed");
  handoffStage = "starting browser fixture";
  console.log("handoff:", handoffStage);
  // A fresh user gesture reaches player.prepare before its first await;
  // indexing the file in an earlier CDP call cannot consume that gesture.
  // Observe file resolution, context state and real media events without
  // changing the player's preparation deadline or its readiness requirement.
  await cdp.evaluate(`(() => {
    const player=window.rhine.music.player, element=player.element, began=performance.now();
    const trace=window.__handoffPlayback={done:false,started:false,fileResolved:false,samples:[]};
    const record=phase=>{
      trace.samples.push({phase,ms:Math.round(performance.now()-began),context:player.context?.state ?? null,
        readyState:element.readyState,networkState:element.networkState,
        hasSource:!!element.src,mediaError:element.error?.code ?? null});
    };
    const originalResolve=player.hooks.resolve;
    const resolve=id=>originalResolve(id).then(file=>{
      trace.fileResolved=!!file; record('file-resolved'); return file;
    });
    player.hooks.resolve=resolve;
    const events=['loadstart','loadedmetadata','loadeddata','canplay','playing','error','stalled'];
    const listeners=events.map(name=>[name,()=>record(name)]);
    listeners.forEach(([name,listener])=>element.addEventListener(name,listener));
    record('begin');
    const playback=player.play(window.rhine.music.library.tracks.find(t=>t.id===${JSON.stringify(handoffId)}));
    const signal=player.preparationAbort?.signal;
    const aborted=()=>record('prepare-aborted');
    signal?.addEventListener('abort',aborted,{once:true});
    playback.then(started=>{trace.started=started;trace.state=player.state();},error=>{trace.error=String(error);}).finally(()=>{
      record('finished'); trace.done=true;
      if (player.hooks.resolve===resolve) player.hooks.resolve=originalResolve;
      listeners.forEach(([name,listener])=>element.removeEventListener(name,listener));
      signal?.removeEventListener('abort',aborted);
    });
  })()`,false,20000);
  const playbackDeadline = Date.now() + 60000;
  let playback = null;
  while (Date.now() < playbackDeadline) {
    playback = await cdp.evaluate(`window.__handoffPlayback`,false,20000);
    if (playback?.done) break;
    await sleep(1000);
  }
  console.log("handoff playback:",JSON.stringify(playback));
  if (!playback?.done || !playback.started || !playback.state?.playing)
    throw new Error(`Browser handoff fixture did not play: ${JSON.stringify(playback)}`);
  handoffStage = "switching back to VLC";
  console.log("handoff:", handoffStage);
  const toVlc=await cdp.evaluate(`(async()=>{
    const m=window.rhine.music;
    const before=m.player.state().playing;
    const switched=await m.setEngine('vlc');
    return {before,switched,engine:m.bridge().engine,browser:m.player.state().playing,
      bridgeTracks:m.library.tracks.filter(t=>t.bridge).length};
  })()`,true,90000);
  check("浏览器切 VLC 前停止旧输出并恢复桥接曲库",toVlc.before && toVlc.switched &&
    toVlc.engine === "vlc" && !toVlc.browser && toVlc.bridgeTracks === expected+1,JSON.stringify(toVlc));

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length)
    console.log("failed:", failed.map((f) => f.name).join("; "));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.log("harness error:", error.message, "handoff:", handoffStage);
  if (cdp) {
    const diagnostic = await cdp.evaluate(`(() => {
      const m=window.rhine.music,b=m.bridge();
      return {player:m.player.state(),access:m.access(),engine:b.engine,connected:b.connected,error:b.error,
        bridgeStatus:b.status,tracks:m.library.tracks.map(t=>({id:t.id,name:t.name,bridge:t.bridge})),
        scene:window.rhine.stats().mode,modal:!!document.querySelector('#modal-root [role="dialog"]'),
        handoffPlayback:window.__handoffPlayback ?? null};
    })()`,false,15000).catch(error => ({ error: error.message }));
    console.log("page failure state:",JSON.stringify(diagnostic));
  }
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
