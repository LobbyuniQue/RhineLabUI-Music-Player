/** Cancel a caller's wait without cancelling work shared with other callers. */
export function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/** A single native status read per control revision, with obsolete results discarded. */
export class VlcStatusReader {
  constructor(read, now = Date.now) {
    this.fetch = read;
    this.now = now;
    this.revision = 0;
    this.pending = null;
    this.cachedRaw = null;
    this.cachedAt = 0;
  }

  invalidate() {
    this.revision++;
    this.pending?.controller.abort();
    this.pending = null;
    this.cachedRaw = null;
    this.cachedAt = 0;
  }

  read() {
    if (this.pending) return this.pending.promise;
    const flight = { revision: this.revision, controller: new AbortController(), promise: null };
    this.pending = flight;
    flight.promise = (async () => {
      let raw = null;
      try { raw = await this.fetch(flight.controller.signal); } catch { /* A current failure is genuinely offline. */ }
      if (flight.revision !== this.revision) return null;
      this.cachedRaw = raw;
      this.cachedAt = raw ? this.now() : 0;
      return raw;
    })().finally(() => {
      // An aborted request may finish after a newer revision has started.
      if (this.pending === flight) this.pending = null;
    });
    return flight.promise;
  }
}

/** Pending controls pause polling from the moment they are queued, including between operations. */
export class VlcOperationQueue {
  constructor(onControl = () => {}) {
    this.onControl = onControl;
    this.pending = 0;
    this.tail = Promise.resolve();
  }

  run(operation) {
    // Cancel a read already in flight before the first queued control. A later
    // queued control must not abort its predecessor's internal status receipt.
    if (this.pending === 0) this.onControl();
    this.pending++;
    const task = this.tail.then(() => {
      this.onControl();
      return operation();
    });
    this.tail = task.finally(() => { this.pending--; }).catch(() => {});
    return task;
  }

  async idle(signal) {
    signal?.throwIfAborted();
    while (this.pending) await waitWithSignal(this.tail, signal);
  }
}
