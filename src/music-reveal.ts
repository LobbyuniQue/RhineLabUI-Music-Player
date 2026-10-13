export type MusicAccessStrategy = "reveal" | "immediate";

/** Custom settings follow the remaining archive reveal effects, not unrelated
 * animation switches or render quality. */
export function musicAccessStrategy(motion: { modelDecryption: boolean; documentReveal: boolean }): MusicAccessStrategy {
  return motion.modelDecryption || motion.documentReveal ? "reveal" : "immediate";
}

/** Full animation starts on its final reveal frame; simplified animation starts
 * as soon as preparation resolves, without holding text or waiting for a frame. */
export class MusicRevealGate {
  private request = 0;
  private track: string | null = null;
  private phase: "idle" | "loading" | "revealing" | "starting" | "playing" | "error" = "idle";
  private error = "";
  private startFrame: number | null = null;
  private strategy: MusicAccessStrategy = "reveal";

  begin(id: string, strategy: MusicAccessStrategy = "reveal") {
    const request = ++this.request;
    this.track = id;
    this.phase = "loading";
    this.error = "";
    this.startFrame = null;
    this.strategy = strategy;
    return request;
  }

  isCurrent(request: number) { return request === this.request && this.phase !== "idle"; }
  get immediate() { return this.strategy === "immediate" && this.phase !== "idle"; }
  get holding() { return !this.immediate && (this.phase === "loading" || this.phase === "error"); }
  get pending() { return this.phase === "loading" || this.phase === "revealing" || this.phase === "starting"; }
  get blocking() { return !this.immediate && (this.pending || this.holding); }
  state() { return { id: this.track, phase: this.phase, error: this.error, startFrame: this.startFrame, strategy: this.strategy }; }

  prepared(request: number) {
    if (!this.isCurrent(request) || this.phase !== "loading") return false;
    this.phase = this.immediate ? "starting" : "revealing";
    return true;
  }

  /** Reducing motion also releases an already-open archive. Returning to full
   * motion affects the next selection, so it cannot re-hide or restart music. */
  useImmediatePlayback(): number | null {
    if (this.phase === "idle" || this.immediate) return null;
    this.strategy = "immediate";
    if (this.phase !== "revealing") return null;
    this.phase = "starting";
    return this.request;
  }

  completeFrame(revealed: boolean, frame: number): number | null {
    if (!revealed || this.immediate || this.phase !== "revealing") return null;
    this.phase = "starting";
    this.startFrame = frame;
    return this.request;
  }

  started(request: number, ok: boolean) {
    if (!this.isCurrent(request) || this.phase !== "starting") return;
    if (ok) this.phase = "playing";
    else this.fail(request, "音乐未能开始播放，请重试");
  }

  fail(request: number, message: string) {
    if (!this.isCurrent(request)) return;
    this.phase = "error";
    this.error = message;
  }

  cancel() {
    ++this.request;
    this.track = null;
    this.phase = "idle";
    this.error = "";
    this.startFrame = null;
    this.strategy = "reveal";
  }
}
