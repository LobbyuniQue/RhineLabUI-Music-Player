// Client for the local VLC bridge (scripts/vlc-bridge.mjs).
//
// The page cannot decode formats the browser does not support, and it cannot
// link libVLC, so when the user runs the bridge the page delegates the whole
// playback path to it: VLC decodes and plays, the bridge exposes transport,
// metadata and a 128 sample spectrum that feeds the existing archive music
// reaction. Without a bridge the page falls back to its own player.
import { queueIndex, type PlayMode } from "./music-queue.ts";

export type BridgeTrack = {
  id: string;
  name: string;
  title: string;
  artist: string;
  album: string;
  track: number | null;
  disc?: number | null;
  year?: string;
  genre?: string;
  duration: number | null;
  codec: string;
  size: number;
  hasCover?: boolean;
  folder: string;
};

export type BridgeScan = {
  phase: string;
  seen: number;
  added: number;
  reused: number;
  failed: number;
  ms: number;
};

export type BridgeHealth = {
  ok: boolean;
  /** False while VLC is still starting or the first scan has not finished. */
  ready?: boolean;
  root: string;
  tracks: number;
  playlist?: BridgePlaylist;
  scan: BridgeScan;
  vlc: { version: string; pid: number | null; startedAt: number };
};

export type BridgePlaylist = { root: string; part: number; total: number; parts: number; limit: number; split: boolean; needsSplit: boolean };
export type BridgeCatalogue = { root: string; tracks: BridgeTrack[]; playlist: BridgePlaylist; scan?: BridgeScan; warning?: string };

export class BridgeRequestError extends Error {
  readonly status: number;
  readonly payload: { error?: string; total?: number; parts?: number };
  constructor(status: number, payload: { error?: string; total?: number; parts?: number }) {
    super(`HTTP ${status}${payload.error ? `: ${payload.error}` : ""}`);
    this.status = status;
    this.payload = payload;
  }
}

export type BridgeStatus = {
  state: "playing" | "paused" | "stopped" | "offline";
  time: number;
  length: number;
  volume: number;
  currentId: string | null;
  title: string;
  artist: string;
  album: string;
  codec: string;
  loading?: boolean;
  prepared?: boolean;
  ended?: boolean;
  vlc: { version: string; pid: number | null; startedAt: number };
};

export type MusicBridgeOptions = {
  port: number;
  token: string;
  /** Optional reveal/animation route for automatic queue advancement. */
  onAdvance?: (id: string) => void | Promise<void>;
  /** 128 samples in the layout the archive music reaction expects. */
  onBands: (samples: Float32Array) => void;
  onState?: (status: BridgeStatus) => void;
  onConnectionChange?: (
    connected: boolean,
    health: BridgeHealth | null,
  ) => void;
};

const CONNECT_TIMEOUT = 6000;
// The bridge allows an individual VLC HTTP response up to eight seconds.
const POLL_TIMEOUT = 10000;
const COMMAND_TIMEOUT = 30000;
/** A busy page can delay a fetch's resolution; retry instead of giving up. */
const PROBE_ATTEMPTS = 3;
const RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 8000;
const STREAM_STALE_AFTER = 7500;
const STREAM_CHECK_INTERVAL = 2500;

export class MusicBridge {
  private options: MusicBridgeOptions;
  private source: EventSource | null = null;
  private health: BridgeHealth | null = null;
  private lastError = "";
  private disposed = false;
  private wantsConnection = false;
  private generation = 0;
  private controller = new AbortController();
  private connectionTask: Promise<BridgeHealth | null> | null = null;
  private catalogueRevision = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private streamRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private streamOpen = false;
  private statusSequence = 0;
  private deliveredStatus = 0;
  private transportSession = crypto.randomUUID();
  private transportSequence = 0;
  private transportAbort = new AbortController();
  private preparedTrack: { id: string; ticket: string } | null = null;
  private queue: { id: string }[] = [];
  private playMode: PlayMode = "list";
  private intentId: string | null = null;
  private naturalEndAllowed = false;
  private transportBusy = false;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private pollTask: Promise<BridgeStatus | null> | null = null;
  private outputMayRemain = false;

  constructor(options: MusicBridgeOptions) {
    this.options = options;
  }

  configure(options: Partial<MusicBridgeOptions>) {
    // A probe or automatic retry may still be running while disconnected.
    this.disconnect();
    this.options = { ...this.options, ...options };
  }

  get connected() {
    return (
      !this.disposed &&
      this.streamOpen &&
      this.health !== null &&
      this.source !== null
    );
  }

  get info() {
    return this.health;
  }

  get error() {
    return this.lastError;
  }

  /** A lost response/connection cannot prove the native output has stopped. */
  get needsStop() { return this.outputMayRemain; }

  private get base() {
    return `http://127.0.0.1:${this.options.port}`;
  }

  private get auth() {
    return { authorization: `Bearer ${this.options.token}` };
  }

  private async request<T>(
    path: string,
    timeout = POLL_TIMEOUT,
    generation = this.generation,
    disconnectOnFailure = true,
    signal?: AbortSignal,
    init?: RequestInit,
  ): Promise<T> {
    if (generation !== this.generation || this.disposed)
      throw new Error("桥接请求已失效");
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        ...init,
        headers: { ...this.auth, ...(init?.headers ?? {}) },
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(timeout),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      if (disconnectOnFailure)
        this.connectionLost(generation, "本地桥接连接已中断，正在重连");
      throw error;
    }
    if (generation !== this.generation || this.disposed)
      throw new Error("桥接请求已失效");
    if (response.status === 401 && disconnectOnFailure)
      this.connectionLost(generation, "令牌不匹配，请更新桥接设置");
    const payload = (await response.json()) as T;
    if (generation !== this.generation || this.disposed)
      throw new Error("桥接请求已失效");
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && "error" in payload
        ? String(payload.error) : "";
      throw new BridgeRequestError(response.status, { ...(payload as object), error: detail });
    }
    return payload;
  }

  /** Health check; also used by the settings panel before connecting. */
  async probe(
    port = this.options.port,
    token = this.options.token,
  ): Promise<BridgeHealth | null> {
    return this.probeForGeneration(
      port,
      token,
      this.generation,
      this.controller.signal,
    );
  }

  private async probeForGeneration(
    port: number,
    token: string,
    generation: number,
    signal: AbortSignal,
  ) {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      if (signal.aborted || this.disposed || generation !== this.generation)
        return null;
      const health = await this.probeOnce(port, token, generation, signal);
      if (health) return health;
      if (attempt < PROBE_ATTEMPTS - 1) await this.delay(600, signal);
    }
    return null;
  }

  private async probeOnce(
    port: number,
    token: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<BridgeHealth | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT)]),
      });
      if (!response.ok) return null;
      const health = (await response.json()) as BridgeHealth;
      if (
        signal.aborted ||
        this.disposed ||
        generation !== this.generation ||
        !health.ok
      )
        return null;
      // The token is required for everything except health, so verify it too.
      const check = await fetch(`http://127.0.0.1:${port}/api/library`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT)]),
      });
      if (signal.aborted || this.disposed || generation !== this.generation)
        return null;
      if (check.status === 401) {
        this.lastError = "令牌不匹配";
        return null;
      }
      if (!check.ok) return null;
      this.lastError = "";
      return health;
    } catch (error) {
      if (signal.aborted || this.disposed || generation !== this.generation)
        return null;
      this.lastError =
        error instanceof Error && error.name === "TimeoutError"
          ? "桥接响应超时（可重试）"
          : "未检测到本地桥接服务";
      return null;
    }
  }

  async connect(): Promise<BridgeHealth | null> {
    if (this.disposed) return null;
    if (this.connected) return this.health;
    if (this.connectionTask) return this.connectionTask;
    this.wantsConnection = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const generation = this.generation;
    const task = this.establishConnection(generation);
    this.connectionTask = task;
    try {
      return await task;
    } finally {
      if (this.connectionTask === task) this.connectionTask = null;
    }
  }

  private async establishConnection(
    generation: number,
  ): Promise<BridgeHealth | null> {
    const { port, token } = this.options;
    const signal = this.controller.signal;
    // VLC needs a moment to start and the first scan may still be running; keep
    // probing briefly instead of connecting to an empty catalogue.
    let health = await this.probeForGeneration(port, token, generation, signal);
    for (
      let attempt = 0;
      health && health.ready === false && attempt < 20;
      attempt++
    ) {
      await this.delay(500, signal);
      if (!this.current(generation)) return null;
      health = await this.probeForGeneration(port, token, generation, signal);
    }
    if (!this.current(generation)) return null;
    if (!health || health.ready === false) {
      this.connectionLost(
        generation,
        health ? "桥接尚未就绪，正在重试" : this.lastError,
      );
      return null;
    }
    try {
      const opened = await this.openSpectrum(health, generation, signal);
      return opened && this.current(generation) && this.connected
        ? health
        : null;
    } catch {
      this.connectionLost(generation, "无法建立桥接事件流，正在重连");
      return null;
    }
  }

  disconnect() {
    this.wantsConnection = false;
    this.resetConnection();
    this.lastError = "";
    this.reconnectDelay = RECONNECT_DELAY;
    this.options.onConnectionChange?.(false, null);
  }

  private resetConnection() {
    ++this.transportSequence;
    this.transportAbort.abort();
    this.transportAbort = new AbortController();
    this.preparedTrack = null;
    this.naturalEndAllowed = false;
    this.transportBusy = false;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.connectionTask = null;
    this.source?.close();
    this.source = null;
    this.health = null;
    this.streamOpen = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.streamTimer !== null) clearInterval(this.streamTimer);
    if (this.streamRecheckTimer !== null) clearTimeout(this.streamRecheckTimer);
    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.reconnectTimer = null;
    this.streamTimer = null;
    this.streamRecheckTimer = null;
    this.playbackTimer = null;
    this.pollTask = null;
  }

  private current(generation: number) {
    return (
      !this.disposed && this.wantsConnection && generation === this.generation
    );
  }

  private connectionLost(generation: number, message: string) {
    if (!this.current(generation)) return;
    this.resetConnection();
    this.lastError = message || "未检测到本地桥接服务，正在重连";
    this.options.onConnectionChange?.(false, null);
    if (this.disposed || !this.wantsConnection) return;
    const retryGeneration = this.generation;
    const wait = this.reconnectDelay;
    this.reconnectDelay = Math.min(wait * 2, MAX_RECONNECT_DELAY);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.current(retryGeneration)) void this.connect();
    }, wait);
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
  }

  private openSpectrum(
    health: BridgeHealth,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (typeof EventSource === "undefined") {
      this.connectionLost(generation, "浏览器不支持桥接事件流");
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const url = `${this.base}/api/spectrum?token=${encodeURIComponent(this.options.token)}`;
      const source = new EventSource(url);
      let settled = false;
      let lastFrame = Date.now();
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        signal.removeEventListener("abort", aborted);
        resolve(opened);
      };
      const aborted = () => finish(false);
      const openTimer = setTimeout(() => {
        finish(false);
        this.connectionLost(generation, "桥接事件流连接超时，正在重连");
      }, CONNECT_TIMEOUT);
      signal.addEventListener("abort", aborted, { once: true });
      source.onopen = () => {
        if (
          !this.current(generation) ||
          this.source !== source ||
          this.streamOpen
        )
          return;
        this.health = health;
        this.streamOpen = true;
        this.lastError = "";
        this.reconnectDelay = RECONNECT_DELAY;
        lastFrame = Date.now();
        let nextCheck = lastFrame + STREAM_CHECK_INTERVAL;
        this.streamTimer = setInterval(() => {
          if (!this.current(generation) || this.source !== source || !this.streamOpen)
            return;
          const now = Date.now();
          const delayed = now - nextCheck >= STREAM_CHECK_INTERVAL;
          nextCheck = now + STREAM_CHECK_INTERVAL;
          if (this.streamRecheckTimer !== null || now - lastFrame <= STREAM_STALE_AFTER)
            return;
          if (!delayed) {
            this.connectionLost(generation, "桥接事件流已中断，正在重连");
            return;
          }
          // Missing an entire check interval can mean the page was blocked,
          // with SSE tasks still queued behind this timer. Give those tasks one
          // interval to run. This single recheck never renews its own deadline,
          // even if its callback is delayed too; a silent stream still fails.
          const recheck = setTimeout(() => {
            if (this.streamRecheckTimer !== recheck) return;
            this.streamRecheckTimer = null;
            if (this.current(generation) && this.source === source && this.streamOpen &&
              Date.now() - lastFrame > STREAM_STALE_AFTER)
              this.connectionLost(generation, "桥接事件流已中断，正在重连");
          }, STREAM_CHECK_INTERVAL);
          this.streamRecheckTimer = recheck;
        }, STREAM_CHECK_INTERVAL);
        finish(true);
        this.options.onConnectionChange?.(true, health);
        this.playbackTimer = setInterval(() => void this.pollStatus(), 750);
        // Restore actual VLC playback/BGM state immediately after reconnecting.
        void this.pollStatus();
      };
      source.onmessage = (event) => {
        if (
          !this.current(generation) ||
          this.source !== source ||
          !this.streamOpen
        )
          return;
        lastFrame = Date.now();
        if (this.streamRecheckTimer !== null) clearTimeout(this.streamRecheckTimer);
        this.streamRecheckTimer = null;
        try {
          const payload = JSON.parse(event.data) as { bands?: number[] };
          if (Array.isArray(payload.bands) && payload.bands.length === 128) {
            this.options.onBands(Float32Array.from(payload.bands));
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      source.onerror = () => {
        finish(false);
        // Close this stream and retry health + authentication as one session;
        // stale EventSource/fetch callbacks cannot restore a lost connection.
        this.connectionLost(generation, "本地桥接连接已中断，正在重连");
      };
      this.source = source;
    });
  }

  async library(): Promise<BridgeTrack[]> {
    const revision = this.catalogueRevision;
    const payload = await this.request<BridgeCatalogue>(
      "/api/library",
      20000,
    );
    if (revision !== this.catalogueRevision) throw new Error("旧歌单请求已失效");
    if (this.health) Object.assign(this.health, { root: payload.root, tracks: payload.tracks.length, ...(payload.playlist ? { playlist: payload.playlist } : {}) });
    return payload.tracks ?? [];
  }

  async switchPlaylist(root: string, part = 0, split = false): Promise<BridgeCatalogue> {
    if (!this.connected) throw new Error("VLC 桥接未连接");
    const generation = this.generation;
    const sequence = this.beginTransport();
    ++this.catalogueRevision;
    try {
      const payload = await this.request<BridgeCatalogue>("/api/playlist", 600000, generation, true, undefined, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, part, split }),
      });
      if (sequence !== this.transportSequence) throw new Error("歌单切换已失效");
      this.outputMayRemain = false;
      if (this.health) {
        this.health = { ...this.health, root: payload.root, tracks: payload.tracks.length, playlist: payload.playlist, scan: payload.scan ?? this.health.scan };
        this.options.onConnectionChange?.(true, this.health);
      }
      return payload;
    } finally {
      if (sequence === this.transportSequence) this.transportBusy = false;
    }
  }

  /** Cover art for a bridge track, streamed from the bridge as an object URL. */
  async coverUrl(id: string): Promise<string | null> {
    if (this.disposed) return null;
    const generation = this.generation;
    try {
      const response = await fetch(
        `${this.base}/api/cover?id=${encodeURIComponent(id)}`,
        {
          headers: this.auth,
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      if (!response.ok) return null;
      const blob = await response.blob();
      if (generation !== this.generation || this.disposed) return null;
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async rescan(full = false): Promise<BridgeScan | null> {
    const revision = ++this.catalogueRevision;
    const payload = await this.request<{ scan: BridgeScan; playlist?: BridgePlaylist }>(
      `/api/scan${full ? "?full=1" : ""}`,
      600000,
    );
    if (revision !== this.catalogueRevision) throw new Error("旧歌单请求已失效");
    if (this.health && payload.playlist) Object.assign(this.health, { playlist: payload.playlist });
    return payload.scan ?? null;
  }

  /** Timer and scene polling share one request and leave transport work alone. */
  pollStatus(): Promise<BridgeStatus | null> {
    if (!this.connected || this.transportBusy) return Promise.resolve(null);
    if (this.pollTask) return this.pollTask;
    const task = this.status().finally(() => {
      if (this.pollTask === task) this.pollTask = null;
    });
    this.pollTask = task;
    return task;
  }

  private acceptStatus(status: BridgeStatus, generation: number, sequence: number, transport: number): BridgeStatus | null {
    if (!this.current(generation) || transport !== this.transportSequence || sequence < this.deliveredStatus)
      return null;
    if (status.state === "offline") {
      this.connectionLost(generation, "VLC 暂时离线，正在重连");
      return null;
    }
    this.deliveredStatus = sequence;
    if (status.currentId !== null || status.state === "playing" || status.state === "paused") this.outputMayRemain = true;
    this.options.onState?.(status);
    if (status.state === "playing" && !status.loading && !status.prepared && !this.preparedTrack && !this.transportBusy) {
      this.intentId = status.currentId;
      this.naturalEndAllowed = true;
    }
    if (status.ended && this.naturalEndAllowed && status.currentId === this.intentId) {
      this.naturalEndAllowed = false;
      void this.advance(1, true).catch(() => {});
    }
    return status;
  }

  async status(): Promise<BridgeStatus | null> {
    if (!this.connected || this.transportBusy) return null;
    const generation = this.generation;
    const sequence = ++this.statusSequence;
    const transport = this.transportSequence;
    try {
      const status = await this.request<BridgeStatus>(
        "/api/status",
        POLL_TIMEOUT,
        generation,
        false,
      );
      return this.acceptStatus(status, generation, sequence, transport);
    } catch {
      // A newer successful poll is authoritative, including when an older
      // request subsequently times out or returns an HTTP/authentication error.
      if (transport === this.transportSequence && sequence >= this.deliveredStatus && !this.transportBusy)
        this.connectionLost(generation, "无法读取 VLC 状态，正在重连");
      return null;
    }
  }

  private async command(
    path: string,
    timeout = COMMAND_TIMEOUT,
    invalidate = true,
  ): Promise<BridgeStatus | null> {
    if (!this.connected) throw new Error(this.lastError || "VLC 桥接未连接");
    const generation = this.generation;
    const sequence = invalidate ? this.beginTransport() : this.transportSequence;
    // A transport acknowledgement is authoritative at completion. Slider/seek
    // snapshots keep their send order, so an older one cannot undo that ack.
    const statusSequence = invalidate ? null : ++this.statusSequence;
    if (/^\/api\/(start|resume)(?:\?|$)/.test(path)) this.outputMayRemain = true;
    try {
      const result = await this.request<BridgeStatus | { status: BridgeStatus }>(this.transportPath(path, sequence), timeout, generation, false, invalidate ? this.transportAbort.signal : undefined);
      if (!this.current(generation) || sequence !== this.transportSequence) return null;
      const status = "status" in result ? result.status : result;
      if (!status || !["playing", "paused", "stopped", "offline"].includes(status.state) ||
        !(status.currentId === null || typeof status.currentId === "string")) throw new Error("VLC 播放操作缺少状态回执");
      const accepted = this.acceptStatus(status, generation, statusSequence ?? ++this.statusSequence, sequence);
      if (accepted && /^\/api\/stop(?:\?|$)/.test(path) && accepted.state === "stopped" && accepted.currentId === null)
        this.outputMayRemain = false;
      return accepted;
    } catch (error) {
      if (generation !== this.generation || sequence !== this.transportSequence) return null;
      if (!(error instanceof Error && /HTTP (400|409)/.test(error.message))) this.connectionLost(generation, "VLC 播放操作失败，正在重连");
      throw error;
    } finally {
      if (sequence === this.transportSequence && invalidate) this.transportBusy = false;
    }
  }

  private beginTransport() {
    ++this.transportSequence;
    this.transportAbort.abort();
    this.transportAbort = new AbortController();
    this.preparedTrack = null;
    this.naturalEndAllowed = false;
    this.transportBusy = true;
    return this.transportSequence;
  }

  private transportPath(path: string, sequence: number) {
    return `${path}${path.includes("?") ? "&" : "?"}client=${this.transportSession}&sequence=${sequence}`;
  }

  queueTracks(tracks: readonly { id: string }[]) { this.queue = tracks.map((track) => ({ id: track.id })); }
  setMode(mode: PlayMode) { this.playMode = mode; }
  mode() { return this.playMode; }
  get prepared() { return this.preparedTrack !== null; }

  async prepare(id: string, options: { position?: number } = {}): Promise<boolean> {
    if (!this.connected) { this.lastError ||= "VLC 桥接未连接"; return false; }
    const generation = this.generation;
    const sequence = this.beginTransport();
    this.intentId = id;
    this.outputMayRemain = true;
    try {
      const ready = await this.request<{ ready: boolean; ticket: string }>(
        this.transportPath(`/api/prepare?id=${encodeURIComponent(id)}&position=${options.position ?? 0}`, sequence),
        30000, generation, false, this.transportAbort.signal,
      );
      if (!this.current(generation) || sequence !== this.transportSequence) return false;
      if (!ready.ready || !ready.ticket) throw new Error("VLC 未完成音频准备");
      this.preparedTrack = { id, ticket: ready.ticket };
      this.lastError = "";
      // The authenticated prepare response is the readiness acknowledgement.
      // A separate short status poll must not discard this valid start ticket.
      return true;
    } catch (error) {
      if (this.current(generation) && sequence === this.transportSequence) {
        const message = error instanceof Error ? error.message : "VLC 音频准备失败";
        // A timed-out response does not mean VLC abandoned its work. Issue a
        // newer stop so a late server continuation cannot retain that file.
        const stopping = this.stop();
        const cancellation = this.transportSequence;
        await stopping.catch(() => {});
        if (this.current(generation) && cancellation === this.transportSequence) this.lastError = message;
      }
      return false;
    } finally {
      if (sequence === this.transportSequence) this.transportBusy = false;
    }
  }

  private async startPreparedStatus(): Promise<BridgeStatus | null> {
    const track = this.preparedTrack;
    if (!this.connected || !track) return null;
    const status = await this.command(`/api/start?ticket=${encodeURIComponent(track.ticket)}`, 20000);
    if (!status || status.state !== "playing" || status.currentId !== track.id) return null;
    this.naturalEndAllowed = true;
    return status;
  }

  async startPrepared(): Promise<boolean> {
    return await this.startPreparedStatus() !== null;
  }

  async play(id: string): Promise<BridgeStatus | null> {
    if (!this.connected) throw new Error(this.lastError || "VLC 桥接未连接");
    if (!await this.prepare(id)) return null;
    return this.startPreparedStatus();
  }

  async resume(): Promise<BridgeStatus | null> {
    const result = await this.command("/api/resume", 20000);
    if (result?.state === "playing") this.naturalEndAllowed = true;
    return result;
  }

  private async advance(step: number, automatic = false): Promise<BridgeStatus | null> {
    const current = this.queue.findIndex((track) => track.id === this.intentId);
    const index = queueIndex(this.queue.length, current, this.playMode, step, automatic);
    if (index < 0) return null;
    const id = this.queue[index].id;
    this.intentId = id;
    if (automatic && this.options.onAdvance) { await this.options.onAdvance(id); return null; }
    return this.play(id);
  }
  next(step = 1) { return this.advance(step); }
  previous() { return this.advance(-1); }

  async pause(): Promise<BridgeStatus | null> {
    return this.command("/api/pause");
  }

  async stop(): Promise<BridgeStatus | null> {
    this.intentId = null;
    return this.command("/api/stop");
  }

  async seek(seconds: number): Promise<BridgeStatus | null> {
    return this.command(
      `/api/seek?seconds=${encodeURIComponent(seconds.toFixed(2))}`,
      COMMAND_TIMEOUT, false,
    );
  }

  /** Volume is stored as 0..1 in the app and as 0..512 in VLC. */
  async volume(value: number): Promise<BridgeStatus | null> {
    const scaled = Math.round(Math.max(0, Math.min(1, value)) * 512);
    return this.command(`/api/volume?value=${scaled}`, COMMAND_TIMEOUT, false);
  }
}
