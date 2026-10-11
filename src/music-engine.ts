export type MusicEngine = "browser" | "vlc";
type HandoffHooks = {
  current: () => MusicEngine;
  cancelPending: () => void;
  stop: (engine: MusicEngine) => Promise<void> | void;
  apply: (engine: MusicEngine, current: () => boolean) => Promise<void>;
  changed: () => void;
  error: (error: unknown) => void;
};

/** Serialize handoffs: stop the old output before changing the selected engine.
 * New requests replace queued choices, including a return to the current engine. */
export class MusicEngineHandoff {
  private request = 0;
  private work: Promise<boolean> = Promise.resolve(true);
  private hooks: HandoffHooks;
  busy = false;

  constructor(hooks: HandoffHooks) { this.hooks = hooks; }

  switchTo(engine: MusicEngine): Promise<boolean> {
    if (!this.busy && this.hooks.current() === engine) return Promise.resolve(true);
    const request = ++this.request;
    const current = () => request === this.request;
    this.busy = true;
    this.hooks.cancelPending();
    this.hooks.changed();
    const task = this.work.then(async () => {
      if (!current()) return false;
      const previous = this.hooks.current();
      if (previous === engine) return true;
      await this.hooks.stop(previous);
      if (!current()) return false;
      await this.hooks.apply(engine, current);
      return current();
    }).catch((error: unknown) => {
      if (current()) this.hooks.error(error);
      return false;
    }).finally(() => {
      if (current()) {
        this.busy = false;
        this.hooks.changed();
      }
    });
    this.work = task;
    return task;
  }
}
