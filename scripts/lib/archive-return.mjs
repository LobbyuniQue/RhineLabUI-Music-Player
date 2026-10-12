export class CdpTimeoutError extends Error {
  constructor(method) {
    super(`${method} timed out`);
    this.name = "CdpTimeoutError";
    this.method = method;
  }
}

export function archiveReturned(state) {
  return state?.mode === "archive" && state.cameraDetail < .01 &&
    state.extraction <= .41 && state.returningFiles === 0 && !state.modal &&
    state.motion?.preset === "full";
}

// Read-only observer. Commands and playback preparation keep their own deadlines.
export async function waitForArchiveReturn({
  read,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onProgress = () => {},
  budgetMs = 240000,
  readBudgetMs = 20000,
  pollMs = 1000,
}) {
  const started = now(), deadline = started + budgetMs;
  let state = null, timeoutCount = 0, reportedAt = -Infinity;
  const observation = () => ({ state, elapsedMs: now() - started, timeoutCount });
  while (now() < deadline) {
    let timedOut = false;
    try {
      const sample = await read(Math.min(readBudgetMs, deadline - now()));
      // A delayed response must never turn an expired observation into a pass.
      if (now() >= deadline) break;
      state = sample;
      if (archiveReturned(state)) return observation();
    } catch (error) {
      // Only retry transport timeouts of this read. Page exceptions, protocol
      // errors and side-effectful commands still fail immediately.
      if (!(error instanceof CdpTimeoutError) || error.method !== "Runtime.evaluate") throw error;
      timeoutCount++;
      timedOut = true;
    }
    if (timedOut || now() - reportedAt >= 30000) {
      onProgress(observation());
      reportedAt = now();
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  const error = new Error(`Archive return did not finish before handoff: ${JSON.stringify(observation())}`);
  error.name = "ArchiveReturnTimeoutError";
  error.observation = observation();
  throw error;
}
