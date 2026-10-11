/** A track is prepared silently before the existing document reveal may run.
 * The frame which completes that reveal is the only place playback may start. */
export class MusicRevealGate {
  private request = 0;
  private track: string | null = null;
  private phase: "idle" | "loading" | "revealing" | "starting" | "playing" | "error" = "idle";
  private error = "";
  private startFrame: number | null = null;

  begin(id: string) {
    const request = ++this.request;
    this.track = id;
    this.phase = "loading";
    this.error = "";
    this.startFrame = null;
    return request;
  }

  isCurrent(request: number) { return request === this.request && this.phase !== "idle"; }
  get holding() { return this.phase === "loading" || this.phase === "error"; }
  get pending() { return this.phase === "loading" || this.phase === "revealing" || this.phase === "starting"; }
  state() { return { id: this.track, phase: this.phase, error: this.error, startFrame: this.startFrame }; }

  prepared(request: number) {
    if (!this.isCurrent(request) || this.phase !== "loading") return false;
    this.phase = "revealing";
    return true;
  }

  completeFrame(revealed: boolean, frame: number): number | null {
    if (!revealed || this.phase !== "revealing") return null;
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
  }
}
