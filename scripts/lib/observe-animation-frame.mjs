// Test-only frame observation. Kept self-contained for injection via toString().
export function observeAnimationFrame(readSnapshot) {
  if (typeof readSnapshot !== "function") throw new TypeError("readSnapshot must be a function");
  return new Promise((resolve, reject) => {
    globalThis.requestAnimationFrame(frameTime => {
      try {
        const snapshot = readSnapshot();
        // The app still updates document/audio state when a static scene reuses
        // its last draw. Observe the callback itself, never GPU draw counters.
        resolve({ frameTime, snapshot });
      } catch (error) { reject(error); }
    });
  });
}
