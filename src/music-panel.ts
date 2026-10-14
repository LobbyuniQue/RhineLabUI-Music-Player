// Local music panel: library status, search, results and the player bar.
//
// The panel owns its subtree inside the shared terminal modal and binds its own
// delegated listeners on mount, so main.ts only has to register the modal kind
// and hand over the library + player instances.

import { escapeHtml } from "./html";
import type { Sound } from "./audio";
import { formatDuration, formatLibrarySize, matchSegments, tokenize, type SearchField } from "./music-search";
import type { CoverLease, LibraryTrack, MusicLibrary, MusicPlaylist, ScanProgress, ScanReport } from "./music-library";
import type { MusicPlayer, PlayMode } from "./music-player";
import type { BridgeCatalogue, BridgePlaylist, BridgeScan, BridgeStatus, BridgeTrack } from "./music-bridge";
import { directoryPickerSupported, type MusicSource } from "./music-source";

export type MusicPanelHost = {
  library: MusicLibrary;
  player: MusicPlayer;
  /** Local VLC bridge; only used when `engine()` returns "vlc". */
  bridge: {
    connected: boolean;
    play(id: string): Promise<unknown>;
    resume(): Promise<unknown>;
    queueTracks(tracks: readonly { id: string }[]): void;
    setMode(mode: PlayMode): void;
    mode(): PlayMode;
    next(): Promise<unknown>;
    previous(): Promise<unknown>;
    pause(): Promise<unknown>;
    stop(): Promise<unknown>;
    seek(seconds: number): Promise<unknown>;
    volume(value: number): Promise<unknown>;
    pollStatus(): Promise<BridgeStatus | null>;
    library(): Promise<BridgeTrack[]>;
    rescan(full?: boolean): Promise<BridgeScan | null>;
    readonly info?: { root: string; playlist?: BridgePlaylist } | null;
    switchPlaylist(root: string, part?: number, split?: boolean): Promise<BridgeCatalogue>;
  };
  engine: () => "browser" | "vlc";
  canControl?: () => boolean;
  beforePlayback?: () => Promise<void> | void;
  beforeLibraryChange?: () => Promise<void> | void;
  onSound: (sound: Sound, pan?: number) => void;
  onNotify: (message: string) => void;
  onOpenSettings: () => void;
  onPlaylistPrompt?: () => void;
  onLibraryChanged?: () => void;
  onVolumeChange?: (value: number) => void;
  /** Whether surface/enter animations are enabled. */
  motion: boolean;
};const FIELD_LABELS: { field: SearchField; label: string }[] = [
  { field: "all", label: "全部" },
  { field: "title", label: "标题" },
  { field: "artist", label: "艺术家" },
  { field: "album", label: "专辑" },
];

const MODE_LABELS: Record<PlayMode, string> = {
  list: "列表循环",
  single: "单曲循环",
  shuffle: "随机播放",
};

const MODE_ORDER: PlayMode[] = ["list", "single", "shuffle"];
const RESULT_PAGE_SIZE = 240;

const CODE_LABELS: Record<string, string> = {
  mp3: "MP3",
  flac: "FLAC",
  m4a: "M4A",
  ogg: "OGG",
  opus: "OPUS",
  wav: "WAV",
};

export class MusicPanel {
  private root: HTMLElement | null = null;
  private host!: MusicPanelHost;
  private controller: AbortController | null = null;
  private query = "";
  private field: SearchField = "all";
  /** Keyboard cursor; -1 keeps the list neutral until an arrow key is used. */
  private cursor = -1;
  private results: LibraryTrack[] = [];
  private visibleResults = RESULT_PAGE_SIZE;
  private resultScope = "";
  private scanText = "";
  private scanAbort: AbortController | null = null;
  private libraryRequest = 0;
  private lastPosition = -1;
  private lastTitle = "";
  private lastStatus = "";
  private mounted = false;
  private bridgeStatus: BridgeStatus | null = null;
  private bridgeAccumulator = 0;
  private bridgeBusy = false;
  /** True between issuing a play and VLC reporting that it is playing. */
  private bridgePending = false;
  /** Playing row the list currently highlights; guards idempotent re-sync. */
  private lastPlayingId: string | null = null;
  private playbackRequest = 0;
  private lastEngineState = "";
  private coverRequest = 0;
  private coverLease: CoverLease | null = null;
  private presets: MusicPlaylist[] = [];
  private activePreset = "";
  private presetRevision = 0;
  private sessionSource: MusicSource | null = null;
  private libraryBusy = false;
  private limitPrompt: { total: number; parts: number; retry: () => Promise<void> } | null = null;

  get switching() { return this.libraryBusy; }
  promptOversizedLibrary(total: number, parts = Math.ceil(total / 1000)) {
    this.showLimit(total, parts, () => this.startScan({ split: true }));
  }

  constructor() {}

  get active() {
    return this.mounted;
  }

  attach(host: MusicPanelHost) {
    this.cancelPending();
    this.host = host;
  }

  mount(root: HTMLElement, host?: MusicPanelHost) {
    if (host) this.host = host;
    this.root = root;
    this.controller?.abort();
    this.controller = new AbortController();
    this.mounted = true;
    this.resetCover();
    this.lastPosition = -1;
    this.lastTitle = "";
    this.lastStatus = "";
    this.lastEngineState = `${this.host.engine()}:${this.host.bridge.connected}:${this.canControl}`;
    this.lastPlayingId = null;
    root.innerHTML = this.markup();
    this.bind(root, this.controller.signal);
    this.refreshIndex();
    this.renderAll();
    void this.refreshPresets();
    if (!this.usingBridge && !this.host.library.tracks.length) void this.autoRestore();
  }

  unmount() {
    this.cancelPending();
    this.resetCover();
    this.controller?.abort();
    this.controller = null;
    this.mounted = false;
    this.root = null;
    this.lastPlayingId = null;
  }

  /** Invalidates asynchronous panel work before an engine or source changes. */
  cancelPending() {
    ++this.playbackRequest;
    ++this.libraryRequest;
    this.scanAbort?.abort();
    this.scanAbort = null;
    this.scanText = "";
    this.libraryBusy = false;
    this.bridgePending = false;
    this.host?.library.cancelScan();
  }

  private get canControl() { return this.host.canControl?.() ?? true; }

  private currentPlaybackRequest(request: number, engine: "browser" | "vlc") {
    return request === this.playbackRequest && this.host.engine() === engine && this.canControl && !this.libraryBusy;
  }

  private currentLibraryRequest(request: number, engine: "browser" | "vlc") {
    return request === this.libraryRequest && this.host.engine() === engine && this.canControl;
  }

  private queueResults() {
    const tracks = this.results.length ? this.results : this.library.tracks;
    this.player.queueTracks(tracks);
    this.host.bridge.queueTracks(tracks);
  }

  /** Called from the app frame loop. The player itself ticks from the same
   * loop regardless of the panel, so closing this window never freezes the
   * analyser that drives the archive music reaction. */
  tick(dt: number) {
    if (!this.mounted) return;
    const engineState = `${this.host.engine()}:${this.host.bridge.connected}:${this.canControl}`;
    if (engineState !== this.lastEngineState) {
      this.lastEngineState = engineState;
      ++this.playbackRequest;
      this.bridgePending = false;
      this.renderStatus();
      this.renderBar();
      this.renderPresets();
    }
    // Track changes can arrive without a panel gesture (MediaSession keys,
    // browser-engine next/previous); keep the highlight and bar in step.
    this.syncPlayingRow(this.activeId());
    if (this.usingBridge) {
      // The bridge plays through VLC; the page only mirrors its transport state.
      this.bridgeAccumulator += dt;
      if (this.host.bridge.connected && this.bridgeAccumulator > 1 && !this.bridgeBusy) {
        this.bridgeAccumulator = 0;
        void this.pollBridge();
      }
      this.renderTimeline();
      return;
    }
    this.renderTimeline();
  }

  /** True when playback is delegated to the local VLC bridge. */
  private get usingBridge() {
    return this.host.engine() === "vlc";
  }

  /** The track the UI marks as playing, whichever engine owns it. */
  private activeId(): string | null {
    if (this.usingBridge) return this.host.bridge.connected ? this.bridgeStatus?.currentId ?? null : null;
    return this.player.state().id;
  }

  private async pollBridge() {
    if (!this.usingBridge || !this.host.bridge.connected) return;
    const request = this.playbackRequest;
    this.bridgeBusy = true;
    try {
      const status = await this.host.bridge.pollStatus();
      if (!this.currentBridgeRequest(request)) return;
      this.bridgeStatus = status;
      if (status) {
        // VLC opens the file (and the PCM tap) asynchronously; the pending flag
        // keeps the bar in a loading state until it really reports playing.
        if (status.state === "playing") this.bridgePending = false;
        this.renderBar();
        this.syncPlayingRow(status.currentId);
      }
    } finally {
      this.bridgeBusy = false;
    }
  }

  focusSearch() {
    this.root?.querySelector<HTMLInputElement>("#music-search")?.focus({ preventScroll: true });
  }

  /** Re-renders after the library was replaced from outside (bridge or rescan). */
  refreshLibrary() {
    this.resetCover();
    this.refreshIndex();
    this.cursor = -1;
    if (this.mounted) this.renderAll();
    void this.refreshPresets();
  }

  private async refreshPresets() {
    if (!this.library.playlists) return;
    const request = this.libraryRequest;
    const revision = ++this.presetRevision;
    const saved = await this.library.playlists();
    if (request !== this.libraryRequest || revision !== this.presetRevision || this.libraryBusy) return;
    this.presets = [...saved, ...this.presets.filter(item => item.id.startsWith("session-"))];
    const info = this.host.bridge.info?.playlist;
    if (this.usingBridge && info) {
      this.activePreset = this.presets.find(item => item.kind === "vlc" && item.root === info.root && item.part === info.part)?.id ?? "";
      if (info.needsSplit && !this.limitPrompt) this.showLimit(info.total, info.parts, () => this.activateBridgeRoot(info.root, 0, true));
    } else if (!this.usingBridge) {
      const id = this.library.currentRoot?.playlistId ?? this.activePreset;
      this.activePreset = this.presets.some(item => item.id === id) ? id : "";
    }
    this.renderPresets();
  }

  private renderPresets() {
    const select = this.root?.querySelector<HTMLSelectElement>("#music-playlist");
    if (!select) return;
    const kind = this.usingBridge ? "vlc" : "browser";
    const options = `<option value="">当前目录</option>${this.presets.filter(item => item.kind === kind).map(item =>
      `<option value="${escapeHtml(item.id)}" ${item.id === this.activePreset ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}`;
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = this.presets.some(item => item.id === this.activePreset && item.kind === kind) ? this.activePreset : "";
    select.disabled = this.libraryBusy || !this.canControl;
    const pathField = this.root?.querySelector<HTMLElement>("#music-playlist-path-field");
    if (pathField) pathField.hidden = !this.usingBridge;
    const path = this.root?.querySelector<HTMLInputElement>("#music-playlist-path");
    if (path && !path.value && this.usingBridge) path.value = this.host.bridge.info?.root ?? "";
    const prompt = this.root?.querySelector<HTMLElement>("#music-playlist-limit");
    if (prompt) {
      prompt.hidden = !this.limitPrompt;
      const html = this.limitPrompt
        ? `<p>此文件夹有 ${this.limitPrompt.total} 首歌曲，每个歌单最多 1000 首。请选择：</p><div class="music-tools"><button data-music="playlist-split">自动拆成 ${this.limitPrompt.parts} 个歌单</button><button data-music="playlist-manual">返回自行整理</button></div><small>自动拆分只建立歌单范围，不移动音乐文件。</small>` : "";
      if (prompt.innerHTML !== html) prompt.innerHTML = html;
    }
    for (const action of ["playlist-add", "playlist-rename", "playlist-remove", "pick", "scan"]) {
      const button = this.root?.querySelector<HTMLButtonElement>(`[data-music="${action}"]`);
      if (button && action !== "scan") button.disabled = this.libraryBusy || !this.canControl ||
        ((action === "playlist-rename" || action === "playlist-remove") && !this.activePreset);
    }
  }

  private showLimit(total: number, parts: number, retry: () => Promise<void>) {
    this.limitPrompt = { total, parts, retry };
    this.renderPresets();
    this.host.onNotify(`文件夹有 ${total} 首歌曲，请选择自动拆分或自行整理`);
    if (!this.mounted) this.host.onPlaylistPrompt?.();
  }

  private playlistName(fallback: string) {
    return this.root?.querySelector<HTMLInputElement>("#music-playlist-name")?.value.trim() || fallback;
  }

  private async rememberBrowserPlaylist(report: ScanReport, request: number) {
    ++this.presetRevision;
    const sourceSnapshot = this.library.source;
    const current = () => this.currentLibraryRequest(request, "browser") && this.library.source === sourceSnapshot;
    const source = this.library.playlistSource();
    if (!source || !current()) return;
    if (source.handle) {
      this.presets = this.presets.filter(item => !item.id.startsWith("session-"));
      this.sessionSource = null;
    }
    if (!source.handle && this.sessionSource !== this.library.source) {
      this.presets = this.presets.filter(item => !item.id.startsWith("session-"));
      this.activePreset = "";
      this.sessionSource = this.library.source;
    }
    let existing = this.presets.find(item => item.id === this.library.currentRoot?.playlistId);
    if (!existing && source.handle) {
      const handle = source.handle as { isSameEntry?(other: unknown): Promise<boolean> };
      for (const preset of this.presets) {
        if (preset.kind !== "browser" || !preset.handle) continue;
        const same = preset.handle === source.handle || await handle.isSameEntry?.(preset.handle).catch(() => false);
        if (!current()) return;
        if (same) { existing = preset; break; }
      }
    }
    if (!source.handle && !existing) existing = this.presets.find(item => item.id === this.activePreset && item.id.startsWith("session-"));
    const base = existing?.id.replace(/-part-\d+$/, "") ?? `${source.handle ? "browser" : "session"}-${crypto.randomUUID()}`;
    const name = this.playlistName(existing?.name.replace(/（\d+）$/, "") ?? source.name);
    const previousNames = new Map(this.presets.filter(item => item.id.startsWith(`${base}-part-`)).map(item => [item.part, item.name]));
    this.presets = this.presets.filter(item => !item.id.startsWith(`${base}-part-`));
    for (let part = 0; part < report.parts; part++) this.presets.push({ id: `${base}-part-${part}`, name: previousNames.get(part) ?? (report.parts > 1 ? `${name}（${part + 1}）` : name),
      kind: "browser", handle: source.handle, part, total: report.totalFiles });
    this.activePreset = `${base}-part-${report.part}`;
    await this.library.savePlaylists(this.presets.filter(item => !item.id.startsWith("session-")), this.activePreset);
    if (current()) this.renderPresets();
  }

  async activatePlaylist(id: string) {
    if (!this.canControl || this.libraryBusy) return;
    const preset = this.presets.find(item => item.id === id);
    if (!preset || preset.kind !== (this.usingBridge ? "vlc" : "browser")) return;
    this.limitPrompt = null;
    const input = this.root?.querySelector<HTMLInputElement>("#music-playlist-name");
    if (input) input.value = preset.name.replace(/（\d+）$/, "");
    if (preset.kind === "vlc") {
      await this.activateBridgeRoot(preset.root!, preset.part, preset.part > 0 || (preset.total ?? 0) > 1000);
      return;
    }
    this.cancelPending();
    if (!preset.id.startsWith("session-") && !(await this.library.usePlaylist(preset))) {
      this.renderPresets();
      throw new Error("无法取得此歌单文件夹的读取权限");
    }
    await this.startScan({ part: preset.part, split: preset.part > 0 || (preset.total ?? 0) > 1000 });
  }

  private async activateBridgeRoot(root: string, part = 0, split = false) {
    if (!this.canControl || this.libraryBusy || !this.bridgeAvailable()) return;
    this.cancelPending();
    const request = ++this.libraryRequest;
    this.libraryBusy = true;
    this.scanText = "正在加载歌单…";
    this.renderStatus();
    this.renderPresets();
    try {
      if (this.host.beforeLibraryChange) await this.host.beforeLibraryChange();
      if (!this.currentLibraryRequest(request, "vlc")) return;
      const result = await this.host.bridge.switchPlaylist(root, part, split);
      if (!this.currentLibraryRequest(request, "vlc")) return;
      this.library.useBridgeTracks(result.tracks, result.root);
      this.host.bridge.queueTracks(result.tracks);
      const folder = result.root.split(/[\\/]/).filter(Boolean).pop() || "本地歌单";
      const name = this.playlistName(folder);
      const known = this.presets.find(item => item.kind === "vlc" && item.root === result.root);
      const base = known?.id.replace(/-part-\d+$/, "") ?? `vlc-${crypto.randomUUID()}`;
      const previousNames = new Map(this.presets.filter(item => item.kind === "vlc" && item.root === result.root).map(item => [item.part, item.name]));
      this.presets = this.presets.filter(item => item.kind !== "vlc" || item.root !== result.root);
      for (let index = 0; index < result.playlist.parts; index++) this.presets.push({ id: `${base}-part-${index}`, name: previousNames.get(index) ?? (result.playlist.parts > 1 ? `${name}（${index + 1}）` : name),
        kind: "vlc", root: result.root, part: index, total: result.playlist.total });
      this.activePreset = `${base}-part-${result.playlist.part}`;
      await this.library.savePlaylists(this.presets.filter(item => !item.id.startsWith("session-")));
      this.bridgeStatus = null;
      if (this.host.bridge.pollStatus) this.bridgeStatus = await this.host.bridge.pollStatus();
      this.limitPrompt = null;
      if (this.currentLibraryRequest(request, "vlc")) {
        this.refreshLibrary();
        this.host.onLibraryChanged?.();
        this.host.onNotify(result.warning ? "歌单已加载，但未能保存重启记录" : `已加载歌单：${result.tracks.length} 首`);
      }
    } catch (error) {
      if (!this.currentLibraryRequest(request, "vlc")) return;
      const payload = (error as { payload?: { error?: string; total?: number; parts?: number } })?.payload;
      if (payload?.error === "playlist_limit") this.showLimit(payload.total!, payload.parts!, () => this.activateBridgeRoot(root, part, true));
      else throw error;
    } finally {
      if (request === this.libraryRequest) {
        this.libraryBusy = false;
        this.scanText = "";
        this.renderStatus();
        this.renderPresets();
      }
    }
  }

  // ------------------------------------------------------------------ markup

  private markup() {
    const pickerSupported = directoryPickerSupported();
    // Structures copied from the archive index modal (search field, category
    // filters, result header/rows, empty state, modal bottom) so the two search
    // surfaces read as the same interface.
    return `
<div class="search-field"><span>⌕</span><input id="music-search" type="search" autocomplete="off" value="${escapeHtml(this.query)}" placeholder="输入曲目、艺术家或专辑" aria-label="检索本地音乐"/><span class="key">ESC</span></div>
<div class="category-filters music-filters" role="group" aria-label="检索范围">${FIELD_LABELS.map(
      (item) =>
        `<button data-music-field="${item.field}" class="${item.field === this.field ? "active" : ""}">${item.label}</button>`,
    ).join("")}<span class="music-tools"><button data-music="pick">${pickerSupported ? "选择目录" : "选择文件"}</button><button data-music="scan" disabled>重新扫描</button></span></div>
<div class="music-playlists">
  <label>歌单<select id="music-playlist" aria-label="切换歌单"><option value="">当前目录</option></select></label>
  <label>名称<input id="music-playlist-name" maxlength="80" placeholder="歌单名称" aria-label="歌单名称"/></label>
  <label id="music-playlist-path-field" hidden>文件夹<input id="music-playlist-path" placeholder="例如 D:\\Music\\Favorites" aria-label="歌单音乐文件夹"/></label>
  <div class="music-tools"><button data-music="playlist-add">添加文件夹</button><button data-music="playlist-rename">重命名</button><button data-music="playlist-remove">删除预设</button></div>
  <div id="music-playlist-limit" role="alert" hidden></div>
</div>
<div class="music-status" id="music-status" role="status"></div>
<div class="result-header"><span>TRACK / 曲目</span><span>FORMAT / 格式</span><span>TIME / 时长</span></div>
<div class="search-results" id="music-results" role="listbox" aria-label="本地音乐检索结果" tabindex="-1"></div>
<div class="music-bar" id="music-bar" data-state="idle">
  <div class="music-now">
    <div class="music-cover" id="music-cover" aria-hidden="true"><span>♪</span></div>
    <div class="music-now-text">
      <strong id="music-now-title">未选择曲目</strong>
      <span id="music-now-sub">LOCAL LIBRARY / 本地曲库</span>
    </div>
  </div>
  <div class="music-controls">
    <button data-music="prev" aria-label="上一首" title="上一首">◀◀</button>
    <button data-music="toggle" class="music-play" aria-label="播放或暂停" title="播放 / 暂停">▶</button>
    <button data-music="next" aria-label="下一首" title="下一首">▶▶</button>
    <button data-music="mode" class="music-mode" aria-label="播放模式" title="播放模式">${MODE_LABELS.list}</button>
  </div>
  <div class="music-timeline">
    <span id="music-position">0:00</span>
    <div class="music-seek" id="music-seek" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
    <span id="music-duration">--:--</span>
  </div>
  <label class="music-volume"><span>音量</span><input type="range" id="music-volume" min="0" max="100" step="1" value="80" aria-label="本地音乐音量"/></label>
</div>
<div class="modal-bottom"><span id="music-result-count"></span><span id="music-engine-label"></span></div>
<input type="file" id="music-files" accept="audio/*" multiple hidden/>`;
  }

  private bind(root: HTMLElement, signal: AbortSignal) {
    root.querySelector<HTMLSelectElement>("#music-playlist")?.addEventListener("change", (event) => {
      const id = (event.target as HTMLSelectElement).value;
      if (id) void this.activatePlaylist(id).catch(error => this.playbackFailed(error));
    }, { signal });
    const input = root.querySelector<HTMLInputElement>("#music-search");
    let timer = 0;
    input?.addEventListener(
      "input",
      () => {
        this.query = input.value;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => this.renderResults(), 90);
      },
      { signal },
    );
    input?.addEventListener(
      "keydown",
      (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "ArrowDown") {
          event.preventDefault();
          this.moveCursor(1);
        } else if (key === "ArrowUp") {
          event.preventDefault();
          this.moveCursor(-1);
        } else if (key === "Enter") {
          event.preventDefault();
          void this.playCursor().catch((error) => this.playbackFailed(error));
        }
      },
      { signal },
    );

    root.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement;
        const field = target.closest<HTMLElement>("[data-music-field]");
        if (field) {
          this.field = (field.dataset.musicField as SearchField) ?? "all";
          root.querySelectorAll("[data-music-field]").forEach((node) => node.classList.toggle("active", node === field));
          this.host.onSound("ui-tick");
          this.renderResults();
          return;
        }
        const trackButton = target.closest<HTMLElement>("[data-music-track]");
        if (trackButton) {
          const index = Number(trackButton.dataset.musicIndex ?? "0");
          this.cursor = index;
          void this.playCursor().catch((error) => this.playbackFailed(error));
          return;
        }
        const action = target.closest<HTMLElement>("[data-music]")?.dataset.music;
        if (!action) return;
        void this.runAction(action).catch((error) => this.playbackFailed(error));
      },
      { signal },
    );

    root.querySelector<HTMLInputElement>("#music-volume")?.addEventListener(
      "input",
      (event) => {
        if (!this.canControl) return;
        const value = Number((event.target as HTMLInputElement).value) / 100;
        this.player.setVolume(value);
        if (this.usingBridge) void this.host.bridge.volume(value).then(() => this.pollBridge()).catch((error) => this.playbackFailed(error));
        this.host.onVolumeChange?.(value);
      },
      { signal },
    );

    const seek = root.querySelector<HTMLElement>("#music-seek");
    const scrub = (event: PointerEvent) => {
      if (!this.canControl) return;
      const rect = seek!.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      if (this.usingBridge) {
        const length = this.bridgeStatus?.length ?? 0;
        if (length > 0) void this.host.bridge.seek(ratio * length).then(() => this.pollBridge()).catch((error) => this.playbackFailed(error));
      } else {
        this.player.seek(ratio);
      }
      this.renderTimeline();
    };
    seek?.addEventListener(
      "pointerdown",
      (event) => {
        seek.setPointerCapture((event as PointerEvent).pointerId);
        scrub(event as PointerEvent);
      },
      { signal },
    );
    seek?.addEventListener("pointermove", (event) => {
      if (seek.hasPointerCapture((event as PointerEvent).pointerId)) scrub(event as PointerEvent);
    }, { signal });
    seek?.addEventListener(
      "keydown",
      (event) => {
        if (!this.canControl) return;
        const key = (event as KeyboardEvent).key;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const delta = key === "ArrowLeft" ? -5 : 5;
          if (this.usingBridge) {
            const target = Math.max(0, (this.bridgeStatus?.time ?? 0) + delta);
            void this.host.bridge.seek(target).then(() => this.pollBridge()).catch((error) => this.playbackFailed(error));
          } else {
            this.player.seekBy(delta);
          }
        } else return;
        event.preventDefault();
        this.renderTimeline();
      },
      { signal },
    );

    root.querySelector<HTMLInputElement>("#music-files")?.addEventListener(
      "change",
      (event) => {
        const files = (event.target as HTMLInputElement).files;
        if (!files || !files.length || !this.host || !this.canControl || this.usingBridge) return;
        this.cancelPending();
        this.presets = this.presets.filter(item => !item.id.startsWith("session-"));
        this.activePreset = "";
        this.host.library.useFiles(files);
        void this.startScan().catch((error) => this.playbackFailed(error));
      },
      { signal },
    );
  }

  private get player() {
    return this.host!.player;
  }

  private get library() {
    return this.host!.library;
  }

  private async runAction(action: string) {
    if (!this.canControl && action !== "reset-search" && action !== "more") return;
    if (this.libraryBusy && action !== "reset-search" && action !== "more") return;
    switch (action) {
      case "playlist-add":
        if (this.usingBridge) {
          const root = this.root?.querySelector<HTMLInputElement>("#music-playlist-path")?.value.trim();
          if (!root) { this.host.onNotify("请填写歌单对应的音乐文件夹"); return; }
          await this.activateBridgeRoot(root);
        } else await this.pickSource();
        break;
      case "playlist-rename": {
        const name = this.root?.querySelector<HTMLInputElement>("#music-playlist-name")?.value.trim();
        const preset = this.presets.find(item => item.id === this.activePreset);
        if (!name || !preset) return;
        ++this.presetRevision;
        preset.name = name;
        await this.library.savePlaylists(this.presets.filter(item => !item.id.startsWith("session-")));
        this.renderPresets();
        break;
      }
      case "playlist-remove":
        ++this.presetRevision;
        this.presets = this.presets.filter(item => item.id !== this.activePreset);
        this.activePreset = "";
        await this.library.savePlaylists(this.presets.filter(item => !item.id.startsWith("session-")));
        this.renderPresets();
        this.host.onNotify("已删除歌单预设，音乐文件保留");
        break;
      case "playlist-split": {
        const pending = this.limitPrompt;
        this.limitPrompt = null;
        this.renderPresets();
        if (pending) await pending.retry();
        break;
      }
      case "playlist-manual":
        this.limitPrompt = null;
        this.renderPresets();
        this.host.onNotify("请将歌曲整理到不同文件夹，再添加歌单；当前歌单保持不变");
        break;
      case "toggle":
        this.host.onSound("ui-tick");
        await this.togglePlayback();
        break;
      case "next":
        this.host.onSound("column");
        await this.step(1);
        break;
      case "prev":
        this.host.onSound("column");
        await this.step(-1);
        break;
      case "mode": {
        const mode = this.usingBridge ? this.host.bridge.mode() : this.player.state().mode;
        const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
        this.player.setMode(next);
        this.host.bridge.setMode(next);
        this.host.onSound("ui-tick");
        this.host.onNotify(`播放模式：${MODE_LABELS[next]}`);
        this.renderBar();
        break;
      }
      case "more": {
        const list = this.root?.querySelector<HTMLElement>("#music-results");
        const scrollTop = list?.scrollTop ?? 0;
        const firstNew = this.visibleResults;
        this.visibleResults += RESULT_PAGE_SIZE;
        this.renderResults();
        if (list) {
          list.scrollTop = scrollTop;
          list.querySelector<HTMLElement>(`[data-music-index="${firstNew}"]`)?.focus({ preventScroll: true });
        }
        break;
      }
      case "pick":
        await this.pickSource();
        break;
      case "scan":
        await this.startScan();
        break;
      case "reset-search": {
        // Mirrors the archive index: the empty state offers a way back.
        this.query = "";
        this.field = "all";
        this.cursor = -1;
        const input = this.root?.querySelector<HTMLInputElement>("#music-search");
        if (input) input.value = "";
        this.root?.querySelectorAll("[data-music-field]").forEach((node, index) => {
          node.classList.toggle("active", index === 0);
        });
        this.host.onSound("ui-tick");
        this.renderResults();
        break;
      }
      default:
        break;
    }
  }

  /** Play/pause, routed to whichever engine is active. */
  private async togglePlayback() {
    if (!this.canControl || (this.usingBridge && !this.bridgeAvailable())) return;
    const engine = this.host.engine();
    const request = ++this.playbackRequest;
    await this.host.beforePlayback?.();
    if (!this.currentPlaybackRequest(request, engine)) return;
    this.queueResults();
    if (engine === "browser") {
      if (this.player.currentTrack()) await this.player.toggle();
      else {
        const track = this.results[this.cursor] ?? this.results[0] ?? this.library.tracks[0];
        if (track) await this.player.play(track);
      }
      if (this.currentPlaybackRequest(request, engine)) this.renderBar();
      return;
    }
    const current = this.bridgeStatus;
    if (current?.state === "playing") {
      await this.host.bridge.pause();
    } else if (current?.state === "paused" && current.currentId) {
      await this.host.bridge.resume();
    } else {
      const id = this.results[this.cursor]?.id ?? current?.currentId ?? this.library.tracks[0]?.id;
      if (!id) return;
      this.bridgePending = true;
      this.renderBar();
      await this.host.bridge.play(id);
    }
    if (!this.currentBridgeRequest(request)) return;
    this.bridgePending = false;
    await this.pollBridge();
  }

  /** Both engines receive the full search queue, including rows not rendered yet. */
  private async step(direction: 1 | -1) {
    if (!this.canControl || (this.usingBridge && !this.bridgeAvailable())) return;
    const engine = this.host.engine();
    const request = ++this.playbackRequest;
    await this.host.beforePlayback?.();
    if (!this.currentPlaybackRequest(request, engine)) return;
    this.queueResults();
    if (engine === "browser") {
      await (direction === 1 ? this.player.next() : this.player.previous());
      return;
    }
    this.bridgePending = true;
    this.renderBar();
    await (direction === 1 ? this.host.bridge.next() : this.host.bridge.previous());
    if (!this.currentBridgeRequest(request)) return;
    this.bridgePending = false;
    await this.pollBridge();
  }

  private currentBridgeRequest(request: number) {
    return this.currentPlaybackRequest(request, "vlc") && this.host.bridge.connected;
  }

  private bridgeAvailable() {
    if (this.host.bridge.connected) return true;
    this.bridgePending = false;
    this.host.onNotify("VLC 桥接已断线，正在等待重连");
    this.renderStatus();
    this.renderBar();
    return false;
  }

  private playbackFailed(error: unknown) {
    this.bridgePending = false;
    this.host.onNotify(error instanceof Error ? error.message : "播放操作失败");
    this.renderStatus();
    this.renderBar();
  }

  private bridgePlaybackState() {
    const status = this.bridgeStatus;
    return this.host.bridge.connected && status
      ? status
      : { state: "offline" as const, currentId: status?.currentId ?? null, time: status?.time ?? 0, length: status?.length ?? 0 };
  }

  private async pickSource() {
    if (!this.canControl || this.libraryBusy) return;
    if (this.usingBridge) {
      this.root?.querySelector<HTMLInputElement>("#music-playlist-path")?.focus();
      this.host.onNotify("填写文件夹和歌单名称，再点击「添加文件夹」");
      return;
    }
    this.cancelPending();
    const request = this.libraryRequest;
    if (!directoryPickerSupported()) {
      this.root?.querySelector<HTMLInputElement>("#music-files")?.click();
      return;
    }
    try {
      this.host.onSound("page-open");
      const picked = await this.library.pick();
      if (!picked || !this.currentLibraryRequest(request, "browser")) return;
      await this.startScan();
    } catch (e) {
      if (!this.currentLibraryRequest(request, "browser")) return;
      const message = e instanceof Error && e.message === "permission" ? "目录权限被拒绝，无法读取曲库" : "已取消选择目录";
      this.host.onNotify(message);
      this.renderStatus();
    }
  }

  async startScan(options: { split?: boolean; part?: number } = {}) {
    if (!this.canControl || this.libraryBusy) return;
    this.scanAbort?.abort();
    this.library.cancelScan();
    const request = ++this.libraryRequest;
    const engine = this.host.engine();
    const current = () => this.currentLibraryRequest(request, engine);
    if (this.usingBridge) {
      if (!this.bridgeAvailable()) return;
      if (this.host.bridge.info?.playlist?.needsSplit) {
        const info = this.host.bridge.info.playlist;
        this.showLimit(info.total, info.parts, () => this.activateBridgeRoot(info.root, 0, true));
        return;
      }
      // The bridge owns the folder; ask it to rescan and re-read the catalogue.
      this.host.onSound("scan");
      this.scanText = "VLC 桥接正在重新扫描…";
      this.libraryBusy = true;
      this.lastStatus = "";
      this.renderStatus();
      this.renderPresets();
      try {
        const report = await this.host.bridge.rescan();
        if (!current() || !this.host.bridge.connected) return;
        if (!report) throw new Error("scan failed");
        const tracks = await this.host.bridge.library();
        if (!current() || !this.host.bridge.connected) return;
        this.library.useBridgeTracks(tracks, this.library.label);
        this.host.bridge.queueTracks(tracks);
        this.scanText = "";
        this.refreshLibrary();
        this.host.onLibraryChanged?.();
        this.host.onNotify(
          report
            ? `VLC 曲库已更新：${tracks.length} 首（新增 ${report.added} · 沿用 ${report.reused} · 跳过 ${report.failed}，${report.ms}ms）`
            : `VLC 曲库已更新：${tracks.length} 首`,
        );
        this.host.onSound("confirm");
      } catch (error) {
        if (!current()) return;
        this.scanText = "";
        this.renderStatus();
        const payload = (error as { payload?: { error?: string; total?: number; parts?: number } })?.payload;
        if (payload?.error === "playlist_limit") this.showLimit(payload.total!, payload.parts!, () => this.activateBridgeRoot(this.host.bridge.info!.root, 0, true));
        else this.host.onNotify("VLC 桥接重新扫描失败");
      } finally {
        if (request === this.libraryRequest) this.libraryBusy = false;
        this.renderStatus();
        this.renderPresets();
      }
      return;
    }
    if (!this.library.hasSource) {
      await this.pickSource();
      return;
    }
    const controller = new AbortController();
    this.scanAbort = controller;
    this.libraryBusy = true;
    this.renderPresets();
    this.host.onSound("scan");
    this.scanText = "正在读取目录…";
    this.renderStatus();
    let report;
    try {
      if (this.host.beforeLibraryChange) await this.host.beforeLibraryChange();
      if (!current() || controller.signal.aborted) return;
      report = await this.library.scan((progress) => {
        if (current() && !controller.signal.aborted) this.renderScanProgress(progress);
      }, { ...options, signal: controller.signal });
    } catch (error) {
      if (current() && !controller.signal.aborted) {
        if (error instanceof Error && error.name === "PlaylistLimitError") {
          const limit = error as Error & { total: number; parts: number };
          this.showLimit(limit.total, limit.parts, () => this.startScan({ ...options, split: true }));
        } else this.host.onNotify(error instanceof Error ? error.message : "扫描失败");
      }
      return;
    } finally {
      if (current()) {
        this.scanAbort = null;
        this.scanText = "";
        this.renderStatus();
      }
      if (request === this.libraryRequest && report?.phase !== "done") this.libraryBusy = false;
      this.renderPresets();
    }
    if (!current() || controller.signal.aborted || report.phase === "cancelled") return;
    if (report.phase === "error") {
      this.host.onNotify("扫描中断，已保留原有曲库");
      return;
    }
    try {
      try { await this.rememberBrowserPlaylist(report, request); }
      catch { if (current()) this.host.onNotify("歌单已加载，但未能保存预设"); }
      if (!current()) return;
      this.limitPrompt = null;
      this.renderPresets();
      this.refreshLibrary();
      this.host.onLibraryChanged?.();
      const parts = [`${report.total} 首曲目`];
      if (report.added) parts.push(`新增 ${report.added}`);
      if (report.updated) parts.push(`更新 ${report.updated}`);
      if (report.removed) parts.push(`移除 ${report.removed}`);
      if (report.failed) parts.push(`跳过 ${report.failed}`);
      if (report.reused) parts.push(`沿用 ${report.reused}`);
      this.host.onNotify(`曲库已更新：${parts.join(" · ")}（${(report.ms / 1000).toFixed(1)}s）`);
      this.host.onSound("confirm");
    } finally {
      if (request === this.libraryRequest) this.libraryBusy = false;
      this.renderStatus();
      this.renderPresets();
      void this.refreshPresets();
    }
  }

  private async autoRestore() {
    if (this.usingBridge || !this.canControl) return;
    if (this.library.hasSource) {
      this.renderStatus();
      return;
    }
    // A remembered directory handle is reopened without a picker; the browser
    // still needs a gesture to grant read permission again, which the panel
    // offers through the "恢复曲库" button.
    const request = ++this.libraryRequest;
    const restored = await this.library.restore().catch(error => {
      if (error instanceof Error && error.name === "PlaylistLimitError") {
        const limit = error as Error & { total: number; parts: number };
        this.promptOversizedLibrary(limit.total, limit.parts);
      }
      return false;
    });
    if (!this.currentLibraryRequest(request, "browser")) return;
    if (restored) {
      this.refreshLibrary();
      this.host.onLibraryChanged?.();
    } else this.renderStatus();
  }

  private refreshIndex() {
    this.visibleResults = RESULT_PAGE_SIZE;
    this.resultScope = "";
    this.renderResults();
  }

  // ----------------------------------------------------------------- render

  private renderAll() {
    this.renderResults();
    this.renderStatus();
    this.renderBar();
    this.renderTimeline();
  }

  private renderResults() {
    const list = this.root?.querySelector<HTMLElement>("#music-results");
    if (!list) return;
    const scope = `${this.field}\n${this.query}`;
    if (scope !== this.resultScope) {
      this.resultScope = scope;
      this.visibleResults = RESULT_PAGE_SIZE;
      this.cursor = -1;
    }
    const tracks = this.library.search(this.query, this.field);
    this.results = tracks;
    if (this.cursor >= tracks.length) this.cursor = Math.max(0, tracks.length - 1);
    if (this.cursor >= this.visibleResults) this.visibleResults = Math.ceil((this.cursor + 1) / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE;
    const terms = tokenize(this.query);
    const playingId = this.activeId();
    this.renderCount(tracks.length);

    if (!tracks.length) {
      list.innerHTML = this.library.tracks.length
        ? `<div class="empty-results"><span>∅</span><strong>没有匹配的曲目</strong><p>尝试其他曲目、艺术家或专辑名称，或切换上方的检索范围。</p><button data-music="reset-search">重置检索 →</button></div>`
        : `<div class="empty-results"><span>♪</span><strong>尚未建立本地曲库</strong><p>${
            directoryPickerSupported()
              ? "选择本机音乐目录即可检索与播放，索引保存在本机浏览器中。"
              : "当前浏览器不支持目录授权，可以先选择文件，仅本次会话可用。"
          }</p><button data-music="pick">${directoryPickerSupported() ? "选择音乐目录 →" : "选择音乐文件 →"}</button></div>`;
      return;
    }

    const highlight = (text: string) =>
      matchSegments(text, terms)
        .map((segment) => (segment.hit ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)))
        .join("");
    list.innerHTML = tracks.slice(0, this.visibleResults)
      .map((track, index) => {
        const classes = [
          "result-row",
          index === this.cursor ? "cursor" : "",
          track.id === playingId ? "playing" : "",
          track.missing ? "missing" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const glyph = track.missing ? "∅" : track.id === playingId ? "♪" : "";
        return `<button class="${classes}" data-music-track="${escapeHtml(track.id)}" data-music-index="${index}" role="option" aria-selected="${index === this.cursor}">
  <span class="result-name"><b>${String(index + 1).padStart(2, "0")}</b><span>${highlight(track.title || track.name)}<small>${highlight(
    [track.artist, track.album].filter(Boolean).join(" · ") || "未知艺术家",
  )}</small></span></span>
  <span>${CODE_LABELS[track.codec] ?? track.codec.toUpperCase().slice(0, 4)}</span>
  <span><span>${track.missing ? "文件失效" : formatDuration(track.duration)}</span><i>${glyph}</i></span>
</button>`;
      })
      .join("") + (tracks.length > this.visibleResults
        ? `<button class="music-more" data-music="more">继续显示 ${Math.min(RESULT_PAGE_SIZE, tracks.length - this.visibleResults)} 首（共 ${tracks.length} 首） ↓</button>`
        : "");
  }

  private renderCount(count: number) {
    const node = this.root?.querySelector<HTMLElement>("#music-result-count");
    if (node) node.textContent = `${String(count).padStart(2, "0")} TRACKS FOUND${count > this.visibleResults ? ` · 已显示 ${this.visibleResults}` : ""}`;
  }

  private renderStatus(progress?: ScanProgress) {
    const node = this.root?.querySelector<HTMLElement>("#music-status");
    if (!node) return;
    const stats = this.library.stats();
    const label = this.library.label || "未选择目录";
    const scan = progress
      ? `${this.phaseLabel(progress.phase)} · 已发现 ${progress.seen} 项 · 解析 ${progress.parsed}`
      : this.scanText;
    const parts = scan
      ? [scan]
      : [
          label,
          `${stats.count} 首`,
          stats.artists ? `${stats.artists} 位艺术家` : "",
          formatLibrarySize(stats.bytes),
          this.library.persistent ? "已记忆目录" : this.library.source ? "本次会话" : "未授权",
          stats.missing ? `${stats.missing} 首失效` : "",
        ].filter(Boolean);
    const html = `<span title="${escapeHtml(label)}">${escapeHtml(parts.join(" · "))}</span>`;
    if (html !== this.lastStatus) {
      this.lastStatus = html;
      node.innerHTML = html;
    }

    const engine = this.root?.querySelector<HTMLElement>("#music-engine-label");
    const live = this.usingBridge ? this.host.bridge.connected : Boolean(this.library.source);
    if (engine) {
      engine.innerHTML = `${this.usingBridge ? "VLC 内核" : "浏览器内核"} <i>●</i> ${live ? "CONNECTED" : this.usingBridge ? "OFFLINE / 等待重连" : "STANDBY"}`;
    }
    const scanButton = this.root?.querySelector<HTMLElement>('[data-music="scan"]');
    if (scanButton) scanButton.toggleAttribute("disabled", !live || !this.canControl || this.libraryBusy || this.library.scanning);
  }

  private renderScanProgress(progress: ScanProgress) {
    const node = this.root?.querySelector<HTMLElement>("#music-status");
    if (!node) return;
    const text = `${this.phaseLabel(progress.phase)} · 已发现 ${progress.seen} 项 · 解析 ${progress.parsed} · 沿用 ${progress.reused}`;
    if (text === this.scanText) return;
    this.scanText = text;
    this.lastStatus = "";
    this.renderStatus(progress);
  }

  private phaseLabel(phase: ScanProgress["phase"]) {
    return {
      walking: "读取目录",
      reading: "解析标签",
      saving: "写入索引",
      done: "完成",
      cancelled: "已取消",
      error: "中断",
    }[phase];
  }

  private renderBar() {
    const bar = this.root?.querySelector<HTMLElement>("#music-bar");
    if (!bar) return;
    const playerState = this.player.state();
    const bridgeState = this.usingBridge ? this.bridgePlaybackState() : null;
    const state = bridgeState
      ? {
          id: bridgeState.currentId,
          playing: bridgeState.state === "playing",
          position: bridgeState.time,
          duration: bridgeState.length,
          mode: this.host.bridge.mode(),
          error: bridgeState.state === "offline" ? "VLC 未响应" : "",
          loading: this.bridgePending && bridgeState.state !== "playing",
        }
      : playerState;
    const track = bridgeState
      ? this.library.tracks.find((item) => item.id === bridgeState.currentId) ?? null
      : this.player.currentTrack();
    bar.dataset.state = state.error
      ? "error"
      : state.playing
        ? "playing"
        : "loading" in state && state.loading
          ? "loading"
          : track
            ? "paused"
            : "idle";
    const play = bar.querySelector<HTMLElement>('[data-music="toggle"]');
    if (play) {
      play.textContent = state.playing ? "❚❚" : "▶";
      play.setAttribute("aria-label", state.playing ? "暂停" : "播放");
    }
    const mode = bar.querySelector<HTMLElement>('[data-music="mode"]');
    if (mode) mode.textContent = MODE_LABELS[state.mode];
    const title = track ? track.title || "未知曲目" : "未选择曲目";
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      const node = bar.querySelector<HTMLElement>("#music-now-title");
      if (node) node.textContent = title;
    }
    const sub = bar.querySelector<HTMLElement>("#music-now-sub");
    if (sub)
      sub.textContent = track
        ? [track.artist || "未知艺术家", track.album].filter(Boolean).join(" · ")
        : "LOCAL LIBRARY / 本地曲库";
    const volume = bar.querySelector<HTMLInputElement>("#music-volume");
    if (volume && document.activeElement !== volume) {
      volume.value = String(Math.round(this.player.volume() * 100));
    }
    this.renderCover(track?.id ?? null);
  }

  private async renderCover(id: string | null) {
    const node = this.root?.querySelector<HTMLElement>("#music-cover");
    if (!node || !this.host) return;
    const key = id ?? "";
    if (node.dataset.coverFor === key) return;
    const request = ++this.coverRequest;
    this.coverLease?.release();
    this.coverLease = null;
    node.dataset.coverFor = key;
    node.style.backgroundImage = "";
    node.classList.remove("has-cover");
    if (!id) {
      node.style.backgroundImage = "";
      node.classList.remove("has-cover");
      return;
    }
    const track = this.library.tracks.find((item) => item.id === id);
    if (!track) return;
    const lease = await this.library.acquireCover(track).catch(() => null);
    if (request !== this.coverRequest || node.dataset.coverFor !== key) {
      lease?.release();
      return;
    }
    if (lease) {
      this.coverLease = lease;
      node.style.backgroundImage = `url("${lease.url}")`;
      node.classList.add("has-cover");
    } else {
      node.style.backgroundImage = "";
      node.classList.remove("has-cover");
    }
  }

  private resetCover() {
    ++this.coverRequest;
    this.coverLease?.release();
    this.coverLease = null;
    const node = this.root?.querySelector<HTMLElement>("#music-cover");
    if (!node) return;
    delete node.dataset.coverFor;
    node.style.backgroundImage = "";
    node.classList.remove("has-cover");
  }

  private renderTimeline() {
    if (!this.mounted) return;
    const bridgeState = this.usingBridge ? this.bridgePlaybackState() : null;
    const playerState = this.player.state();
    const state = bridgeState
      ? { position: bridgeState.time, duration: bridgeState.length, playing: bridgeState.state === "playing" }
      : playerState;
    const position = Math.floor(state.position);
    if (position !== this.lastPosition) {
      this.lastPosition = position;
      const node = this.root?.querySelector<HTMLElement>("#music-position");
      if (node) node.textContent = formatDuration(state.position);
    }
    const durationNode = this.root?.querySelector<HTMLElement>("#music-duration");
    if (durationNode) durationNode.textContent = formatDuration(state.duration);
    const seek = this.root?.querySelector<HTMLElement>("#music-seek");
    if (seek) {
      const ratio = state.duration > 0 ? Math.min(1, state.position / state.duration) : 0;
      seek.style.setProperty("--music-progress", `${(ratio * 100).toFixed(2)}%`);
      seek.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      seek.classList.toggle("scrubbing", state.playing);
    }
  }

  /** Follows the currently playing row; idempotent, safe to call every frame. */
  syncPlayingRow(trackId: string | null) {
    if (!this.mounted) return;
    const changed = trackId !== this.lastPlayingId;
    this.lastPlayingId = trackId;
    if (!changed && trackId) return;
    const list = this.root?.querySelector<HTMLElement>("#music-results");
    if (!list) return;
    list.querySelectorAll<HTMLElement>(".result-row.playing").forEach((row) => row.classList.remove("playing"));
    if (trackId) {
      const index = this.results.findIndex((track) => track.id === trackId);
      if (index >= 0) {
        if (index >= this.visibleResults) {
          this.visibleResults = Math.ceil((index + 1) / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE;
          this.renderResults();
        }
        const row = list.querySelector<HTMLElement>(`.result-row[data-music-index="${index}"]`);
        row?.classList.add("playing");
        if (changed) row?.scrollIntoView({ block: "nearest" });
      }
    }
    if (changed) this.renderBar();
  }

  private moveCursor(step: number) {
    if (!this.results.length) return;
    this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + step));
    this.renderResults();
    this.root
      ?.querySelector<HTMLElement>(`.result-row[data-music-index="${this.cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  private async playCursor() {
    if (!this.canControl || (this.usingBridge && !this.bridgeAvailable())) return;
    const track = this.results[this.cursor] ?? this.results[0];
    if (!track) return;
    const engine = this.host.engine();
    const request = ++this.playbackRequest;
    await this.host.beforePlayback?.();
    if (!this.currentPlaybackRequest(request, engine)) return;
    this.queueResults();
    this.host.onSound("open");
    if (this.usingBridge) {
      if (!track.bridge) return;
      // VLC owns the file; the page only sends the id from its own catalogue.
      this.bridgePending = true;
      this.renderBar();
      await this.host.bridge.play(track.id);
      if (!this.currentBridgeRequest(request)) return;
      this.bridgePending = false;
      this.bridgeAccumulator = 0;
      await this.pollBridge();
      if (!this.currentBridgeRequest(request)) return;
      this.renderBar();
      this.syncPlayingRow(track.id);
      return;
    }
    await this.player.play(track);
    if (!this.currentPlaybackRequest(request, engine) || this.player.currentTrack()?.id !== track.id) return;
    this.renderBar();
    this.syncPlayingRow(track.id);
  }
}
