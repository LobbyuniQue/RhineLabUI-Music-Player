// Local music playback.
//
// One <audio> element feeds its own AudioContext graph
// (MediaElementSource → gain → analyser → destination) so the local track is
// independent of the three-stem background score, while still being able to
// drive the archive music reaction: the analyser is folded into the same 128
// sample / 64 bin per channel layout the Wallpaper Engine host provides, then
// handed to the existing SpectrumEnvelope.

import { SpectrumEnvelope, quietBands, type MusicBands } from "./archive-play-motion";
import { queueIndex, type PlayMode } from "./music-queue.ts";
export type { PlayMode } from "./music-queue.ts";

export type PlayerTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  codec: string;
};

export type PlayerState = {
  id: string | null;
  playing: boolean;
  loading: boolean;
  prepared: boolean;
  position: number;
  duration: number;
  mode: PlayMode;
  error: string;
};

export type MusicPlayerHooks = {
  /** Resolves a library id back to a readable file (permission may be needed). */
  resolve: (id: string) => Promise<File | null>;
  coverUrl?: (id: string) => Promise<string | null>;
  onState: (state: PlayerState) => void;
  onBands: (bands: MusicBands) => void;
  /** True while a local track is playing, so the background score can yield. */
  onActiveChange: (active: boolean) => void;
  onError?: (message: string) => void;
  volume: () => number;
  /** Playback has moved on; the panel uses it to follow the current row. */
  onTrackChange?: (track: PlayerTrack | null) => void;
  /** Main may own media keys and route them to the selected engine. */
  mediaSessionActions?: boolean;
  preparationTimeoutMs?: number;
};

const BINS = 64;
/** Analyser dB below this floor count as silence. */
const DB_FLOOR = -86;
/**
 * Bin edges follow the musical split the archive reaction expects: the first
 * eight of the host's 64 bins are the bass range that drives the array, the
 * next 24 are the body, the rest is treble. A plain log sweep from 24 Hz would
 * squeeze the bass into the first few hertz and leave the low band empty.
 */
const BAND_EDGES = [
  [20, 250],
  [250, 2500],
  [2500, 16000],
] as const;

function binFrequency(index: number) {
  const [from, to] = index < 8 ? BAND_EDGES[0] : index < 32 ? BAND_EDGES[1] : BAND_EDGES[2];
  const start = index < 8 ? 0 : index < 32 ? 8 : 32;
  const span = index < 8 ? 8 : index < 32 ? 24 : 32;
  return from * Math.pow(to / from, (index - start) / span);
}

export class MusicPlayer {
  private hooks: MusicPlayerHooks;
  private element: HTMLAudioElement;
  private context?: AudioContext;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private source?: MediaElementAudioSourceNode;
  private envelope = new SpectrumEnvelope();
  private spectrum = new Float32Array(1024);
  private bins = new Float32Array(BINS * 2);
  private edges: [number, number][] = [];

  private queue: PlayerTrack[] = [];
  private current: PlayerTrack | null = null;
  private objectUrl: string | null = null;
  private mode: PlayMode = "list";
  private volumeValue = 0.8;
  private error = "";
  private loading = false;
  private started = 0;
  private active = false;
  private disposed = false;
  /** Every transport change invalidates continuations from earlier requests. */
  private playRequest = 0;
  private prepared = false;
  private preparationAbort: AbortController | null = null;

  constructor(hooks: MusicPlayerHooks) {
    this.hooks = hooks;
    this.volumeValue = hooks.volume();
    const element = document.createElement("audio");
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    this.element = element;
    element.addEventListener("ended", this.ended);
    element.addEventListener("error", this.failed);
    element.addEventListener("loadedmetadata", this.metadataLoaded);
  }

  state(): PlayerState {
    return {
      id: this.current?.id ?? null,
      playing: this.isPlaying(),
      loading: this.loading,
      prepared: this.prepared,
      position: this.element.currentTime || 0,
      duration: Number.isFinite(this.element.duration) ? this.element.duration : (this.current?.duration ?? 0),
      mode: this.mode,
      error: this.error,
    };
  }

  isPlaying() {
    return this.active && !this.element.paused && !this.element.ended;
  }

  volume() {
    return this.volumeValue;
  }

  currentTrack() {
    return this.current;
  }

  queueTracks(tracks: PlayerTrack[]) {
    this.queue = [...tracks];
  }

  setVolume(value: number) {
    this.volumeValue = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.volumeValue;
    this.emit();
  }

  setMode(mode: PlayMode) {
    this.mode = mode;
    this.emit();
  }

  /** Open only the selected file and buffer it, without calling audio.play(). */
  async prepare(track: PlayerTrack, options: { position?: number } = {}): Promise<boolean> {
    if (this.disposed) return false;
    const request = ++this.playRequest;
    this.cancelPreparation();
    const controller = new AbortController();
    this.preparationAbort = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("预加载超时", "TimeoutError")), this.hooks.preparationTimeoutMs ?? 15000);
    // The selected track must never be displayed over the previous audio.
    this.clearSource();
    this.active = false;
    this.hooks.onActiveChange(false);
    this.error = "";
    this.loading = true;
    this.current = track;
    this.hooks.onTrackChange?.(track);
    this.emit();
    try {
      // Unlock synchronously in the user gesture, before file I/O can consume
      // activation. The media element remains paused throughout preparation.
      this.ensureGraph();
      const resumed = this.context!.resume();
      const [file] = await this.abortable(Promise.all([this.hooks.resolve(track.id), resumed]), controller.signal);
      if (!this.isCurrentRequest(request)) return false;
      if (!file) throw new Error("missing");
      this.objectUrl = URL.createObjectURL(file);
      this.element.src = this.objectUrl;
      this.element.load();
      await this.waitForReady(controller.signal);
      if (!this.isCurrentRequest(request)) return false;
      if (options.position) this.element.currentTime = options.position;
      this.loading = false;
      this.prepared = true;
      this.updateMediaSession(track, request);
      this.emit();
      return true;
    } catch (e) {
      if (!this.isCurrentRequest(request)) return false;
      this.failPlayback(e instanceof Error && e.message === "missing" ? "文件不可用，可能需要重新授权目录" : e instanceof Error && e.name === "TimeoutError" ? "文件预加载超时，请重试" : "无法准备该文件");
      return false;
    } finally {
      clearTimeout(timer);
      if (this.preparationAbort === controller) this.preparationAbort = null;
    }
  }

  /** Called at readiness or the final reveal frame; play precedes the first await. */
  async startPrepared(): Promise<boolean> {
    if (this.disposed || !this.prepared || !this.current || !this.element.src) return false;
    const request = this.playRequest;
    this.prepared = false;
    try {
      const started = this.element.play();
      await started;
      if (!this.isCurrentRequest(request)) return false;
      this.loading = false;
      this.active = true;
      this.hooks.onActiveChange(true);
      this.emit();
      return true;
    } catch {
      if (this.isCurrentRequest(request)) this.failPlayback("无法开始播放该文件");
      return false;
    }
  }

  async play(track: PlayerTrack, options: { position?: number; queueIndex?: number } = {}) {
    if (await this.prepare(track, options)) return this.startPrepared();
    return false;
  }

  async resume(): Promise<boolean> {
    if (this.disposed || !this.current) return false;
    if (!this.element.src) return this.play(this.current);
    const request = ++this.playRequest;
    this.cancelPreparation();
    this.loading = true;
    this.error = "";
    this.emit();
    try {
      this.ensureGraph();
      await this.context!.resume();
      if (!this.isCurrentRequest(request)) return false;
      this.prepared = true;
      return this.startPrepared();
    } catch {
      if (this.isCurrentRequest(request)) this.failPlayback("无法恢复播放");
      return false;
    }
  }

  async toggle() {
    if (this.disposed || !this.current) return;
    if (this.loading || this.isPlaying()) {
      this.pause();
      return;
    }
    await this.resume();
  }

  pause() {
    if (this.disposed) return;
    ++this.playRequest;
    this.cancelPreparation();
    this.element.pause();
    this.loading = false;
    this.active = false;
    this.hooks.onActiveChange(false);
    this.emit();
  }

  stop() {
    if (this.disposed) return;
    ++this.playRequest;
    this.cancelPreparation();
    this.clearSource();
    this.loading = false;
    this.error = "";
    this.active = false;
    this.current = null;
    this.hooks.onActiveChange(false);
    this.hooks.onBands(quietBands());
    this.hooks.onTrackChange?.(null);
    this.emit();
  }

  seek(ratio: number) {
    const duration = this.element.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.element.currentTime = Math.max(0, Math.min(1, ratio)) * duration;
    this.emit();
  }

  seekBy(seconds: number) {
    const duration = this.element.duration;
    if (!Number.isFinite(duration)) return;
    this.element.currentTime = Math.max(0, Math.min(duration, this.element.currentTime + seconds));
    this.emit();
  }

  async next(step = 1) {
    if (!this.queue.length) return;
    const index = this.current ? this.queue.findIndex((item) => item.id === this.current!.id) : -1;
    const target = this.queue[queueIndex(this.queue.length, index, this.mode, step)];
    await this.play(target);
  }

  previous() {
    return this.next(-1);
  }

  /** Called from the app's single rAF loop. It keeps ticking after pause too:
   * the envelope owns the decay, and without a live tick the archive reaction
   * would freeze at the moment of pause instead of relaxing to silence. */
  tick(dt: number) {
    if (this.disposed || !this.analyser) return;
    const now = performance.now() / 1000;
    this.readSpectrum();
    this.envelope.ingest(this.bins, now);
    this.hooks.onBands(this.envelope.update(Math.min(dt, 0.1), now, this.isPlaying()));
    if (this.isPlaying() && now - this.started > 0.25) {
      this.started = now;
      this.emit();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.playRequest;
    this.cancelPreparation();
    this.clearSource();
    this.loading = false;
    this.active = false;
    this.current = null;
    this.element.removeEventListener("ended", this.ended);
    this.element.removeEventListener("error", this.failed);
    this.element.removeEventListener("loadedmetadata", this.metadataLoaded);
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close().catch(() => {});
    this.context = undefined;
    this.hooks.onActiveChange(false);
    this.hooks.onBands(quietBands());
    this.hooks.onTrackChange?.(null);
  }

  private emit() {
    if (this.disposed) return;
    this.hooks.onState(this.state());
  }

  private isCurrentRequest(request: number) {
    return !this.disposed && request === this.playRequest;
  }

  private clearSource() {
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.releaseUrl();
  }

  private failPlayback(message: string) {
    ++this.playRequest;
    this.cancelPreparation();
    this.clearSource();
    this.loading = false;
    this.active = false;
    this.error = message;
    this.hooks.onActiveChange(false);
    this.hooks.onError?.(message);
    this.emit();
  }

  private releaseUrl() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private cancelPreparation() {
    this.prepared = false;
    this.preparationAbort?.abort();
    this.preparationAbort = null;
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      promise.then((value) => { signal.removeEventListener("abort", aborted); resolve(value); }, (error) => { signal.removeEventListener("abort", aborted); reject(error); });
    });
  }

  private waitForReady(signal: AbortSignal): Promise<void> {
    if (this.element.readyState >= 3) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.element.removeEventListener("canplay", ready);
        this.element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const ready = () => { if (this.element.readyState >= 3) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("media error")); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      if (signal.aborted) return aborted();
      this.element.addEventListener("canplay", ready);
      this.element.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      ready();
    });
  }

  private ensureGraph() {
    if (this.context) return;
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = this.volumeValue;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.68;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    const source = context.createMediaElementSource(this.element);
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(context.destination);
    this.context = context;
    this.gain = gain;
    this.analyser = analyser;
    this.source = source;
    this.spectrum = new Float32Array(analyser.frequencyBinCount);
  }

  /**
   * Folds the FFT into the host layout: 64 log-spaced bins for the left half
   * and the same again for the right half, normalised to 0..1 amplitude.
   */
  private readSpectrum() {
    const analyser = this.analyser!;
    if (this.spectrum.length !== analyser.frequencyBinCount) this.spectrum = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(this.spectrum);
    const nyquist = (this.context?.sampleRate ?? 48000) / 2;
    if (!this.edges.length) {
      for (let i = 0; i < BINS; i++) {
        const from = binFrequency(i);
        const to = binFrequency(i + 1);
        const start = Math.max(0, Math.min(this.spectrum.length - 1, Math.floor((from / nyquist) * this.spectrum.length)));
        const end = Math.max(start + 1, Math.min(this.spectrum.length, Math.ceil((to / nyquist) * this.spectrum.length)));
        this.edges.push([start, end]);
      }
    }
    for (let i = 0; i < BINS; i++) {
      const [start, end] = this.edges[i];
      let peak = DB_FLOOR;
      for (let bin = start; bin < end; bin++) if (this.spectrum[bin] > peak) peak = this.spectrum[bin];
      const level = Math.max(0, Math.min(1, (peak - DB_FLOOR) / -DB_FLOOR));
      const shaped = Math.pow(level, 1.15);
      this.bins[i] = shaped;
      this.bins[i + BINS] = shaped;
    }
  }

  private updateMediaSession(track: PlayerTrack, request: number) {
    const session = navigator.mediaSession;
    if (!session || typeof MediaMetadata === "undefined") return;
    const apply = (artwork?: MediaImage[]) => {
      session.metadata = new MediaMetadata({
        title: track.title || "未知曲目",
        artist: track.artist || "未知艺术家",
        album: track.album || "",
        artwork,
      });
    };
    apply();
    if (this.hooks.coverUrl) {
      void this.hooks
        .coverUrl(track.id)
        .then((url) => {
          if (url && this.isCurrentRequest(request)) apply([{ src: url, sizes: "256x256", type: "image/jpeg" }]);
        })
        .catch(() => {});
    }
    if (this.hooks.mediaSessionActions === false) return;
    try {
      session.setActionHandler("play", () => void this.toggle());
      session.setActionHandler("pause", () => this.pause());
      session.setActionHandler("nexttrack", () => void this.next());
      session.setActionHandler("previoustrack", () => void this.previous());
      session.setActionHandler("seekbackward", () => this.seekBy(-10));
      session.setActionHandler("seekforward", () => this.seekBy(10));
    } catch {
      /* unsupported actions are ignored by the browser */
    }
  }

  private ended = () => {
    if (this.disposed || !this.active || this.loading || !this.current || !this.element.src || !this.element.ended) return;
    if (this.mode === "single") {
      // Seeking to zero can clear `ended` before `paused` changes. Force the
      // resume path so toggle cannot interpret this restart as a pause.
      this.active = false;
      this.element.currentTime = 0;
      void this.toggle();
      return;
    }
    if (!this.queue.length) {
      this.pause();
      return;
    }
    void this.next();
  };

  private failed = () => {
    if (this.disposed || !this.element.src || !this.element.error) return;
    this.failPlayback("无法读取该文件");
  };

  private metadataLoaded = () => {
    if (this.element.src) this.emit();
  };
}
