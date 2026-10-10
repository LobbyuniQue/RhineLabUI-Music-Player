import { createRollingClock } from "./rolling-clock";
import { InspectionOverlay } from "./inspection-overlay";
import { DocumentDecryption } from "./document-decryption";
import "./document-decryption.css";
import "./decryption.css";
import { escapeHtml } from "./html";
import { normalizeQuality, qualityPresets, type QualityPreset, type RenderQuality } from "./render-quality";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { superPerformanceQuality, wallpaperQuality } from "./wallpaper-quality";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./responsive.css";
import { viewportLayout, openingLayout } from "./viewport-layout";
import { assetUrl } from "./asset-url";
import { initPwa, pwaSettingsMarkup } from "./pwa";
import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { ArchiveScene } from "./scene";
import { ModelViewer } from "./model-viewer";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { BootSequence } from "./boot";
import { loadBootWebfonts } from "./boot-lettering";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  activeView,
  setActiveView,
  rhineView,
  recordText,
  type ArchiveView,
} from "./archive-view";
import { buildMusicView, MUSIC_GROUPINGS, type MusicArchiveView, type MusicGrouping } from "./music-grouping";
import { CoverAtlas } from "./cover-atlas";
import type { LibraryTrack } from "./music-library";
import { TerminalAudio } from "./audio";
import { audioSettingsMarkup } from "./audio-settings";
import { MusicLibrary } from "./music-library";
import { MusicPlayer } from "./music-player";
import { MusicPanel } from "./music-panel";
import { MusicBridge, type BridgeHealth } from "./music-bridge";
import { musicSettingsMarkup } from "./music-settings";
import { clampRowSpacing, MUSIC_ROW_SPACING_DEFAULT, ROW_SPACING_MIN } from "./row-spacing";
import { SpectrumEnvelope, quietBands, type MusicBands } from "./archive-play-motion";
import "./music.css";
import {
  createMotionPreferences,
  fullMotion,
  motionEnabled,
  motionPresetFor,
  motionSettingsMarkup,
  motionSummary,
  reducedMotion,
  type MotionKey,
  type MotionPreset,
  type StoredMotion,
} from "./motion-preferences";
import { StartupGate } from "./startup";
import { isWallpaper, wallpaperHost, wallpaperFrame, type WallpaperProperties } from "./wallpaper";
import "./startup.css";
import "./wallpaper.css";
import { Workbench } from "./workbench";
let workbench: Workbench | undefined;
import { ArchivePlayground } from "./archive-playground";
import { ARRAY_OPENING_END, openingShowsDetail } from "./wallpaper-opening";
import { paintTheme, themeSettingsMarkup } from "./theme-ui";
let playground: ArchivePlayground | undefined;
import { WallpaperEffects } from "./wallpaper-effects";
import { WallpaperBackground } from "./wallpaper-background";
let wallpaperEffects: WallpaperEffects | undefined;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
import { logo, brandHeading } from "./brand";

$("#stage").innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="scene-atmosphere archive-atmosphere"></div>
  <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
  <header class="brand">${brandHeading}</header>
  <nav class="system-nav" aria-label="系统导航">
    <button data-action="search"><span class="nav-glyph">⌕</span> ARCHIVE INDEX <span class="key">/</span></button>
    <button data-action="library-mode" aria-label="切换档案库或音乐库" title="档案库 / 音乐库"><span class="nav-glyph">▦</span> <span id="library-mode-label">ARCHIVE 档案库</span></button>
    <button data-action="music" aria-label="本地音乐" title="本地音乐"><span class="nav-glyph">♪</span> LOCAL MUSIC <span class="key" id="music-nav-state">OFF</span></button>
    <button data-action="saved" aria-label="查看收藏档案" title="收藏档案">＋ SAVED <span id="saved-count">00</span></button>
    <button class="settings-button" data-action="settings" aria-label="系统设置" title="系统设置"><span class="settings-glyph" aria-hidden="true">◷</span><span class="settings-label">设置</span></button>
  </nav>
  <button id="skip" class="skip" data-action="skip">ENTER SYSTEM <span>↗</span></button>
  <section id="boot" class="boot" aria-label="系统启动">
    <div class="access-text">ACCESS</div>
    <div class="boot-logo">${logo}</div>
    <div class="auth-status"><span>▪</span> <span id="auth-message"></span><i></i></div>
    <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE LAB.LLC.</strong><strong class="welcome-highlight" aria-hidden="true">RHINE LAB.LLC.</strong></div><div class="welcome-database">INTERNAL DATABASE</div><div class="welcome-logo">${logo}</div></div>
  </section>
  <svg id="inspection-marks" viewBox="0 0 1920 1080" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true">CONFIDENTIALITY:<strong>GENERAL BUSINESS USE</strong></div>
  <section id="archive-ui" class="archive-ui" aria-label="档案选择">
    <div class="archive-callout"><div class="eyebrow">INTERNAL DATABASE <span>／</span> <span id="archive-category">机构档案</span></div><button class="file-title" data-action="open">FILE NUMBER: <span id="selected-id"><span id="selected-prefix">X-</span><span id="selected-code">001</span></span><span class="file-open">↗</span></button><div class="callout-rule"><i></i></div><div class="file-summary"><span id="selected-title">莱茵生命</span><span id="selected-clearance">BUSINESS AREA</span></div><button class="read-file" data-action="open">ACCESS FILE <span>→</span></button></div>
    <div id="hover-label" class="hover-label" hidden><span id="hover-prefix">X-</span><span id="hover-code">001</span> / <span id="hover-title"></span></div>
    <div class="archive-counter"><span class="tiny-label">ARCHIVE / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">12</span></div></div>
    <div class="archive-navigation"><button data-action="prev" aria-label="上一个档案">↑</button><div id="file-ticks" class="file-ticks"></div><button data-action="next" aria-label="下一个档案">↓</button></div>
    <div class="column-navigation"><button data-action="column-prev" aria-label="上一列">←</button><div><span id="column-number">COLUMN <span id="column-index">03</span> / <span id="column-total">05</span></span><strong id="column-name">机构档案</strong></div><button data-action="column-next" aria-label="下一列">→</button></div>
    <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换列 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后档案 <span>／</span> <kbd>ENTER</kbd> 读取</div>
  </section>
  <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
    <button class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
    <div class="object-caption"><span id="object-id">NO.001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small><button class="viewer-open" data-action="model-viewer">360° 查看文档模型 <span>↗</span></button></div>
    <article id="detail-content" class="detail-content"></article>
  </section>
  <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
  <footer class="system-footer"><span><i class="status-light"></i> SESSION AUTHORIZED${isWallpaper ? '<button type="button" class="three-toggle" data-action="toggle-three" aria-pressed="true" title="卸载三维模型，保留 2D 界面">3D 开启</button>' : ''}</span><span>JOYCE MOORE <i>／</i> <span id="clock">00:00:00</span></span><button data-action="replay" title="重播启动流程">REINITIALIZE ↗</button></footer>
  <div id="pwa-update-notice" class="pwa-update-notice" role="status" hidden><span>新版本已就绪</span><button data-pwa-action="update">更新并重启 ↻</button></div>
  <div id="modal-root"></div><div id="toast" class="toast" role="status"></div>
  <div id="loading" class="loading"><div class="loading-mark">${logo}</div><span>CONNECTING TO INTERNAL DATABASE</span><i></i></div>
`;

$("#boot-background").insertAdjacentHTML(
  "beforeend",
  '<div class="boot-white"></div>',
);
const bootSequence = new BootSequence($("#stage"));
$("#viewport").insertAdjacentHTML("beforeend", '<button class="mobile-entry" data-action="skip">进入档案 <span>→</span></button>');

type Mode = "boot" | "archive" | "detail";
let mode: Mode = "boot",
  selected = 0,
  bootStart = 0,
  lastStep = "",
  ready = false;
let modal: "search" | "saved" | "settings" | "music" | null = null,
  searchQuery = "",
  filter = "全部档案";
let activeTab = "overview";
type LauncherBridgeSession = { port: number; token: string; autoConnect: boolean };
const launcherSessionKey = "rhine-launcher-bridge";
function readLauncherSession(): LauncherBridgeSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(launcherSessionKey) ?? "null") as Partial<LauncherBridgeSession> | null;
    const port = Number(value?.port);
    const token = typeof value?.token === "string" ? value.token.trim() : "";
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && token && typeof value?.autoConnect === "boolean") {
      return { port, token, autoConnect: value.autoConnect };
    }
  } catch {
    /* sessionStorage can be unavailable or contain stale data */
  }
  return null;
}
function writeLauncherSession(value: LauncherBridgeSession | null) {
  try {
    if (value) sessionStorage.setItem(launcherSessionKey, JSON.stringify(value));
    else sessionStorage.removeItem(launcherSessionKey);
  } catch {
    /* ignore storage restrictions */
  }
}
const reviewParams = new URLSearchParams(location.search);
const queryPort = Number(reviewParams.get("rhine-bridge-port"));
const queryToken = reviewParams.get("rhine-bridge-token")?.trim() ?? "";
const queryBridge = Number.isInteger(queryPort) && queryPort >= 1024 && queryPort <= 65535 && queryToken.length > 0
  ? { port: queryPort, token: queryToken, autoConnect: true }
  : null;
let launcherSession = queryBridge ?? readLauncherSession();
const launcherBridgePort = launcherSession?.port ?? 0;
const launcherBridgeToken = launcherSession?.token ?? "";
const launcherBridge = launcherSession !== null;
const launcherAutoConnect = launcherSession?.autoConnect === true;
let launcherHandoffPending = launcherBridge;
if (queryBridge) writeLauncherSession(queryBridge);
if (reviewParams.has("rhine-bridge-port") || reviewParams.has("rhine-bridge-token") || reviewParams.has("rhine-music-engine")) {
  reviewParams.delete("rhine-bridge-port");
  reviewParams.delete("rhine-bridge-token");
  reviewParams.delete("rhine-music-engine");
  const cleanQuery = reviewParams.toString();
  history.replaceState(null, "", `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}${location.hash}`);
}
const reviewTimeParam = reviewParams.get("time");
const requestedReviewTime = reviewTimeParam === null ? Number.NaN : Number(reviewTimeParam);
const validReviewTime = Number.isFinite(requestedReviewTime) && requestedReviewTime >= 0 && requestedReviewTime < 35;
let frozenTime = reviewParams.get("freeze") === "1" && validReviewTime ? requestedReviewTime : null;
if (reviewParams.get("review") === "1") {
  $("#stage").dataset.review = "true";
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.type !== "rhine-review-frame"
    )
      return;
    const t = Number(event.data.time);
    if (!Number.isFinite(t) || t < 0 || t >= 35) return;
    frozenTime = t;
    if (ready && mode !== "boot") setMode("boot");
  });
}
let toastTimer: ReturnType<typeof setTimeout>;
let previousFocus: HTMLElement | null = null;
const detailTransition = new SurfaceTransition($("#detail-ui"), undefined, 180, 180);
const tabTransition = new ContentTransition();
let modalTransition: SurfaceTransition | undefined;
let modalClosing = false;
let modalSiblings: { node: HTMLElement; inert: boolean }[] = [];
let pendingDetailFocus = false;
let bookmarkFeedback: Animation | undefined;
function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
const saved = new Set<string>(readLocal<string[]>("rhine-saved", []));
const storedPrefs = readLocal<Partial<{ sound: boolean; music: boolean; soundVolume: number; musicVolume: number; localMusicVolume: number; musicReactive: boolean; musicRhythm: "legacy" | "wave" | "lift" | "pulse" | "ripple" | "groove" | "shimmer"; musicEngine: "browser" | "vlc"; vlcPort: number; vlcToken: string; libraryMode: "archive" | "music"; musicGrouping: MusicGrouping; reduced: boolean; quality: boolean; rendering: RenderQuality; superPerformance: boolean; colorTheme: "light" | "dark"; motion: StoredMotion; motionPreset: MotionPreset; musicRowSpacing: number }>>("rhine-settings", {});
const initialMotion = createMotionPreferences(
  storedPrefs.motion,
  storedPrefs.reduced ?? (storedPrefs.motion === undefined
    ? matchMedia("(prefers-reduced-motion: reduce)").matches
    : undefined),
);
const initialMotionPreset = motionPresetFor(initialMotion);
const prefs = {
  sound: storedPrefs.sound ?? true,
  music: storedPrefs.music ?? storedPrefs.sound ?? true,
  soundVolume: storedPrefs.soundVolume ?? .55,
  musicVolume: storedPrefs.musicVolume ?? .5,
  localMusicVolume: storedPrefs.localMusicVolume ?? .8,
  musicReactive: storedPrefs.musicReactive ?? true,
  // 1.3 defaults to the wave-frequency rings; an explicitly saved choice still wins.
  musicRhythm: storedPrefs.musicRhythm ?? ("ripple" as const),
  musicEngine: launcherBridge
    ? launcherAutoConnect ? ("vlc" as const) : ("browser" as const)
    : storedPrefs.musicEngine === "vlc" ? ("vlc" as const) : ("browser" as const),
  vlcPort: launcherBridge ? launcherBridgePort : storedPrefs.vlcPort ?? 8788,
  vlcToken: launcherBridge ? launcherBridgeToken : storedPrefs.vlcToken ?? "",
  // 2.0: the archive array can show the local music library instead.
  libraryMode: storedPrefs.libraryMode === "music" ? ("music" as const) : ("archive" as const),
  musicGrouping: storedPrefs.musicGrouping === "artist" || storedPrefs.musicGrouping === "letter" ? storedPrefs.musicGrouping : ("album" as const),
  musicRowSpacing: clampRowSpacing(storedPrefs.musicRowSpacing ?? MUSIC_ROW_SPACING_DEFAULT),
  motion: initialMotion,
  motionPreset: initialMotionPreset,
  quality: storedPrefs.quality ?? true,
  superPerformance: storedPrefs.superPerformance ?? false,
  rendering: normalizeQuality(storedPrefs.rendering, storedPrefs.quality !== false),
  colorTheme: storedPrefs.colorTheme === "dark" ? "dark" : "light",
};
const motionActive = (key: MotionKey) => motionEnabled(prefs.motion, key);
const motionIsReduced = () => Object.values(prefs.motion).every((value) => !value);
paintTheme(prefs.colorTheme === "dark" ? 1 : 0);
const rollingMotion = {
  duration: 460,
  motionBlur: true,
  animated: motionActive("rollingNumbers"),
};
const updateFooterClock = createRollingClock($("#clock"));
const numberOptions = {
  ...rollingMotion,
  locales: "en-US",
  format: { minimumIntegerDigits: 2, useGrouping: false },
};
const fileCounter = createRollingNumber($("#selected-number"), {
  ...numberOptions,
  value: 1,
});
const columnCounter = createRollingNumber($("#column-index"), {
  ...numberOptions,
  value: 3,
});
const codeOptions = {
  ...numberOptions,
  format: { minimumIntegerDigits: 3, useGrouping: false },
  value: 1,
};
const textOptions = {
  ...rollingMotion,
  animated: motionActive("rollingText"),
  transition: "direct" as const,
  stagger: "none" as const,
};
const selectionTitle = createRollingText($("#selected-title"), {
  ...textOptions,
  text: $("#selected-title").textContent ?? "",
});
const columnTitle = createRollingText($("#column-name"), {
  ...textOptions,
  text: $("#column-name").textContent ?? "",
});
const hoverTitle = createRollingText($("#hover-title"), { ...textOptions, text: "" });
const categoryTitle = createRollingText($("#archive-category"), {
  ...textOptions,
  text: $("#archive-category").textContent ?? "",
});
const clearanceTitle = createRollingText($("#selected-clearance"), {
  ...textOptions,
  text: $("#selected-clearance").textContent ?? "",
});
const rollingTitles = [selectionTitle, columnTitle, hoverTitle, categoryTitle, clearanceTitle];
const selectedCode = createRollingNumber($("#selected-code"), codeOptions);
const hoverCode = createRollingNumber($("#hover-code"), codeOptions);
const audio = new TerminalAudio();
let musicSuppressed = false;
function configureAudio() { audio.configure({ ...prefs, music: prefs.music && !musicSuppressed }); }
configureAudio();
// Local music: the library index lives in IndexedDB, playback in its own audio
// graph, and the analyser is folded into the archive music reaction.
const musicLibrary = new MusicLibrary();
const musicPlayer = new MusicPlayer({
  resolve: async (id) => {
    const track = musicLibrary.tracks.find((item) => item.id === id);
    if (!track) return null;
    const file = await musicLibrary.file(track);
    if (file) return file;
    // A remembered directory handle may need a fresh gesture to be readable.
    if (musicLibrary.persistent && (await musicLibrary.reconnect().catch(() => false)))
      return musicLibrary.file(track);
    return null;
  },
  coverUrl: async (id) => {
    const track = musicLibrary.tracks.find((item) => item.id === id);
    return track ? musicLibrary.coverUrl(track) : null;
  },
  volume: () => prefs.localMusicVolume,
  onState: () => syncMusicIndicators(),
  onBands: (bands) => applyMusicBands(bands),
  onActiveChange: (active) => {
    audio.setLocalMusicActive(active);
    if (!active && scene && !isWallpaper) scene.setPlayfield(false, quietBands(), 1, 0, null, true);
  },
  onError: (message) => notify(message),
  onTrackChange: () => syncMusicIndicators(),
});
const musicPanel = new MusicPanel();
musicLibrary.bridgeCoverUrl = (id) => musicBridge.coverUrl(id);
// VLC bridge: when connected it owns decoding and playback; the PCM it taps
// from VLC's decoded output drives the same archive reaction as the browser path.
const bridgeEnvelope = new SpectrumEnvelope();
let bridgeHealth: BridgeHealth | null = null;
let bridgeStatus: { state: string; currentId: string | null } | null = null;
let bridgeStatusElapsed = 1;
let bridgeStatusBusy = false;
const musicBridge = new MusicBridge({
  port: prefs.vlcPort,
  token: prefs.vlcToken,
  onBands: (samples) => bridgeEnvelope.ingest(samples, performance.now() / 1000),
  onState: (status) => {
    const wasPlaying = bridgeStatus?.state === "playing";
    bridgeStatus = { state: status.state, currentId: status.currentId };
    if (status.state === "playing" && !wasPlaying) audio.setLocalMusicActive(true);
    if (status.state !== "playing" && wasPlaying) audio.setLocalMusicActive(false);
  },
  onConnectionChange: (connected, health) => {
    bridgeHealth = health;
    if (!connected) bridgeStatus = null;
    bridgeStatusElapsed = connected ? .75 : 1;
    syncMusicIndicators();
    refreshMusicSettings();
  },
});
async function refreshBridgeStatus() {
  if (!musicBridge.connected || bridgeStatusBusy) return;
  bridgeStatusBusy = true;
  try {
    const status = await musicBridge.status();
    bridgeStatus = status
      ? { state: status.state, currentId: status.currentId }
      : { state: "stopped", currentId: null };
  } finally {
    bridgeStatusBusy = false;
  }
}
async function loadBridgeLibrary() {
  const tracks = await musicBridge.library().catch(() => []);
  musicLibrary.useBridgeTracks(tracks, bridgeHealth?.root ?? "VLC 桥接");
  musicPanel.refreshLibrary();
  refreshMusicSettings();
  onLibraryMayHaveChanged();
  return tracks.length;
}
async function connectMusicBridge(silent = false) {
  const health = await musicBridge.connect();
  if (health) {
    const count = await loadBridgeLibrary();
    if (!silent) notify(`已连接 VLC 内核：${count} 首曲目`);
  } else if (!silent) {
    notify(musicBridge.error || "未检测到本地 VLC 桥接服务");
  }
  refreshMusicSettings();
  return health;
}
function abandonLauncherHandoff() {
  if (!launcherHandoffPending) return;
  if (launcherBridge && prefs.vlcPort === launcherBridgePort && prefs.vlcToken === launcherBridgeToken) {
    prefs.vlcPort = storedPrefs.vlcPort ?? 8788;
    prefs.vlcToken = storedPrefs.vlcToken ?? "";
  }
  writeLauncherSession(null);
  launcherSession = null;
  launcherHandoffPending = false;
}
async function setMusicEngine(engine: "browser" | "vlc") {
  if (prefs.musicEngine === engine) return;
  prefs.musicEngine = engine;
  if (launcherSession) {
    launcherSession = { ...launcherSession, autoConnect: engine === "vlc" };
    writeLauncherSession(launcherSession);
  }
  saveAudioPrefs();
  if (engine === "vlc") {
    if (!musicBridge.connected) await connectMusicBridge();
    else await loadBridgeLibrary();
  } else {
    musicBridge.disconnect();
    bridgeStatus = null;
    audio.setLocalMusicActive(false);
    await musicLibrary.restore().catch(() => false);
    musicPanel.refreshLibrary();
    notify("已切换为浏览器内核");
  }
  refreshMusicSettings();
}

// ------------------------------------------------------ library mode (2.0)
// The archive array can present the local music library instead of the Rhine
// archive. Both are ArchiveViews; the scene and the loop math read the active
// view, so a mode switch is a data swap plus a re-selection.
const view = () => activeView();
const columnMemory: Record<"archive" | "music", number[]> = {
  archive: rhineView.columns.map((_, lane) => rhineView.columnFiles(lane)[0] ?? 0),
  music: [],
};
let musicViewCache: ArchiveView | null = null;
let musicViewGrouping: MusicGrouping | null = null;
let musicViewTracks: readonly unknown[] | null = null;
function musicView(): ArchiveView {
  if (!musicViewCache || musicViewGrouping !== prefs.musicGrouping || musicViewTracks !== musicLibrary.tracks) {
    musicViewCache = buildMusicView(musicLibrary.tracks, prefs.musicGrouping);
    musicViewGrouping = prefs.musicGrouping;
    musicViewTracks = musicLibrary.tracks;
  }
  return musicViewCache;
}
function memoryFor(v: ArchiveView) {
  const mem = columnMemory[v.kind];
  if (mem.length !== v.columns.length) {
    columnMemory[v.kind] = v.columns.map((_, lane) => mem[lane] ?? v.columnFiles(lane)[0] ?? 0);
  }
  return columnMemory[v.kind];
}
let fileTicks: HTMLButtonElement[] = [];
function refreshFileTicks() {
  const v = view();
  $("#file-ticks").innerHTML = v.columnFiles(v.fileLocation(selected).lane).map((index) => `<button data-select="${index}"></button>`).join("");
  fileTicks = [...$("#file-ticks").querySelectorAll<HTMLButtonElement>("button")];
}
function rowSpacingForView(v: ArchiveView = activeView()) {
  return v.kind === "music" ? prefs.musicRowSpacing : ROW_SPACING_MIN;
}
function applyRowSpacing(immediate = false) {
  scene?.setRowSpacing(rowSpacingForView(), immediate);
}
function applyView(v: ArchiveView, preferBackingId?: string) {
  setActiveView(v);
  applyRowSpacing();
  const mem = memoryFor(v);
  const preferred = preferBackingId ? v.records.findIndex((_, i) => v.backingId(i) === preferBackingId) : -1;
  if (preferred >= 0) {
    selected = preferred;
  } else {
    const lane = Math.min(v.fileLocation(Math.min(selected, v.records.length - 1)).lane, v.columns.length - 1);
    selected = mem[lane] ?? v.columnFiles(0)[0] ?? 0;
  }
  filter = "全部档案";
  refreshFileTicks();
  scene?.select(selected);
  updateSelection();
  syncLibraryModeUI();
}
const currentBackingId = () => view().backingId(selected);

// ------------------------------------------------------ cover art (2.0)
// The atlas packs every track's cover so each card in the array samples one
// tile through its per-instance index; art decodes asynchronously and fills in.
const coverAtlas = new CoverAtlas();
const coverRequested = new Set<string>();
const coverLoading = new Set<string>();
const coverRetryAt = new Map<string, number>();
function coverTileFor(recordIndex: number): number {
  const v = view();
  if (v.kind !== "music") return 0;
  const track = (v as MusicArchiveView).musicTracks[recordIndex];
  if (!track) return 0;
  const tile = coverAtlas.tileFor(track.id);
  const retryAt = coverRetryAt.get(track.id) ?? 0;
  if (track.hasCover && performance.now() >= retryAt && !coverAtlas.filled.has(track.id) && !coverRequested.has(track.id) && !coverLoading.has(track.id)) {
    coverLoading.add(track.id);
    void loadCoverIntoAtlas(track);
  }
  return tile;
}
async function loadCoverIntoAtlas(track: LibraryTrack) {
  try {
    const url = await musicLibrary.coverUrl(track);
    if (!url) {
      coverRetryAt.set(track.id, performance.now() + 2000);
      return;
    }
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("cover image failed to load"));
      image.src = url;
    });
    coverAtlas.fill(track.id, image);
    coverRequested.add(track.id);
    coverRetryAt.delete(track.id);
  } catch {
    // Avoid retrying a missing cover on every visible instance every frame.
    coverRetryAt.set(track.id, performance.now() + 2000);
  } finally {
    coverLoading.delete(track.id);
  }
}
const labelCoverTried = new Set<string>();
const labelCoverLoading = new Set<string>();
function requestLabelCover(recordIndex: number) {
  const v = view();
  if (v.kind !== "music" || !scene) return;
  const track = (v as MusicArchiveView).musicTracks[recordIndex];
  if (!track?.hasCover || labelCoverTried.has(track.id) || labelCoverLoading.has(track.id)) return;
  labelCoverLoading.add(track.id);
  void (async () => {
    try {
      const url = await musicLibrary.coverUrl(track);
      if (!url) return;
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("cover image failed to load"));
        image.src = url;
      });
      labelCoverTried.add(track.id);
      if (view().kind === "music" && selected === recordIndex) scene?.redrawLabel(recordIndex, image);
    } catch {
      // A missing cover is retried when the selection is revisited.
    } finally {
      labelCoverLoading.delete(track.id);
    }
  })();
}
function setLibraryMode(mode: "archive" | "music") {
  if (prefs.libraryMode === mode) return;
  if (mode === "music" && !musicLibrary.tracks.length) {
    notify("曲库为空：先在「设置 → 本地音乐」选择目录，或连接 VLC 内核");
    return;
  }
  prefs.libraryMode = mode;
  saveAudioPrefs();
  applyView(mode === "music" ? musicView() : rhineView);
  notify(mode === "music" ? `音乐库 · ${view().columns.length} 列 · ${view().records.length} 首` : "莱茵档案库");
  audio.play("column");
}
function setMusicRowSpacing(value: number, persist: boolean) {
  prefs.musicRowSpacing = clampRowSpacing(value);
  applyRowSpacing();
  const output = document.querySelector<HTMLOutputElement>("[data-music-spacing-output]");
  if (output) output.value = prefs.musicRowSpacing.toFixed(2);
  if (persist) saveAudioPrefs();
}
function setMusicGrouping(grouping: MusicGrouping) {
  if (prefs.musicGrouping === grouping) return;
  prefs.musicGrouping = grouping;
  saveAudioPrefs();
  const backing = currentBackingId();
  musicViewCache = null;
  if (prefs.libraryMode === "music") applyView(musicView(), backing);
  refreshMusicSettings();
}
function onLibraryMayHaveChanged() {
  if (prefs.libraryMode !== "music") return;
  if (!musicLibrary.tracks.length) {
    prefs.libraryMode = "archive";
    saveAudioPrefs();
    applyView(rhineView);
    notify("曲库已清空，回到莱茵档案库");
    return;
  }
  const backing = currentBackingId();
  musicViewCache = null;
  applyView(musicView(), backing);
}
function syncLibraryModeUI() {
  const music = activeView().kind === "music";
  $("#library-mode-label").textContent = music ? "MUSIC 音乐库" : "ARCHIVE 档案库";
  $<HTMLButtonElement>('[data-action="library-mode"]').setAttribute("aria-pressed", String(music));
  $<HTMLButtonElement>('[data-action="saved"]').toggleAttribute("hidden", music);
}
const musicHost = {
  library: musicLibrary,
  player: musicPlayer,
  bridge: musicBridge,
  engine: () => prefs.musicEngine,
  onSound: (sound: Parameters<typeof audio.play>[0], pan?: number) => audio.play(sound, pan),
  onNotify: (message: string) => notify(message),
  onOpenSettings: () => closeModal(() => openModal("settings")),
  onLibraryChanged: () => { refreshMusicSettings(); onLibraryMayHaveChanged(); },
  onVolumeChange: (value: number) => {
    prefs.localMusicVolume = value;
    saveAudioPrefs();
  },
  get motion() {
    return motionActive("surfaceTransitions");
  },
};
musicPanel.attach(musicHost);
let lastMusicBands: MusicBands = quietBands();
function syncMusicIndicators() {
  const state = musicPlayer.state();
  const node = document.querySelector("#music-nav-state");
  if (node) node.textContent = state.playing ? "PLAYING" : state.id ? "PAUSED" : "OFF";
  document.querySelector('[data-action="music"]')?.classList.toggle("playing", state.playing);
}
/** Feeds the archive scene's existing music reaction with the local track. */
function applyMusicBands(bands: MusicBands) {
  lastMusicBands = bands;
  if (!scene || isWallpaper) return;
  const reactive = prefs.musicReactive && motionActive("musicReaction") && !motionIsReduced();
  scene.setPlayfield(reactive, reactive ? bands : quietBands(), 1, 0, null, true);
}
function musicSettingsState() {
  return {
    engine: prefs.musicEngine,
    bridgeConnected: musicBridge.connected,
    bridgePort: prefs.vlcPort,
    bridgeToken: prefs.vlcToken,
    bridgeInfo: bridgeHealth
      ? { root: bridgeHealth.root, tracks: bridgeHealth.tracks, vlc: bridgeHealth.vlc?.version ?? "" }
      : null,
    bridgeError: musicBridge.error,
    reactive: prefs.musicReactive,
    rhythm: prefs.musicRhythm,
    grouping: prefs.musicGrouping,
    rowSpacing: prefs.musicRowSpacing,
  };
}
function refreshMusicSettings() {
  const node = document.querySelector("[data-music-settings]");
  if (!node) return;
  const panel = node.closest<HTMLElement>(".settings-modal");
  const scroll = panel?.scrollTop ?? 0;
  node.outerHTML = musicSettingsMarkup(musicLibrary, musicSettingsState());
  if (panel) panel.scrollTop = scroll;
}
async function runMusicSetting(action: string) {
  if (action === "pick") {
    if (prefs.musicEngine === "vlc") {
      notify("VLC 内核下由桥接服务扫描目录，请改用「浏览器内核」或重新指定 --root");
      return;
    }
    try {
      await musicLibrary.pick();
      notify(`已选择目录：${musicLibrary.label}`);
      await musicPanel.startScan();
    } catch (e) {
      notify(e instanceof Error && e.message === "permission" ? "目录权限被拒绝" : "已取消选择目录");
    }
    return;
  }
  if (action === "scan") {
    await musicPanel.startScan();
    return;
  }
  if (action === "clear") {
    musicPlayer.stop();
    await musicLibrary.clear();
    refreshMusicSettings();
    notify("已清除本地曲库索引");
    audio.play("confirm");
  }
}
const reviewEntry = reviewParams.has("scene") || validReviewTime || reviewParams.get("review") === "1";
let started = false;
const loading = $("#loading");
// The entry screen uses the actual viewport, including portrait phones; the
// reference animation still uses its calibrated 1920 x 1080 stage.
$("#viewport").append(loading);
$("#stage").inert = true;
$(".mobile-entry").inert = true;
const entry = !isWallpaper && !reviewEntry && (prefs.sound || prefs.music) ? new StartupGate({
  root: loading,
  unlock: () => audio.unlock(),
  cancel: () => audio.cancelEntry(),
  start: silent => completeStartup(silent),
}) : undefined;
if (entry) {
  audio.holdForEntry();
  if (prefs.music) void audio.prepareMusic().catch(() => { /* Entry offers retry. */ });
}
let audioPreview = false, audioPreviewRequest = 0;
let scene: ArchiveScene | undefined;
let threeState: "on" | "closing" | "off" | "loading" = "on";
let resumeCell: { lane: number; row: number } | undefined;
let resumeSelection = -1;
let viewer: ModelViewer | undefined;
const accessLog: { id: string; time: string }[] = [];
function recordAccess() {
  accessLog.unshift({
    id: view().records[selected].id,
    time: new Date().toLocaleTimeString("en-GB"),
  });
}
function saveAudioPrefs() {
  const launcherCredentialsActive =
    launcherHandoffPending &&
    launcherBridge &&
    prefs.vlcPort === launcherBridgePort &&
    prefs.vlcToken === launcherBridgeToken;
  const persistedPrefs = launcherCredentialsActive
    ? {
        ...prefs,
        vlcPort: storedPrefs.vlcPort ?? 8788,
        vlcToken: storedPrefs.vlcToken ?? "",
      }
    : prefs;
  try {
    localStorage.setItem("rhine-settings", JSON.stringify(persistedPrefs));
  } catch {}
  configureAudio();
}
function superPerformanceEnabled() { return isWallpaper ? wallpaperHost()?.properties.superperformance?.value === true : prefs.superPerformance; }
function effectiveRenderQuality() { return superPerformanceEnabled() ? superPerformanceQuality : prefs.rendering; }
function savePrefs() {
  saveAudioPrefs();
  if (!motionActive("rollingText")) rollingTitles.forEach(title => title.finish());
  if (!motionActive("rollingNumbers")) [fileCounter, columnCounter, selectedCode, hoverCode].forEach(counter => counter.finish());
  if (!motionActive("surfaceTransitions")) {
    detailTransition.finish();
    modalTransition?.finish();
    tabTransition.finish();
    bookmarkFeedback?.cancel();
  }
  scene?.setMotion(prefs.motion);
  scene?.setTheme(prefs.colorTheme === "dark", !motionActive("surfaceTransitions") || !started);
  document.querySelectorAll<HTMLElement>("[data-color-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.colorTheme === prefs.colorTheme)));
  scene?.setSuperPerformance(superPerformanceEnabled());
  viewer?.setSuperPerformance(superPerformanceEnabled());
  scene?.setQuality(effectiveRenderQuality());
  viewer?.setQuality(effectiveRenderQuality());
  viewer?.setMotion(prefs.motion);
  syncQualityUI(prefs.rendering);
  updateQualitySummary();
  fileCounter.update({ animated: motionActive("rollingNumbers") && mode === "archive" });
  rollingTitles.forEach(title => title.update({ animated: motionActive("rollingText") && mode === "archive" }));
  columnCounter.update({ animated: motionActive("rollingNumbers") && mode === "archive" });
  selectedCode.update({ animated: motionActive("rollingNumbers") && mode === "archive" });
  hoverCode.update({ animated: motionActive("rollingNumbers") && mode === "archive" });
  $("#stage").classList.toggle("reduce-motion", motionIsReduced());
  $("#stage").classList.toggle("reduce-surfaces", !motionActive("surfaceTransitions"));
  workbench?.setMotion(prefs.motion);
  updateFooterClock(new Date(), motionActive("rollingNumbers"));
  syncWallpaperBackground();
}
let previousLayout = "";
function fit() {
  const stage = $("#stage");
  const viewport = $("#viewport");
  const coarse = matchMedia("(pointer: coarse)").matches;
  const reference = validReviewTime || reviewParams.get("review") === "1";
  const { width, height, scale, kind } = mode === "boot" && !reference
    ? openingLayout(viewport.clientWidth, viewport.clientHeight)
    : viewportLayout(viewport.clientWidth, viewport.clientHeight, coarse, mode === "boot");
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  stage.dataset.layout = kind;
  stage.dataset.touch = String(coarse);
  viewport.dataset.mobileBoot = String(mode === "boot" && (coarse || viewport.clientWidth < 1100));
  stage.style.setProperty("--stage-scale", String(scale));
  stage.style.setProperty("--opening-width", `${width}px`);
  stage.style.setProperty("--opening-height", `${height}px`);
  stage.style.setProperty("--opening-scan-scale", String(Math.min(1, width / 1920)));
  stage.dataset.openingPortrait = String(width < height);
  // The software keyboard resizes dialogs without recomposing the 3D scene.
  const visible = window.visualViewport;
  const stageTop = (viewport.clientHeight - height * scale) / 2;
  stage.style.setProperty("--modal-top", `${Math.max(0, (visible?.offsetTop ?? 0) - stageTop) / scale}px`);
  stage.style.setProperty("--modal-height", `${Math.min(height, (visible?.height ?? viewport.clientHeight) / scale)}px`);
  $("#viewport").style.setProperty("--scale", String(scale));
  const marks = document.querySelector("#inspection-marks");
  marks?.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const layoutKey = JSON.stringify([width, height, scale, kind, devicePixelRatio]);
  if (layoutKey !== previousLayout) {
    previousLayout = layoutKey;
    scene?.resize();
    viewer?.resize();
  }
  updateQualitySummary();
  // Re-measure line covers and tab underline after wrapping changes.
  requestAnimationFrame(() => {
    documentDecryption.refresh();
    const tab = document.querySelector<HTMLElement>(".detail-tabs button.active");
    const indicator = document.querySelector<HTMLElement>(".tab-indicator");
    if (tab && indicator) indicator.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
  });
}
window.addEventListener("resize", fit);
window.visualViewport?.addEventListener("resize", fit);
window.visualViewport?.addEventListener("scroll", fit);
matchMedia("(pointer: coarse)").addEventListener("change", fit);
fit();
refreshFileTicks();

function setMode(next: Mode) {
  if (workbench?.enabled && next === "detail") next = "archive";
  const previousMode = mode;
  rollingTitles.forEach(title => title.update({ animated: motionActive("rollingText") && next === "archive" }));
  if (next !== "archive") {
    rollingTitles.forEach(title => title.finish());
    hoverCode.finish();
    $("#hover-label").hidden = true;
  }
  if (next === "detail" && mode !== "detail") recordAccess();
  mode = next;
  syncWallpaperBackground();
  audio.setScene(next);
  if (next !== "boot" && audioPreview) {
    audioPreview = false;
    audioPreviewRequest++;
    configureAudio();
  }
  $("#stage").dataset.mode = next;
  workbench?.syncVisibility();
  if (previousMode !== next) fit();
  $("#boot").inert = next !== "boot";
  $("#boot").setAttribute("aria-hidden", String(next !== "boot"));
  $("#archive-ui").inert = next !== "archive" || Boolean(modal) || Boolean(workbench?.enabled);
  $("#archive-ui").setAttribute("aria-hidden", String(next !== "archive" || Boolean(workbench?.enabled)));
  $(".system-nav").inert = next === "boot" || Boolean(modal);
  $(".system-footer").inert = next === "boot" || Boolean(modal);
  if (next === "detail") {
    if (previousMode !== "detail") detailTransition.show(!motionActive("surfaceTransitions"));
  } else if (previousMode === "detail" || (next === "boot" && !$("#detail-ui").hidden)) {
    pendingDetailFocus = false;
    tabTransition.cancel();
    detailTransition.hide(!motionActive("surfaceTransitions") || next === "boot");
    if (!modal && next === "archive") $(".read-file").focus({ preventScroll: true });
  }
  $("#detail-ui").inert = next !== "detail" || Boolean(modal);
  scene?.setMode(next === "boot" ? "hidden" : next);
  if (next !== "boot") {
    bootSequence.reset();
    $(".file-title").firstChild!.textContent = "FILE NUMBER: ";
    $("#stage").dataset.boot = "done";
  }
  if (next === "detail" && previousMode !== "detail") {
    renderDetail();
    pendingDetailFocus = true;
    if (!scene) {
      $("#detail-content").style.opacity = "1";
      $("#detail-content").style.translate = "0 0";
      $("#detail-content").inert = false;
    }
  }
}
function select(index: number, navigation?: ArchiveNavigation) {
  const v = view();
  selected = (index + v.records.length) % v.records.length;
  memoryFor(v)[v.fileLocation(selected).lane] = selected;
  if (mode === "detail") setMode("archive");
  activeTab = "overview";
  scene?.select(selected, navigation);
  updateSelection(navigation);
  const columnMove = navigation && "axis" in navigation && navigation.axis === "lane";
  audio.play(columnMove ? "column" : "tick", columnMove ? navigation.direction * .45 : 0);
}
function stepFile(direction: number) {
  const files = view().columnFiles(view().fileLocation(selected).lane);
  if (files.length < 2) return;
  select(
    files[(files.indexOf(selected) + direction + files.length) % files.length],
    { axis: "row", direction },
  );
}
function stepColumn(direction: number) {
  const v = view();
  const lane = v.fileLocation(selected).lane;
  const next = wrap(lane + direction, v.columns.length);
  select(memoryFor(v)[next], { axis: "lane", direction });
}
function updateSelection(navigation?: ArchiveNavigation) {
  const v = view();
  const r = v.records[selected];
  const { lane } = v.fileLocation(selected);
  const files = v.columnFiles(lane);
  $("#selected-prefix").textContent = r.id.slice(0, 2);
  selectionTitle.update({ text: r.title, animated: motionActive("rollingText") && mode === "archive" });
  clearanceTitle.update({ text: r.clearance, animated: motionActive("rollingText") && mode === "archive" });
  categoryTitle.update({ text: r.category, animated: motionActive("rollingText") && mode === "archive" });
  const direction =
    navigation && "axis" in navigation
      ? navigation.direction > 0
        ? "up"
        : "down"
      : "auto";
  selectedCode.update({
    value: Number(r.id.slice(2)),
    animated: motionActive("rollingNumbers") && mode === "archive",
    direction,
  });
  fileCounter.update({
    value: files.indexOf(selected) + 1,
    animated: motionActive("rollingNumbers") && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "row"
        ? direction
        : "auto",
  });
  $(".count-total").textContent = String(files.length).padStart(2, "0");
  columnCounter.update({
    value: lane + 1,
    animated: motionActive("rollingNumbers") && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "lane"
        ? direction
        : "auto",
  });
  $("#column-total").textContent = String(v.columns.length).padStart(2, "0");
  columnTitle.update({ text: v.columns[lane], animated: motionActive("rollingText") && mode === "archive" });
  $<HTMLButtonElement>('[data-action="column-prev"]').disabled = false;
  $<HTMLButtonElement>('[data-action="column-next"]').disabled = false;
  fileTicks.forEach((button, slot) => {
    const index = files[slot], record = v.records[index];
    if (record === undefined) return;
    button.dataset.select = String(index);
    button.setAttribute("aria-label", `选择档案 ${record.id} ${record.title}`);
    button.title = `${record.id} · ${record.title}`;
    button.classList.toggle("selected", index === selected);
    button.setAttribute("aria-pressed", String(index === selected));
  });
  $("#saved-count").textContent = String(saved.size).padStart(2, "0");
  if (v.kind === "music") requestLabelCover(selected);
}
function replayBoot(forcePreview = false) {
  if (!ready) return;
  closeModal(() => replayBootAfterModal(forcePreview));
}
function replayBootAfterModal(forcePreview: boolean) {
  bootStart = performance.now() / 1000 - 1.76;
  frozenTime = null;
  lastStep = "";
  setMode(!motionActive("boot") && !forcePreview ? "archive" : "boot");
  audio.restartBoot();
  scene?.select(0);
  selected = 0;
  updateSelection();
  if (!forcePreview) audio.play("ui-tick");
}
function musicPlayerTrack(track: LibraryTrack) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    codec: track.codec,
  };
}
async function playSelectedMusicArchive() {
  if (activeView().kind !== "music") return;
  const musicView = activeView() as MusicArchiveView;
  const track = musicView.musicTracks[selected] ?? musicLibrary.tracks.find((item) => item.id === musicView.backingId(selected));
  if (!track) {
    notify("当前音乐档案没有对应曲目");
    return;
  }
  if (prefs.musicEngine === "vlc" || track.bridge) {
    if (prefs.musicEngine !== "vlc" || !musicBridge.connected) {
      notify("VLC 桥接未连接，无法播放当前曲目");
      return;
    }
    const status = await musicBridge.play(track.id).catch(() => null);
    if (status) {
      bridgeStatus = { state: status.state, currentId: status.currentId };
      syncMusicIndicators();
      notify(`正在播放：${track.title}`);
    } else {
      notify(musicBridge.error || "VLC 无法播放当前曲目");
    }
    return;
  }
  musicPlayer.queueTracks(musicLibrary.tracks.map(musicPlayerTrack));
  await musicPlayer.play(track);
  if (musicPlayer.state().id === track.id && !musicPlayer.state().error) notify(`正在播放：${track.title}`);
}
function openFile() {
  if (!ready) return;
  closeModal(() => {
    setMode("detail");
    audio.play("open");
    void playSelectedMusicArchive();
  });
}
function toggleSaved() {
  if (view().kind === "music") return;
  const id = view().records[selected].id;
  if (saved.has(id)) saved.delete(id);
  else saved.add(id);
  try {
    localStorage.setItem("rhine-saved", JSON.stringify([...saved]));
  } catch {}
  $("#saved-count").textContent = String(saved.size).padStart(2, "0");
  const button = $<HTMLButtonElement>('[data-action="bookmark"]');
  const added = saved.has(id);
  button.firstChild!.textContent = added ? "− REMOVE FROM SAVED" : "＋ SAVE ARCHIVE";
  button.querySelector("span")!.textContent = added ? "已收藏" : "收藏档案";
  button.setAttribute("aria-pressed", String(added));
  bookmarkFeedback?.cancel();
  if (motionActive("surfaceTransitions")) bookmarkFeedback = button.animate(
    [{ backgroundColor: "#67634c" }, { backgroundColor: "#252820" }],
    { duration: 220, easing: "ease-out" },
  );
  audio.play("confirm");
  notify(saved.has(id) ? "档案已加入收藏" : "已取消收藏");
}
function renderDetail() {
  tabTransition.cancel();
  const v = view();
  const r = v.records[selected];
  const isMusic = v.kind === "music";
  $("#object-id").textContent = "NO." + String(selected + 1).padStart(3, "0");
  const actions = isMusic
    ? `<div class="detail-actions"><button class="export-button" data-action="export-track" aria-label="导出 ${r.id} 曲目信息">EXPORT <span>↓</span></button></div>`
    : `<div class="detail-actions"><button class="solid-button" data-action="bookmark">${saved.has(r.id) ? "− REMOVE FROM SAVED" : "＋ SAVE ARCHIVE"}<span>${saved.has(r.id) ? "已收藏" : "收藏档案"}</span></button><a class="export-button" href="${assetUrl(`archives/RHINE-LAB-${r.id}.txt`)}" download="RHINE-LAB-${r.id}.txt" aria-label="导出 ${r.id} 档案">EXPORT <span>↓</span></a></div>`;
  $("#detail-content").classList.toggle("music-detail", isMusic);
  $("#detail-content").innerHTML = `
  <div class="detail-kicker"><span>FILE ${r.id}</span><span>${escapeHtml(r.clearance)}</span></div>
  <h2>${escapeHtml(isMusic ? r.title : r.en)}</h2><div class="detail-title-cn">${escapeHtml(isMusic ? r.en : r.title)}<span>${escapeHtml(r.category)}</span></div>
  <div class="detail-rule"></div>
  <dl class="metadata"><div><dt>${isMusic ? "ALBUM / 专辑" : "DEPARTMENT / 科室"}</dt><dd>${escapeHtml(r.department)}</dd></div><div><dt>${isMusic ? "YEAR / 年份" : "COLLECTION / 编目范围"}</dt><dd>${escapeHtml(r.date)}</dd></div><div><dt>${isMusic ? "ARTIST / 艺术家" : "RELATED / 相关人物"}</dt><dd>${escapeHtml(r.lead)}</dd></div><div><dt>STATUS / 状态</dt><dd><i></i>${r.clearance === "RESTRICTED" ? "目录访问" : "已归档 · 可读取"}</dd></div></dl>
  <div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>${isMusic ? "曲目信息" : "概述"}</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">02 <span>${isMusic ? "文件详情" : "研究记录"}</span></button><button id="tab-history" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="history">03 <span>访问日志</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
  <div id="tab-panel" class="tab-panel" role="tabpanel">${overview()}</div>
  ${actions}
  <div class="detail-footnote">${r.source ? `<a href="${escapeHtml(r.source)}" target="_blank" rel="noopener">设定参考 ↗</a>` : "<i></i>"}<span>${String(selected + 1).padStart(3, "0")} / ${String(v.records.length).padStart(3, "0")}</span></div>`;
  $("#detail-content").setAttribute("tabindex", "-1");
  if (!isMusic) $('[data-action="bookmark"]').setAttribute("aria-pressed", String(saved.has(r.id)));
  documentDecryption.reset($("#detail-content"), !motionActive("documentReveal") || !scene || scene.decryptionFrame.phase === "clear");
  setTab(activeTab, false);
}
function overview() {
  const v = view();
  const label = v.kind === "music" ? "TRACK / 曲目" : "ABSTRACT / 摘要";
  return `<div class="panel-label">${label}</div><p>${escapeHtml(v.records[selected].abstract)}</p>`;
}
function downloadTextFile(name: string, text: string) {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" }));
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function setTab(tab: string, sound = true) {
  if (sound && tab === activeTab) return;
  activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    const active = (b as HTMLElement).dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.setAttribute("tabindex", active ? "0" : "-1");
  });
  const r = view().records[selected];
  const tabButton = $<HTMLButtonElement>(`[data-tab="${tab}"]`);
  const indicator = $(".tab-indicator");
  indicator.style.transition = sound && motionActive("surfaceTransitions") ? "" : "none";
  indicator.style.transform = `translateX(${tabButton.offsetLeft}px) scaleX(${tabButton.offsetWidth})`;
  $("#tab-panel").setAttribute("aria-labelledby", tabButton.id);
  $("#tab-panel").innerHTML =
    tab === "overview"
      ? overview()
      : tab === "notes"
        ? `<div class="panel-label">RESEARCH NOTES / 研究记录</div><ol class="research-notes">${r.findings.map((f, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span>${escapeHtml(f)}</li>`).join("")}</ol>`
        : `<div class="panel-label">ACCESS LOG / 本次访问</div>${accessLog
            .filter((entry) => entry.id === r.id)
            .slice(0, 4)
            .map(
              (entry) =>
                `<div class="log-row"><span>${entry.time}</span><span>JOYCE MOORE</span><b>READ AUTHORIZED</b></div>`,
            )
            .join(
              "",
            )}<p class="log-note">本次会话已通过身份验证。档案内容以当前终端可访问范围展示。</p>`;
  $("#tab-panel").scrollTop = 0;
  documentDecryption.refresh();
  if (sound) {
    tabTransition.reveal($("#tab-panel"), !motionActive("surfaceTransitions"));
    audio.play("ui-tick");
  }
}
function notify(message: string) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function openModal(kind: NonNullable<typeof modal>) {
  if (!ready) return;
  if (!modal) {
    previousFocus = document.activeElement as HTMLElement;
    modalSiblings = [...$("#stage").children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== "modal-root")
      .map((node) => ({ node, inert: node.inert }));
    modalSiblings.forEach(({ node }) => (node.inert = true));
  }
  modalClosing = false;
  modal = kind;
  searchQuery = "";
  filter = "全部档案";
  audio.play("page-open");
  renderModal();
}
function closeModal(afterClose?: () => void) {
  if (!modal) {
    afterClose?.();
    return;
  }
  if (modalClosing) return;
  modalClosing = true;
  audio.play("page-close");
  modalTransition!.hide(!motionActive("surfaceTransitions"), () => {
    modal = null;
    modalClosing = false;
    musicPanel.unmount();
    $("#modal-root").replaceChildren();
    modalTransition = undefined;
    modalSiblings.forEach(({ node, inert }) => (node.inert = inert));
    modalSiblings = [];
    $("#archive-ui").inert = mode !== "archive" || Boolean(workbench?.enabled);
    $("#detail-ui").inert = mode !== "detail";
    previousFocus?.focus({ preventScroll: true });
    afterClose?.();
  });
}
function renderModal() {
  if (!modal) return;
  modalTransition?.dispose();
  const modalTitle =
    modal === "settings"
      ? "SYSTEM PREFERENCES"
      : modal === "music"
        ? "LOCAL MUSIC LIBRARY"
        : "ARCHIVE DIRECTORY";
  const modalLabel =
    modal === "settings" ? "系统设置" : modal === "music" ? "本地音乐" : modal === "saved" ? "收藏档案" : "档案检索";
  const modalBody =
    modal === "settings"
      ? settingsMarkup()
      : modal === "music"
        ? `<h2>LOCAL MUSIC<small>本地音乐检索与播放</small></h2><div id="music-panel" class="music-panel"></div>`
        : `<h2>${modal === "saved" ? "SAVED ARCHIVES" : "ARCHIVE INDEX"}<small>${modal === "saved" ? "收藏档案" : view().kind === "music" ? "音乐库检索" : "内部档案检索"}</small></h2><div class="search-field"><span>⌕</span><input id="archive-search" type="search" autocomplete="off" placeholder="${view().kind === "music" ? "输入曲名、艺术家或专辑" : "输入档案编号、名称或科室"}" aria-label="检索档案"/><span class="key">ESC</span></div>${view().kind === "music" && view().columns.length > 12 ? "" : `<div class="category-filters">${view().categories.map((c, i) => `<button data-filter="${escapeHtml(c)}" class="${i === 0 ? "active" : ""}">${escapeHtml(c)}</button>`).join("")}</div>`}<div class="result-header"><span>${view().kind === "music" ? "TRACK / 曲目" : "FILE / 档案"}</span><span>${view().kind === "music" ? "ARTIST / 艺术家" : "DEPARTMENT / 科室"}</span><span>ACCESS</span></div><div id="search-results" class="search-results"></div><div class="modal-bottom"><span id="result-count"></span><span>INTERNAL DATABASE <i>●</i> CONNECTED</span></div>`;
  $("#modal-root").innerHTML = `<div class="modal-backdrop"><section class="terminal-modal${modal === "settings" ? " settings-modal" : ""}${modal === "music" ? " music-modal" : ""}" role="dialog" aria-modal="true" aria-label="${modalLabel}"><div class="modal-top"><span>RHINE LAB / ${modalTitle}</span><button data-action="close-modal" aria-label="关闭窗口">CLOSE <span>×</span></button></div>${modalBody}</section></div>`;
  const backdrop = $(".modal-backdrop");
  backdrop.hidden = true;
  modalTransition = new SurfaceTransition(backdrop, $(".terminal-modal"));
  modalTransition.show(!motionActive("surfaceTransitions"));
  if (modal === "settings") updateQualitySummary();
  if (modal === "music") {
    musicPanel.mount($("#music-panel"));
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) musicPanel.focusSearch();
    });
  } else if (modal !== "settings") {
    renderResults();
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $("#archive-search").focus();
    });
  } else
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $('[data-action="close-modal"]').focus();
    });
  $("#modal-root")
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
}
function renderResults() {
  const v = view();
  const isMusic = v.kind === "music";
  const results = v.records
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        (modal !== "saved" || saved.has(r.id)) &&
        (filter === "全部档案" || r.category === filter) &&
        `${r.id} ${r.title} ${r.en} ${r.department} ${r.lead}`
          .toLowerCase()
          .includes(searchQuery.toLowerCase()),
    );
  $("#search-results").innerHTML = results.length
    ? results
        .map(
          ({ r, i }) =>
            `<button class="result-row" data-result="${i}"><span class="result-name"><b>${r.id}</b><span>${escapeHtml(r.title)}<small>${escapeHtml(r.en)}</small></span>${!isMusic && saved.has(r.id) ? "<i>＋</i>" : ""}</span><span>${escapeHtml(isMusic ? r.en : r.department)}</span><span>${r.clearance === "RESTRICTED" ? "CATALOG ONLY" : "AUTHORIZED"} <i>↗</i></span></button>`,
        )
        .join("")
    : `<div class="empty-results"><span>∅</span><strong>${modal === "saved" && !searchQuery ? "尚无收藏档案" : isMusic ? "没有匹配的曲目" : "没有匹配的档案"}</strong><p>${modal === "saved" && !searchQuery ? "读取档案时，选择 SAVE ARCHIVE 将其保存在此处。" : isMusic ? "尝试其他曲名、艺术家或专辑名。" : "尝试其他名称、档案编号，或切换科室分类。"}</p><button data-action="reset-search">${modal === "saved" ? "查看全部档案 →" : "重置检索 →"}</button></div>`;
  $("#result-count").textContent =
    `${String(results.length).padStart(2, "0")} ${isMusic ? "TRACKS" : "RECORDS"} FOUND`;
}
function updateQualitySummary() {
  const summary = document.querySelector("#quality-summary");
  if (!summary) return;
  if (!scene) { summary.textContent = "3D 已关闭 · 三维模型与渲染资源已释放"; return; }
  const canvas = scene.renderer.domElement;
  const metrics = JSON.parse(canvas.parentElement?.dataset.renderQuality ?? "{}");
  summary.textContent = `${superPerformanceEnabled() ? "超级性能模式已启用 · 画质设置暂被覆盖，关闭后恢复 · " : ""}实际渲染 ${canvas.width} × ${canvas.height} · ${effectiveRenderQuality().antialias === "smaa" ? "SMAA" : "原始抗锯齿"} · 纹理 ${metrics.anisotropy ?? 1}×${metrics.limited ? " · 已达到缓冲上限" : ""}`;
}
function motionPreferenceNoteMarkup() {
  const preset = prefs.motionPreset;
  const allEnabled = Object.values(prefs.motion).every(Boolean);
  return `<div id="motion-preference-note" class="motion-preference-note"><p>${motionSummary(prefs.motion)}</p><span>预设：${preset === "full" ? "完整动画" : preset === "reduced" ? "减少动画" : "自定义"} · 选择会保存在本站</span>${allEnabled ? "" : '<button data-action="enable-motion">启用完整动画并重播 ↻</button>'}</div>`;
}
function settingsMarkup() {
  return `<h2>SYSTEM SETTINGS<small>终端偏好设置</small></h2><p class="settings-intro">JOYCE MOORE <span>·</span> SESSION AUTHORIZED</p>${isWallpaper ? '<p class="wallpaper-settings-note">每次启动都会读取 Wallpaper Engine 中的设置。在此修改仅对当前运行生效，无法持久保存；如需保留，请在 Wallpaper Engine 的壁纸属性中调整。</p>' : ""}<div class="settings-list">${themeSettingsMarkup(prefs.colorTheme === "dark")}${!isWallpaper ? `<label><div><strong>SUPER PERFORMANCE</strong><span>降低三维画质和渲染分辨率，保留完整动效；关闭后恢复原画质</span></div><input type="checkbox" data-pref="superPerformance" ${prefs.superPerformance ? "checked" : ""}/><i class="toggle"></i></label>` : ""}${workbench?.settingsMarkup() ?? ""}${audioSettingsMarkup(prefs)}${musicSettingsMarkup(musicLibrary, musicSettingsState())}</div>${motionPreferenceNoteMarkup()}${motionSettingsMarkup(prefs.motion, prefs.motionPreset)}${qualityMarkup(prefs.rendering)}${pwaSettingsMarkup()}<div class="settings-shortcuts">${isWallpaper ? '<span>DESKTOP CONTROLS</span><p>拖动阵列或点击界面按钮浏览档案。桌面模式下，方向键与滚轮可能无法传入壁纸。</p>' : '<span>KEYBOARD CONTROLS</span><p><kbd>←</kbd><kbd>→</kbd> 切列 <kbd>↑</kbd><kbd>↓</kbd> 选档 <kbd>ENTER</kbd> 读取 <kbd>/</kbd> 检索 <kbd>ESC</kbd> 返回</p>'}</div><div class="settings-bottom">${!isWallpaper && document.fullscreenEnabled ? '<button data-action="fullscreen">FULLSCREEN <span>↗</span></button>' : ''}<button data-action="restart">REINITIALIZE SYSTEM <span>↻</span></button></div><div class="modal-bottom"><span>ANALYSIS OS / 1.0 · 使用 MiSans 字体（小米） <a href="${assetUrl("fonts/MiSans-license.pdf")}" target="_blank" rel="noopener">字体许可</a></span><span>POWERED BY RHINE LAB</span></div>`;
}

document.addEventListener("input", (e) => {
  const slider = e.target as HTMLInputElement;
  if (slider.dataset.quality) {
    const output = document.querySelector<HTMLOutputElement>(`[data-quality-output="${slider.dataset.quality}"]`);
    if (output) output.value = `${slider.value}%`;
  }
  const volume = e.target as HTMLInputElement;
  if (volume.dataset.volume === "musicVolume" || volume.dataset.volume === "soundVolume") {
    prefs[volume.dataset.volume] = Number(volume.value) / 100;
    volume.closest("label")?.querySelector("output")?.replaceChildren(`${volume.value}%`);
    saveAudioPrefs();
  }
  if (slider.dataset.musicSpacing !== undefined) setMusicRowSpacing(Number(slider.value), false);
  if ((e.target as HTMLElement).id === "archive-search") {
    searchQuery = (e.target as HTMLInputElement).value;
    renderResults();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.musicReactive !== undefined) {
    prefs.musicReactive = el.checked;
    savePrefs();
    audio.play("confirm");
    return;
  }
  if (el.dataset.musicSpacing !== undefined) {
    setMusicRowSpacing(Number(el.value), true);
    audio.play("confirm");
    return;
  }
  if (el.dataset.musicBridgePort !== undefined) {
    abandonLauncherHandoff();
    const port = Math.max(1024, Math.min(65535, Number(el.value) || prefs.vlcPort));
    prefs.vlcPort = port;
    saveAudioPrefs();
    musicBridge.configure({ port, token: prefs.vlcToken });
    return;
  }
  if (el.dataset.musicBridgeToken !== undefined) {
    abandonLauncherHandoff();
    prefs.vlcToken = el.value.trim();
    saveAudioPrefs();
    musicBridge.configure({ port: prefs.vlcPort, token: prefs.vlcToken });
    return;
  }
  if (el.id === "quality-preset" && Object.hasOwn(qualityPresets, el.value)) {
    prefs.rendering = { ...qualityPresets[el.value as QualityPreset] };
    savePrefs();
  } else if (el.dataset.quality) {
    const key = el.dataset.quality as keyof RenderQuality;
    prefs.rendering = normalizeQuality({ ...prefs.rendering, [key]: key === "antialias" ? el.value : Number(el.value) });
    savePrefs();
  }
  if (el.dataset.pref) {
    const key = el.dataset.pref;
    if (key === "sound" || key === "music" || key === "quality" || key === "superPerformance") prefs[key] = el.checked;
    if (key === "sound" || key === "music") saveAudioPrefs(); else savePrefs();
    audio.play("confirm");
  }
  if (el.dataset.motion) {    const key = el.dataset.motion as MotionKey;
    prefs.motion[key] = el.checked;
    prefs.motionPreset = motionPresetFor(prefs.motion);
    savePrefs();
    const motionRoot = $("#motion-settings");
    const advancedOpen = motionRoot.querySelector<HTMLDetailsElement>(".motion-advanced")?.open ?? false;
    const settingsPanel = motionRoot.closest<HTMLElement>(".settings-modal");
    const scrollTop = settingsPanel?.scrollTop ?? 0;
    motionRoot.outerHTML = motionSettingsMarkup(prefs.motion, prefs.motionPreset);
    $("#motion-preference-note").outerHTML = motionPreferenceNoteMarkup();
    $("#motion-settings").querySelector<HTMLDetailsElement>(".motion-advanced")!.open = advancedOpen;
    requestAnimationFrame(() => {
      if (settingsPanel) settingsPanel.scrollTop = scrollTop;
      document.querySelector<HTMLInputElement>(`[data-motion="${key}"]`)?.focus({ preventScroll: true });
    });
    notify(key === "boot" ? "开场设置将在下次重播时生效" : el.checked ? "已启用此动画" : "已关闭此动画");
    audio.play("confirm");
  }
});
document.addEventListener("click", (e) => {
  const themeButton = (e.target as Element).closest<HTMLElement>("[data-color-theme]");
  if (themeButton) { prefs.colorTheme = themeButton.dataset.colorTheme === "dark" ? "dark" : "light"; savePrefs(); return; }
  if (!started) return;
  if (modalClosing) return;
  const el = (e.target as Element).closest<HTMLElement>("button");
  if (!el) return;
  if (el.dataset.action === "motion-preset") {
    const preset = el.dataset.preset;
    if (preset !== "full" && preset !== "reduced") return;
    prefs.motionPreset = preset;
    prefs.motion = preset === "full" ? fullMotion() : reducedMotion();
    savePrefs();
    renderModal();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-action="motion-preset"][data-preset="${prefs.motionPreset}"]`)?.focus({ preventScroll: true }));
    audio.play("confirm");
    return;
  }
  if (el.dataset.musicEngine) {
    const engine = el.dataset.musicEngine === "vlc" ? "vlc" : "browser";
    void setMusicEngine(engine);
    return;
  }
  if (el.dataset.musicBridge) {
    const action = el.dataset.musicBridge;
    if (action === "connect") void connectMusicBridge();
    else if (action === "disconnect") {
      musicBridge.disconnect();
      bridgeStatus = null;
      audio.setLocalMusicActive(false);
      refreshMusicSettings();
      notify("已断开 VLC 桥接");
    }
    return;
  }
  if (el.dataset.musicSetting) {
    void runMusicSetting(el.dataset.musicSetting);
    return;
  }
  if (el.dataset.musicRhythm) {
    const rhythm = el.dataset.musicRhythm;
    if (rhythm === "legacy" || rhythm === "wave" || rhythm === "lift" || rhythm === "pulse" || rhythm === "ripple" || rhythm === "groove" || rhythm === "shimmer") {
      prefs.musicRhythm = rhythm;
      savePrefs();
      scene?.setRhythmStyle(rhythm);
      refreshMusicSettings();
      audio.play("confirm");
    }
    return;
  }
  if (el.dataset.musicGrouping) {
    const grouping = el.dataset.musicGrouping;
    if (grouping === "album" || grouping === "artist" || grouping === "letter") {
      setMusicGrouping(grouping);
      audio.play("confirm");
    }
    return;
  }
  if (el.dataset.select) {
    select(Number(el.dataset.select));
    return;
  }
  if (el.dataset.result) {
    const index = Number(el.dataset.result);    closeModal(() => {
      select(index);
      openFile();
    });
    return;
  }
  if (el.dataset.filter) {
    filter = el.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === filter,
        ),
      );
    renderResults();
    return;
  }
  if (el.dataset.tab) {
    setTab(el.dataset.tab);
    return;
  }
  const action = el.dataset.action;
  if (action === "toggle-three") { void toggleThree(); return; }
  if (action === "library-mode") {
    setLibraryMode(prefs.libraryMode === "music" ? "archive" : "music");
    return;
  }
  if (action === "export-track") {
    const r = view().records[selected];
    downloadTextFile(`${r.id}-${r.title}.txt`, recordText(r));
    notify(`已导出 ${r.id} 曲目信息`);
    return;
  }
  if (action === "sound-preview") audio.play("confirm");
  if (action === "skip") {
    setMode("archive");
    audio.play("confirm");
  }
  if (action === "prev") stepFile(-1);
  if (action === "next") stepFile(1);
  if (action === "column-prev") stepColumn(-1);
  if (action === "column-next") stepColumn(1);
  if (action === "open") openFile();
  if (action === "model-viewer" && mode === "detail" && scene) {
    const activeScene = scene;
    // Safari does not always focus a button when it is tapped. Capture the
    // actual opener so closing the modal reliably restores the right control.
    el.focus({ preventScroll: true });
    viewer ??= new ModelViewer($("#stage"), () => { audio.setScene(mode); audio.play("page-close"); }, (sound) => audio.play(sound === "tick" ? "ui-tick" : sound));
    audio.setScene("viewer");
    viewer.setSuperPerformance(superPerformanceEnabled());
    viewer.setQuality(effectiveRenderQuality());
    viewer.setMotion(prefs.motion);
    scene.finishDecryption();
    viewer.open(
      view().records[selected].id,
      view().records[selected].title,
      () => activeScene.createAssemblyModel(),
      !motionActive("viewerNavigation"),
    );
    audio.play("page-open");
  }
  if (action === "back") {
    setMode("archive");
    audio.play("back");
  }
  if (action === "search" || action === "saved" || action === "settings" || action === "music") {
    el.focus({ preventScroll: true });
    openModal(action);
  }
  if (action === "close-modal") closeModal();
  if (action === "bookmark") toggleSaved();
  if (action === "reset-search") {
    modal = "search";
    searchQuery = "";
    filter = "全部档案";
    renderModal();
  }
  if (action === "replay" || action === "restart") {
    replayBoot();
  }
  if (action === "enable-motion") {
    prefs.motion = fullMotion();
    prefs.motionPreset = "full";
    savePrefs();
    replayBoot();
  }
  if (action === "fullscreen" && document.fullscreenEnabled) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => notify("请使用浏览器的全屏快捷键 F11"));
  }
});
document.addEventListener("keydown", (e) => {
  if (!started) return;
  if (viewer?.isOpen) return;
  if (playground?.active && !modal) {
    if (e.key === "Escape") { e.preventDefault(); playground.stop(); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "/"].includes(e.key) && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
    return;
  }
  if (modalClosing) {
    e.preventDefault();
    return;
  }
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === "Escape") {
    if (modal) closeModal();
    else if (mode === "detail" || (mode === "boot" && ready)) { const sound = mode === "detail" ? "back" : "ui-tick"; setMode("archive"); audio.play(sound); }
    return;
  }
  if (modal && e.key === "Tab") {
    const focusables = [
      ...$("#modal-root").querySelectorAll<HTMLElement>(
        'button,input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
      ),
    ];
    const visible = focusables.filter(el => el.getClientRects().length > 0);
    const first = visible[0],
      last = visible.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
  if (typing || modal || !ready) return;
  if (
    (e.target as HTMLElement).dataset.tab &&
    ["ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
    const tabs = ["overview", "notes", "history"];
    setTab(
      tabs[(tabs.indexOf(activeTab) + (e.key === "ArrowRight" ? 1 : 2)) % 3],
    );
    $<HTMLButtonElement>(`[data-tab="${activeTab}"]`).focus();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    openModal("search");
  }
  if (e.key === "ArrowLeft" && mode !== "boot") {
    e.preventDefault();
    stepColumn(-1);
  }
  if (e.key === "ArrowRight" && mode !== "boot") {
    e.preventDefault();
    stepColumn(1);
  }
  if (["ArrowUp", "ArrowDown"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepFile(e.key === "ArrowUp" ? -1 : 1);
  }
  if (
    e.key === "Enter" &&
    (document.activeElement === document.body ||
      document.activeElement?.id === "detail-content" ||
      ["prev", "next", "column-prev", "column-next"].includes(
        (document.activeElement as HTMLElement)?.dataset.action ?? "",
      ) ||
      (document.activeElement as HTMLElement)?.dataset.select)
  ) {
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    else if (mode === "archive") openFile();
  }
});

const ease = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
function bootFrame(t: number) {
  if (isWallpaper && !scene && frozenTime === null && t >= 21.9) {
    setMode("archive");
    return undefined;
  }
  if (isWallpaper && frozenTime === null && t >= ARRAY_OPENING_END &&
      !openingShowsDetail(wallpaperHost()?.properties.openingdetail?.value, !!workbench?.enabled)) {
    setMode("archive");
    return undefined;
  }
  audio.updateBoot(t, frozenTime !== null);
  const motion = bootSequence.update(t);
  if (workbench?.enabled && frozenTime === null) {
    const end = openingShowsDetail(wallpaperHost()?.properties.openingdetail?.value, true) ? 35 : ARRAY_OPENING_END;
    if (t > end - .35) $(".powered").style.opacity = String(1 - ease((t - end + .35) / .35));
  }
  let step: string = motion.step;
  if (t >= 22) {
    step = "array";
  }
  if (t >= 25.68) {
    step = "select";
  }
  if (t >= 28.3) {
    step = "inspect";
  }
  if (step !== lastStep) {
    $("#stage").dataset.boot = step;
    lastStep = step;
  }
  $(".file-title").firstChild!.textContent =
    step === "array"
      ? "SELECTING FILES...".slice(0, Math.max(0, Math.floor((t - 21.94) * 18)))
      : "FILE NUMBER: ";
  $("#stage").style.setProperty(
    "--entry-opacity",
    String(ease((t - 21.9) / 0.13)),
  );
  $(".callout-rule").style.transform = `scaleX(${ease((t - 22.08) / 0.9)})`;
  const reveal = ease((t - 22) / 0.4),
    lift = ease((t - 26) / 1.8),
    zoom = 0.55 * ease((t - 27.3) / 1.65) + 0.45 * ease((t - 29.0) / 5.0);
  if (t >= 35) {
    setMode("detail");
    return undefined;
  }
  return { reveal, lift, zoom, time: t };
}

const inspectionOverlay = new InspectionOverlay();
const documentDecryption = new DocumentDecryption();
// A newly opened archive can introduce another font shard. Re-measure its
// redaction lines after font swap while retaining the current reveal progress.
document.fonts.addEventListener("loadingdone", () => documentDecryption.refresh());

let lastTime = 0,
  frameCount = 0,
  frameStart = performance.now(),
  fps = 0;
let lastFrameMs = 0;
function frame(ms: number) {
  if (!wallpaperFrame(ms)) { requestAnimationFrame(frame); return; }
  if (document.hidden) { requestAnimationFrame(frame); return; }
  workbench?.tick();
  const musicDt = lastFrameMs ? Math.min(0.1, (ms - lastFrameMs) / 1000) : 0.016;
  lastFrameMs = ms;
  // The player owns the analyser that feeds the archive reaction; it must keep
  // ticking with the music even when the panel (and its own tick) is closed.
  musicPlayer.tick(musicDt);
  musicPanel.tick(musicDt);
  coverAtlas.flush();
  // VLC path: the bridge taps VLC's decoded PCM, so the archive reaction follows
  // whatever codec VLC is playing.
  if (prefs.musicEngine === "vlc" && musicBridge.connected) {
    bridgeStatusElapsed += musicDt;
    if (bridgeStatusElapsed >= .75) {
      bridgeStatusElapsed = 0;
      void refreshBridgeStatus();
    }
    applyMusicBands(bridgeEnvelope.update(musicDt, ms / 1000, bridgeStatus?.state === "playing"));
  } else {
    bridgeStatusElapsed = .75;
  }
  const time = ms / 1000;
  const theme = scene?.themeAmount ?? (prefs.colorTheme === "dark" ? 1 : 0);
  paintTheme(theme);
  viewer?.setTheme(theme);
  playground?.tick(time);
  const cinema =
    mode === "boot" && ready
      ? bootFrame(frozenTime ?? time - bootStart)
      : undefined;
  wallpaperEffects?.update(time, motionIsReduced(), motionActive("pointerParallax"));
  // The calibrated 2D opening fully covers the scene until array entry.
  if (!viewer?.isOpen && (!cinema || cinema.time >= 21.9)) scene?.update(time, cinema);
  viewer?.update(time);
  if (threeState === "closing" && scene?.presentationHidden) releaseThree();
  playground?.position();
  if (scene && mode === "detail") {
    documentDecryption.update(time, scene.decryptionFrame, !motionActive("documentReveal"));
    $("#detail-content").style.opacity = String(scene.detailVisibility);
    $("#detail-content").style.translate =
      `0 ${(1 - scene.detailVisibility) * 18}px`;
    $("#detail-content").inert = scene.detailVisibility < 0.1;
    if (pendingDetailFocus && scene.detailVisibility >= 0.1 && !modal && !viewer?.isOpen) {
      $("#detail-content").focus({ preventScroll: true });
      pendingDetailFocus = false;
    }
  }
  $("#stage").style.setProperty("--detail-shade", String(mode === "boot" ? 0 : scene?.detailVisibility ?? 0));
  const currentScene = scene;
  if (currentScene) inspectionOverlay.render(currentScene.decryptionFrame,
    (x, y) => currentScene.projectCard(x, y), Boolean(cinema), motionActive("modelDecryption"));
  if (Math.floor(time) !== lastTime) {
    lastTime = Math.floor(time);
    updateFooterClock(new Date(), motionActive("rollingNumbers"));
  }
  frameCount++;
  if (ms - frameStart > 1000) {
    fps = (frameCount * 1000) / (ms - frameStart);
    frameStart = ms;
    frameCount = 0;
    $("#three-scene").dataset.fps = String(Math.round(fps));
    $("#three-scene").dataset.renderStats = JSON.stringify(scene?.getStats() ?? { loaded: false, drawCalls: 0, triangles: 0 });
  }
  requestAnimationFrame(frame);
}
function bindScene(scene: ArchiveScene, cell?: { lane: number; row: number }) {
    scene.setRowSpacing(rowSpacingForView(), true);
    scene.setCoverProvider(coverTileFor, coverAtlas.texture);
    scene.select(selected, cell ? { cell } : undefined);
    scene.setRhythmStyle(prefs.musicRhythm);
    scene.onSelect = (i, cell) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      select(i, cell ? { cell } : undefined);
    };
    scene.onNavigate = (axis, direction) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      if (axis === "lane") stepColumn(direction);
      else stepFile(direction);
    };
    scene.onHover = (i) => {
      const label = $("#hover-label");
      if (i === null) {
        label.hidden = true;
        hoverCode.finish();
        hoverTitle.finish();
        return;
      }
      const animated = motionActive("rollingText") && mode === "archive";
      const numbersAnimated = motionActive("rollingNumbers") && mode === "archive";
      hoverCode.update({
        value: Number(view().records[i].id.slice(2)),
        animated: !label.hidden && numbersAnimated,
      });
      $("#hover-prefix").textContent = view().records[i].id.slice(0, 2);
      hoverTitle.update({ text: view().records[i].title, animated: !label.hidden && animated });
      label.hidden = false;
      // Prepare the first visible value so the next hover can animate immediately.
      hoverCode.update({ animated: numbersAnimated });
      hoverTitle.update({ animated });
    };
}
function syncThreeButton() {
  $("#stage").dataset.threeState = threeState;
  syncWallpaperBackground();
  const button = document.querySelector<HTMLButtonElement>('[data-action="toggle-three"]');
  if (!button) return;
  button.textContent = threeState === "loading" ? "3D 载入中…" : threeState === "closing" ? "3D 关闭中…" : threeState === "off" ? "3D 关闭" : "3D 开启";
  button.disabled = threeState === "loading";
  button.setAttribute("aria-pressed", String(threeState === "on"));
  button.title = threeState === "off" ? "重新载入三维模型" : threeState === "closing" ? "取消关闭，恢复三维画面" : "卸载三维模型，保留 2D 界面";
}
function releaseThree() {
  if (!scene) return;
  resumeCell = { ...scene.getStats().selectedCell }; resumeSelection = selected;
  viewer?.dispose(); viewer = undefined;
  scene.dispose(); scene = undefined;
  if (mode === "detail") {
    $("#detail-content").style.opacity = "1";
    $("#detail-content").style.translate = "0 0";
    $("#detail-content").inert = false;
    documentDecryption.reset($("#detail-content"), true);
  }
  threeState = "off"; syncThreeButton();
  $("#hover-label").hidden = true;
  delete $("#three-scene").dataset.renderQuality;
  updateQualitySummary();
}
async function toggleThree() {
  if (!isWallpaper || !ready || threeState === "loading") return;
  if (threeState === "closing") {
    scene?.setPresentationVisible(true, !motionActive("surfaceTransitions"));
    threeState = "on"; syncThreeButton(); return;
  }
  if (scene) {
    playground?.stop();
    threeState = "closing"; syncThreeButton();
    scene.setPresentationVisible(false, !motionActive("surfaceTransitions"));
    if (!motionActive("surfaceTransitions")) releaseThree();
    return;
  }
  threeState = "loading"; syncThreeButton();
  let next: ArchiveScene | undefined;
  try {
    next = new ArchiveScene($("#three-scene"));
    next.renderer.domElement.style.opacity = "0";
    next.setPresentationVisible(false, true);
    await next.load();
    next.setMode(mode === "detail" ? "detail" : "archive");
    bindScene(next, resumeSelection === selected ? resumeCell : undefined);
    next.revealImmediately();
    scene = next;
    scene.setTheme(prefs.colorTheme === "dark", true);
    scene.setArchiveCoverage(wallpaperHost()?.properties.archivecoverage?.value === "extra");
    savePrefs();
    scene.setPresentationVisible(true, !motionActive("surfaceTransitions"));
    threeState = "on"; syncThreeButton();
  } catch (error) {
    next?.dispose(); scene = undefined;
    threeState = "off"; syncThreeButton();
    notify("三维模型载入失败，请点击 3D 关闭重试。");
    console.error(error);
  }
}

async function start() {
  try {
    if (isWallpaper) await window.rhineWallpaperPropertiesReady;
    if (!isWallpaper || wallpaperHost()?.properties.load3donstartup?.value !== false) {
      scene = new ArchiveScene($("#three-scene"));
      scene.setTheme(prefs.colorTheme === "dark", true);
      scene.setArchiveCoverage(wallpaperHost()?.properties.archivecoverage?.value === "extra");
    } else {
      threeState = "off";
      syncThreeButton();
    }
    await Promise.all([
      scene?.load(),
      loadBootWebfonts(),
      // With unicode-range faces, preload the opening's actual characters,
      // not every font shard. Other archive text loads on demand.
      document.fonts.load("300 20px MiSans", "ACCESS WELCOME TO INTERNAL DATABASE"),
      document.fonts.load("400 20px MiSans", "身份信息确认请求已接收开始处理权限验证通过欢迎访问莱茵生命内部资料档案编号保密级别商业区选择档案：0123456789 JOYCE MOORE"),
      document.fonts.load("600 20px MiSans", "SYNTHESIZE INFORMATION ANALYSIS OS"),
      document.fonts.load("700 20px MiSans", "RHINE LAB WELCOME TO INTERNAL DATABASE"),
    ]);
    if (scene) bindScene(scene);
    savePrefs();
    ready = true;
    select(0);
    if (entry) entry.ready();
    else {
      if (isWallpaper) {
        // CEF allows automatic audio; never block the visual on audio policy or decoding.
        await Promise.race([audio.unlock(), new Promise(resolve => setTimeout(resolve, 3000))]);
      }
      completeStartup(false);
    }
    // Reconnect the local VLC kernel when the user left it selected.
    if (prefs.musicEngine === "vlc" && prefs.vlcToken) void connectMusicBridge(true);
  } catch (error) {
    console.error(error);
    $("#loading").innerHTML =
      '<div class="error-state"><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认浏览器已启用硬件加速，然后重新连接。</p><button onclick="location.reload()">RECONNECT →</button></div>';
  }
}
function completeStartup(silent: boolean) {
  if (started || !ready) return;
  started = true;
  if (silent) {
    prefs.sound = false;
    prefs.music = false;
    saveAudioPrefs();
  }
  audio.releaseEntry();
  audio.restartBoot();
  const fade = motionActive("boot") ? 600 : 0;
  bootStart = performance.now() / 1000 - (validReviewTime ? Number(reviewParams.get("time")) : 1.76);
  if (!validReviewTime) bootStart += fade / 1000;
  setMode("boot");
  if (reviewParams.get("scene") === "archive" || (!motionActive("boot") && !validReviewTime)) setMode("archive");
  if (reviewParams.get("scene") === "detail") setMode("detail");
  if (isWallpaper && wallpaperHost()?.properties.boot?.value === false) setMode("archive");
  $("#stage").inert = false;
  $(".mobile-entry").inert = false;
  loading.classList.add("loaded");
  loading.inert = true;
  setTimeout(() => {
    const restoreFocus = loading.contains(document.activeElement) || document.activeElement === document.body;
    loading.remove();
    if (entry && restoreFocus) {
      const skip = $("#skip");
      const target = mode === "boot" ? skip.getClientRects().length ? skip : $(".mobile-entry") : $(".read-file");
      target.focus({ preventScroll: true });
    }
  }, fade);
  requestAnimationFrame(frame);
  // Do not compete with entry audio/font downloads. Full offline installation
  // begins after startup is complete and remains atomic.
  setTimeout(() => void initPwa(notify), 1500);
}
updateSelection();
syncLibraryModeUI();
// Music archive mode persisted from an earlier session: the library restores
// lazily, so kick the restore here and swap views once tracks are known.
if (prefs.libraryMode === "music" && !musicLibrary.tracks.length && prefs.musicEngine === "browser") {
  void musicLibrary.restore().then((restored) => {
    if (restored) onLibraryMayHaveChanged();
    else {
      prefs.libraryMode = "archive";
      saveAudioPrefs();
      syncLibraryModeUI();
    }
  });
} else if (prefs.libraryMode === "music" && musicLibrary.tracks.length) {
  applyView(musicView());
}
const customBackground = isWallpaper ? new WallpaperBackground($("#stage"), notify) : undefined;
function syncWallpaperBackground(retry = false) {
  customBackground?.update(wallpaperHost()?.properties ?? {}, mode !== "boot" && (threeState === "off" || threeState === "loading"), !motionActive("surfaceTransitions"), retry);
}
if (isWallpaper) {
  const apply = (properties: WallpaperProperties) => {
    const theme = properties.colortheme?.value;
    if (theme === "light" || theme === "dark") prefs.colorTheme = theme;
    scene?.setArchiveCoverage(properties.archivecoverage?.value === "extra" || wallpaperHost()?.properties.archivecoverage?.value === "extra");
    for (const key of ["sound", "music"] as const)
      if (typeof properties[key]?.value === "boolean") prefs[key] = properties[key].value as boolean;
    if (typeof properties.reduced?.value === "boolean") {
      prefs.motion = properties.reduced.value ? reducedMotion() : fullMotion();
      prefs.motionPreset = motionPresetFor(prefs.motion);
    }
    for (const key of ["soundVolume", "musicVolume"] as const) {
      const value = properties[key.toLowerCase()]?.value;
      if (typeof value === "number" && Number.isFinite(value)) prefs[key] = Math.max(0, Math.min(1, value / 100));
    }
    const qualityProperties = { ...wallpaperHost()?.properties, ...properties };
    if (Object.keys(properties).some(key => key === "renderquality" || key.startsWith("quality")))
      prefs.rendering = wallpaperQuality(qualityProperties, prefs.rendering);
    savePrefs();
    if (properties.customwallpaperfile || properties.customwallpaper?.value === true) syncWallpaperBackground(true);
    if (properties.boot?.value === false && started && mode === "boot") setMode("archive");
    // Keep an already-open settings surface in sync without replacing focused controls.
    document.querySelectorAll<HTMLInputElement>("[data-pref]").forEach(input => {
      const key = input.dataset.pref as "sound" | "music" | "quality" | "superPerformance";
      if (key in prefs) input.checked = prefs[key];
    });
    document.querySelectorAll<HTMLInputElement>("[data-motion]").forEach(input => {
      input.checked = prefs.motion[input.dataset.motion as MotionKey];
    });
    document.querySelectorAll<HTMLElement>('[data-action="motion-preset"]').forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.preset === prefs.motionPreset));
    });
    const note = document.querySelector("#motion-preference-note");
    if (note) note.outerHTML = motionPreferenceNoteMarkup();
    for (const key of ["soundVolume", "musicVolume"] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-volume="${key}"]`);
      if (input) { input.value = String(Math.round(prefs[key] * 100)); input.closest("label")?.querySelector("output")?.replaceChildren(`${input.value}%`); }
    }
  };
  window.addEventListener("rhine-wallpaper-properties", event => apply((event as CustomEvent<WallpaperProperties>).detail));
  let pausedAt: number | undefined;
  const pause = () => {
    const paused = wallpaperHost()?.paused ?? false;
    if (paused && pausedAt === undefined) pausedAt = performance.now();
    if (!paused && pausedAt !== undefined) {
      if (started && mode === "boot") bootStart += (performance.now() - pausedAt) / 1000;
      pausedAt = undefined;
    }
    audio.setHostPaused(paused);
  };
  window.addEventListener("rhine-wallpaper-pause", pause);
  apply(wallpaperHost()?.properties ?? {});
  pause();
}
if (isWallpaper) {
  workbench = new Workbench($("#stage"), () => {
    if (ready && mode !== "boot") setMode("archive");
  }, lane => {
    if (ready && !modal) select(memoryFor(view())[lane]);
  });
  workbench.setMotion(prefs.motion);
  playground = new ArchivePlayground($("#stage"), () => scene,
    () => ({ enabled: !!workbench?.enabled && mode === "archive" && ready, paused: Boolean(modal) || modalClosing || Boolean(wallpaperHost()?.paused) || document.hidden, reduced: motionIsReduced() }),
    value => { musicSuppressed = value; configureAudio(); }, () => audio.play("tick"));
  wallpaperEffects = new WallpaperEffects($("#stage"), () => scene);
  document.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-workbench-mode]");
    if (button) closeModal(() => { workbench!.setEnabled(button.dataset.workbenchMode === "workbench"); });
  });
}
void start();
// Deterministic review controls: the running application, never a video surrogate.
Object.assign(window, {
  rhine: {
    // The review button supplies a real user activation. Preferences stay local to this preview.
    playBootPreview: async (music = false) => {
      if (!ready || !navigator.userActivation.isActive) return false;
      const request = ++audioPreviewRequest;
      audioPreview = true;
      audio.configure({ ...prefs, sound: true, music });
      const unlocked = await audio.unlock();
      if (request !== audioPreviewRequest) return false;
      if (!unlocked) {
        audioPreview = false;
        configureAudio();
        return false;
      }
      replayBoot(true);
      return true;
    },
    seek: (t: number) => {
      setMode("boot");
      bootStart = performance.now() / 1000 - t;
      lastStep = "";
    },
    archive: () => setMode("archive"),
    detail: () => openFile(),
    select: (i: number) => select(i),
    stats: () => ({
      ...scene?.getStats(),
      threeState,
      fps: Math.round(fps),
      mode,
      ready,
      startup: started ? "started" : entry?.phase ?? "loading",
      motion: { reduced: motionIsReduced(), preset: prefs.motionPreset },
      bootTime: mode === "boot" ? started ? (frozenTime ?? performance.now() / 1000 - bootStart) + 5 : 6.76 : null,
      selected: view().records[selected].id,
      libraryMode: prefs.libraryMode,
      grouping: prefs.libraryMode === "music" ? prefs.musicGrouping : undefined,
      musicRowSpacing: prefs.musicRowSpacing,
      columns: view().columns.length,
      saved: [...saved],
      audio: audio.stats(),
      music: {
        ...musicPlayer.state(),
        tracks: musicLibrary.tracks.length,
        label: musicLibrary.label,
        persistent: musicLibrary.persistent,
        reactive: prefs.musicReactive,
        rhythm: prefs.musicRhythm,
        volume: prefs.localMusicVolume,
        bands: lastMusicBands,
      },
      wallpaper: isWallpaper ? wallpaperHost() : null,
    }),
    // Deterministic local-music control for checks and review pages.
    music: {
      open: () => openModal("music"),
      close: () => closeModal(),
      library: musicLibrary,
      player: musicPlayer,
      panel: musicPanel,
      rescan: () => musicPanel.startScan(),
      search: (query: string, field?: "all" | "title" | "artist" | "album") =>
        musicLibrary.search(query, field ?? "all").map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
        })),
      play: (id: string) => {
        const track = musicLibrary.tracks.find((item) => item.id === id);
        if (!track) return false;
        musicPlayer.queueTracks(
          musicLibrary.tracks.map((item) => ({
            id: item.id,
            title: item.title,
            artist: item.artist,
            album: item.album,
            duration: item.duration,
            codec: item.codec,
          })),
        );
        void musicPlayer.play(track);
        return true;
      },
      bands: () => lastMusicBands,
      bridge: () => ({
        connected: musicBridge.connected,
        health: bridgeHealth,
        status: bridgeStatus,
        error: musicBridge.error,
        engine: prefs.musicEngine,
        port: prefs.vlcPort,
      }),
      bridgePlay: async (id: string) => {
        const status = await musicBridge.play(id).catch(() => null);
        if (status) bridgeStatus = { state: status.state, currentId: status.currentId };
        return status;
      },
      bridgeSeek: (seconds: number) => musicBridge.seek(seconds).catch(() => null),
      bridgePause: () => musicBridge.pause().catch(() => null),
      bridgeStop: () => musicBridge.stop().catch(() => null),
      useFiles: (files: File[]) => {
        musicLibrary.useFiles(files);
        return musicPanel.startScan();
      },
    },
  },
});
if (import.meta.hot) import.meta.hot.dispose(() => audio.dispose());

