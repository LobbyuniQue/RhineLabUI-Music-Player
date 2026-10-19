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
import { waitForArchiveReturn } from "../lib/archive-return.mjs";
import { Cdp } from "../lib/cdp.mjs";
import { observeAnimationFrame } from "../lib/observe-animation-frame.mjs";

const DIST = DIST_DIR;
const FIXTURES = BROWSER_FIXTURES;
const SHOTS = SHOTS_DIR;
const PORT = 4188;
const DEBUG_PORT = 9333;
const EDGE = BROWSER;
const PROFILE = profilePath("music");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    "--window-size=420,300",
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
  // Hosted Windows runners use software rendering. Keep the real animations,
  // but select the app's lightweight rendering before each document loads so
  // fixture fetches and playback callbacks are not starved by the 3D scene.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const stored = JSON.parse(localStorage.getItem("rhine-settings") || "{}");
      stored.superPerformance = true;
      stored.reduced = false;
      delete stored.motion;
      localStorage.setItem("rhine-settings", JSON.stringify(stored));
    })()`,
  });

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

  const closeIndex = async () => {
    const closed = await cdp.evaluate(`new Promise(resolve => {
      document.querySelector('[data-action="close-modal"]')?.click();
      const started = performance.now();
      const poll = () => {
        if (!document.querySelector('#modal-root [role="dialog"]') && !document.querySelector('.system-nav').inert) return resolve(true);
        if (performance.now() - started > 60000) return resolve(false);
        setTimeout(poll, 100);
      }; poll();
    })`, true, 90000);
    if (!closed) throw new Error("Index closing animation did not release navigation");
  };
  const pressIndexShortcut = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "/", code: "Slash", text: "/" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash" });
    await sleep(700);
  };

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

  const layoutMode = await cdp.evaluate(`window.rhine.stats().mode`, false, 20000);
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  const panelLayout = () => cdp.evaluate(`(() => {
    const modal = document.querySelector('.music-modal');
    const search = modal.querySelector('.search-field');
    const list = document.querySelector('#music-results');
    const rect = target => {
      const r = (typeof target === 'string' ? modal.querySelector(target) : target).getBoundingClientRect();
      return { top:r.top, bottom:r.bottom, height:r.height };
    };
    return { layout:document.querySelector('#stage').dataset.layout, viewportWidth:innerWidth, viewportHeight:innerHeight,
      deviceRatio:devicePixelRatio, searchHeight:parseFloat(getComputedStyle(search).height),
      topPadding:parseFloat(getComputedStyle(modal).paddingTop),
      headingGap:rect('.search-field').top-rect('h2').bottom,
      header:rect('.result-header'), list:rect('#music-results'),
      first:rect('#music-results .result-row'), last:rect([...list.querySelectorAll('.result-row')].at(-1)),
      bar:rect('#music-bar'), footer:rect('.modal-bottom'),
      listScroll:list.scrollTop, listOverflow:list.scrollHeight-list.clientHeight,
      modalOverflow:modal.scrollHeight-modal.clientHeight,
      modalHorizontalOverflow:modal.scrollWidth-modal.clientWidth,
      horizontalOverflow:list.scrollWidth-list.clientWidth };
  })()`, false, 30000);
  for (const [width, height] of [[1920,1080], [960,600], [390,844]]) {
    // Layout is measured in real CSS pixels. Reduce only this section's raster
    // density so the 1080p software-rendered backdrop cannot starve CDP scroll
    // commands. Clear the override before the playback and animation checks.
    console.log(`panel layout: ${width}x${height} CSS pixels, DPR 0.25`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:0.25, mobile:false });
    await sleep(700);
    const geometry = await panelLayout();
    check(`音乐面板 ${width}×${height}：紧凑搜索与表头、曲目、播放器互不遮挡`,
      geometry.viewportWidth === width && geometry.viewportHeight === height && geometry.deviceRatio === 0.25 &&
      geometry.searchHeight >= 40 && geometry.searchHeight <= 48 && geometry.topPadding <= 30 &&
      geometry.layout === (width < 600 ? 'portrait' : width < 1100 ? 'compact' : 'desktop') &&
      geometry.headingGap >= 0 && geometry.headingGap <= 20 && geometry.header.bottom <= geometry.list.top+1 &&
      geometry.header.bottom <= geometry.first.top+1 && geometry.list.bottom <= geometry.bar.top+1 &&
      geometry.bar.bottom <= geometry.footer.top+1 && geometry.list.height > 40 &&
      (width < 600 || geometry.modalOverflow <= 2) && geometry.modalHorizontalOverflow <= 2 &&
      geometry.horizontalOverflow <= 2, JSON.stringify(geometry));
    await cdp.evaluate(`document.querySelector('#music-results').scrollTop = document.querySelector('#music-results').scrollHeight`, false, 20000);
    const scrolled = await panelLayout();
    check(`音乐面板 ${width}×${height}：曲目区域独立滚动、固定表头与播放器、末首可见`,
      Math.abs(scrolled.header.top-geometry.header.top) <= 1 && Math.abs(scrolled.bar.top-geometry.bar.top) <= 1 &&
      scrolled.last.top >= scrolled.list.top-1 && scrolled.last.bottom <= scrolled.list.bottom+1 &&
      (geometry.listOverflow <= 2 || scrolled.listScroll > 0), JSON.stringify(scrolled));
    if (width < 600) {
      const bottom = await cdp.evaluate(`(() => {
        const modal = document.querySelector('.music-modal');
        modal.scrollTop = modal.scrollHeight;
        const box = modal.getBoundingClientRect();
        const bar = document.querySelector('#music-bar').getBoundingClientRect();
        const footer = modal.querySelector('.modal-bottom').getBoundingClientRect();
        return { modalBottom:box.bottom, barTop:bar.top, barBottom:bar.bottom, footerBottom:footer.bottom,
          viewportHeight:innerHeight, horizontalOverflow:modal.scrollWidth-modal.clientWidth };
      })()`, false, 20000);
      check('音乐面板窄视口：播放器与页脚滚动可达、无需横向滚动',
        bottom.barTop >= 0 && bottom.barBottom <= bottom.modalBottom+1 && bottom.footerBottom <= bottom.modalBottom+1 &&
        bottom.footerBottom <= bottom.viewportHeight+1 && bottom.horizontalOverflow <= 2, JSON.stringify(bottom));
    }
    const layoutShot = await cdp.send('Page.captureScreenshot', { format:'png' });
    await writeFile(join(SHOTS, `music-panel-layout-${width}x${height}.png`), Buffer.from(layoutShot.data,'base64'));
    await cdp.evaluate(`document.querySelector('#music-results').scrollTop = 0`, false, 20000);
    await cdp.evaluate(`document.querySelector('.music-modal').scrollTop = 0`, false, 20000);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  // Preserve the opening's low render load for the existing short-tone checks.
  if (layoutMode === 'boot') await cdp.evaluate(`window.rhine.seek(0)`, false, 20000);

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
  await cdp.send("Emulation.clearDeviceMetricsOverride");

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

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
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
    `(() => { const tick = document.querySelector('#file-ticks [aria-pressed="true"]'); const title = (tick?.title ?? '').replace(/^M-\\d+\\s*·\\s*/, '').trim() || document.querySelector('#selected-song-title .rn-value')?.textContent?.trim() || ''; const track = window.rhine.music.library.tracks.find(t => t.title === title); return { id: track?.id ?? '', title: track?.title ?? '', artist: track?.artist?.trim() || '未知艺术家' }; })()`,
    false,
    20000,
  );
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  const callout = await cdp.evaluate(`(() => {
    const title = document.querySelector('#selected-song-title');
    const artist = document.querySelector('#selected-title');
    return { title:title.querySelector('.rn-value').textContent, artist:artist.querySelector('.rn-value').textContent,
      visible:getComputedStyle(title).display !== 'none', idHidden:getComputedStyle(document.querySelector('#selected-id')).display === 'none',
      tooltip:title.title };
  })()`, false, 20000);
  check("音乐主标题显示歌名、副标题显示歌手", callout.visible && callout.idHidden &&
    callout.title === archiveTarget.title && callout.tooltip === archiveTarget.title && callout.artist === archiveTarget.artist, JSON.stringify(callout));

  const musicIndex = await cdp.evaluate(`(() => {
    const index = document.querySelector('.system-nav [data-action="search"]');
    const status = document.querySelector('#music-nav-state');
    return { count:document.querySelectorAll('.system-nav [data-action="search"]').length,
      duplicate:document.querySelectorAll('.system-nav [data-action="music"]').length,
      label:document.querySelector('#library-index-label').textContent,
      accessible:index.getAttribute('aria-label'), statusEnabled:!status.hidden };
  })()`, false, 20000);
  check("顶部只保留一个检索入口并随音乐库显示 MUSIC INDEX", musicIndex.count === 1 && musicIndex.duplicate === 0 &&
    musicIndex.label === "MUSIC INDEX" && /音乐/.test(musicIndex.accessible) && musicIndex.statusEnabled, JSON.stringify(musicIndex));
  await cdp.evaluate(`(() => { const index=document.querySelector('.system-nav [data-action="search"]'); index.focus(); index.click(); })()`, false, 20000);
  await sleep(700);
  const indexPanel = await cdp.evaluate(`({ rows:document.querySelectorAll('#music-results .result-row').length,
    controls:!!document.querySelector('.music-controls'), archiveInput:!!document.querySelector('#archive-search'),
    focus:document.activeElement?.id })`, false, 20000);
  check("音乐库检索入口打开含歌曲与播放控制的音乐面板", indexPanel.rows === N && indexPanel.controls &&
    !indexPanel.archiveInput && indexPanel.focus === "music-search", JSON.stringify(indexPanel));
  await closeIndex();
  const musicFocus = await cdp.evaluate(`document.activeElement === document.querySelector('.system-nav [data-action="search"]')`, false, 20000);
  check("关闭音乐检索后焦点返回统一入口", musicFocus);
  await pressIndexShortcut();
  const musicShortcut = await cdp.evaluate(`({ music:!!document.querySelector('#music-search'),
    controls:!!document.querySelector('.music-controls'), focus:document.activeElement?.id })`, false, 20000);
  check("音乐库下 / 快捷键打开同一音乐检索面板", musicShortcut.music && musicShortcut.controls &&
    musicShortcut.focus === "music-search", JSON.stringify(musicShortcut));
  await closeIndex();
  await cdp.evaluate(`window.rhine.music.player.setMode("single")`, false, 20000);
  await playAndWait(idOf("02 测试正弦 440Hz.wav"), "检索入口播放指示");
  const indexPlaying = await cdp.evaluate(`({ text:document.querySelector('#music-nav-state').textContent,
    visible:!document.querySelector('#music-nav-state').hidden,
    playing:document.querySelector('.system-nav [data-action="search"]').classList.contains('playing') })`, false, 20000);
  check("音乐播放状态显示在统一检索入口", indexPlaying.text === "PLAYING" && indexPlaying.visible && indexPlaying.playing, JSON.stringify(indexPlaying));

  await cdp.evaluate(`(() => {
    const music = window.rhine.music;
    music.player.stop();
    window.__originalFile = music.library.file.bind(music.library);
    window.__startFrames = [];
    const start = music.player.startPrepared.bind(music.player);
    music.player.startPrepared = function () {
      window.__startFrames.push({ phase: music.access().phase, frame: music.access().startFrame,
        masks: document.querySelectorAll('#detail-content .document-redaction-window').length });
      return start();
    };
    const gate = new Promise(resolve => { window.__releaseFile = resolve; });
    music.library.file = async track => { await gate; return window.__originalFile(track); };
    document.querySelector('.read-file[data-action="open"]').click();
  })()`, false, 20000);
  await sleep(6000);
  const waiting = await cdp.evaluate(`({ access:window.rhine.music.access(), state:window.rhine.music.player.state(),
    masks:document.querySelectorAll('#detail-content .document-redaction-window').length,
    held:document.querySelector('#detail-content').dataset.revealHeld, three:window.rhine.stats().threeState,
    starts:window.__startFrames.length, mode:window.rhine.stats().mode })`, false, 20000);
  check("加载期间保留场景、保持文字黑条且不起播", waiting.access.phase === "loading" && waiting.held === "true" &&
    waiting.masks > 0 && waiting.three === "on" && waiting.starts === 0 && !waiting.state.playing && waiting.mode === "detail", JSON.stringify(waiting));
  const waitingShot = await cdp.send("Page.captureScreenshot", { format:"png" });
  await writeFile(join(SHOTS,"music-loading-masks.png"),Buffer.from(waitingShot.data,"base64"));
  await cdp.evaluate(`window.rhine.archive(); window.__releaseFile();`, false, 20000);
  await sleep(800);
  const cancelled = await cdp.evaluate(`({ phase:window.rhine.music.access().phase, playing:window.rhine.music.player.state().playing,
    starts:window.__startFrames.length, mode:window.rhine.stats().mode })`, false, 20000);
  check("返回曲库后旧文件即使完成也不能起播", cancelled.phase === "idle" && !cancelled.playing && cancelled.starts === 0 && cancelled.mode === "archive", JSON.stringify(cancelled));
  await cdp.evaluate(`window.rhine.music.library.file = async () => { throw Error('Synthetic unavailable file'); };
    document.querySelector('.read-file[data-action="open"]').click();`, false, 20000);
  await sleep(800);
  const failedLoad = await cdp.evaluate(`({ phase:window.rhine.music.access().phase,
    retry:!document.querySelector('[data-action="retry-music-access"]').hidden,
    held:document.querySelector('#detail-content').dataset.revealHeld, playing:window.rhine.music.player.state().playing })`, false, 20000);
  check("加载失败保留黑条并提供重新加载", failedLoad.phase === "error" && failedLoad.retry && failedLoad.held === "true" && !failedLoad.playing, JSON.stringify(failedLoad));
  await cdp.evaluate(
    `window.rhine.music.library.file = window.__originalFile; document.querySelector('[data-action="retry-music-access"]').click()`,
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
  let archivePlayback = null;
  const archiveWaitStarted = Date.now();
  let lastAnimationLog = -10000;
  // The full animation uses bounded frame deltas. Software rendering can take
  // longer than 30 wall-clock seconds; keep the same 120 s budget as VLC UI.
  while (Date.now() - archiveWaitStarted < 120000) {
    await sleep(500);
    archivePlayback = await cdp.evaluate(
      `(() => { const state = window.rhine.music.player.state(); const access = window.rhine.music.access(); const stats = window.rhine.stats(); return {
        ...state, ok:state.id === ${JSON.stringify(archiveTarget.id)} && state.playing && !state.loading && state.position > .35,
        accessPhase:access.phase, decryptionPhase:stats.decryption?.phase, decryptionTime:stats.decryption?.time,
        sceneMode:stats.mode, fps:stats.fps, frames:stats.renderedFrames, reusedFrames:stats.reusedFrames,
        modal:Boolean(document.querySelector('#modal-root [role="dialog"]')),
        masks:document.querySelectorAll('#detail-content .document-redaction-window').length, hidden:document.hidden
      }; })()`,
      false,
      20000,
    );
    const waited = Date.now() - archiveWaitStarted;
    if (waited - lastAnimationLog >= 10000) {
      console.log("archive animation:", JSON.stringify(archivePlayback));
      lastAnimationLog = waited;
    }
    if (archivePlayback.ok || archivePlayback.error || archivePlayback.accessPhase === "error") break;
  }
  check(
    "音乐档案 ACCESS FILE 选择并播放对应曲目",
    archivePlayback.ok === true && archivePlayback.id === archiveTarget.id,
    JSON.stringify({ archiveTarget, archivePlayback }),
  );
  const frameStart = await cdp.evaluate(`window.__startFrames`,false,20000);
  check("文字揭示结束帧只发出一次起播调用", frameStart.length === 1 && frameStart[0].phase === "starting" &&
    frameStart[0].frame > 0 && frameStart[0].masks === 0, JSON.stringify(frameStart));

  // Exercise the actual animation setting, then keep file resolution pending.
  // Reduced playback must show clear text before audio becomes ready; it must
  // retain cancellation and retry without borrowing the reveal's final frame.
  const setMotionPreset = async preset => {
    await cdp.evaluate(`document.querySelector('[data-action="settings"]').click()`, false, 20000);
    await cdp.evaluate(`document.querySelector('[data-action="motion-preset"][data-preset="${preset}"]').click(); window.rhine.music.close();`, false, 20000);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate(`!document.querySelector('#modal-root [role="dialog"]') && !document.querySelector('.system-nav').inert`, false, 20000)) return;
      await sleep(200);
    }
    throw new Error(`Motion settings did not close after choosing ${preset}`);
  };
  await setMotionPreset("reduced");
  const reducedWaiting = await cdp.evaluate(`(() => {
    const music=window.rhine.music;
    window.rhine.archive(); music.player.stop();
    window.__reducedStartsBase=window.__startFrames.length;
    window.__reducedPreparationTimeout=music.player.hooks.preparationTimeoutMs;
    music.player.hooks.preparationTimeoutMs=60000;
    const gate=new Promise(resolve=>{window.__releaseReducedFile=resolve;});
    music.library.file=async track=>{await gate;return window.__originalFile(track);};
    document.querySelector('.read-file[data-action="open"]').click();
    return {access:music.access(),state:music.player.state(),motion:window.rhine.stats().motion,
      masks:document.querySelectorAll('#detail-content .document-redaction-window').length,
      held:document.querySelector('#detail-content').dataset.revealHeld,
      title:document.querySelector('#detail-content h2')?.textContent?.trim(),
      starts:window.__startFrames.length-window.__reducedStartsBase,frames:window.rhine.stats().renderedFrames};
  })()`,false,20000);
  // Static reduced scenes legitimately reuse their previous WebGL frame. Read
  // after a real animation callback; no new 3D draw is needed to update text.
  const reducedFrameObservation=await cdp.evaluate(`(${observeAnimationFrame.toString()})(() => ({
      access:window.rhine.music.access(),state:window.rhine.music.player.state(),frames:window.rhine.stats().renderedFrames,
      masks:document.querySelectorAll('#detail-content .document-redaction-window').length,
      held:document.querySelector('#detail-content').dataset.revealHeld,
      starts:window.__startFrames.length-window.__reducedStartsBase}))`,true,30000);
  const reducedWaitingFrame=reducedFrameObservation.snapshot;
  check("简化动画点击加载立即显示文字，不创建黑条等待帧", reducedWaiting.motion.preset==="reduced" &&
    reducedWaiting.access.strategy==="immediate" && reducedWaiting.access.phase==="loading" &&
    reducedWaiting.access.startFrame===null && reducedWaiting.masks===0 && reducedWaiting.held==="false" &&
    reducedWaiting.title===archiveTarget.title && reducedWaiting.starts===0 && !reducedWaiting.state.playing &&
    Number.isFinite(reducedFrameObservation.frameTime) && reducedWaitingFrame.access.phase==="loading" &&
    reducedWaitingFrame.access.strategy==="immediate" && reducedWaitingFrame.access.startFrame===null &&
    reducedWaitingFrame.masks===0 && reducedWaitingFrame.held==="false" && reducedWaitingFrame.starts===0 &&
    !reducedWaitingFrame.state.playing,
    JSON.stringify({initial:reducedWaiting,nextFrame:reducedFrameObservation}));
  await cdp.evaluate(`window.rhine.archive(); window.__releaseReducedFile(); window.rhine.music.library.file=window.__originalFile;
    window.rhine.music.player.hooks.preparationTimeoutMs=window.__reducedPreparationTimeout;`,false,20000);
  await sleep(800);
  const reducedCancelled=await cdp.evaluate(`({access:window.rhine.music.access(),playing:window.rhine.music.player.state().playing,
    starts:window.__startFrames.length-window.__reducedStartsBase,mode:window.rhine.stats().mode})`,false,20000);
  check("简化动画返回后延迟加载完成也不能起播", reducedCancelled.access.phase==="idle" &&
    !reducedCancelled.playing && reducedCancelled.starts===0 && reducedCancelled.mode==="archive",JSON.stringify(reducedCancelled));
  await cdp.evaluate(`window.rhine.music.library.file=async()=>{throw Error('Synthetic reduced unavailable file');};
    document.querySelector('.read-file[data-action="open"]').click();`,false,20000);
  await sleep(800);
  const reducedError=await cdp.evaluate(`({access:window.rhine.music.access(),
    retry:!document.querySelector('[data-action="retry-music-access"]').hidden,
    masks:document.querySelectorAll('#detail-content .document-redaction-window').length,
    held:document.querySelector('#detail-content').dataset.revealHeld,playing:window.rhine.music.player.state().playing})`,false,20000);
  check("简化动画加载失败保留清晰文字和重试入口", reducedError.access.phase==="error" &&
    reducedError.access.strategy==="immediate" && reducedError.retry && reducedError.masks===0 &&
    reducedError.held==="false" && !reducedError.playing,JSON.stringify(reducedError));
  await cdp.evaluate(`window.rhine.music.library.file=window.__originalFile;
    document.querySelector('[data-action="retry-music-access"]').click();`,false,20000);
  let reducedPlayback=null;
  const reducedDeadline=Date.now()+120000;
  while(Date.now()<reducedDeadline) {
    reducedPlayback=await cdp.evaluate(`({access:window.rhine.music.access(),state:window.rhine.music.player.state(),
      masks:document.querySelectorAll('#detail-content .document-redaction-window').length})`,false,20000);
    if(reducedPlayback.state.playing || reducedPlayback.access.phase==="error") break;
    await sleep(500);
  }
  check("简化动画音乐就绪后直接播放对应曲目", reducedPlayback?.state.id===archiveTarget.id &&
    reducedPlayback.state.playing && !reducedPlayback.state.loading && reducedPlayback.access.phase==="playing" &&
    reducedPlayback.access.strategy==="immediate" && reducedPlayback.access.startFrame===null && reducedPlayback.masks===0,
    JSON.stringify(reducedPlayback));
  const reducedStartFrames=await cdp.evaluate(`window.__startFrames.slice(window.__reducedStartsBase)`,false,20000);
  check("简化动画不等待揭示帧且只发出一次起播调用", reducedStartFrames.length===1 &&
    reducedStartFrames[0].phase==="starting" && reducedStartFrames[0].frame===null && reducedStartFrames[0].masks===0,
    JSON.stringify(reducedStartFrames));
  // Playback is already verified. Stop the reactive music before restoring
  // full motion and capturing the archive on a software-rendered CI host.
  await cdp.evaluate(`window.rhine.music.player.stop()`,false,20000);
  await setMotionPreset("full");
  await cdp.evaluate(`window.rhine.archive()`, false, 20000);
  const returnedForCapture=await waitForArchiveReturn({
    read: timeoutMs => cdp.evaluate(`(() => {
      const stats=window.rhine.stats();
      return {mode:stats.mode,cameraDetail:stats.cameraDetail,extraction:stats.extraction,
        returningFiles:stats.returningFiles,motion:stats.motion,fps:stats.fps,
        frames:stats.renderedFrames,reusedFrames:stats.reusedFrames,
        modal:!!document.querySelector('#modal-root [role="dialog"]')};
    })()`,false,timeoutMs),
    onProgress: observation => console.log("archive capture return progress:",JSON.stringify(observation)),
  });
  console.log("archive capture return:",JSON.stringify(returnedForCapture));
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1500);
  const calloutBounds = await cdp.evaluate(`(() => {
    const title = document.querySelector('#selected-song-title');
    const box = document.querySelector('.archive-callout').getBoundingClientRect();
    const bounds = title.getBoundingClientRect();
    return { title:title.querySelector('.rn-value').textContent, tooltip:title.title,
      width:bounds.width, contained:bounds.right <= box.right + 1 && bounds.left >= box.left - 1 };
  })()`, false, 20000);
  check("窄屏音乐主标题受可用宽度约束并保留完整名称", calloutBounds.width > 0 &&
    calloutBounds.contained && calloutBounds.tooltip === calloutBounds.title, JSON.stringify(calloutBounds));
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
  // Spacing converges on rendered frames. Software rendering can take more
  // than six seconds even though the target and persistence are already set.
  let spacingApplied = NaN;
  const spacingDeadline = Date.now() + 60000;
  let nextSpacingLog = Date.now() + 10000;
  while (Date.now() < spacingDeadline) {
    const state = await cdp.evaluate(
      `(() => { const s = window.rhine.stats(); return { rowSpacing: s.rowSpacing, target: s.rowSpacingTarget, fps: s.fps, frames: s.renderedFrames }; })()`,
      false,
      20000,
    );
    spacingApplied = state.rowSpacing;
    if (Math.abs(spacingApplied - 4.05) < 0.03) break;
    if (Date.now() >= nextSpacingLog) {
      console.log("archive spacing:", JSON.stringify(state));
      nextSpacingLog = Date.now() + 10000;
    }
    await sleep(500);
  }
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
  await cdp.evaluate(`document.querySelector('[data-music-grouping="letter"]').click()`, false, 20000);
  const letterMode = await cdp.evaluate(`(() => {
    const text = selector => document.querySelector(selector + ' .rn-value')?.textContent ?? '';
    return { grouping:window.rhine.stats().grouping, title:text('#selected-song-title'), artist:text('#selected-title'),
      column:text('#column-name'), label:document.querySelector('[data-music-grouping="letter"]').textContent.trim() };
  })()`, false, 20000);
  check("歌名首字母分组：Business Test Music 归 B、歌手 Rhine Lab 不影响分组",
    letterMode.grouping === "letter" && letterMode.title === "Business Test Music" &&
    letterMode.artist === FIXTURE_ARTIST && letterMode.column === "B" && letterMode.label === "按歌名首字母", JSON.stringify(letterMode));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width:960, height:600, deviceScaleFactor:1, mobile:false });
  await cdp.evaluate(`(() => {
    const track = window.rhine.music.library.tracks.find(track => track.id === ${JSON.stringify(archiveTarget.id)});
    window.__calloutSample = { track, title:track.title, artist:track.artist };
    track.title = '一颗方糖悬滞的时间 Long Song Title '.repeat(8);
    track.artist = '';
    document.querySelector('[data-music-grouping="artist"]').click();
  })()`, false, 20000);
  await sleep(900);
  const longCallout = await cdp.evaluate(`(() => {
    const title = document.querySelector('#selected-song-title');
    const artist = document.querySelector('#selected-title .rn-value').textContent;
    const box = document.querySelector('.archive-callout').getBoundingClientRect();
    const bounds = title.getBoundingClientRect();
    return { full:title.querySelector('.rn-value').textContent === window.__calloutSample.track.title,
      tooltip:title.title === window.__calloutSample.track.title, artist,
      contained:bounds.right <= box.right + 1 && bounds.left >= box.left - 1, width:bounds.width };
  })()`, false, 20000);
  check("长中英文歌名保持完整语义且不越界，缺少歌手显示未知艺术家",
    longCallout.full && longCallout.tooltip && longCallout.contained && longCallout.width > 0 &&
    longCallout.artist === "未知艺术家", JSON.stringify(longCallout));
  await cdp.evaluate(`(() => {
    Object.assign(window.__calloutSample.track, { title:window.__calloutSample.title, artist:window.__calloutSample.artist });
    delete window.__calloutSample;
    document.querySelector('[data-music-grouping="letter"]').click();
  })()`, false, 20000);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.evaluate(
    `document.querySelector('[data-action="close-modal"]').click()`,
    false,
    20000,
  );
  // Back to the Rhine archive so the dark-theme pass runs in the classic mode.
  // Closing animation keeps the navigation inert; wait for its completion
  // instead of assuming it finishes within a fixed half second.
  const modalClosed = await cdp.evaluate(
    `new Promise(resolve => { const started = performance.now(); const poll = () => {
      if (!document.querySelector('[data-action="close-modal"]') && !document.querySelector('.system-nav').inert) return resolve(true);
      if (performance.now() - started > 10000) return resolve(false);
      setTimeout(poll, 100);
    }; poll(); })`,
    true,
    20000,
  );
  if (!modalClosed) throw new Error("Settings closing animation did not release archive navigation");
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
  const restoredCallout = await cdp.evaluate(`(() => {
    const text = document.querySelector('#selected-title .rn-value').textContent;
    const label = document.querySelector('#file-ticks [aria-pressed="true"]').title;
    return { text, label, prefix:document.querySelector('#file-title-label').textContent.trim(),
      idVisible:getComputedStyle(document.querySelector('#selected-id')).display !== 'none',
      songHidden:getComputedStyle(document.querySelector('#selected-song-title')).display === 'none' };
  })()`, false, 20000);
  check("普通档案恢复文件编号与原档案标题", restoredCallout.idVisible && restoredCallout.songHidden &&
    restoredCallout.prefix === "FILE NUMBER:" && restoredCallout.label.endsWith(restoredCallout.text), JSON.stringify(restoredCallout));

  const archiveIndex = await cdp.evaluate(`(() => {
    const index=document.querySelector('.system-nav [data-action="search"]');
    const status=document.querySelector('#music-nav-state');
    index.focus();
    return { label:document.querySelector('#library-index-label').textContent,
      accessible:index.getAttribute('aria-label'), statusHidden:status.hidden && getComputedStyle(status).display === 'none',
      playing:index.classList.contains('playing') };
  })()`, false, 20000);
  check("切回档案库时统一入口恢复 ARCHIVE INDEX 并隐藏播放状态", archiveIndex.label === "ARCHIVE INDEX" &&
    archiveIndex.accessible === "档案检索" && archiveIndex.statusHidden && !archiveIndex.playing, JSON.stringify(archiveIndex));
  await cdp.evaluate(`document.querySelector('.system-nav [data-action="search"]').click()`, false, 20000);
  await sleep(700);
  const archiveIndexPanel = await cdp.evaluate(`({ archive:!!document.querySelector('#archive-search'),
    music:!!document.querySelector('#music-search'), rows:document.querySelectorAll('#search-results .result-row').length,
    focus:document.activeElement?.id })`, false, 20000);
  check("档案库检索入口恢复档案检索内容", archiveIndexPanel.archive && !archiveIndexPanel.music &&
    archiveIndexPanel.rows > 0 && archiveIndexPanel.focus === "archive-search", JSON.stringify(archiveIndexPanel));
  await closeIndex();
  check("关闭档案检索后焦点返回统一入口", await cdp.evaluate(`document.activeElement === document.querySelector('.system-nav [data-action="search"]')`, false, 20000));
  await pressIndexShortcut();
  const archiveShortcut = await cdp.evaluate(`({ archive:!!document.querySelector('#archive-search'),
    music:!!document.querySelector('#music-search'), focus:document.activeElement?.id })`, false, 20000);
  check("档案库下 / 快捷键打开原档案检索", archiveShortcut.archive && !archiveShortcut.music &&
    archiveShortcut.focus === "archive-search", JSON.stringify(archiveShortcut));
  await closeIndex();

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
  // A fresh file selection must be re-read even when size/mtime match another
  // source. Incremental reuse is safe only on a second scan of that same source.
  const restored = await cdp.evaluate(
    `(async () => {
    await window.rhine.music.library.restore();
    const before = window.rhine.music.library.tracks.length;
    window.rhine.music.library.useFiles(window.__files);
    const fresh = await window.rhine.music.library.scan(() => {});
    const report = await window.rhine.music.library.scan(() => {});
    return { before, fresh: { parsed:fresh.parsed, reused:fresh.reused }, report: { total: report.total, reused: report.reused, parsed: report.parsed, ms: report.ms } };
  })()`,
    true,
    180000,
  );
  console.log("rescan:", JSON.stringify(restored));
  check(
    "二次扫描增量复用（索引持久化）",
    restored.before === FIXTURE_PATHS.length &&
      restored.fresh.parsed === FIXTURE_PATHS.length && restored.fresh.reused === 0 &&
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

  const limitChoice = await cdp.evaluate(`(async () => {
    const before = window.rhine.music.library.tracks.length;
    const wav = new Uint8Array(48);
    const view = new DataView(wav.buffer);
    for (const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']]) for (let i=0;i<text.length;i++) wav[offset+i]=text.charCodeAt(i);
    view.setUint32(4,40,true); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); view.setUint32(40,4,true);
    window.__playlistFiles = Array.from({length:1001},(_,i)=>new File([wav], String(i).padStart(4,'0')+'.wav'));
    await window.rhine.music.useFiles(window.__playlistFiles);
    return {before,after:window.rhine.music.library.tracks.length,auto:!!document.querySelector('[data-music="playlist-split"]'),manual:!!document.querySelector('[data-music="playlist-manual"]')};
  })()`, true, 180000);
  check("1001 首超限先询问且保留原歌单", limitChoice.before === limitChoice.after && limitChoice.auto && limitChoice.manual, JSON.stringify(limitChoice));
  const manualChoice = await cdp.evaluate(`(() => {
    document.querySelector('[data-music="playlist-manual"]').click();
    return {count:window.rhine.music.library.tracks.length,hidden:document.querySelector('#music-playlist-limit').hidden};
  })()`, false);
  check("自行整理分支不加载超限文件夹", manualChoice.count === limitChoice.before && manualChoice.hidden, JSON.stringify(manualChoice));
  await cdp.evaluate(`(async () => { await window.rhine.music.rescan(); document.querySelector('[data-music="playlist-split"]').click(); })()`, true, 180000);
  let splitState;
  for (let i=0;i<30;i++) {
    await sleep(500);
    splitState = await cdp.evaluate(`({count:window.rhine.music.library.tracks.length,options:document.querySelector('#music-playlist').options.length,busy:window.rhine.music.panel.switching})`, false, 20000);
    if (splitState.count === 1000 && splitState.options === 3 && !splitState.busy) break;
  }
  check("自动拆分只加载首卷 1000 首并建立两卷", splitState.count === 1000 && splitState.options === 3 && !splitState.busy, JSON.stringify(splitState));
  const thousandBefore = await panelLayout();
  const thousandRows = await cdp.evaluate(`(() => {
    for (let page=0; page<4; page++) document.querySelector('#music-results [data-music="more"]')?.click();
    const list = document.querySelector('#music-results');
    list.scrollTop = list.scrollHeight;
    const last = [...list.querySelectorAll('.result-row')].at(-1);
    return { rows:list.querySelectorAll('.result-row').length, index:last.dataset.musicIndex,
      realId:last.dataset.musicTrack === window.rhine.music.library.tracks[999].id };
  })()`, false, 30000);
  const thousandAfter = await panelLayout();
  check("千首歌单分批展开后可滚动到末首，表头与播放器保持可见",
    thousandRows.rows === 1000 && thousandRows.index === '999' && thousandRows.realId && thousandAfter.listScroll > 0 &&
    Math.abs(thousandAfter.header.top-thousandBefore.header.top) <= 1 && Math.abs(thousandAfter.bar.top-thousandBefore.bar.top) <= 1 &&
    thousandAfter.last.top >= thousandAfter.list.top-1 && thousandAfter.last.bottom <= thousandAfter.list.bottom+1 &&
    thousandAfter.list.bottom <= thousandAfter.bar.top+1 && thousandAfter.bar.bottom <= thousandAfter.footer.top+1,
    JSON.stringify({ ...thousandRows, geometry:thousandAfter }));
  const thousandShot = await cdp.send('Page.captureScreenshot', { format:'png' });
  await writeFile(join(SHOTS, 'music-panel-last-track.png'), Buffer.from(thousandShot.data,'base64'));
  await cdp.evaluate(`(() => { const select=document.querySelector('#music-playlist'); select.value=select.options[2].value; select.dispatchEvent(new Event('change',{bubbles:true})); })()`, false);
  let volumeState;
  for (let i=0;i<20;i++) {
    await sleep(500);
    volumeState = await cdp.evaluate(`({count:window.rhine.music.library.tracks.length,name:window.rhine.music.library.tracks[0]?.name,busy:window.rhine.music.panel.switching})`, false, 20000);
    if (volumeState.count === 1 && volumeState.name === '1000.wav' && !volumeState.busy) break;
  }
  check("歌单下拉切换第二卷且保留第 1001 首", volumeState.count === 1 && volumeState.name === '1000.wav' && !volumeState.busy, JSON.stringify(volumeState));
  const playlistShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(SHOTS,"music-playlists.png"), Buffer.from(playlistShot.data,"base64"));
  await cdp.evaluate(`delete window.__playlistFiles`, false);

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
