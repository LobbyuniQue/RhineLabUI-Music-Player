import { ArchiveScene } from '../src/scene';
import { setActiveView } from '../src/archive-view';
import { buildMusicView } from '../src/music-grouping';
import type { LibraryTrack } from '../src/music-library';
import { RhythmMotion, quietBands } from '../src/archive-play-motion';
import { qualityPresets } from '../src/render-quality';

// Metadata only: no personal files, decoding, or audio output in this render probe.
const tracks: LibraryTrack[] = Array.from({ length: 24 }, (_, i) => ({
  id: `music-model-${i}`, title: `Demo score ${String(i + 1).padStart(2, '0')}`,
  artist: 'Rhine Lab Ensemble', album: `Album ${Math.floor(i / 6) + 1}`,
  name: `score-${i + 1}.mp3`, path: `demo/score-${i + 1}.mp3`, track: i % 6 + 1,
  duration: 180, codec: 'MP3', genre: '', year: '', disc: 1, tagged: true,
  hasCover: false, missing: false, size: 0, modified: 0,
}));
setActiveView(buildMusicView(tracks, 'album'));
// The same random AO kernel and renderer serve both sides of the comparison.
let seed = 431;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const scene = new ArchiveScene(document.querySelector('#scene')!);
await scene.load();
const internal = scene as any;
internal.inputEvents.abort();
scene.uiOnlyParallax = true;
scene.setQuality(qualityPresets.original);
scene.setRhythmStyle('ripple');
scene.setRowSpacing(.62, true);

type Scenario = 'array' | 'detail' | 'navigate';
let time = 100;
let prepared: { name: Scenario; simplified: boolean } | null = null;
// Product input normally stamps wall time. This fixed-step probe stamps its own
// event time so query waits and the order of A/B runs cannot alter spring motion.
internal.markMotionChange = () => {
  internal.motionChangedAt = internal.clock = internal.lastInteraction = time;
};
const step = () => { time += 1 / 60; scene.update(time); };
const bands = (frame: number) => ({
  low: .5 + .3 * Math.sin(frame * .27), mid: .4 + .2 * Math.sin(frame * .19),
  high: .3 + .2 * Math.cos(frame * .31), loudness: .55 + .2 * Math.sin(frame * .13), activity: 1,
});
const drive = (name: Scenario, frame: number, navigate = true) => {
  if (name === 'array') scene.setPlayfield(true, bands(frame), 1, 1, null, true);
  else {
    if (name === 'navigate' && navigate && frame % 6 === 0) scene.select((Math.floor(frame / 6) + 1) % tracks.length);
    internal.targetRotation = .45 * Math.cos(frame * .055);
  }
};
const gl = scene.renderer.getContext() as WebGL2RenderingContext;
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const debug = gl.getExtension('WEBGL_debug_renderer_info');
const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const summary = (samples: Record<string, number | null>[]) => Object.fromEntries(
  ['cpu', 'total', 'gpu', 'drawCalls', 'triangles'].map(key => {
    const values = samples.map(s => s[key]).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return [key, { median: values[Math.floor(values.length / 2)] ?? null,
      p95: values[Math.min(values.length - 1, Math.floor(values.length * .95))] ?? null, count: values.length }];
  }),
);

Object.assign(window, { bench: {
  scene,
  async prepare(name: Scenario, simplified: boolean) {
    if (!['array', 'detail', 'navigate'].includes(name)) throw new Error(`Unknown scenario: ${name}`);
    prepared = null;
    time = 100;
    scene.resetFrameClock();
    // Hidden mode removes owned returning copies through the real disposal path.
    scene.setMode('hidden');
    scene.setReduced(true);
    scene.setPlayfield(false, quietBands(), 1, 0, null, false);
    scene.setPresentationVisible(true, true);
    scene.setTheme(false, true);
    scene.setRowSpacing(.62, true);
    scene.select(0);
    internal.rotation = internal.targetRotation = 0;
    internal.scanTime = 29.1;
    internal.scanBlend = internal.flatMix = internal.idleGain = 0;
    internal.pulses = [];
    internal.hoverLifts.clear();
    internal.relayLifts.clear();
    internal.pointer.set(0, 0);
    internal.rhythm = new RhythmMotion();
    scene.setCardInteriorVisible(!simplified);
    // Settle all existing spring velocities, then enter the same canonical scene.
    // Skipping draw here changes neither simulation nor the timed sample frames.
    const render = internal.composer.render;
    try {
      internal.composer.render = () => {};
      for (let i = 0; i < 1200; i++) step();
      scene.setReduced(false);
      scene.setMode(name === 'array' ? 'archive' : 'detail');
      scene.revealImmediately();
      if (name !== 'array') internal.targetRotation = .45;
      for (let i = 0; i < 1200; i++) { drive(name, -1208 + i, false); step(); }
    } finally { internal.composer.render = render; }
    // Resize invalidates the skipped canvas; warm both material variants before timing.
    scene.resize();
    for (let i = -8; i < 0; i++) { drive(name, i, false); step(); }
    gl.finish();
    prepared = { name, simplified };
    return { ...prepared, stats: scene.getStats() };
  },
  async sample(name: Scenario, count = 24) {
    if (!prepared || prepared.name !== name) throw new Error('Prepare this scenario before sampling.');
    if (!Number.isInteger(count) || count < 1 || count > 600) throw new Error('Sample count must be 1–600.');
    const settings = { ...prepared };
    prepared = null; // Every measurement starts from its own deterministic prepare.
    const initial = scene.getStats();
    const samples: Record<string, number | null>[] = [];
    for (let i = 0; i < count; i++) {
      drive(name, i);
      const before = scene.getStats();
      const query = ext ? gl.createQuery() : null;
      if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const start = performance.now();
      step();
      const cpu = performance.now() - start;
      if (query) gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.finish();
      const total = performance.now() - start;
      await new Promise(r => setTimeout(r, 0));
      let gpu: number | null = null;
      if (query) {
        for (let n = 0; n < 100 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); n++) await new Promise(r => setTimeout(r, 1));
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
      }
      const stats = scene.getStats();
      samples.push({ frame: i, time, cpu, total, gpu, drawCalls: stats.drawCalls,
        triangles: stats.triangles, renderedFrames: stats.renderedFrames, reusedFrames: stats.reusedFrames,
        rendered: stats.renderedFrames - before.renderedFrames, reused: stats.reusedFrames - before.reusedFrames,
        returningFiles: stats.returningFiles, selectedSlot: stats.selectedSlot,
        rotation: stats.rotation, extraction: stats.extraction, cameraDetail: stats.cameraDetail });
    }
    const byReturningFiles = Object.fromEntries([...new Set(samples.map(s => s.returningFiles))].map(copies => {
      const group = samples.filter(s => s.returningFiles === copies);
      return [String(copies), { count: group.length, summary: summary(group) }];
    }));
    const stats = scene.getStats();
    return { ...settings, samples, summary: summary(samples), byReturningFiles, initial, stats,
      renderedFrames: stats.renderedFrames - initial.renderedFrames, reusedFrames: stats.reusedFrames - initial.reusedFrames,
      quality: document.querySelector('#scene')!.getAttribute('data-render-quality'),
      renderer, gpuTimer: !!ext, userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      timing: 'Fixed 1/60-second simulation. CPU is scene.update; total includes gl.finish. Not interactive FPS.' };
  },
} });
