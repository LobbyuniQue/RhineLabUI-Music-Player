// Local music panel: library status, search, results and the player bar.
//
// The panel owns its subtree inside the shared terminal modal and binds its own
// delegated listeners on mount, so main.ts only has to register the modal kind
// and hand over the library + player instances.

import { escapeHtml } from "./html";
import type { Sound } from "./audio";
import { MusicSearchIndex, formatDuration, formatLibrarySize, matchSegments, tokenize, type SearchField } from "./music-search";
import type { LibraryTrack, MusicLibrary, ScanProgress } from "./music-library";
import type { MusicPlayer, PlayMode } from "./music-player";
import type { BridgeScan, BridgeStatus, BridgeTrack } from "./music-bridge";
import { directoryPickerSupported } from "./music-source";

export type MusicPanelHost = {
  library: MusicLibrary;
  player: MusicPlayer;
  /** Local VLC bridge; only used when `engine()` returns "vlc". */
  bridge: {
    connected: boolean;
    play(id: string): Promise<unknown>;
    pause(): Promise<unknown>;
    stop(): Promise<unknown>;
    seek(seconds: number): Promise<unknown>;
    volume(value: number): Promise<unknown>;
    status(): Promise<BridgeStatus | null>;
    library(): Promise<BridgeTrack[]>;
    rescan(full?: boolean): Promise<BridgeScan | null>;
  };
  engine: () => "browser" | "vlc";
  onSound: (sound: Sound, pan?: number) => void;
  onNotify: (message: string) => void;
  onOpenSettings: () => void;
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
  private index = new MusicSearchIndex<LibraryTrack>([]);
  private scanText = "";
  private scanAbort: AbortController | null = null;
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

  constructor() {}

  get active() {
    return this.mounted;
  }

  attach(host: MusicPanelHost) {
    this.host = host;
  }

  mount(root: HTMLElement, host?: MusicPanelHost) {
    if (host) this.host = host;
    this.root = root;
    this.controller?.abort();
    this.controller = new AbortController();
    this.mounted = true;
    this.lastPlayingId = null;
    root.innerHTML = this.markup();
    this.bind(root, this.controller.signal);
    this.refreshIndex();
    this.renderAll();
    if (!this.host.library.tracks.length) this.autoRestore();
  }

  unmount() {
    this.controller?.abort();
    this.controller = null;
    this.scanAbort?.abort();
    this.scanAbort = null;
    this.mounted = false;
    this.root = null;
    this.lastPlayingId = null;
  }

  /** Called from the app frame loop. The player itself ticks from the same
   * loop regardless of the panel, so closing this window never freezes the
   * analyser that drives the archive music reaction. */
  tick(dt: number) {
    if (!this.mounted) return;
    // Track changes can arrive without a panel gesture (MediaSession keys,
    // browser-engine next/previous); keep the highlight and bar in step.
    this.syncPlayingRow(this.activeId());
    if (this.usingBridge) {
      // The bridge plays through VLC; the page only mirrors its transport state.
      this.bridgeAccumulator += dt;
      if (this.bridgeAccumulator > 1 && !this.bridgeBusy) {
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
    return this.host.engine() === "vlc" && this.host.bridge.connected;
  }

  /** The track the UI marks as playing, whichever engine owns it. */
  private activeId(): string | null {
    if (this.usingBridge) return this.bridgeStatus?.currentId ?? null;
    return this.player.state().id;
  }

  private async pollBridge() {
    this.bridgeBusy = true;
    try {
      const status = await this.host.bridge.status();
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
    this.refreshIndex();
    this.cursor = -1;
    if (this.mounted) this.renderAll();
  }

  // ------------------------------------------------------------------ markup

  private markup() {
    const pickerSupported = directoryPickerSupported();
    // Structures copied from the archive index modal (search field, category
    // filters, result header/rows, empty state, modal bottom) so the two search
    // surfaces read as the same interface.
    return `
<div class="search-field"><span>⌕</span><input id="music-search" type="search" autocomplete="off" placeholder="输入曲目、艺术家或专辑" aria-label="检索本地音乐"/><span class="key">ESC</span></div>
<div class="category-filters music-filters" role="group" aria-label="检索范围">${FIELD_LABELS.map(
      (item, index) =>
        `<button data-music-field="${item.field}" class="${index === 0 ? "active" : ""}">${item.label}</button>`,
    ).join("")}<span class="music-tools"><button data-music="pick">${pickerSupported ? "选择目录" : "选择文件"}</button><button data-music="scan" disabled>重新扫描</button></span></div>
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
          this.playCursor();
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
          void this.playCursor();
          return;
        }
        const action = target.closest<HTMLElement>("[data-music]")?.dataset.music;
        if (!action) return;
        void this.runAction(action);
      },
      { signal },
    );

    root.querySelector<HTMLInputElement>("#music-volume")?.addEventListener(
      "input",
      (event) => {
        const value = Number((event.target as HTMLInputElement).value) / 100;
        this.player.setVolume(value);
        if (this.usingBridge) void this.host.bridge.volume(value).then(() => this.pollBridge());
        this.host.onVolumeChange?.(value);
      },
      { signal },
    );

    const seek = root.querySelector<HTMLElement>("#music-seek");
    const scrub = (event: PointerEvent) => {
      const rect = seek!.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      if (this.usingBridge) {
        const length = this.bridgeStatus?.length ?? 0;
        if (length > 0) void this.host.bridge.seek(ratio * length).then(() => this.pollBridge());
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
        const key = (event as KeyboardEvent).key;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const delta = key === "ArrowLeft" ? -5 : 5;
          if (this.usingBridge) {
            const target = Math.max(0, (this.bridgeStatus?.time ?? 0) + delta);
            void this.host.bridge.seek(target).then(() => this.pollBridge());
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
        if (!files || !files.length || !this.host) return;
        this.host.library.useFiles(files);
        void this.startScan();
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
    switch (action) {
      case "toggle":
        this.host.onSound("ui-tick");
        await this.togglePlayback();
        break;
      case "next":
        this.host.onSound("column");
        await this.step(-1);
        break;
      case "prev":
        this.host.onSound("column");
        await this.step(1);
        break;
      case "mode": {
        const next = MODE_ORDER[(MODE_ORDER.indexOf(this.player.state().mode) + 1) % MODE_ORDER.length];
        this.player.setMode(next);
        this.host.onSound("ui-tick");
        this.host.onNotify(`播放模式：${MODE_LABELS[next]}`);
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
    if (!this.usingBridge) {
      await this.player.toggle();
      return;
    }
    const current = this.bridgeStatus;
    if (current?.state === "playing") {
      this.bridgeStatus = await this.host.bridge.pause().then(() => this.host.bridge.status());
      this.renderBar();
      return;
    }
    const id = current?.currentId ?? this.results[this.cursor]?.id ?? this.library.tracks[0]?.id;
    if (id) {
      await this.host.bridge.play(id);
      this.bridgeStatus = await this.host.bridge.status();
      this.renderBar();
      this.syncPlayingRow(id);
    }
  }

  /**
   * Moves through the visible results. VLC has no queue the page can reorder, so
   * the direction is resolved here and handed to the bridge as a single play.
   */
  private async step(direction: 1 | -1) {
    if (!this.usingBridge) {
      await (direction === 1 ? this.player.next() : this.player.previous());
      return;
    }
    const list = this.results.length ? this.results : this.library.tracks;
    if (!list.length) return;
    const currentId = this.bridgeStatus?.currentId ?? null;
    const index = currentId ? list.findIndex((track) => track.id === currentId) : -1;
    const nextIndex = ((index < 0 ? 0 : index + direction) % list.length + list.length) % list.length;
    const target = list[nextIndex];
    await this.host.bridge.play(target.id);
    this.bridgeStatus = await this.host.bridge.status();
    this.cursor = nextIndex;
    this.renderResults();
    this.renderBar();
    this.syncPlayingRow(target.id);
  }

  private async pickSource() {
    if (!directoryPickerSupported()) {
      this.root?.querySelector<HTMLInputElement>("#music-files")?.click();
      return;
    }
    try {
      this.host.onSound("page-open");
      await this.library.pick();
      await this.startScan();
    } catch (e) {
      const message = e instanceof Error && e.message === "permission" ? "目录权限被拒绝，无法读取曲库" : "已取消选择目录";
      this.host.onNotify(message);
      this.renderStatus();
    }
  }

  async startScan() {
    if (this.usingBridge) {
      // The bridge owns the folder; ask it to rescan and re-read the catalogue.
      this.host.onSound("scan");
      this.scanText = "VLC 桥接正在重新扫描…";
      this.lastStatus = "";
      this.renderStatus();
      try {
        const report = await this.host.bridge.rescan();
        const tracks = await this.host.bridge.library();
        this.library.useBridgeTracks(tracks, this.library.label);
        this.scanText = "";
        this.refreshIndex();
        this.renderAll();
        this.host.onLibraryChanged?.();
        this.host.onNotify(
          report
            ? `VLC 曲库已更新：${tracks.length} 首（新增 ${report.added} · 沿用 ${report.reused} · 跳过 ${report.failed}，${report.ms}ms）`
            : `VLC 曲库已更新：${tracks.length} 首`,
        );
        this.host.onSound("confirm");
      } catch {
        this.scanText = "";
        this.renderStatus();
        this.host.onNotify("VLC 桥接重新扫描失败");
      }
      return;
    }
    if (!this.library.source) {
      await this.pickSource();
      return;
    }
    this.scanAbort?.abort();
    const controller = new AbortController();
    this.scanAbort = controller;
    this.host.onSound("scan");
    this.scanText = "正在读取目录…";
    this.renderStatus();
    const report = await this.library.scan((progress) => this.renderScanProgress(progress), {
      signal: controller.signal,
    });
    this.scanAbort = null;
    this.scanText = "";
    this.refreshIndex();
    this.cursor = -1;
    this.renderAll();
    this.host.onLibraryChanged?.();
    if (report.phase === "error") {
      this.host.onNotify("扫描中断，已保留原有曲库");
      return;
    }
    const parts = [`${report.total} 首曲目`];
    if (report.added) parts.push(`新增 ${report.added}`);
    if (report.updated) parts.push(`更新 ${report.updated}`);
    if (report.removed) parts.push(`移除 ${report.removed}`);
    if (report.failed) parts.push(`跳过 ${report.failed}`);
    if (report.reused) parts.push(`沿用 ${report.reused}`);
    this.host.onNotify(`曲库已更新：${parts.join(" · ")}（${(report.ms / 1000).toFixed(1)}s）`);
    this.host.onSound("confirm");
  }

  private async autoRestore() {
    if (this.library.source) {
      this.renderStatus();
      return;
    }
    // A remembered directory handle is reopened without a picker; the browser
    // still needs a gesture to grant read permission again, which the panel
    // offers through the "恢复曲库" button.
    await this.library.restore().catch(() => false);
    this.renderStatus();
  }

  private refreshIndex() {
    this.index = new MusicSearchIndex<LibraryTrack>(this.library.tracks);
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
    const tracks = this.library.search(this.query, this.field);
    this.results = tracks;
    if (this.cursor >= tracks.length) this.cursor = Math.max(0, tracks.length - 1);
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
    list.innerHTML = tracks
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
      .join("");
  }

  private renderCount(count: number) {
    const node = this.root?.querySelector<HTMLElement>("#music-result-count");
    if (node) node.textContent = `${String(count).padStart(2, "0")} TRACKS FOUND`;
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
    if (html === this.lastStatus) return;
    this.lastStatus = html;
    node.innerHTML = html;

    const engine = this.root?.querySelector<HTMLElement>("#music-engine-label");
    const live = this.usingBridge ? this.host.bridge.connected : Boolean(this.library.source);
    if (engine) {
      engine.innerHTML = `${this.usingBridge ? "VLC 内核" : "浏览器内核"} <i>●</i> ${live ? "CONNECTED" : "STANDBY"}`;
    }
    const scanButton = this.root?.querySelector<HTMLElement>('[data-music="scan"]');
    if (scanButton) scanButton.toggleAttribute("disabled", !live);
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
    const bridgeState = this.usingBridge ? this.bridgeStatus : null;
    const state = bridgeState
      ? {
          id: bridgeState.currentId,
          playing: bridgeState.state === "playing",
          position: bridgeState.time,
          duration: bridgeState.length,
          mode: playerState.mode,
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
    node.dataset.coverFor = key;
    if (!id) {
      node.style.backgroundImage = "";
      node.classList.remove("has-cover");
      return;
    }
    const track = this.library.tracks.find((item) => item.id === id);
    if (!track) return;
    const url = await this.library.coverUrl(track).catch(() => null);
    if (node.dataset.coverFor !== key) return;
    if (url) {
      node.style.backgroundImage = `url("${url}")`;
      node.classList.add("has-cover");
    } else {
      node.style.backgroundImage = "";
      node.classList.remove("has-cover");
    }
  }

  private renderTimeline() {
    if (!this.mounted) return;
    const bridgeState = this.usingBridge ? this.bridgeStatus : null;
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
    const track = this.results[this.cursor] ?? this.results[0];
    if (!track) return;
    this.host.onSound("open");
    if (this.usingBridge && track.bridge) {
      // VLC owns the file; the page only sends the id from its own catalogue.
      this.bridgePending = true;
      await this.host.bridge.play(track.id);
      this.bridgeAccumulator = 0;
      await this.pollBridge();
      this.renderBar();
      this.syncPlayingRow(track.id);
      return;
    }
    this.player.queueTracks(
      (this.results.length ? this.results : this.library.tracks).map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        codec: item.codec,
      })),
    );
    await this.player.play(track);
    this.renderBar();
    this.syncPlayingRow(track.id);
  }
}
