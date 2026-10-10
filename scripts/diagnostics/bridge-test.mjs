// Exercise the VLC bridge: health, scan, play, status, bands, spectrum SSE.
const PORT = Number(process.argv[2] ?? 8788);
const TOKEN = process.argv[3] ?? "";
const BASE = `http://127.0.0.1:${PORT}`;
const auth = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path, headers = auth) => {
  const response = await fetch(BASE + path, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

const started = Date.now();
let health;
for (let i = 0; i < 60; i++) {
  try {
    health = await get("/api/health", {});
    if (health.status === 200) break;
  } catch {
    /* still starting */
  }
  await sleep(500);
}
if (!health || health.status !== 200) {
  console.log("bridge never answered /api/health");
  process.exit(1);
}
console.log(`health (${Date.now() - started}ms):`, JSON.stringify(health.body));

const library = await get("/api/library");
console.log(`library: ${library.body.tracks?.length} tracks`);
for (const track of (library.body.tracks ?? []).slice(0, 6))
  console.log(
    `  ${track.codec.padEnd(5)} ${String(Math.round(track.duration ?? 0)).padStart(4)}s  ${track.title} — ${track.artist || "?"}  [${track.folder}]`,
  );

const unauthorized = await get("/api/library", {});
console.log("unauthorized without token:", unauthorized.status);

const target =
  (library.body.tracks ?? []).find(
    (track) => track.codec === "wav" && /60Hz/.test(track.name),
  ) ?? library.body.tracks[0];
console.log("playing:", target.name);
const play = await get(`/api/play?id=${encodeURIComponent(target.id)}`);
console.log(
  "play:",
  play.status,
  JSON.stringify(play.body.track ?? play.body).slice(0, 160),
);

await sleep(3000);
const status = await get("/api/status");
console.log(
  "status:",
  JSON.stringify({
    state: status.body.state,
    time: status.body.time,
    length: status.body.length,
    title: status.body.title,
    artist: status.body.artist,
  }),
);

// Read bands a few times; the tap needs a moment to attach and fill a frame.
let bands = { bands: [] };
for (let i = 0; i < 12; i++) {
  const response = await get("/api/bands");
  bands = response.body;
  const energy = Math.max(...(bands.bands ?? [0]));
  if (energy > 0.05) break;
  await sleep(1000);
}
const low = bands.bands.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
const mid = bands.bands.slice(8, 32).reduce((a, b) => a + b, 0) / 24;
const high = bands.bands.slice(32, 64).reduce((a, b) => a + b, 0) / 32;
console.log(
  `bands: low ${low.toFixed(3)} mid ${mid.toFixed(3)} high ${high.toFixed(3)} (max ${Math.max(...bands.bands).toFixed(3)})`,
);
console.log(
  "expectation for a 60 Hz tone: low dominant →",
  low > mid && low > high ? "PASS" : "CHECK",
);

// SSE stream: two frames must arrive.
const sse = await fetch(
  BASE + "/api/spectrum?" + new URLSearchParams({ token: TOKEN }),
  { headers: auth },
);
const reader = sse.body.getReader();
let frames = 0;
const decoder = new TextDecoder();
const deadline = Date.now() + 6000;
while (frames < 2 && Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  frames += decoder.decode(value).split("data: ").length - 1;
}
await reader.cancel().catch(() => {});
console.log(
  "spectrum SSE frames received:",
  frames,
  frames >= 2 ? "PASS" : "FAIL",
);

const seekTo = Math.max(1, Math.round((status.body.length || 6) * 0.5));
const seek = await get(`/api/seek?seconds=${seekTo}`);
console.log(
  `seek to ${seekTo}s →`,
  JSON.stringify({ state: seek.body.state, time: seek.body.time }),
);

const pause = await get("/api/pause");
await sleep(600);
const paused = await get("/api/status");
console.log("pause →", paused.body.state);

const stop = await get("/api/stop");
console.log("stop →", stop.body.state);
