// Client for the local VLC bridge (scripts/vlc-bridge.mjs).
//
// The page cannot decode formats the browser does not support, and it cannot
// link libVLC, so when the user runs the bridge the page delegates the whole
// playback path to it: VLC decodes and plays, the bridge exposes transport,
// metadata and a 128 sample spectrum that feeds the existing archive music
// reaction. Without a bridge the page falls back to its own player.

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
  scan: BridgeScan;
  vlc: { version: string; pid: number | null; startedAt: number };
};

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
  vlc: { version: string; pid: number | null; startedAt: number };
};

export type MusicBridgeOptions = {
  port: number;
  token: string;
  /** 128 samples in the layout the archive music reaction expects. */
  onBands: (samples: Float32Array) => void;
  onState?: (status: BridgeStatus) => void;
  onConnectionChange?: (connected: boolean, health: BridgeHealth | null) => void;
};

const CONNECT_TIMEOUT = 6000;
const POLL_TIMEOUT = 4000;
/** A busy page can delay a fetch's resolution; retry instead of giving up. */
const PROBE_ATTEMPTS = 3;

export class MusicBridge {
  private options: MusicBridgeOptions;
  private source: EventSource | null = null;
  private health: BridgeHealth | null = null;
  private lastError = "";
  private disposed = false;

  constructor(options: MusicBridgeOptions) {
    this.options = options;
  }

  configure(options: Partial<MusicBridgeOptions>) {
    this.options = { ...this.options, ...options };
    if (this.connected) this.disconnect();
  }

  get connected() {
    return this.health !== null && this.source !== null;
  }

  get info() {
    return this.health;
  }

  get error() {
    return this.lastError;
  }

  private get base() {
    return `http://127.0.0.1:${this.options.port}`;
  }

  private get auth() {
    return { authorization: `Bearer ${this.options.token}` };
  }

  private async request<T>(path: string, timeout = POLL_TIMEOUT): Promise<T> {
    const response = await fetch(this.base + path, {
      headers: this.auth,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /** Health check; also used by the settings panel before connecting. */
  async probe(port = this.options.port, token = this.options.token): Promise<BridgeHealth | null> {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      const health = await this.probeOnce(port, token);
      if (health) return health;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return null;
  }

  private async probeOnce(port: number, token: string): Promise<BridgeHealth | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT),
      });
      if (!response.ok) return null;
      const health = (await response.json()) as BridgeHealth;
      // The token is required for everything except health, so verify it too.
      const check = await fetch(`http://127.0.0.1:${port}/api/library`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT),
      });
      if (check.status === 401) {
        this.lastError = "令牌不匹配";
        return null;
      }
      if (!check.ok) return null;
      this.options.port = port;
      this.options.token = token;
      this.lastError = "";
      return health;
    } catch (error) {
      this.lastError =
        error instanceof Error && error.name === "TimeoutError" ? "桥接响应超时（可重试）" : "未检测到本地桥接服务";
      return null;
    }
  }

  async connect(): Promise<BridgeHealth | null> {
    // VLC needs a moment to start and the first scan may still be running; keep
    // probing briefly instead of connecting to an empty catalogue.
    let health = await this.probe();
    for (let attempt = 0; health && health.ready === false && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      health = await this.probe();
    }
    if (!health) {
      this.options.onConnectionChange?.(false, null);
      return null;
    }
    this.health = health;
    this.openSpectrum();
    this.options.onConnectionChange?.(true, health);
    return health;
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.health = null;
    this.options.onConnectionChange?.(false, null);
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
  }

  private openSpectrum() {
    this.source?.close();
    if (typeof EventSource === "undefined") return;
    const url = `${this.base}/api/spectrum?token=${encodeURIComponent(this.options.token)}`;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      if (this.disposed) return;
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
      // EventSource reconnects on its own; a stopped VLC simply keeps silent.
    };
    this.source = source;
  }

  async library(): Promise<BridgeTrack[]> {
    const payload = await this.request<{ tracks: BridgeTrack[]; root: string }>("/api/library", 20000);
    return payload.tracks ?? [];
  }

  /** Cover art for a bridge track, streamed from the bridge as an object URL. */
  async coverUrl(id: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.base}/api/cover?id=${encodeURIComponent(id)}`, {
        headers: this.auth,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  }

  async rescan(full = false): Promise<BridgeScan | null> {
    const payload = await this.request<{ scan: BridgeScan }>(`/api/scan${full ? "?full=1" : ""}`, 600000);
    return payload.scan ?? null;
  }

  async status(): Promise<BridgeStatus | null> {
    try {
      const status = await this.request<BridgeStatus>("/api/status");
      this.options.onState?.(status);
      return status;
    } catch {
      return null;
    }
  }

  async play(id: string): Promise<BridgeStatus | null> {
    await this.request(`/api/play?id=${encodeURIComponent(id)}`, 20000);
    return this.status();
  }

  async pause(): Promise<BridgeStatus | null> {
    await this.request("/api/pause");
    return this.status();
  }

  async stop(): Promise<BridgeStatus | null> {
    await this.request("/api/stop");
    return this.status();
  }

  async seek(seconds: number): Promise<BridgeStatus | null> {
    await this.request(`/api/seek?seconds=${encodeURIComponent(seconds.toFixed(2))}`);
    return this.status();
  }

  /** Volume is stored as 0..1 in the app and as 0..512 in VLC. */
  async volume(value: number): Promise<BridgeStatus | null> {
    const scaled = Math.round(Math.max(0, Math.min(1, value)) * 512);
    await this.request(`/api/volume?value=${scaled}`);
    return this.status();
  }
}
