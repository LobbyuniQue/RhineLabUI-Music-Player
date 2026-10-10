// Local music end-to-end verification harness.
//
// Drives the *built* application in headless Edge over the Chrome DevTools
// Protocol: injects a session library made from the project score and test tones,
// scans it, searches, plays, and captures screenshots. No extra npm
// dependencies — Node's global WebSocket talks to CDP directly.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DIST_DIR,
  SHOTS_DIR,
  BROWSER_FIXTURES,
  STATIC_SERVER,
  BROWSER,
  profilePath,
  resetLocalDirectory,
  removeLocalDirectory,
  requireE2EEnvironment,
} from "../lib/workspace-paths.mjs";
import {
  buildMusicFixtures,
  FIXTURE_PATHS,
  FIXTURE_ARTIST,
} from "../lib/music-fixtures.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";

const DIST = DIST_DIR;
const FIXTURES = BROWSER_FIXTURES;
const SHOTS = SHOTS_DIR;
const PORT = 4188;
const DEBUG_PORT = 9333;
const EDGE = BROWSER;
const PROFILE = profilePath("music");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(" ");
        this.logs.push(`${message.params.type}: ${text}`.slice(0, 300));
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.logs.push(
          `exception: ${message.params.exceptionDetails?.exception?.description?.slice(0, 300)}`,
        );
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 90000) {
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
  async evaluate(expression, awaitPromise = true, timeoutMs = 90000) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result.value;
  }
}

async function waitForJson(url, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run test:e2e:music
Requires npm run build and Edge/Chrome; RHINE_BROWSER overrides the browser path.
Fixtures and screenshots are stored in .local/.`);
  process.exit(0);
}
requireE2EEnvironment();

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

await mkdir(SHOTS, { recursive: true });
// A leftover profile can hold a service worker that keeps serving the previous
// build; always start from a clean one (cleanup at the end stays as well).
await resetLocalDirectory(PROFILE);
await buildMusicFixtures(FIXTURES);
console.log("fixtures ready");

const server = spawn(
  process.execPath,
  [STATIC_SERVER, DIST, String(PORT), "--fixtures", FIXTURES],
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
    "--disable-crash-reporter",
    "--disable-extensions",
    // Emulate a visible page: pausing the only audio otherwise lets Chrome
    // throttle the occluded headless page and stall rAF-driven ticks.
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

try {
  const targets = await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const cdp = new Cdp(socket);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const load = async () => {
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${PORT}/?review=1`,
    });
    for (let i = 0; i < 120; i++) {
      await sleep(300);
      const ready = await cdp
        .evaluate(
          "Boolean(window.rhine && window.rhine.stats().ready)",
          false,
          15000,
        )
        .catch(() => false);
      if (ready) return true;
    }
    return false;
  };

  check("应用就绪（review 模式）", await load());

  // One helper in page scope, then one fetch per call: a single evaluate with
  // four fetches starves under software rendering.
  await cdp.evaluate(
    `(() => {
    window.__files = [];
    window.__fetchFixture = async (path) => {
      const response = await fetch("/__fixtures/" + path.split("/").map(encodeURIComponent).join("/"));
      if (!response.ok) return "HTTP " + response.status;
      const blob = await response.blob();
      // Fixed mtime: reuse detection keys on size+modified, and a default-now
      // stamp would force a full re-parse on every injected rescan.
      const file = new File([blob], path.split("/").pop(), { type: blob.type || "audio/mpeg", lastModified: 1759600000000 });
      Object.defineProperty(file, "webkitRelativePath", { value: "本地音乐/" + path });
      window.__files.push(file);
      return file.name + ":" + file.size;
    };
    return true;
  })()`,
    false,
    30000,
  );
  const fetched = [];
  for (const path of FIXTURE_PATHS) {
    const entry = await cdp.evaluate(
      `window.__fetchFixture(${JSON.stringify(path)})`,
      true,
      60000,
    );
    fetched.push(entry);
    console.log("  fetched", entry);
  }
  check(
    "测试曲库文件可读取",
    fetched.length === FIXTURE_PATHS.length &&
      fetched.every((f) => !String(f).startsWith("HTTP")),
    `${fetched.length} files`,
  );

  // Library-level scan (bypasses the panel to isolate failures).
  const report = await cdp.evaluate(
    `(async () => {
    window.rhine.music.library.useFiles(window.__files);
    const progress = [];
    const report = await window.rhine.music.library.scan((p) => progress.push(p.phase + ":" + p.seen + ":" + p.parsed));
    return { report, progress: progress.slice(-4) };
  })()`,
    true,
    180000,
  );
  check(
    "扫描并建立索引",
    report.report.total === FIXTURE_PATHS.length && report.report.failed === 0,
    `total=${report.report.total} added=${report.report.added} reused=${report.report.reused} failed=${report.report.failed} ${report.report.ms}ms phases=${report.progress.join(",")}`,
  );

  const library = await cdp.evaluate(
    `window.rhine.music.library.tracks.map(t => ({ title: t.title, artist: t.artist, album: t.album, codec: t.codec, duration: Math.round(t.duration || 0), track: t.track }))`,
    false,
  );
  console.log("library:", JSON.stringify(library));
  const N = library.length;
  check(
    "标签解析（标题/艺术家/时长/编号）",
    library.length >= 4 &&
      library.some((t) => t.artist === FIXTURE_ARTIST) &&
      library.every((t) => t.title && t.duration > 1),
    `${N} tracks`,
  );

  const search = await cdp.evaluate(
    `({
    business: window.rhine.music.search("business").map(t => t.title),
    chinese: window.rhine.music.search("正弦").length,
    trackNo: window.rhine.music.search("02").map(t => t.title),
    artist: window.rhine.music.search(${JSON.stringify(FIXTURE_ARTIST)}).length,
    miss: window.rhine.music.search("zzzz").length,
  })`,
    false,
  );
  console.log("search:", JSON.stringify(search));
  check(
    "检索（英文/中文/编号/艺术家/空结果）",
    search.business.length >= 1 &&
      search.chinese >= 2 &&
      search.trackNo.length >= 1 &&
      search.artist >= 1 &&
      search.miss === 0,
  );

  await cdp.evaluate(
    `(async () => { window.rhine.music.open(); await new Promise(r => setTimeout(r, 900)); return true; })()`,
    true,
    30000,
  );
  const panel = await cdp.evaluate(
    `({
    rows: document.querySelectorAll(".result-row").length,
    status: document.querySelector("#music-status")?.innerText.replace(/\\s+/g, " ").trim(),
    empty: Boolean(document.querySelector(".music-empty")),
    focus: document.activeElement?.id ?? "",
  })`,
    false,
  );
  console.log("panel:", JSON.stringify(panel));
  check(
    "面板渲染结果列表",
    panel.rows === N && !panel.empty,
    `${panel.rows} rows · ${panel.status}`,
  );
  check("检索框自动获得焦点", panel.focus === "music-search", panel.focus);

  const keyboard = await cdp.evaluate(
    `(() => {
    const input = document.querySelector("#music-search");
    input.focus();
    const send = (key) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    send("ArrowDown"); send("ArrowDown");
    return { cursor: document.querySelector(".result-row.cursor")?.dataset.musicIndex, playing: Boolean(document.querySelector(".result-row.playing")) };
  })()`,
    false,
  );
  check("键盘上下选择结果", keyboard.cursor === "1", JSON.stringify(keyboard));

  const typed = await cdp.evaluate(
    `(async () => {
    const input = document.querySelector("#music-search");
    input.value = "正弦";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { rows: document.querySelectorAll(".result-row").length, marks: document.querySelectorAll(".result-row mark").length };
  })()`,
    true,
    30000,
  );
  check(
    "输入即时过滤并高亮",
    typed.rows >= 2 && typed.marks >= 1,
    JSON.stringify(typed),
  );

  await cdp.evaluate(
    `(() => { const i = document.querySelector("#music-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
    false,
  );
  await sleep(400);
  // Widen the page only for the capture: software rendering at 1600x1000 slows
  // the page far too much for the interaction steps above.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
  const lightShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(SHOTS, "music-panel-light.png"),
    Buffer.from(lightShot.data, "base64"),
  );

  // Loop the current track: the tone files are six seconds long, and under
  // software rendering the poll loop is slow enough for list mode to rotate
  // into a different song mid-assertion.
  await cdp.evaluate(
    `window.rhine.music.player.setMode("single")`,
    false,
    20000,
  );
  const playAndWait = async (id, label) => {
    await cdp.evaluate(
      `window.rhine.music.play(${JSON.stringify(id)})`,
      false,
      30000,
    );
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      const state = await cdp
        .evaluate(
          `(() => { const s = window.rhine.music.player.state(); if (s.id !== ${JSON.stringify(id)}) return { wrong: s.id }; return { playing: s.playing, loading: s.loading, position: s.position, bands: window.rhine.music.bands(), motion: window.rhine.stats().motion }; })()`,
          false,
          20000,
        )
        .catch(() => null);
      if (
        state &&
        state.playing &&
        !state.loading &&
        state.position > 0.4 &&
        state.bands.activity > 0.5
      )
        return state;
      if (i === 29) return state ?? { error: "no state" };
      console.log(
        `  ${label}: waiting (${JSON.stringify(state?.bands ?? state)})`,
      );
    }
    return null;
  };

  const tone440 = library.findIndex((t) => t.title.includes("440"));
  const idOf = (needle) => `本地音乐/观测室/${needle}`;
  const mid = await playAndWait(idOf("02 测试正弦 440Hz.wav"), "440Hz");
  console.log("playback 440Hz:", JSON.stringify(mid));
  check("播放本地文件", Boolean(mid?.playing), JSON.stringify(mid?.bands));
  check(
    "频谱进入阵列律动（440Hz → 中频段）",
    mid && mid.bands.activity > 0.5 && mid.bands.mid > 0.05,
    `low=${mid?.bands.low.toFixed(3)} mid=${mid?.bands.mid.toFixed(3)} high=${mid?.bands.high.toFixed(3)} activity=${mid?.bands.activity.toFixed(3)}`,
  );

  const bgmHandoff = await cdp.evaluate(
    `window.rhine.stats().audio.localMusic`,
    false,
    20000,
  );
  check("本地音乐占用背景音乐通道", bgmHandoff === true, String(bgmHandoff));

  const playingShot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    join(SHOTS, "music-panel-playing.png"),
    Buffer.from(playingShot.data, "base64"),
  );
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  // 1.3 regression: the analyser used to tick only while the panel was open.
  // With the panel closed the bands must stay live (the archive array on the
  // main screen consumes them), and pausing must decay the envelope to
  // silence — a frozen envelope would pin the last values forever.
  await cdp.evaluate(`window.rhine.music.close()`, true, 30000);
  await sleep(1500);
  const closedLive = await cdp.evaluate(
    `(() => { const b = window.rhine.music.bands(); return { activity: b.activity, mid: b.mid, motion: window.rhine.stats().motion }; })()`,
    false,
    20000,
  );
  check(
    "关闭面板后律动数据继续流动（主界面可见）",
    closedLive.activity > 0.5 && closedLive.mid > 0.05,
    JSON.stringify(closedLive),
  );
  await cdp.evaluate(`window.rhine.music.player.pause()`, false, 20000);
  // The envelope decays per frame (dt capped at 0.1), and this software-
  // rendered page can run at a fraction of a frame per second — poll the
  // trend for up to 30s instead of reading once after a fixed delay.
  const series = [];
  let decayed = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    decayed = await cdp.evaluate(
      `(() => ({ a: window.rhine.music.bands().activity, playing: window.rhine.music.player.state().playing }))()`,
      false,
      20000,
    );
    series.push(Number(decayed.a.toFixed(3)));
    if (decayed.a < 0.15) break;
  }
  const trend = series.length > 1 && series[series.length - 1] < series[0];
  check(
    "关面板暂停后律动包络归零",
    decayed.a < 0.15 && decayed.playing === false,
    `final=${decayed.a.toFixed(3)} trend=${trend ? "decaying" : "FLAT"} [${series.slice(0, 8).join("→")}…${series.slice(-3).join("→")}]`,
  );

  const low = await playAndWait(idOf("04 测试正弦 60Hz.wav"), "60Hz");
  check(
    "频段映射（60Hz → 低频段）",
    low && low.bands.low > 0.05 && low.bands.low > low.bands.high,
    `low=${low?.bands.low.toFixed(3)} mid=${low?.bands.mid.toFixed(3)} high=${low?.bands.high.toFixed(3)}`,
  );

  const high = await playAndWait(idOf("03 测试正弦 6kHz.wav"), "6kHz");
  check(
    "频段映射（6kHz → 高频段）",
    high && high.bands.high > 0.05 && high.bands.high > high.bands.low,
    `low=${high?.bands.low.toFixed(3)} mid=${high?.bands.mid.toFixed(3)} high=${high?.bands.high.toFixed(3)}`,
  );

  const transitions = await cdp.evaluate(
    `(async () => {
    window.rhine.music.player.pause();
    await new Promise(r => setTimeout(r, 600));
    const paused = window.rhine.music.player.state().playing;
    const released = window.rhine.stats().audio.localMusic;
    await window.rhine.music.player.toggle();
    await new Promise(r => setTimeout(r, 1200));
    const resumed = window.rhine.music.player.state().playing;
    window.rhine.music.player.seek(0.5);
    await new Promise(r => setTimeout(r, 600));
    return { paused, released, resumed, position: window.rhine.music.player.state().position, duration: window.rhine.music.player.state().duration };
  })()`,
    true,
    60000,
  );
  check(
    "暂停释放背景音乐 / 继续占用 / 进度定位",
    transitions.paused === false &&
      transitions.released === false &&
      transitions.resumed === true &&
      transitions.position > 1,
    JSON.stringify(transitions),
  );

  const modes = await cdp.evaluate(
    `(async () => {
    const player = window.rhine.music.player;
    player.setMode("shuffle");
    const a = player.currentTrack().id;
    await player.next();
    const b = player.currentTrack().id;
    player.setMode("list");
    await player.next();
    return { shuffled: a !== b, mode: player.state().mode, nowPlaying: player.currentTrack().title };
  })()`,
    true,
    45000,
  );
  check(
    "随机切换曲目与队列推进",
    modes.shuffled === true && modes.mode === "list",
    JSON.stringify(modes),
  );

  const bgm = await cdp.evaluate(`window.rhine.stats().music`, false);
  console.log("music stats:", JSON.stringify(bgm));
  check(
    "播放状态暴露给调试面与设置",
    bgm.reactive === true && bgm.rhythm === "ripple" && bgm.tracks === N,
    `rhythm=${bgm.rhythm} tracks=${bgm.tracks}`,
  );

  // 2.0 music archive mode: the array swaps its record source to the library,
  // every column becomes one album/artist/initial, and cards take cover art.
  await cdp.evaluate(
    `document.querySelector('[data-action="library-mode"]').click()`,
    false,
    20000,
  );
  await sleep(900);
  const musicMode = await cdp.evaluate(
    `({
    mode: window.rhine.stats().libraryMode,
    columns: window.rhine.stats().columns,
    selected: window.rhine.stats().selected,
    grouping: window.rhine.stats().grouping,
    rowSpacing: window.rhine.stats().rowSpacing,
    rowSpacingTarget: window.rhine.stats().rowSpacingTarget,
    musicRowSpacing: window.rhine.stats().musicRowSpacing,
    coverVisible: window.rhine.stats().coverVisible,
    category: document.querySelector("#archive-category").textContent,
    columnName: document.querySelector("#column-name").textContent,
    columnTotal: document.querySelector("#column-total").textContent,
  })`,
    false,
    20000,
  );
  const expectedAlbumColumns = new Set(
    library.map((t) => t.album || "未标记专辑"),
  ).size;
  check(
    "音乐库档案阵列（按专辑分组）",
    musicMode.mode === "music" &&
      musicMode.columns === expectedAlbumColumns &&
      musicMode.selected.startsWith("M-") &&
      musicMode.grouping === "album" &&
      Math.abs(musicMode.rowSpacingTarget - 4.05) < 0.001 &&
      musicMode.musicRowSpacing === 4.05 &&
      musicMode.coverVisible === true &&
      musicMode.category.length > 0 &&
      musicMode.columnName === musicMode.category,
    JSON.stringify({ ...musicMode, expected: expectedAlbumColumns }),
  );
  const archiveTarget = await cdp.evaluate(
    `(() => { const title = document.querySelector('#selected-title')?.textContent?.trim() ?? ''; const track = window.rhine.music.library.tracks.find(t => t.title === title); return { id: track?.id ?? '', title: track?.title ?? '', artist: track?.artist?.trim() || '未知艺术家' }; })()`,
    false,
    20000,
  );
  await cdp.evaluate(
    `document.querySelector('.read-file[data-action="open"]')?.click()`,
    false,
    20000,
  );
  await sleep(900);
  const detailOrder = await cdp.evaluate(
    `(() => { const title = document.querySelector('#detail-content h2')?.textContent?.trim() ?? ''; const artist = document.querySelector('.detail-title-cn')?.childNodes[0]?.textContent?.trim() ?? ''; const titleSize = Number.parseFloat(getComputedStyle(document.querySelector('#detail-content h2')).fontSize); const artistSize = Number.parseFloat(getComputedStyle(document.querySelector('.detail-title-cn')).fontSize); return { title, artist, titleSize, artistSize, musicDetail: document.querySelector('#detail-content')?.classList.contains('music-detail'), mode: window.rhine.stats().mode }; })()`,
    false,
    20000,
  );
  check(
    "音乐详情歌曲名/歌手层级",
    detailOrder.title === archiveTarget.title &&
      detailOrder.artist === archiveTarget.artist &&
      detailOrder.titleSize > detailOrder.artistSize &&
      detailOrder.musicDetail === true &&
      detailOrder.mode === "detail",
    JSON.stringify({ ...detailOrder, archiveTarget }),
  );
  const archivePlayback = await cdp.evaluate(
    `new Promise(resolve => { const started = performance.now(); const poll = () => { const state = window.rhine.music.player.state(); if (state.id === ${JSON.stringify(archiveTarget.id)} && state.playing && !state.loading && state.position > .35) return resolve({ ...state, ok: true }); if (performance.now() - started > 30000) return resolve({ ...state, ok: false }); setTimeout(poll, 200); }; poll(); })`,
    true,
    40000,
  );
  check(
    "音乐档案 ACCESS FILE 选择并播放对应曲目",
    archivePlayback.ok === true && archivePlayback.id === archiveTarget.id,
    JSON.stringify({ archiveTarget, archivePlayback }),
  );
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  await sleep(700);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1500);
  const modeShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(SHOTS, "music-archive-mode.png"),
    Buffer.from(modeShot.data, "base64"),
  );
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await cdp.evaluate(
    `document.querySelector('[data-action="settings"]').click()`,
    false,
    20000,
  );
  await sleep(800);
  const groupingButtons = await cdp.evaluate(
    `[...document.querySelectorAll("[data-music-grouping]")].map(b => b.dataset.musicGrouping)`,
    false,
    20000,
  );
  const spacingControl = await cdp.evaluate(
    `(() => { const input = document.querySelector('[data-music-spacing]'); return input ? { min: input.min, max: input.max, step: input.step, value: input.value, width: input.getBoundingClientRect().width } : null; })()`,
    false,
    20000,
  );
  check(
    "音乐档案行距滑条可见并有默认值",
    Boolean(
      spacingControl &&
      Number(spacingControl.width) > 60 &&
      spacingControl.min === "0.62" &&
      spacingControl.max === "8" &&
      spacingControl.value === "4.05",
    ),
    JSON.stringify(spacingControl),
  );
  const spacingChecks = [];
  for (const value of ["0.62", "8", "4.05"]) {
    const state = await cdp.evaluate(
      `(() => { const input = document.querySelector('[data-music-spacing]'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); const saved = JSON.parse(localStorage.getItem('rhine-settings') || '{}'); const s = window.rhine.stats(); return { value: input.value, output: input.closest('label').querySelector('output').value, saved: saved.musicRowSpacing, target: s.musicRowSpacing }; })()`,
      false,
      20000,
    );
    spacingChecks.push(state);
  }
  const spacingApplied = await cdp.evaluate(
    `new Promise(resolve => { const started = performance.now(); const tick = () => { const s = window.rhine.stats(); if (Math.abs(s.rowSpacing - 4.05) < 0.03 || performance.now() - started > 6000) resolve(s.rowSpacing); else setTimeout(tick, 100); }; tick(); })`,
    true,
    20000,
  );
  check(
    "音乐档案行距实时更新并持久化（最小/最大/默认）",
    spacingChecks.map((x) => x.target).join(",") === "0.62,8,4.05" &&
      spacingChecks.map((x) => x.saved).join(",") === "0.62,8,4.05" &&
      spacingChecks.every((x) => Number(x.value) === Number(x.output)),
    JSON.stringify(spacingChecks),
  );
  check(
    "音乐档案行距应用到场景坐标",
    Math.abs(spacingApplied - 4.05) < 0.03,
    `rowSpacing=${spacingApplied}`,
  );
  await cdp.evaluate(`window.rhine.seek(26)`, false, 20000);
  await sleep(900);
  const cinematicSpacing = await cdp.evaluate(
    `window.rhine.stats().rowSpacing`,
    false,
    20000,
  );
  check(
    "开场 cinematic 保持档案基准行距",
    Math.abs(cinematicSpacing - 0.62) < 0.01,
    `rowSpacing=${cinematicSpacing}`,
  );
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  await sleep(1200);
  await cdp.evaluate(
    `document.querySelector('[data-music-grouping="artist"]').click()`,
    false,
    20000,
  );
  await sleep(700);
  const artistMode = await cdp.evaluate(
    `({ grouping: window.rhine.stats().grouping, selected: window.rhine.stats().selected, columns: window.rhine.stats().columns })`,
    false,
    20000,
  );
  check(
    "排列方式切换（专辑→歌手）",
    groupingButtons.join(",") === "album,artist,letter" &&
      artistMode.grouping === "artist" &&
      artistMode.selected.startsWith("M-"),
    JSON.stringify(artistMode),
  );
  await cdp.evaluate(
    `document.querySelector('[data-action="close-modal"]').click()`,
    false,
    20000,
  );
  await sleep(500);
  // Back to the Rhine archive so the dark-theme pass runs in the classic mode.
  await cdp.evaluate(
    `document.querySelector('[data-action="library-mode"]').click()`,
    false,
    20000,
  );
  await sleep(700);
  const archiveMode = await cdp.evaluate(
    `({ mode: window.rhine.stats().libraryMode, selected: window.rhine.stats().selected, coverVisible: window.rhine.stats().coverVisible })`,
    false,
    20000,
  );
  check(
    "切回莱茵档案库",
    archiveMode.mode === "archive" &&
      archiveMode.selected.startsWith("X-") &&
      archiveMode.coverVisible === false,
    JSON.stringify(archiveMode),
  );

  await cdp.evaluate(
    `(() => { window.rhine.music.player.stop(); return true; })()`,
    false,
  );
  await sleep(400);

  // Dark theme: reload with the dark preference, then re-inject a small library.
  await cdp.evaluate(
    `(() => {
    const stored = JSON.parse(localStorage.getItem("rhine-settings") || "{}");
    stored.colorTheme = "dark";
    localStorage.setItem("rhine-settings", JSON.stringify(stored));
    return true;
  })()`,
    false,
  );
  check("暗色主题下重新载入", await load());
  const restoredSpacing = await cdp.evaluate(
    `window.rhine.stats().musicRowSpacing`,
    false,
    20000,
  );
  check(
    "音乐档案行距跨重载持久化",
    restoredSpacing === 4.05,
    `musicRowSpacing=${restoredSpacing}`,
  );
  // The reload clears page state, so re-fetch the same folder and rescan: the
  // index must come back from IndexedDB and reuse every unchanged file.
  await cdp.evaluate(
    `(() => {
    window.__files = [];
    window.__fetchFixture = async (path) => {
      const response = await fetch("/__fixtures/" + path.split("/").map(encodeURIComponent).join("/"));
      if (!response.ok) return "HTTP " + response.status;
      const blob = await response.blob();
      const file = new File([blob], path.split("/").pop(), { type: blob.type || "audio/mpeg", lastModified: 1759600000000 });
      Object.defineProperty(file, "webkitRelativePath", { value: "本地音乐/" + path });
      window.__files.push(file);
      return file.name + ":" + file.size;
    };
    return true;
  })()`,
    false,
    30000,
  );
  for (const path of FIXTURE_PATHS)
    await cdp.evaluate(
      `window.__fetchFixture(${JSON.stringify(path)})`,
      true,
      60000,
    );
  // The library restores lazily (panel open / engine switch). Trigger it here
  // so the rescan asserts real persistence: stored metadata must be reused for
  // every unchanged file instead of being re-parsed.
  const restored = await cdp.evaluate(
    `(async () => {
    await window.rhine.music.library.restore();
    const before = window.rhine.music.library.tracks.length;
    window.rhine.music.library.useFiles(window.__files);
    const report = await window.rhine.music.library.scan(() => {});
    return { before, report: { total: report.total, reused: report.reused, parsed: report.parsed, ms: report.ms } };
  })()`,
    true,
    180000,
  );
  console.log("rescan:", JSON.stringify(restored));
  check(
    "二次扫描增量复用（索引持久化）",
    restored.before === FIXTURE_PATHS.length &&
      restored.report.reused === FIXTURE_PATHS.length &&
      restored.report.parsed === 0,
    JSON.stringify(restored.report),
  );

  await cdp.evaluate(
    `(() => {
    window.rhine.music.open();
    const tone = window.rhine.music.library.tracks.find(t => t.title.includes("440"));
    if (tone) window.rhine.music.play(tone.id);
    return Boolean(tone);
  })()`,
    false,
    30000,
  );
  // Poll from Node: in-page timers are throttled in this headless environment.
  // Diagnostics included: lastPlayingId shows whether the panel tick kept the
  // highlight in step, cls shows the live classes on the first row.
  let dark = null;
  for (let i = 0; i < 25; i++) {
    await sleep(700);
    dark = await cdp.evaluate(
      `({ dark: document.documentElement.dataset.darkSurface, rows: document.querySelectorAll(".result-row").length, playing: document.querySelectorAll(".result-row.playing").length, state: window.rhine.music.player.state().playing, id: window.rhine.music.player.state().id, results: window.rhine.music.panel.results.length, lastPlayingId: window.rhine.music.panel.lastPlayingId, cls: document.querySelector(".result-row") ? [...document.querySelector(".result-row").classList] : [] })`,
      false,
      20000,
    );
    if (dark.playing >= 1) break;
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
  const darkShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(SHOTS, "music-panel-dark.png"),
    Buffer.from(darkShot.data, "base64"),
  );
  check(
    "暗色主题面板与播放行高亮",
    dark.dark === "true" && dark.rows >= 2 && dark.playing >= 1,
    JSON.stringify(dark),
  );

  const finalStats = await cdp.evaluate(`window.rhine.stats()`, false);
  check(
    "既有三维场景与帧率未受影响",
    finalStats.threeState === "on" && finalStats.fps >= 0,
    `fps=${Math.round(finalStats.fps)} three=${finalStats.threeState} mode=${finalStats.mode}`,
  );

  if (cdp.logs.length)
    console.log(
      `\npage console (${cdp.logs.length}):\n` + cdp.logs.slice(-12).join("\n"),
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
  process.exitCode = 1;
} finally {
  await Promise.all([stopProcessTree(edge), stopProcessTree(server)]);
  await removeLocalDirectory(FIXTURES).catch(() => {});
  await removeLocalDirectory(PROFILE).catch(() => {});
  await sleep(300);
}
