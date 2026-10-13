// Test-only scheduling budget, installed after the real archive has returned.
// Keep this function self-contained: the E2E harness injects its toString().
export function installHandoffRenderBudget(idleMs = 750) {
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new RangeError("idleMs must be finite and nonnegative");
  const root = globalThis;
  const originalRequest = root.requestAnimationFrame, originalCancel = root.cancelAnimationFrame;
  const nativeRequest = originalRequest.bind(root), nativeCancel = originalCancel.bind(root);
  const setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root);
  const now = () => root.performance.now();
  const pending = new Map(), samples = [];
  let nextId = 0, timer = null, frame = null, running = false, restored = false;
  let allowedAt = now() + idleMs;

  function releaseCancel() {
    if (restored && !pending.size && !running && root.cancelAnimationFrame === cancel)
      root.cancelAnimationFrame = originalCancel;
  }
  function clearScheduled() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (frame !== null) { nativeCancel(frame); frame = null; }
  }
  function schedule() {
    if (restored) { releaseCancel(); return; }
    if (running || timer !== null || frame !== null || !pending.size) return;
    const remaining = allowedAt - now();
    if (remaining > 0) timer = setTimer(() => { timer = null; schedule(); }, remaining);
    else frame = nativeRequest(flush);
  }
  function invoke(entry, timestamp) {
    running = true;
    const startedAt = now();
    const idleGapMs = samples.length ? startedAt - samples[samples.length - 1].endedAt : null;
    try { entry.callback.call(root, timestamp); }
    finally {
      const endedAt = now();
      allowedAt = endedAt + idleMs;
      samples.push({ timestamp, startedAt, endedAt, durationMs: endedAt - startedAt, idleGapMs, idleMs, restored });
      if (samples.length > 120) samples.shift();
      running = false;
      schedule();
    }
  }
  function flush(timestamp) {
    frame = null;
    // Timers may arrive early; recheck at both timer and native RAF entry.
    if (now() < allowedAt) { schedule(); return; }
    const first = pending.entries().next();
    if (first.done) return;
    const [id, entry] = first.value;
    pending.delete(id);
    invoke(entry, timestamp);
  }
  function request(callback) {
    if (typeof callback !== "function") throw new TypeError("RAF callback must be a function");
    if (restored) return nativeRequest(callback);
    // Negative IDs cannot collide with requests already registered natively.
    const id = --nextId;
    pending.set(id, { callback, nativeId: null });
    schedule();
    return id;
  }
  function cancel(id) {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      if (entry.nativeId !== null) nativeCancel(entry.nativeId);
      if (!pending.size) clearScheduled();
    } else if (id >= 0) nativeCancel(id);
    releaseCancel();
  }
  function restore() {
    if (restored) return;
    restored = true;
    if (root.requestAnimationFrame === request) root.requestAnimationFrame = originalRequest;
    clearScheduled();
    // Drain every outstanding callback through native RAF. Keep synthetic IDs
    // cancellable until this drain finishes instead of losing queued callbacks.
    for (const [id, entry] of pending) entry.nativeId = nativeRequest(timestamp => {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      invoke(entry, timestamp);
    });
    releaseCancel();
  }
  root.requestAnimationFrame = request;
  root.cancelAnimationFrame = cancel;
  return { samples, restore };
}
