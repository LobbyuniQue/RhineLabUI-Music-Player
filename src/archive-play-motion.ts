const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export type MusicBands = { low: number; mid: number; high: number; loudness: number; activity: number };
export const quietBands = (): MusicBands => ({ low: 0, mid: 0, high: 0, loudness: 0, activity: 0 });
/**
 * Overall perceived loudness of a 128-sample spectrum (64 bands per channel).
 * The beat lives in the lows and presence range, the airy top contributes
 * little, so the 64 bands are weighted accordingly; the soft-knee curve keeps
 * quiet passages readable without flattening transients.
 */
export function spectrumLoudness(samples: ArrayLike<number>) {
  if (samples.length !== 128) return 0;
  let energy = 0, weight = 0;
  for (let i = 0; i < 64; i++) {
    const w = i < 8 ? 1 : i < 40 ? .8 : .45;
    const l = Number.isFinite(samples[i]) ? clamp(samples[i]) : 0;
    const r = Number.isFinite(samples[i + 64]) ? clamp(samples[i + 64]) : 0;
    energy += (w * (l * l + r * r)) / 2;
    weight += w;
  }
  return clamp(1 - Math.exp(-Math.sqrt(energy / weight) * 4.2));
}
export class SpectrumEnvelope {
  bands = quietBands();
  private target = quietBands();
  private received = -Infinity;
  private audible = -Infinity;
  private localSoundUntil = -Infinity;
  ignoreLocalSound(until: number) {
    if (Number.isFinite(until)) this.localSoundUntil = Math.max(this.localSoundUntil, until);
  }
  ingest(samples: ArrayLike<number>, time: number) {
    if (samples.length !== 128) return;
    // WE captures the wallpaper's own interaction sounds too. They cannot
    // start music mode from silence; already-established music keeps flowing.
    if (time <= this.localSoundUntil && this.bands.activity < .1) return;
    const band = (start: number, end: number) => {
      let energy = 0;
      for (let i = start; i < end; i++) {
        const l = Number.isFinite(samples[i]) ? clamp(samples[i]) : 0;
        const r = Number.isFinite(samples[i + 64]) ? clamp(samples[i + 64]) : 0;
        energy += (l * l + r * r) / 2;
      }
      return Math.sqrt(energy / (end - start));
    };
    this.target = { low: band(0, 8), mid: band(8, 32), high: band(32, 64), loudness: spectrumLoudness(samples), activity: 0 };
    this.received = time;
    if (Math.max(this.target.low, this.target.mid, this.target.high) > .012) this.audible = time;
  }
  update(dt: number, time: number, enabled: boolean): MusicBands {
    const fresh = enabled && time - this.received < .5;
    for (const key of ["low", "mid", "high"] as const) {
      const target = fresh ? this.target[key] : 0;
      const rate = target > this.bands[key] ? 16 : 3.2;
      this.bands[key] += (target - this.bands[key]) * (1 - Math.exp(-Math.min(dt, .1) * rate));
    }
    // Loudness pumps the whole array: a fast attack keeps beats crisp, the
    // slower release lets each hit decay instead of flickering.
    const loudTarget = fresh ? this.target.loudness : 0;
    const loudRate = loudTarget > this.bands.loudness ? 22 : 2.4;
    this.bands.loudness += (loudTarget - this.bands.loudness) * (1 - Math.exp(-Math.min(dt, .1) * loudRate));
    const active = fresh && time - this.audible < 1.5 ? 1 : 0;
    this.bands.activity += (active - this.bands.activity) * (1 - Math.exp(-Math.min(dt, .1) * (active ? 3 : 1.5)));
    return { ...this.bands };
  }
}
export function musicDisplacement(row: number, lane: number, time: number, bands: MusicBands, strength: number) {
  const bass = bands.low * .8 * (.5 + .5 * Math.sin(row * .29 - lane * .5 - time * 2.7));
  const middle = bands.mid * .48 * (.5 + .5 * Math.sin(row * .72 + lane * .9 - time * 4.3));
  const treble = bands.high * .18 * Math.pow(Math.max(0, Math.sin(row * 1.7 - lane * 2.2 - time * 6.4)), 4);
  return clamp((bass + middle + treble) * clamp(strength, 0, 2), 0, 1.8);
}
export type RelayStatus = "idle" | "preparing" | "playing" | "over";
export class RelayRound {
  status: RelayStatus = "idle";
  score = 0;
  target: string | null = null;
  remaining = 0;
  total = 0;
  reason = "";
  start() { this.status = "preparing"; this.score = 0; this.target = null; this.remaining = .8; this.reason = ""; }
  stop() { this.status = "idle"; this.target = null; this.remaining = 0; }
  aim(target: string, pace: "gentle" | "normal" | "quick") {
    this.target = target; this.status = "playing";
    const base = pace === "gentle" ? 8 : pace === "quick" ? 4 : 6;
    this.total = this.remaining = Math.max(base * .55, base - this.score * .12);
  }
  tick(dt: number, paused: boolean) {
    if (paused || (this.status !== "playing" && this.status !== "preparing")) return;
    this.remaining = Math.max(0, this.remaining - Math.max(0, dt));
    if (this.status === "playing" && this.remaining === 0) this.finish("这道波纹停下了");
  }
  hit(target: string | null) {
    if (this.status !== "playing") return false;
    if (target !== this.target) { this.finish("接力结束"); return false; }
    this.score++; this.status = "preparing"; this.target = null; this.remaining = .28; return true;
  }
  finish(reason: string) { this.status = "over"; this.target = null; this.reason = reason; }
}

export type RhythmStyle = 'legacy' | 'wave' | 'lift' | 'pulse' | 'ripple' | 'groove' | 'shimmer';
export type RhythmFrame = {
  style: Record<RhythmStyle, number>;
  /** Visual-only smoothing keeps browser and bridge motion equally calm. */
  bands?: MusicBands;
  /** Short low-band accent used by beat-led styles. */
  accent?: number;
};
/** Crossfade styles without a beat gate: sustained notes remain visible. */
export class RhythmMotion {
  private weights = { legacy: 1, wave: 0, lift: 0, pulse: 0, ripple: 0, groove: 0, shimmer: 0 };
  private visualBands = quietBands();
  private previousLow = 0;
  private accent = 0;
  update(bands: MusicBands, _time: number, dt: number, style: RhythmStyle): RhythmFrame {
    const step = clamp(dt, 0, .1);
    for (const key of ['legacy', 'wave', 'lift', 'pulse', 'ripple', 'groove', 'shimmer'] as const)
      this.weights[key] += ((style === key ? 1 : 0) - this.weights[key]) * (1 - Math.exp(-step * 5));
    const source = {
      low: Number.isFinite(bands.low) ? clamp(bands.low) : 0,
      mid: Number.isFinite(bands.mid) ? clamp(bands.mid) : 0,
      high: Number.isFinite(bands.high) ? clamp(bands.high) : 0,
      loudness: Number.isFinite(bands.loudness) ? clamp(bands.loudness) : 0,
      activity: Number.isFinite(bands.activity) ? clamp(bands.activity) : 0,
    };
    for (const key of ['low', 'mid', 'high', 'loudness'] as const) {
      const target = source[key];
      const rate = target > this.visualBands[key]
        ? key === 'high' ? 12 : key === 'loudness' ? 20 : 16
        : key === 'loudness' ? 3.5 : 4.5;
      this.visualBands[key] += (target - this.visualBands[key]) * (1 - Math.exp(-step * rate));
    }
    this.visualBands.activity += (source.activity - this.visualBands.activity) * (1 - Math.exp(-step * 6));
    const rise = step > 0 ? Math.max(0, this.visualBands.low - this.previousLow) / step : 0;
    this.previousLow = this.visualBands.low;
    const accentTarget = clamp(rise * 1.8) * this.visualBands.activity;
    this.accent += (accentTarget - this.accent) * (1 - Math.exp(-step * (accentTarget > this.accent ? 18 : 5)));
    return { style: { ...this.weights }, bands: { ...this.visualBands }, accent: this.accent };
  }
}
/** x is the card's projected horizontal position, left=0, right=1; y its
 * vertical position, top=0, bottom=1 (ripple needs both for radial rings). */
export function rhythmDisplacement(row: number, lane: number, time: number, bands: MusicBands, strength: number, frame: RhythmFrame, x = .5, y = .5) {
  x = clamp(x);
  const inputBands: MusicBands = {
    low: Number.isFinite(bands.low) ? clamp(bands.low) : 0,
    mid: Number.isFinite(bands.mid) ? clamp(bands.mid) : 0,
    high: Number.isFinite(bands.high) ? clamp(bands.high) : 0,
    loudness: Number.isFinite(bands.loudness) ? clamp(bands.loudness) : 0,
    activity: Number.isFinite(bands.activity) ? clamp(bands.activity) : 0,
  };
  const visualBands = frame.bands ?? inputBands;
  const classicBands = inputBands;
  const smooth = (v: number) => v * v * (3 - 2 * v);
  const right = smooth(clamp((x - .5) * 2));
  const left = 1 - smooth(clamp(x * 2));
  const middle = 1 - left - right;
  const spectrum = classicBands.low * left + classicBands.mid * middle + classicBands.high * right;
  // A: broad, screen-aligned spectrum ridges, continuous across band boundaries.
  const wave = spectrum * (.72 + .28 * Math.sin(row * .32 - time * 2.2)) * .95;
  // B: layered travelling currents; vocals and sustained treble also carry motion.
  const flow = classicBands.low * .62 * (.55 + .45 * Math.sin(row * .22 + lane * .18 - time * 1.8))
    + classicBands.mid * .42 * (.55 + .45 * Math.sin(row * .38 - lane * .27 - time * 2.8))
    + classicBands.high * .28 * (.55 + .45 * Math.sin(row * .62 + lane * .4 - time * 4.1));
  // C: loudness pump — every card rises with overall loudness so the array
  // breathes as one body; cards nearer the screen centre travel a little
  // further, which keeps the beat legible instead of a flat sheet.
  const centre = 1 - Math.abs(x - .5) * 2;
  const pulse = classicBands.loudness * (.8 + .35 * centre);
  // D: wave-frequency rings — the loudness pump radiates from the screen
  // centre as travelling rings; bass stretches and slows them, treble
  // tightens and quickens them, so the array answers the music's frequency
  // content, not just its level.
  const total = classicBands.low + classicBands.mid + classicBands.high + 1e-4;
  const treble = classicBands.high / total, bass = classicBands.low / total;
  const radius = Math.hypot(x - .5, (y - .5) * 1.35);
  const rings = Math.sin(radius * (7 + treble * 8) - time * (2.4 + treble * 3.2 - bass * 1.1));
  const ripple = classicBands.loudness * (.62 + .38 * rings);
  // E: bass-led broad groove. The accent is bounded and only sharpens a
  // rising low-band transient, so sustained notes remain smooth.
  const accent = frame.accent ?? 0;
  const groove = visualBands.low * (.62 + .14 * Math.sin(row * .18 - time * 1.45))
    + accent * (.12 + .08 * centre);
  // F: a restrained high-frequency shimmer, spatially fine but deliberately
  // quiet so treble detail never turns into visible jitter.
  const shimmer = (visualBands.mid * .12 + visualBands.high * .2)
    * (.5 + .5 * Math.sin(row * .88 + lane * .63 - time * 5.2))
    * (.35 + .65 * visualBands.loudness);
  return musicDisplacement(row, lane, time, classicBands, strength) * frame.style.legacy
    + (frame.style.wave * wave + frame.style.lift * flow + frame.style.pulse * pulse + frame.style.ripple * ripple
      + frame.style.groove * groove + frame.style.shimmer * shimmer) * clamp(strength, 0, 2);
}
