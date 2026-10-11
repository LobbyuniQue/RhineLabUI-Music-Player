export type PlayMode = "list" | "single" | "shuffle";

/** Identical queue policy for browser audio and VLC; no file is opened here. */
export function queueIndex(length: number, current: number, mode: PlayMode, step = 1, automatic = false, random = Math.random) {
  if (length <= 0) return -1;
  if (automatic && mode === "single" && current >= 0) return current;
  if (mode === "shuffle" && length > 1 && current >= 0) {
    const pick = Math.min(length - 2, Math.max(0, Math.floor(random() * (length - 1))));
    return pick >= current ? pick + 1 : pick;
  }
  return current < 0 ? 0 : ((current + step) % length + length) % length;
}
